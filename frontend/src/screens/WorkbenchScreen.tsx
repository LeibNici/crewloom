import { useQuery } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useSessionStore } from '../auth/store';
import { useActiveRoleTitle } from '../auth/useRoleTitle';
import {
  fetchMyConversations,
  fetchMyEmployees,
  fetchMyPendingTaskStats,
  fetchMyTaskTypeStats,
  type AiEmployeeSummary,
  type ConversationSummary,
  type TaskTypeStats,
  type WorkflowTaskStatsRow,
} from '../api/workbench';
import { toUserMessage } from '../api/errors';
import { languageLabel, useSystemSettings } from '../api/systemSettings';
import { PageCard, PageHeader, StatTile } from '../components/Card';
import { hasUnknownProbe } from '../permissions/probes';
import {
  fetchCcTasks,
  fetchManualTasks,
  type CcTaskRow,
  type ManualTaskRow,
} from '../modules/tasks/domain';
import {
  filterVisibleModules,
  listDeniedModules,
  resolveModuleVisibility,
  resolveRouteTarget,
  MODULE_BY_ID,
} from '../permissions/modules';
import styles from './screens.module.css';

// 注意：模块注册表存在"注册表 → 模块文件 → 本组件 → permissions/modules → 注册表"的
// 单向再导出链，因此**模块顶层不能读取注册表的导出值**（会命中 TDZ）。页面列表在
// 组件体内读取，见下方 `boards`。
interface WorkbenchScreenProps {
  boardPath?: string;
}

/**
 * 工作台。
 *
 * P1 只呈现真实可核对的信息：当前账号、当前角色、可进入模块，以及后端真实返回的
 * 待处理任务、会话与员工数据。不编造业务指标，也不把流程标题当作任务标题。
 */
