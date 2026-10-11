/**
 * 「指定记录的工作内容」工作区——原页面区块上下文（`flow-model`）在 Crewloom 的等价实现。
 *
 * 用户明确选择 **数据表 → 字段 → 一条记录**，发送时映射成真实的 `datasource` 上下文
 * （主键等值筛选，`limit: 1`），由服务端按当前角色 ACL 解析出记录内容。
 *
 * 不做的事：不伪造旧 `FlowModelUID`、不默认抓取当前页面区块、不依赖 flow-engine 模型。
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PageCard } from '../../../../components/Card';
import { resourceMessageOf, resourceStateOf } from '../../resources';
import { getCollectionSchema, listCollectionOptions, listDataSourceKeys, listRecords } from '../schema';
import { requestChatHandoff, upsertSelection, removeSelection, useContextStoreSnapshot } from '../store';
import { recordUid } from '../payload';
import type { RecordSelection } from '../types';
import { Field, Notice, Select, StateBlock, TextInput } from '../../ui';
import { cellText } from '../format';
import styles from '../../group-a.module.css';

const PREVIEW_LIMIT = 10;

export function RecordSection() {
  const [datasource, setDatasource] = useState('main');
  const [collectionName, setCollectionName] = useState('');
  const [fieldsText, setFieldsText] = useState('');
  const [requested, setRequested] = useState(false);
  const snapshot = useContextStoreSnapshot();
  const current = snapshot.selections.find((item): item is RecordSelection => item.kind === 'record') ?? null;

  const dataSources = useQuery({ queryKey: ['ai', 'context', 'data-sources'], queryFn: listDataSourceKeys, retry: false, staleTime: 60_000 });
  const collections = useQuery({ queryKey: ['ai', 'context', 'collections'], queryFn: () => listCollectionOptions(), retry: false, staleTime: 60_000 });
  const schema = useQuery({
    queryKey: ['ai', 'context', 'schema', collectionName],
    queryFn: () => getCollectionSchema(collectionName),
    enabled: collectionName.length > 0,
    retry: false,
    staleTime: 60_000,
  });
  const fields = useMemo(() => {
    const parsed = fieldsText.split(',').map((item) => item.trim()).filter(Boolean);
    return parsed.length > 0 ? parsed : null;
  }, [fieldsText]);

  const records = useQuery({
    queryKey: ['ai', 'context', 'records', datasource, collectionName, fieldsText],
    queryFn: () =>
      listRecords(collectionName, {
        pageSize: PREVIEW_LIMIT,
        ...(fields ? { fields } : {}),
        dataSource: datasource,
      }),
    enabled: requested && collectionName.length > 0,
    retry: false,
  });

  const primaryKey = schema.data?.primaryKey ?? 'id';
  const state = !requested ? 'empty' : records.isLoading ? 'loading' : resourceStateOf(records.error, (records.data?.rows.length ?? 0) === 0);

  const pick = (row: Record<string, unknown>) => {
    const recordId = row[primaryKey] as string | number | undefined;
    if (recordId === undefined || recordId === null) return;
    const selection: RecordSelection = {
      kind: 'record',
      uid: recordUid({ datasource, collectionName, recordId }),
      title: `${schema.data?.title || collectionName} · ${String(recordId)}`,
      datasource,
      collectionName,
      primaryKey,
      recordId,
      fields,
    };
    upsertSelection(selection);
    requestChatHandoff();
  };

  return (
    <div className={styles.stack}>
      <PageCard
        title="指定记录的工作内容"
        description="先选数据表与字段，再从预览里挑一条记录。发送时只带上这一条记录。"
      >
        <div className={styles.fieldRow}>
          <Field label="数据源">
            {dataSources.data && dataSources.data.length > 0 ? (
              <Select
                value={datasource}
                onChange={(next) => {
                  setDatasource(next);
                  setRequested(false);
                }}
                options={dataSources.data.map((key) => ({ value: key, label: key }))}
              />
            ) : (
              <TextInput value={datasource} onChange={(next) => setDatasource(next)} />
            )}
          </Field>
          <Field label="数据表" required hint={collections.error ? '集合清单读取失败，可手动填写。' : undefined}>
            <input
              className={styles.input}
              list="crewloom-record-collections"
              value={collectionName}
              onChange={(event) => {
                setCollectionName(event.target.value);
                setRequested(false);
              }}
              data-testid="context-record-collection"
            />
            <datalist id="crewloom-record-collections">
              {(collections.data ?? []).map((item) => (
                <option key={item.name} value={item.name}>
                  {item.title ?? item.name}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="字段" hint="逗号分隔；留空表示全部可读字段。">
            <input
              className={styles.input}
              list="crewloom-record-fields"
              value={fieldsText}
              onChange={(event) => setFieldsText(event.target.value)}
              placeholder="如需限定，用逗号分隔字段名"
            />
            <datalist id="crewloom-record-fields">
              {(schema.data?.fields ?? []).map((item) => (
                <option key={item.name} value={item.name} />
              ))}
            </datalist>
          </Field>
        </div>

        <div className={styles.toolbar}>
          <button
            type="button"
            className={styles.button}
            disabled={collectionName.trim().length === 0 || records.isFetching}
            onClick={() => {
              setRequested(true);
              if (requested) void records.refetch();
            }}
            data-testid="context-record-preview"
          >
            {records.isFetching ? '正在读取…' : '读取记录'}
          </button>
          <span className={styles.rowHint}>只读取最多 {PREVIEW_LIMIT} 条用于选择，不会修改数据。</span>
        </div>

        {requested ? (
          <>
            <StateBlock
              state={state}
              message={resourceMessageOf(records.error)}
              onRetry={() => void records.refetch()}
              emptyTitle="没有可选的记录"
              emptyDescription="当前没有可选记录。可以换一张数据表，或联系管理员确认你的权限范围。"
            />
            {(records.data?.rows.length ?? 0) > 0 ? (
              <div className={styles.tableWrap}>
                <table className={styles.table} data-testid="context-record-table">
                  <thead>
                    <tr>
                      <th>记录</th>
                      <th>内容</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {records.data!.rows.map((row, index) => (
                      <tr key={index}>
                        <td className={styles.mono}>{String(row[primaryKey] ?? index + 1)}</td>
                        <td>
                          <span className={styles.mono}>
                            {Object.entries(row)
                              .slice(0, 6)
                              .map(([key, value]) => `${key}=${cellText({ name: key, value })}`)
                              .join('，')}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className={`${styles.button} ${styles.buttonSmall}`}
                            onClick={() => pick(row)}
                            data-testid="context-record-pick"
                          >
                            选择
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : (
          <Notice>还没有读取记录。填好数据表后点击「读取记录」，再从结果里选择一条。</Notice>
        )}
      </PageCard>

      {current ? (
        <div data-testid="context-record-summary">
          <PageCard
            title="已选择的记录"
            description="发送消息时会带上这条记录。"
            actions={
              <div className={styles.rowActions}>
                <button type="button" className={styles.button} onClick={() => setRequested(true)}>
                  重新选择
                </button>
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonDanger}`}
                  onClick={() => removeSelection('record')}
                  data-testid="context-record-clear"
                >
                  取消
                </button>
              </div>
            }
          >
            <div className={styles.fieldRow}>
              <Field label="数据表">
                <span className={styles.mono}>{current.collectionName}</span>
              </Field>
              <Field label="记录">
                <span className={styles.mono}>{String(current.recordId)}</span>
              </Field>
              <Field label="字段">
                <span className={styles.mono}>{current.fields?.join('、') ?? '全部可读字段'}</span>
              </Field>
            </div>
          </PageCard>
        </div>
      ) : null}
    </div>
  );
}
