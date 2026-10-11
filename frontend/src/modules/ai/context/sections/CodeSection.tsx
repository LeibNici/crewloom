/**
 * 「代码工作内容」工作区。
 *
 * 实际包含：代码编辑区域、语言、以及这段代码所用的数据选择（数据源 / 数据表 / 字段 + schema，
 * 来自 `collections:get`）。发送时映射成真实的 `code-editor` 上下文
 * （服务端模板用 `scene` / `language` / `code`），数据选择另发一条真实的 `datasource` 项，
 * 两者的 consumer 都存在（报告 10 §2.3）。
 *
 * 工具链路：`read_code_workspace`（只读）/ `preview_code_change`（只读，产生待确认修改）/
 * `apply_code_change`（ASK，必须用户确认）。界面上的「应用 / 拒绝」与原生会话的两步确认
 * 共用同一份工具定义（`../tools.ts`）。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PageCard } from '../../../../components/Card';
import { getCollectionSchema, listCollectionOptions, listDataSourceKeys } from '../schema';
import { CODE_WORKSPACE_UID } from '../payload';
import { requestChatHandoff, upsertSelection, useContextStoreSnapshot } from '../store';
import { runContextTool } from '../tools';
import type { CodeSelection } from '../types';
import { ToolProposals } from '../ToolProposals';
import { Field, Notice, Select, TextArea, TextInput } from '../../ui';
import styles from '../../group-a.module.css';

const LANGUAGES = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'sql', label: 'SQL' },
  { value: 'json', label: 'JSON' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'text', label: '纯文本' },
];

const DEFAULT_CODE = '// 在这里写下要与员工讨论的代码\n';

export function CodeSection() {
  const snapshot = useContextStoreSnapshot();
  const current = snapshot.selections.find((item): item is CodeSelection => item.kind === 'code') ?? null;

  const [title, setTitle] = useState('代码工作区');
  const [language, setLanguage] = useState('javascript');
  const [code, setCode] = useState(DEFAULT_CODE);
  const [useData, setUseData] = useState(false);
  const [datasource, setDatasource] = useState('main');
  const [collectionName, setCollectionName] = useState('');
  const [fieldsText, setFieldsText] = useState('');
  const [proposed, setProposed] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncToken, setSyncToken] = useState(0);

  // 依赖整个对象而不是 uid：工具「应用」会更新 store 里的这一项，
  // 表单必须同步显示新内容（用户正在输入时 store 不变，因此不会被覆盖）。
  useEffect(() => {
    if (!current) return;
    setTitle(current.title);
    setLanguage(current.language);
    setCode(current.code);
    setProposed(current.code);
    if (current.data) {
      setUseData(true);
      setDatasource(current.data.datasource);
      setCollectionName(current.data.collectionName);
      setFieldsText(current.data.fields?.join(', ') ?? '');
    }
  }, [current, syncToken]);

  const dataSources = useQuery({ queryKey: ['ai', 'context', 'data-sources'], queryFn: listDataSourceKeys, retry: false, staleTime: 60_000 });
  const collections = useQuery({ queryKey: ['ai', 'context', 'collections'], queryFn: () => listCollectionOptions(), retry: false, staleTime: 60_000 });
  const schema = useQuery({
    queryKey: ['ai', 'context', 'schema', collectionName],
    queryFn: () => getCollectionSchema(collectionName),
    enabled: useData && collectionName.length > 0,
    retry: false,
    staleTime: 60_000,
  });

  const save = () => {
    const fields = fieldsText.split(',').map((item) => item.trim()).filter(Boolean);
    const selection: CodeSelection = {
      kind: 'code',
      uid: CODE_WORKSPACE_UID,
      title: title.trim() || '代码工作区',
      scene: 'crewloom-code-workspace',
      language,
      code,
      data:
        useData && collectionName.trim().length > 0
          ? {
              datasource,
              collectionName: collectionName.trim(),
              fields: fields.length > 0 ? fields : null,
              label: schema.data?.title || collectionName.trim(),
            }
          : null,
    };
    upsertSelection(selection);
    requestChatHandoff();
    setProposed(code);
    setFailed(false);
    setMessage('已保存为本次会话的代码工作内容。');
  };

  const readWorkspace = async () => {
    setBusy(true);
    setFailed(false);
    const result = await runContextTool('code', CODE_WORKSPACE_UID, 'read_code_workspace');
    setBusy(false);
    if (result.status === 'success') {
      setMessage('已读取当前代码工作区。');
      return;
    }
    setFailed(true);
    setMessage(typeof result.content === 'string' ? result.content : '读取失败。');
  };

  const previewChange = async () => {
    setBusy(true);
    setFailed(false);
    setMessage(null);
    const result = await runContextTool('code', CODE_WORKSPACE_UID, 'preview_code_change', { code: proposed });
    setBusy(false);
    if (result.status === 'success') {
      setMessage('已生成一份待确认的代码修改，请在下面选择「应用」或「拒绝」。');
      return;
    }
    setFailed(true);
    setMessage(typeof result.content === 'string' ? result.content : '预览失败。');
  };

  return (
    <div className={styles.stack}>
      <PageCard
        title="代码工作内容"
        description="写下要与员工讨论的代码，也可以指明这段代码用到的数据表与字段。"
      >
        <div className={styles.fieldRow}>
          <Field label="标题">
            <TextInput value={title} onChange={setTitle} />
          </Field>
          <Field label="语言">
            <Select value={language} onChange={setLanguage} options={LANGUAGES} />
          </Field>
        </div>

        <Field label="代码">
          <TextArea value={code} rows={10} onChange={setCode} testId="context-code-input" />
        </Field>

        <Field label="这段代码用到的数据（可选）">
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={useData}
              onChange={(event) => setUseData(event.target.checked)}
              data-testid="context-code-data-toggle"
            />
            <span>选择数据表与字段，作为同一段工作内容的数据范围</span>
          </label>
        </Field>

        {useData ? (
          <div className={styles.fieldRow}>
            <Field label="数据源">
              {dataSources.data && dataSources.data.length > 0 ? (
                <Select value={datasource} onChange={setDatasource} options={dataSources.data.map((key) => ({ value: key, label: key }))} />
              ) : (
                <TextInput value={datasource} onChange={setDatasource} />
              )}
            </Field>
            <Field label="数据表" required>
              <input
                className={styles.input}
                list="crewloom-code-collections"
                value={collectionName}
                onChange={(event) => setCollectionName(event.target.value)}
                data-testid="context-code-collection"
              />
              <datalist id="crewloom-code-collections">
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
                list="crewloom-code-fields"
                value={fieldsText}
                onChange={(event) => setFieldsText(event.target.value)}
                data-testid="context-code-fields"
              />
              <datalist id="crewloom-code-fields">
                {(schema.data?.fields ?? []).map((item) => (
                  <option key={item.name} value={item.name} />
                ))}
              </datalist>
            </Field>
          </div>
        ) : null}

        {schema.data && fieldsText.trim().length > 0 ? (
          <p className={styles.rowHint}>
            字段类型：{fieldsText
              .split(',')
              .map((name) => name.trim())
              .filter(Boolean)
              .map((name) => {
                const field = schema.data?.fields.find((item) => item.name === name);
                return field ? `${name}(${field.type ?? field.interface ?? 'unknown'})` : name;
              })
              .join('、')}
          </p>
        ) : null}

        <div className={styles.toolbar}>
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={save} data-testid="context-code-save">
            保存为会话内容
          </button>
          {current ? (
            <button type="button" className={styles.button} disabled={busy} onClick={() => void readWorkspace()}>
              读取当前工作区
            </button>
          ) : null}
        </div>
        {message ? <Notice tone={failed ? 'danger' : 'info'}>{message}</Notice> : null}
      </PageCard>

      {current ? (
        <PageCard title="修改确认" description="员工提出的代码修改会出现在这里，由你决定应用还是拒绝；也可以先用下面的建议内容自己预览。">
          <Field label="建议代码">
            <TextArea value={proposed} rows={8} onChange={setProposed} testId="context-code-proposal" />
          </Field>
          <div className={styles.toolbar}>
            <button
              type="button"
              className={styles.button}
              disabled={busy || proposed.trim().length === 0}
              onClick={() => void previewChange()}
              data-testid="context-code-preview-change"
            >
              预览这份修改
            </button>
            <span className={styles.rowHint}>预览不会改写工作区，只会生成一条待确认的修改。</span>
          </div>
          <ToolProposals kind="code" uid={CODE_WORKSPACE_UID} title="代码工作内容" onSettled={() => setSyncToken((value) => value + 1)} />
        </PageCard>
      ) : null}
    </div>
  );
}