export function WorkbenchScreen({ boardPath }: WorkbenchScreenProps) {
  const user = useSessionStore((state) => state.user);
  const access = useSessionStore((state) => state.access);
  const roles = useSessionStore((state) => state.roles);
  const activeRole = useSessionStore((state) => state.activeRole);
  const probes = useSessionStore((state) => state.probes);
  const accessState = useSessionStore((state) => state.accessState);
  const settings = useSystemSettings();

  const board = boardPath
    ? MODULE_BY_ID.workbench.boards.find((item) => item.path === boardPath)
    : undefined;
  const showOverview = !board || board.path === 'overview';
  const showTasks = showOverview || board?.path === 'my-tasks';

  const pendingStats = useQuery({
    queryKey: ['workbench', 'pendingTaskStats'],
    queryFn: fetchMyPendingTaskStats,
    enabled: showTasks,
  });
  const taskTypes = useQuery({
    queryKey: ['workbench', 'taskTypes'],
    queryFn: fetchMyTaskTypeStats,
    enabled: showTasks,
  });
  const conversations = useQuery({
    queryKey: ['workbench', 'conversations'],
    queryFn: fetchMyConversations,
    enabled: showOverview || board?.path === 'recent-sessions',
  });
  const employees = useQuery({
    queryKey: ['workbench', 'employees'],
    queryFn: fetchMyEmployees,
    enabled: showOverview || board?.path === 'available-employees',
  });
  /**
   * 工作台要给出**可点击的待办详情入口**：统计口径只能看到"有多少条"，
   * 因此这里直接读取真实的待办列表（人工待办 / 抄送），点进去就是各模块自己的详情页。
   * 与「任务与待办」模块同一批只读接口，不新建聚合端点、不造假行。
   */
  const manualTasks = useQuery({
    queryKey: ['workbench', 'manualTasks'],
    queryFn: () => fetchManualTasks({ page: 1, pageSize: 5, appends: ['node', 'workflow'] }),
    enabled: showTasks,
  });
  const ccTasks = useQuery({
    queryKey: ['workbench', 'ccTasks'],
    queryFn: () => fetchCcTasks({ page: 1, pageSize: 5 }),
    enabled: showTasks,
  });

  const visibleModules = useMemo(
    () => filterVisibleModules(resolveModuleVisibility(access, probes)),
    [access, probes],
  );
  const deniedModules = useMemo(() => listDeniedModules(access, probes), [access, probes]);
  const permissionUnknown = accessState === 'unknown' || hasUnknownProbe(probes);
  const probesReady = probes !== null && accessState === 'ready';

  // 角色名称只展示后端给用户看的中文标题；读不到时统一显示"当前角色"，不展示内部标识。
  const effectiveRole = activeRole ?? access?.role ?? null;
  const roleTitle = useActiveRoleTitle(effectiveRole, roles);

  const displayName = user?.nickname || user?.username || user?.email || '当前账号';

  return (
    <div className={styles.stack}>
      <PageHeader
        title={board ? board.title : '概览'}
        description={
          board
            ? board.description
            : '这里汇总当前账号的状态：可使用的模块、待处理任务、最近会话与可用员工。'
        }
      />

      {showOverview ? (
        <>
          <PageCard title="当前账号">
            <div className={styles.statGrid}>
              <StatTile label="登录账号" value={displayName} hint={user?.email ?? undefined} />
              <StatTile
                label="当前角色"
                value={roleTitle ?? '当前角色'}
                hint={roleTitle ? undefined : '角色名称暂不可读，不影响已授权的功能'}
              />
              <StatTile
                label="可使用的模块"
                value={permissionUnknown ? '—' : probesReady ? String(visibleModules.length) : '…'}
                hint={
                  permissionUnknown
                    ? '暂时无法确认，可重试'
                    : probesReady
                      ? '已确认可以进入'
                      : '正在确认'
                }
              />
              <StatTile
                label="后台应用"
                value={
                  settings.isLoading
                    ? '…'
                    : settings.isError
                      ? '—'
                      : settings.data?.title ?? '未设置'
                }
                hint={
                  settings.isError
                    ? '暂时无法读取后台信息'
                    : backendHint(settings.data?.appLang, settings.data?.enabledLanguages)
                }
              />
            </div>
          </PageCard>

          <PageCard title="可使用的模块" description="下面这些模块当前角色可以使用，点击即可进入。">
            <div className={styles.boardList}>
              {visibleModules.map((module) => (
                <div key={module.id} className={styles.boardRow}>
                  <div className={styles.boardRowText}>
                    <span className={styles.boardRowTitle}>{module.title}</span>
                    <span className={styles.boardRowDescription}>{module.subtitle}</span>
                  </div>
                  <Link className={styles.secondaryButton} to={module.path}>
                    进入
                  </Link>
                </div>
              ))}
              {visibleModules.length === 0 ? (
                <p className={styles.listItemHint}>
                  {permissionUnknown
                    ? '暂时无法确认当前角色可用的模块，请稍后重试。'
                    : probesReady
                      ? '当前角色还没有可使用的模块。'
                      : '正在确认中…'}
                </p>
              ) : null}
            </div>
            {probesReady && deniedModules.length > 0 ? (
              <p className={styles.listItemHint} style={{ marginTop: 10 }}>
                其余模块需要另外授权，请联系管理员，或切换到其他角色后再试。
              </p>
            ) : null}
          </PageCard>
        </>
      ) : null}

      {showTasks ? (
        <PageCard
          title="本人工作流待处理任务"
          description="只统计属于当前账号的工作流待处理任务，按流程汇总。"
          actions={
            <>
              <CrossLink to="/tasks/pending" fallback="待办入口暂时无法打开，请从左侧导航进入「任务与待办」">
                前往我的待办
              </CrossLink>
              <CrossLink to="/tasks/cc-list" fallback="抄送入口暂时无法打开，请从左侧导航进入「任务与待办」">
                查看抄送
              </CrossLink>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => {
                  void pendingStats.refetch();
                  void taskTypes.refetch();
                  void manualTasks.refetch();
                  void ccTasks.refetch();
                }}
              >
                刷新
              </button>
            </>
          }
        >
          <div className={styles.statGrid}>
            <StatTile
              label="待处理任务"
              value={renderCount(pendingStats.data?.pendingTotal, pendingStats.isLoading, pendingStats.error)}
              hint={pendingStats.data?.scopeLabel ?? '本人工作流待处理（人工待办与抄送）'}
            />
            <StatTile
              label="涉及流程"
              value={renderCount(pendingStats.data?.workflowCount, pendingStats.isLoading, pendingStats.error)}
              hint={
                // 读取失败时不展示上一次成功读取的累计数字，避免把旧汇总当成当前结果。
                // 成功时只表达业务含义（累计任务数），不暴露分页/页数这类实现细节。
                pendingStats.error
                  ? undefined
                  : pendingStats.data
                    ? `累计 ${pendingStats.data.allTotal} 条工作流任务（含已处理）`
                    : '按流程汇总'
              }
            />
          </div>
          {pendingStats.error ? (
            <p className={styles.inlineNote}>暂时无法读取全部待处理任务，请刷新重试。</p>
          ) : null}
          <WorkflowStatsList
            loading={pendingStats.isLoading}
            error={pendingStats.error}
            rows={pendingStats.data?.rows ?? []}
          />
          <TaskTypeStatsBlock
            loading={taskTypes.isLoading}
            error={taskTypes.error}
            data={taskTypes.data}
          />
          <PendingEntryList
            loading={manualTasks.isLoading || ccTasks.isLoading}
            manualError={manualTasks.error}
            ccError={ccTasks.error}
            manual={manualTasks.data?.rows ?? []}
            cc={ccTasks.data?.rows ?? []}
          />
          <p className={styles.listItemHint} style={{ marginTop: 10 }}>
            这里只做只读汇总；待办的处理表单、领取与审核在「任务与待办」模块中完成。
          </p>
        </PageCard>
      ) : null}

      {(showOverview || board?.path === 'recent-sessions') && (
        <PageCard
          title="最近会话"
          description="只显示属于当前账号的会话。"
          actions={
            <CrossLink to="/ai/conversations" fallback="会话入口暂时无法打开，请从左侧导航进入「数字员工」">
              打开会话工作区
            </CrossLink>
          }
        >
          <ConversationList
            loading={conversations.isLoading}
            error={conversations.error}
            items={(conversations.data?.items ?? []) as ConversationSummary[]}
          />
          <p className={styles.listItemHint} style={{ marginTop: 10 }}>
            会话的完整内容、逐步输出与工具确认在「数字员工 → 会话工作区」中处理。
          </p>
        </PageCard>
      )}

      {(showOverview || board?.path === 'available-employees') && (
        <PageCard
          title="可用员工"
          description="当前角色可以使用的数字员工。"
          actions={
            <CrossLink to="/ai/directory" fallback="员工目录暂时无法打开，请从左侧导航进入「数字员工」">
              打开员工目录
            </CrossLink>
          }
        >
          <EmployeeList
            loading={employees.isLoading}
            error={employees.error}
            items={(employees.data?.items ?? []) as AiEmployeeSummary[]}
          />
          <p className={styles.listItemHint} style={{ marginTop: 10 }}>
            开启会话、查看与维护员工资料在「数字员工」模块中进行。
          </p>
        </PageCard>
      )}
    </div>
  );
}

