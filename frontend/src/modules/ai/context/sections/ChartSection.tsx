/**
 * 「图表工作内容」工作区。
 *
 * 实际配置数据表、字段 / 聚合、图表样式与必要 options，并且**真的**渲染一份可见预览
 * （读取一小段记录后在前端聚合；图表能力用项目已有的 `echarts-for-react`）。
 * 发送时映射成真实的 `chart-config` 上下文：该类型在 2.2.22 有客户端注册（`getContent`），
 * 服务端没有专门策略，走默认 `JSON.stringify(item)`，因此内容必须是自描述的完整配置
 * （报告 10 §2.4）。
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PageCard } from '../../../../components/Card';
import { loadChartPreview, type ChartPreviewData } from '../chart-data';
import { getCollectionSchema, listCollectionOptions, listDataSourceKeys } from '../schema';
import { CHART_WORKSPACE_UID } from '../payload';
import { CHART_AGGREGATIONS, CHART_TYPES } from '../types';
import { requestChatHandoff, upsertSelection, useContextStoreSnapshot } from '../store';
import { runContextTool } from '../tools';
import type { ChartAggregation, ChartSelection, ChartType } from '../types';
import { ToolProposals } from '../ToolProposals';
import { Checkbox, Field, Notice, Select, StateBlock, TextArea, TextInput } from '../../ui';
import styles from '../../group-a.module.css';

const ChartPreview = lazy(() => import('../ChartPreview'));

const EMPTY_PREVIEW: ChartPreviewData = { points: [], total: 0, usedRows: 0, numericRows: 0, truncated: false };

export function ChartSection() {
  const snapshot = useContextStoreSnapshot();
  const current = snapshot.selections.find((item): item is ChartSelection => item.kind === 'chart') ?? null;

  const [title, setTitle] = useState('图表工作区');
  const [datasource, setDatasource] = useState('main');
  const [collectionName, setCollectionName] = useState('');
  const [fieldsText, setFieldsText] = useState('');
  const [metricField, setMetricField] = useState('');
  const [aggregation, setAggregation] = useState<ChartAggregation>('count');
  const [groupBy, setGroupBy] = useState('');
  const [limit, setLimit] = useState('100');
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [showLegend, setShowLegend] = useState(true);
  const [smooth, setSmooth] = useState(false);
  const [stacked, setStacked] = useState(false);
  const [preview, setPreview] = useState<ChartPreviewData>(EMPTY_PREVIEW);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncToken, setSyncToken] = useState(0);

  // 同「代码工作内容」：工具应用会更新 store 里的这一项，表单需要同步。
  useEffect(() => {
    if (!current) return;
    setTitle(current.title);
    setDatasource(current.datasource);
    setCollectionName(current.collectionName);
    setFieldsText(current.fields.join(', '));
    setMetricField(current.metricField);
    setAggregation(current.aggregation);
    setGroupBy(current.groupBy);
    setLimit(String(current.limit));
    setChartType(current.chartType);
    setShowLegend(current.options.showLegend);
    setSmooth(current.options.smooth);
    setStacked(current.options.stacked);
  }, [current, syncToken]);

  const dataSources = useQuery({ queryKey: ['ai', 'context', 'data-sources'], queryFn: listDataSourceKeys, retry: false, staleTime: 60_000 });
  const collections = useQuery({ queryKey: ['ai', 'context', 'collections'], queryFn: () => listCollectionOptions(), retry: false, staleTime: 60_000 });
  const schema = useQuery({
    queryKey: ['ai', 'context', 'schema', collectionName],
    queryFn: () => getCollectionSchema(collectionName),
    enabled: collectionName.length > 0,
    retry: false,
    staleTime: 60_000,
  });

  const fieldOptions = useMemo(
    () => (schema.data?.fields ?? []).map((field) => ({ value: field.name, label: field.title ? `${field.title}（${field.name}）` : field.name })),
    [schema.data],
  );

  const buildSelection = (): ChartSelection => ({
    kind: 'chart',
    uid: CHART_WORKSPACE_UID,
    title: title.trim() || '图表工作区',
    datasource,
    collectionName: collectionName.trim(),
    fields: fieldsText.split(',').map((item) => item.trim()).filter(Boolean),
    metricField,
    aggregation,
    groupBy,
    filter: null,
    sort: null,
    limit: Number(limit) || 100,
    chartType,
    options: { showLegend, smooth, stacked },
  });

  const loadPreview = async () => {
    if (collectionName.trim().length === 0) {
      setPreviewError('请先选择数据表。');
      return;
    }
    setPreviewing(true);
    setPreviewError(null);
    try {
      setPreview(await loadChartPreview(buildSelection()));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : '读取预览数据失败，请稍后重试。');
    } finally {
      setPreviewing(false);
    }
  };

  const save = () => {
    upsertSelection(buildSelection());
    requestChatHandoff();
    setFailed(false);
    setMessage('已保存为本次会话的图表工作内容。');
  };

  const previewChange = async () => {
    setBusy(true);
    setFailed(false);
    setMessage(null);
    const result = await runContextTool('chart', CHART_WORKSPACE_UID, 'preview_chart_config', {
      chartType,
      aggregation,
      groupBy,
    });
    setBusy(false);
    if (result.status === 'success') {
      setMessage('已生成一份待确认的图表配置修改，请在下面选择「应用」或「拒绝」。');
      return;
    }
    setFailed(true);
    setMessage(typeof result.content === 'string' ? result.content : '预览失败。');
  };

  return (
    <div className={styles.stack}>
      <PageCard
        title="图表工作内容"
        description="选择数据表、字段与聚合方式，配置图表样式；预览会读取一小段数据。发送时这份配置会一起带给员工。"
      >
        <div className={styles.fieldRow}>
          <Field label="标题">
            <TextInput value={title} onChange={setTitle} />
          </Field>
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
              list="crewloom-chart-collections"
              value={collectionName}
              onChange={(event) => setCollectionName(event.target.value)}
              data-testid="context-chart-collection"
            />
            <datalist id="crewloom-chart-collections">
              {(collections.data ?? []).map((item) => (
                <option key={item.name} value={item.name}>
                  {item.title ?? item.name}
                </option>
              ))}
            </datalist>
          </Field>
        </div>

        <Field label="统计字段" hint="逗号分隔；用于图表的数据列，留空表示全部可读字段。">
          <TextArea value={fieldsText} rows={2} onChange={setFieldsText} testId="context-chart-fields" />
        </Field>

        <div className={styles.fieldRow}>
          <Field label="聚合方式">
            <Select
              value={aggregation}
              onChange={(next) => setAggregation(next as ChartAggregation)}
              options={CHART_AGGREGATIONS.map((item) => ({ value: item.value, label: item.label }))}
              testId="context-chart-aggregation"
            />
          </Field>
          <Field label="指标字段" hint="除计数外，需要选择一个数值字段。">
            {fieldOptions.length > 0 ? (
              <Select value={metricField} onChange={setMetricField} options={[{ value: '', label: '（不指定）' }, ...fieldOptions]} testId="context-chart-metric" />
            ) : (
              <TextInput value={metricField} onChange={setMetricField} testId="context-chart-metric" />
            )}
          </Field>
          <Field label="分组字段" hint="留空表示只统计一个总量。">
            {fieldOptions.length > 0 ? (
              <Select value={groupBy} onChange={setGroupBy} options={[{ value: '', label: '（不分组）' }, ...fieldOptions]} testId="context-chart-groupby" />
            ) : (
              <TextInput value={groupBy} onChange={setGroupBy} testId="context-chart-groupby" />
            )}
          </Field>
        </div>

        <div className={styles.fieldRow}>
          <Field label="图表类型">
            <Select
              value={chartType}
              onChange={(next) => setChartType(next as ChartType)}
              options={CHART_TYPES.map((item) => ({ value: item.value, label: item.label }))}
              testId="context-chart-type"
            />
          </Field>
          <Field label="取数上限">
            <TextInput type="number" value={limit} onChange={setLimit} testId="context-chart-limit" />
          </Field>
          <Field label="样式选项">
            <div className={styles.stack}>
              <Checkbox label="显示图例" checked={showLegend} onChange={setShowLegend} />
              <Checkbox label="折线平滑" checked={smooth} onChange={setSmooth} />
              <Checkbox label="堆叠显示" checked={stacked} onChange={setStacked} />
            </div>
          </Field>
        </div>

        <div className={styles.toolbar}>
          <button
            type="button"
            className={styles.button}
            disabled={previewing || collectionName.trim().length === 0}
            onClick={() => void loadPreview()}
            data-testid="context-chart-preview-button"
          >
            {previewing ? '正在读取…' : '预览图表'}
          </button>
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={save} data-testid="context-chart-save">
            保存为会话内容
          </button>
          <span className={styles.rowHint}>预览只读取数据，不会修改任何记录。</span>
        </div>

        {previewError ? <Notice tone="danger">{previewError}</Notice> : null}
        {message ? <Notice tone={failed ? 'danger' : 'info'}>{message}</Notice> : null}

        {preview.points.length > 0 ? (
          <div data-testid="context-chart-preview">
            <Suspense fallback={<p className={styles.rowHint}>正在准备图表…</p>}>
              <ChartPreview
                type={chartType}
                points={preview.points}
                title={title}
                showLegend={showLegend}
                smooth={smooth}
                stacked={stacked}
              />
            </Suspense>
            <p className={styles.rowHint}>
              参与统计 {preview.usedRows} 行（范围内共 {preview.total} 条{preview.truncated ? '，已截断' : ''}）；
              有效数值 {preview.numericRows} 行。
            </p>
          </div>
        ) : (
          <StateBlock
            state={previewing ? 'loading' : previewError ? 'error' : 'empty'}
            emptyTitle="还没有图表预览"
            emptyDescription="选好数据表与聚合方式后点击「预览图表」，这里会显示聚合结果。"
          />
        )}
      </PageCard>

      {current ? (
        <PageCard title="修改确认" description="员工提出的图表调整会出现在这里，由你决定应用还是拒绝；也可以先用当前设置自己预览。">
          <div className={styles.toolbar}>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => void previewChange()}
              data-testid="context-chart-preview-change"
            >
              预览当前配置修改
            </button>
            <span className={styles.rowHint}>预览不会改写工作区，只会生成一条待确认的修改。</span>
          </div>
          <ToolProposals kind="chart" uid={CHART_WORKSPACE_UID} title="图表工作内容" onSettled={() => setSyncToken((value) => value + 1)} />
        </PageCard>
      ) : null}
    </div>
  );
}
