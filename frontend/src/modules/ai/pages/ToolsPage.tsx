import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { displayTitle } from '../../access/display';
import { readAction } from '../read-action';
import { listSkills, listTools, listUsableEmployees, resourceMessageOf, resourceStateOf } from '../resources';
import type { AiSkillRow, AiToolRow } from '../types';
import { Field, Notice, Select, StateBlock, TextInput } from '../ui';
import styles from '../group-a.module.css';

/**
 * AI-05（一）工具与技能。
 *
 * 契约已闭环（十页契约附录 A2），按**完整实现**：
 *  - `aiTools:list` / `aiSkills:list` 是**注册表列表**，返回数组、没有分页 meta
 *    （源码 `server/resource/aiTools.ts`），因此这里是客户端筛选，不假装有服务端分页；
 *  - 员工绑定用后端真实的 `aiTools:listBinding` / `aiSkills:listBinding`（`?username=`），
 *    不使用前端猜测；
 *  - 绑定关系的修改在「员工配置」页保存（`aiEmployees.skillSettings`），本页负责查看与跳转。
 */

const INITIAL_VISIBLE = 60;

export function ToolsPage() {
  const [keyword, setKeyword] = useState('');
  const [scope, setScope] = useState('');
  const [bindingUsername, setBindingUsername] = useState('');
  const [visible, setVisible] = useState(INITIAL_VISIBLE);

  const tools = useQuery({
    queryKey: ['ai', 'tools', 'list'],
    queryFn: () => listTools(),
    staleTime: 60_000,
  });

  const skills = useQuery({
    queryKey: ['ai', 'skills', 'list'],
    queryFn: () => listSkills(),
    staleTime: 60_000,
  });

  const employees = useQuery({
    queryKey: ['ai', 'employees', 'listByUser', 'for-binding'],
    queryFn: () => listUsableEmployees({ pageSize: 100 }),
    staleTime: 60_000,
  });

  const toolRows = tools.data?.rows ?? [];
  const skillRows = skills.data?.rows ?? [];

  const filteredTools = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    return toolRows.filter((tool) => {
      if (scope && String(tool.scope ?? '') !== scope) return false;
      if (text.length === 0) return true;
      const name = tool.definition?.name ?? '';
      const title = tool.introduction?.title ?? '';
      const description = tool.definition?.description ?? tool.introduction?.about ?? '';
      return `${name} ${title} ${description}`.toLowerCase().includes(text);
    });
  }, [toolRows, keyword, scope]);

  const filteredSkills = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (text.length === 0) return skillRows;
    return skillRows.filter((skill) =>
      `${skill.name} ${skill.title ?? ''} ${skill.description ?? ''}`.toLowerCase().includes(text),
    );
  }, [skillRows, keyword]);

  return (
    <div className={styles.stack}>
      <PageHeader
        title="工具与技能"
        description="查看当前可用的工具与技能清单，并确认每位员工实际绑定到哪些能力。绑定关系在员工配置里维护。"
      />

      <PageCard title="筛选">
        <div className={styles.fieldRow}>
          <Field label="关键词">
            <TextInput
              value={keyword}
              onChange={(next) => {
                setKeyword(next);
                setVisible(INITIAL_VISIBLE);
              }}
              placeholder="按名称或说明搜索"
            />
          </Field>
          <Field label="作用范围">
            <Select
              value={scope}
              onChange={(next) => {
                setScope(next);
                setVisible(INITIAL_VISIBLE);
              }}
              options={[
                { value: 'GENERAL', label: '通用（所有员工）' },
                { value: 'SPECIFIED', label: '指定（绑定后可用）' },
                { value: 'CUSTOM', label: '自定义' },
              ]}
              placeholder="全部范围"
            />
          </Field>
          <Field label="查看员工绑定">
            <Select
              value={bindingUsername}
              onChange={setBindingUsername}
              options={(employees.data?.rows ?? []).map((row) => ({
                value: row.username,
                label: row.nickname ? `${row.nickname}（${row.username}）` : row.username,
              }))}
              placeholder="不查看，仅浏览清单"
            />
          </Field>
        </div>
      </PageCard>

      {bindingUsername ? <BindingPanel username={bindingUsername} /> : null}

      <PageCard
        title="工具清单"
        description="按名称、说明或作用范围筛选，查看每个工具的用途与执行方式。"
      >
        <StateBlock
          state={tools.isLoading ? 'loading' : resourceStateOf(tools.error, toolRows.length === 0)}
          message={resourceMessageOf(tools.error)}
          onRetry={() => void tools.refetch()}
          emptyTitle="当前没有可用的工具"
          deniedDescription="你的角色没有查看工具清单的权限（需要登录并具备 AI 工具读取权限）。"
        />
        <p className={styles.rowHint}>
          共 {toolRows.length} 个工具，当前筛选出 {filteredTools.length} 个。
        </p>
        {filteredTools.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>工具</th>
                  <th>标识</th>
                  <th>范围</th>
                  <th>来源</th>
                  <th>执行位置</th>
                  <th>默认确认</th>
                </tr>
              </thead>
              <tbody>
                {filteredTools.slice(0, visible).map((tool) => (
                  <tr key={tool.definition?.name ?? String(tool.introduction?.title ?? '')}>
                    <td>{tool.introduction?.title || tool.definition?.name || '未命名工具'}</td>
                    <td>
                      <span className={styles.mono}>{tool.definition?.name ?? '—'}</span>
                    </td>
                    <td>{scopeLabel(tool.scope)}</td>
                    <td>{fromLabel(tool.from)}</td>
                    <td>{tool.execution === 'frontend' ? '浏览器内执行' : '服务端执行'}</td>
                    <td>{tool.defaultPermission === 'ALLOW' ? '自动执行' : '需要确认'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {filteredTools.length > visible ? (
          <div className={styles.toolbar} style={{ marginTop: 12, marginBottom: 0 }}>
            <button type="button" className={styles.button} onClick={() => setVisible(visible + 100)}>
              显示更多（还有 {filteredTools.length - visible} 个）
            </button>
          </div>
        ) : null}
      </PageCard>

      <PageCard
        title="技能清单"
        description="技能是预置的一组工具与提示；这里展示名称与说明。"
      >
        <StateBlock
          state={skills.isLoading ? 'loading' : resourceStateOf(skills.error, skillRows.length === 0)}
          message={resourceMessageOf(skills.error)}
          onRetry={() => void skills.refetch()}
          emptyTitle="当前没有可用的技能"
          deniedDescription="你的角色没有查看技能清单的权限。"
        />
        {filteredSkills.length > 0 ? (
          <div className={styles.rowList}>
            {filteredSkills.map((skill: AiSkillRow) => (
              <div key={skill.name} className={styles.rowCard}>
                <div className={styles.rowMain}>
                  <div className={styles.chipRow}>
                    <span className={styles.rowTitle}>{displayTitle(skill.title, skill.name)}</span>
                    <StatusPill tone="neutral">{scopeLabel(skill.scope)}</StatusPill>
                  </div>
                  <span className={styles.rowHint}>{skill.description || '没有说明'}</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </PageCard>
    </div>
  );
}

function BindingPanel({ username }: { username: string }) {
  const tools = useQuery({
    queryKey: ['ai', 'tools', 'listBinding', username],
    queryFn: async () => {
      const result = await readAction<AiToolRow[]>('aiTools', 'listBinding', { username });
      return Array.isArray(result.data) ? result.data : [];
    },
    staleTime: 30_000,
  });
  const skills = useQuery({
    queryKey: ['ai', 'skills', 'listBinding', username],
    queryFn: async () => {
      const result = await readAction<AiSkillRow[]>('aiSkills', 'listBinding', { username });
      return Array.isArray(result.data) ? result.data : [];
    },
    staleTime: 30_000,
  });

  const bindingRows = tools.data ?? [];
  const state = tools.isLoading ? 'loading' : resourceStateOf(tools.error, bindingRows.length === 0);

  return (
    <PageCard
      title={`员工绑定：${username}`}
      description="通用能力与这位员工单独绑定的能力。"
      actions={
        <Link className={styles.button} to={`/ai/employees-config/${encodeURIComponent(username)}`}>
          去员工配置修改
        </Link>
      }
    >
      <StateBlock
        state={state}
        message={resourceMessageOf(tools.error)}
        onRetry={() => void tools.refetch()}
        emptyTitle="这位员工当前没有可用工具"
        emptyDescription="通用工具与绑定工具都为空。"
      />
      {bindingRows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>工具</th>
                <th>标识</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {bindingRows.map((tool) => (
                <tr key={String(tool.name ?? tool.definition?.name ?? '')}>
                  <td>{String(tool.title ?? tool.name ?? '—')}</td>
                  <td>
                    <span className={styles.mono}>{String(tool.name ?? '—')}</span>
                  </td>
                  <td>{String(tool.description ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {skills.error ? <Notice tone="warn">技能绑定读取失败：{resourceMessageOf(skills.error)}</Notice> : null}
      {skills.data && skills.data.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <span className={styles.fieldLabel}>可用技能</span>
          <div className={styles.chipRow} style={{ marginTop: 6 }}>
            {skills.data.map((skill) => (
              <span key={String(skill.name)} className={styles.chip}>
                {displayTitle(typeof skill.title === 'string' ? skill.title : null, String(skill.name))}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </PageCard>
  );
}

function scopeLabel(scope: unknown): string {
  switch (scope) {
    case 'GENERAL':
      return '通用';
    case 'SPECIFIED':
      return '指定';
    case 'CUSTOM':
      return '自定义';
    default:
      return '未标注';
  }
}

function fromLabel(from: unknown): string {
  switch (from) {
    case 'loader':
      return '内置加载';
    case 'workflow':
      return '工作流';
    case 'mcp':
      return 'MCP 连接';
    default:
      return '未标注';
  }
}