/** 后台语言信息的一行说明；两个字段都没有时给中性提示。 */
function backendHint(
  appLang: string | null | undefined,
  enabledLanguages: string[] | undefined,
): string | undefined {
  const current = languageLabel(appLang);
  const available = (enabledLanguages ?? []).map((code) => languageLabel(code) ?? code);
  if (current && available.length > 0) return `默认 ${current}　可用 ${available.join('、')}`;
  if (current) return `默认 ${current}`;
  if (available.length > 0) return `可用 ${available.join('、')}`;
  return '后台未声明语言信息';
}

/**
 * 跨模块入口。
 *
 * 工作台要给出"去对应模块继续操作"的入口，但目标详情页由各组实现。
 * 这里先查注册表：目标页面存在才渲染链接，否则显示为尚未开放的说明，
 * 避免用户点进一条还不存在的路由。
 */
function CrossLink({ to, children, fallback }: { to: string; children: ReactNode; fallback: string }) {
  const target = resolveRouteTarget(to);
  if (!target?.board) return <span className={styles.entryMuted}>{fallback}</span>;
  return (
    <Link className={styles.entryLink} to={to}>
      {children}
    </Link>
  );
}

function renderCount(count: number | null | undefined, loading: boolean, error: unknown): string {
  if (loading) return '…';
  if (error) return '—';
  if (typeof count === 'number') return String(count);
  return '—';
}

function errorHint(error: unknown): string | null {
  if (!error) return null;
  return toUserMessage(error);
}

