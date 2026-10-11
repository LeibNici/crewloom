import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../../api/client';
import { toUserMessage } from '../../../api/errors';
import { DefinitionRow, EmptyState, PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { useMutation } from '../useMutation';
import { asRecord, humanizeType, stringifyJson } from '../format';
import { triggerTypeLabel } from '../labels';
import { fetchFlowNodes, fetchWorkflow, type FlowNodeRow, type WorkflowRow } from '../domain';
import { nodeTypeSpec, readPath, validateNodeConfig } from '../nodeTypes';
import { NodeConfigForm } from '../components/NodeConfigForm';
import styles from '../workflow.module.css';

/**
 * WF-03 节点配置。
 *
 * 契约事实（十页闭环 §C2）：节点类型与配置面板**全部是客户端代码注册**，
 * 服务端只存 `type` + `config`（自由 jsonb），**没有**"列出节点类型"的端点。
 *
 * 本页因此按固定源码的 `configSchema` 为**每一种已确认节点类型**提供可操作表单：
 *  - `calculation`：引擎 + 表达式（含表达式体检）
 *  - `condition`：判断方式 + 引擎 + 基础条件组 / 条件表达式
 *  - `multi-conditions`：条件列表（增删改排序）+ 都不匹配时继续
 *  - `query` / `create` / `update` / `destroy`：数据表（必填）+ 条件 / 内容 / 附带关联 / 分页排序
 *  - `output`：输出内容
 *  - `end`：结束状态
 *  - `manual`：待办标题 / 处理方式 / 处理人 / 处理动作配置 / Formily 表单布局
 *
 * **未知类型**不会被降级成"只有一个 JSON 框"的猜配置：页面明确标注"未知类型"，
 * 并保留原始 `config`（可切换原始模式查看/编辑），与原生"保留节点记录并提示"的行为对齐。
 *
 * 保存走 `flow_nodes:update`（`values.config`）；已产生执行记录的版本会返回 400，
 * 界面在保存前就检查并说明。
 */
export function NodeConfigPage() {
  const [params] = useSearchParams();
  const workflowId = params.get('workflowId') ?? '';
  const nodeId = params.get('nodeId') ?? '';

  const [workflow, setWorkflow] = useState<WorkflowRow | null>(null);
  const [node, setNode] = useState<FlowNodeRow | null>(null);
  const [title, setTitle] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [rawError, setRawError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation();

  const load = useCallback(async () => {
    if (!workflowId || !nodeId) {
      setLoading(false);
      setLoadError('没有指定要配置的节点。');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [detail, nodes] = await Promise.all([fetchWorkflow(workflowId), fetchFlowNodes(workflowId)]);
      const found = nodes.find((item) => item.id === nodeId) ?? null;
      setWorkflow(detail);
      setNode(found);
      if (!found) {
        setLoadError('这个节点不存在，可能已被删除。');
      } else {
        setTitle(found.title ?? '');
        const initial = asRecord(found.config) ?? {};
        setConfig(initial);
        setRawText(stringifyJson(found.config ?? {}));
        setValidationErrors({});
      }
    } catch (error) {
      setWorkflow(null);
      setNode(null);
      setLoadError(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [workflowId, nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const spec = useMemo(() => nodeTypeSpec(node?.type), [node]);
  const executed = workflow?.versionExecuted ?? 0;
  const locked = executed > 0;

  /** 顶层字段名（用于展示"当前 config 里有哪些键"）。 */
  const configKeys = useMemo(() => Object.keys(config), [config]);

  const save = async () => {
    if (!node) return;
    setRawError(null);
    let nextConfig: Record<string, unknown>;
    if (rawMode || !spec) {
      try {
        const parsed = rawText.trim() === '' ? {} : JSON.parse(rawText);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setRawError('配置内容需要是一个对象（用一对花括号包起来的键值对）。');
          return;
        }
        nextConfig = parsed as Record<string, unknown>;
      } catch {
        setRawError('配置内容不是有效的 JSON，请检查括号、引号与逗号后重试。');
        return;
      }
    } else {
      const errors = validateNodeConfig(node.type, config);
      setValidationErrors(errors);
      if (Object.keys(errors).length > 0) {
        setRawError('表单里还有需要补齐或修正的内容，请按提示修改后再保存。');
        return;
      }
      nextConfig = config;
    }
    const result = await mutation.run(() =>
      api.resourceAction('flow_nodes', 'update', {
        params: { filterByTk: node.id },
        values: { title: title.trim(), config: nextConfig },
      }),
    );
    if (result !== null) {
      setNotice('已保存该节点的配置。');
      await load();
    }
  };

  if (loading) {
    return (
      <PageCard title="节点配置">
        <p className={styles.mutedText}>正在读取节点配置…</p>
      </PageCard>
    );
  }

  if (loadError || !node) {
    return (
      <div className={styles.stack}>
        <PageHeader title="节点配置" description="查看并修改某个节点的配置。" />
        <EmptyState tone="warn" title="暂时读不到节点配置" description={loadError ?? '没有找到这个节点。'} />
        <Link
          className={styles.secondaryButton}
          to={workflowId ? `/workflow/canvas?workflowId=${workflowId}` : '/workflow/list'}
        >
          返回流程编排
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      <PageHeader
        title={`节点配置 · ${node.title ?? humanizeType(node.type)}`}
        description="按节点类型填写配置。保存后立即生效；不认识的字段会原样保留。"
        meta={
          <div className={styles.tagRow}>
            <StatusPill tone={spec ? 'neutral' : 'warn'}>
              {spec ? spec.label : `未知类型（${node.type ?? '未设置'}）`}
            </StatusPill>
            {workflow ? <span className={styles.metaText}>所属流程：{workflow.title}</span> : null}
          </div>
        }
        actions={
          <Link className={styles.secondaryButton} to={`/workflow/canvas?workflowId=${workflowId}`}>
            返回编排
          </Link>
        }
      />

      <PageCard title="节点信息">
        <DefinitionRow term="节点标识">#{node.id}</DefinitionRow>
        <DefinitionRow term="节点类型">
          {node.type ?? '未设置'}
          {spec ? `（${spec.label}）` : ''}
        </DefinitionRow>
        <DefinitionRow term="前序节点">{node.upstreamId ?? '（流程起点）'}</DefinitionRow>
        <DefinitionRow term="下游节点">{node.downstreamId ?? '（流程终点）'}</DefinitionRow>
        {node.branchIndex !== null ? <DefinitionRow term="分支序号">{node.branchIndex}</DefinitionRow> : null}
        {workflow ? <DefinitionRow term="触发方式">{triggerTypeLabel(workflow.type)}</DefinitionRow> : null}
      </PageCard>

      {locked ? (
        <PageCard tone="muted" title="这个版本已执行过，不能修改">
          <p className={styles.warnText}>
            版本一旦产生执行记录，节点与流程配置都不允许再改。需要调整时请回到流程列表，对该流程"新建版本"后在
            新版本上修改。
          </p>
        </PageCard>
      ) : null}

      {spec ? (
        <PageCard
          title={`${spec.label}配置`}
          description={spec.description}
          actions={
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={locked}
              onClick={() => {
                // 切到原始模式时用当前表单值刷新文本，避免两边不一致。
                setRawText(stringifyJson(config));
                setRawMode((value) => !value);
                setRawError(null);
              }}
            >
              {rawMode ? '返回表单配置' : '原始配置模式'}
            </button>
          }
        >
          <label className={styles.field}>
            <span className={styles.fieldLabel}>节点标题</span>
            <input
              className={styles.input}
              value={title}
              disabled={locked}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {rawMode ? null : (
            <NodeConfigForm
              fields={spec.fields}
              config={config}
              disabled={locked}
              errors={validationErrors}
              onChange={setConfig}
            />
          )}
        </PageCard>
      ) : (
        <PageCard tone="muted" title="未知节点类型">
          <p className={styles.warnText}>
            这个节点的类型是「{node.type ?? '未设置'}」，当前前端没有它的配置面板
            （节点类型面板由客户端插件注册，没有"列出节点类型"的接口）。
            为避免误改，本页不猜它的字段结构：下面的原始配置里会**完整保留**它原有的全部内容，
            可以直接查看或编辑。
          </p>
        </PageCard>
      )}

      {!spec || rawMode ? (
        <PageCard title="原始配置（JSON）" description="按保存的原始结构读写；不认识的字段会原样保留。">
          <label className={styles.field}>
            <span className={styles.fieldLabel}>节点标题</span>
            <input
              className={styles.input}
              value={title}
              disabled={locked}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <textarea
            className={styles.textarea}
            aria-label="配置内容"
            rows={16}
            spellCheck={false}
            disabled={locked}
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
          />
          {configKeys.length > 0 && !rawMode ? (
            <p className={styles.cellHint}>原有配置包含这些字段：{configKeys.join('、')}。</p>
          ) : null}
          {rawError ? <p className={styles.errorText}>{rawError}</p> : null}
        </PageCard>
      ) : null}

      {!locked ? (
        <PageCard title="保存" description="保存前会做一次体检；最终以系统的校验结果为准。">
          <div className={styles.formActions}>
            <button type="button" className={styles.primaryButton} disabled={mutation.isSubmitting} onClick={() => void save()}>
              保存配置
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={mutation.isSubmitting}
              onClick={() => {
                setTitle(node.title ?? '');
                setConfig(asRecord(node.config) ?? {});
                setRawText(stringifyJson(node.config ?? {}));
                setValidationErrors({});
                setRawError(null);
              }}
            >
              撤销修改
            </button>
          </div>
        </PageCard>
      ) : null}

      {readPath(config, 'collection') ? (
        <p className={styles.cellHint}>
          提示：该节点会读写数据表「{String(readPath(config, 'collection'))}」。配置里引用变量时请确认前序节点已经产出对应字段。
        </p>
      ) : null}

      {notice ? <p className={styles.successText}>{notice}</p> : null}
      {mutation.message ? <p className={styles.errorText}>{mutation.message}</p> : null}
    </div>
  );
}