/** 任务的已知类型到中文名称；未知类型不展示内部标识。 */
export function taskTypeLabel(type: string | null | undefined): string {
  switch (type) {
    case 'manual':
      return '人工待办';
    case 'cc':
      return '抄送';
    default:
      return '其他待办类型';
  }
}

/**
 * 任务类型 → 对应列表页（注册表里的真实路径）。
 *
 * 未知类型没有对应入口，界面不给出可能 404 的链接。
 */
export function taskTypeHref(type: string | null | undefined): string | null {
  switch (type) {
    case 'manual':
      return '/tasks/pending';
    case 'cc':
      return '/tasks/cc-list';
    default:
      return null;
  }
}

/** 最近待办：真实列表的少量行 + 直达详情页的入口。 */
function PendingEntryList({
  manual,
  cc,
  loading,
  manualError,
  ccError,
}: {
  manual: ManualTaskRow[];
  cc: CcTaskRow[];
  loading: boolean;
  manualError: unknown;
  ccError: unknown;
}) {
  const hints = [errorHint(manualError), errorHint(ccError)].filter((item): item is string => Boolean(item));
  return (
    <div style={{ marginTop: 12 }}>
      <span className={styles.listItemTitle}>最近待办</span>
      {hints.length > 0 ? <p className={styles.inlineNote}>{hints.join('；')}</p> : null}
      {hints.length === 0 && loading ? <div className={styles.skeleton} style={{ marginTop: 8 }} /> : null}
      {hints.length === 0 && !loading ? (
        manual.length === 0 && cc.length === 0 ? (
          <p className={styles.listItemHint} style={{ marginTop: 8 }}>
            当前没有可处理的待办或抄送，因此没有可展开的详情入口。
          </p>
        ) : (
          <div className={styles.list} style={{ marginTop: 8 }}>
            {manual.map((row) => (
              <div key={`manual-${row.id}`} className={styles.listItem}>
                <div className={styles.listItemMain}>
                  <span className={styles.listItemTitle}>{row.nodeTitle ?? '人工处理节点'}</span>
                  <span className={styles.listItemHint}>
                    {taskTypeLabel('manual')}　{row.workflowTitle ?? '流程已不存在'}
                  </span>
                </div>
                <CrossLink
                  to={`/tasks/manual?id=${encodeURIComponent(row.id)}`}
                  fallback="该处理入口暂时无法打开，请从「任务与待办」进入"
                >
                  去处理
                </CrossLink>
              </div>
            ))}
            {cc.map((row) => (
              <div key={`cc-${row.id}`} className={styles.listItem}>
                <div className={styles.listItemMain}>
                  <span className={styles.listItemTitle}>{row.nodeTitle ?? '抄送消息'}</span>
                  <span className={styles.listItemHint}>
                    {taskTypeLabel('cc')}　{row.workflowTitle ?? '流程已不存在'}
                  </span>
                </div>
                <CrossLink
                  to={`/tasks/cc?id=${encodeURIComponent(row.id)}`}
                  fallback="该抄送入口暂时无法打开，请从「任务与待办」进入"
                >
                  查看
                </CrossLink>
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function WorkflowStatsList({
  rows,
  loading,
  error,
}: {
  rows: WorkflowTaskStatsRow[];
  loading: boolean;
  error: unknown;
}) {
  if (error) return null;
  if (loading) return <div className={styles.skeleton} style={{ marginTop: 12 }} />;
  if (rows.length === 0) {
    return (
      <p className={styles.listItemHint} style={{ marginTop: 10 }}>
        当前没有待处理任务。
      </p>
    );
  }
  return (
    <div className={styles.list} style={{ marginTop: 8 }}>
      {rows.map((row) => (
        <div key={row.workflowKey} className={styles.listItem}>
          <div className={styles.listItemMain}>
            <span className={styles.listItemTitle}>{row.title ?? '未命名流程'}</span>
            <span className={styles.listItemHint}>
              待处理 {Number(row.stats?.pending) || 0}　累计 {Number(row.stats?.all) || 0}
            </span>
          </div>
        </div>
      ))}
      <p className={styles.listItemHint} style={{ marginTop: 8 }}>
        以上名称是该流程的标题，不是单条任务的标题。
      </p>
    </div>
  );
}

function TaskTypeStatsBlock({
  data,
  loading,
  error,
}: {
  data: TaskTypeStats | undefined;
  loading: boolean;
  error: unknown;
}) {
  const hint = errorHint(error);
  if (hint) {
    return (
      <p className={styles.listItemHint} style={{ marginTop: 10 }}>
        按类型的汇总暂时无法加载：{hint}
      </p>
    );
  }
  if (loading) return <div className={styles.skeleton} style={{ marginTop: 12 }} />;
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <p className={styles.listItemHint} style={{ marginTop: 10 }}>
        当前没有按类型汇总的待处理任务。
      </p>
    );
  }
  return (
    <div className={styles.list} style={{ marginTop: 8 }}>
      {rows.map((row) => {
        const href = taskTypeHref(row.type);
        return (
          <div key={String(row.id)} className={styles.listItem}>
            <div className={styles.listItemMain}>
              <span className={styles.listItemTitle}>{taskTypeLabel(row.type)}</span>
              <span className={styles.listItemHint}>
                待处理 {Number(row.stats?.pending) || 0}　累计 {Number(row.stats?.all) || 0}
              </span>
            </div>
            {href ? (
              <CrossLink to={href} fallback="该入口暂时无法打开，请从左侧导航进入「任务与待办」">
                查看列表
              </CrossLink>
            ) : null}
          </div>
        );
      })}
      <p className={styles.listItemHint} style={{ marginTop: 8 }}>
        按任务类型汇总（人工待办 / 抄送），不包含其它来源的待办。
      </p>
    </div>
  );
}

function ConversationList({
  items,
  loading,
  error,
}: {
  items: ConversationSummary[];
  loading: boolean;
  error: unknown;
}) {
  const hint = errorHint(error);
  if (hint) return <p className={styles.inlineNote}>{hint}</p>;
  if (loading) return <div className={styles.skeleton} style={{ marginTop: 12 }} />;
  if (items.length === 0) {
    return (
      <p className={styles.listItemHint} style={{ marginTop: 10 }}>
        当前还没有会话。
      </p>
    );
  }
  return (
    <div className={styles.list} style={{ marginTop: 4 }}>
      {items.map((item) => (
        <div key={item.sessionId} className={styles.listItem}>
          <div className={styles.listItemMain}>
            <span className={styles.listItemTitle}>{item.title ?? '未命名会话'}</span>
            <span className={styles.listItemHint}>
              更新时间：{formatDateTime(item.updatedAt)}
              {item.aiEmployeeUsername ? `　员工：${item.aiEmployeeUsername}` : ''}
            </span>
          </div>
          <CrossLink
            to={`/ai/conversations/${encodeURIComponent(item.sessionId)}`}
            fallback="该会话暂时无法打开，请从「数字员工 → 会话工作区」进入"
          >
            打开会话
          </CrossLink>
        </div>
      ))}
    </div>
  );
}

/** 时间只做可读化；解析不了就显示"未知"，不显示原始时间串格式错误。 */
function formatDateTime(value: string | null | undefined): string {
  if (!value) return '未知';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '未知';
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

function EmployeeList({
  items,
  loading,
  error,
}: {
  items: AiEmployeeSummary[];
  loading: boolean;
  error: unknown;
}) {
  const hint = errorHint(error);
  if (hint) return <p className={styles.inlineNote}>{hint}</p>;
  if (loading) return <div className={styles.skeleton} style={{ marginTop: 12 }} />;
  if (items.length === 0) {
    return (
      <p className={styles.listItemHint} style={{ marginTop: 10 }}>
        当前角色没有可使用的员工。
      </p>
    );
  }
  return (
    <div className={styles.list} style={{ marginTop: 4 }}>
      {items.map((item) => (
        <div key={String(item.username ?? item.id)} className={styles.listItem}>
          <div className={styles.listItemMain}>
            <span className={styles.listItemTitle}>{item.nickname ?? item.username ?? '未命名员工'}</span>
            <span className={styles.listItemHint}>{item.position ?? '未设置岗位'}</span>
          </div>
          {item.username ? (
            <CrossLink
              to={`/ai/directory/${encodeURIComponent(item.username)}`}
              fallback="该员工暂时无法打开，请从「数字员工 → 员工目录」进入"
            >
              查看员工
            </CrossLink>
          ) : null}
        </div>
      ))}
    </div>
  );
}
