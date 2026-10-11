import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { useSessionStore } from '../../../auth/store';
import { isResourceActionAllowed } from '../../../permissions/model';
import { PageCard, PageHeader, StatTile, StatusPill } from '../../../components/Card';
import { CrewloomError } from '../../../api/errors';
import {
  getEmployee,
  listEmployees,
  listSkills,
  listUsableEmployees,
  resourceMessageOf,
  resourceStateOf,
  updateEmployee,
} from '../resources';
import type { AiEmployeeRow } from '../types';
import { ListPager, Notice, Select, StateBlock, formatTime, orDash } from '../ui';
import { resolveAllowedModels } from '../resources';
import { displayTitle } from '../../access/display';
import { renderEmployeeAvatar } from './employeeAvatars';
import styles from '../group-a.module.css';

/**
 * AI-01 员工目录。
 *
 * 顶部有两个**互相独立**的控件，不要混为一谈：
 *  - **查看范围**（两个页签，沿用既有）：「我可以使用的员工」/「全部员工（可管理）」，
 *    决定查哪个接口、看谁的员工；
 *  - **启用状态**（参考图的「全部状态」下拉，三态 全部/已启用/已停用）：在选定的查看范围内
 *    按记录里已有的 `enabled` 字段筛选。
 *
 * 两条列表严格分开（报告 01 §2）：
 *  - **可使用**：`aiEmployees:listByUser`（仅需登录，按 `rolesAiEmployees` 过滤、`enabled=true`）；
 *  - **可管理**：`aiEmployees:list`（需要员工管理权限，包含已停用的员工）。
 * 因此"能使用"不等于"能编辑"，界面用不同的标记与不同的列表回答这两个问题。
 *
 * 两个来源的**分页与筛选能力不同**，界面据实处理（13000 只读实测）：
 *  - `aiEmployees:list` 是标准集合 list 动作：`page` / `pageSize` / `filter` / `sort` 都由后端生效，
 *    状态与关键词因此**合并进同一次请求**（后端 `$and`），总数与分页是整张表的真实结果；
 *  - `aiEmployees:listByUser` 是**自定义动作**：服务端 `findAll` 后整体返回，**忽略 page/pageSize/filter**
 *    （源码 `plugin-ai/src/server/resource/aiEmployees.ts` 的 `listByUser` 只按 enabled + rolesAiEmployees 过滤）。
 *    因此「可使用」页签一次取回全部，关键词与状态用**本地过滤**完成（仍在该角色真实可用的集合内，
 *    不会去请求未授权员工），并且不显示会骗人的分页控件；界面上只说"已一次性全部列出、因此没有分页"。
 */

const PAGE_SIZE = 12;
/** `listByUser` 是自定义动作、忽略分页参数；这里按后端能力一次取回（上限放宽以避免截断）。 */
const USABLE_FETCH_SIZE = 200;

/**
 * 「可使用」列表的本地关键词过滤（后端 `listByUser` 不支持 filter）。
 *
 * 与后端 `$includes` 的语义保持一致：用户名 / 昵称 / 岗位任一包含关键词即命中，
 * 大小写不敏感；关键词为空时原样返回。
 */
export function filterEmployeesByKeyword(rows: AiEmployeeRow[], keyword: string): AiEmployeeRow[] {
  const trimmed = keyword.trim().toLowerCase();
  if (trimmed.length === 0) return rows;
  return rows.filter((row) =>
    `${row.username ?? ''} ${row.nickname ?? ''} ${row.position ?? ''}`.toLowerCase().includes(trimmed),
  );
}

/**
 * 顶部的启用状态筛选（参考图的「全部状态」下拉）。
 *
 * 只用记录里已有的 `enabled` 字段，三态与字面一致：
 *  - `all` 默认值，不加任何条件，既有行为不变；
 *  - `enabled` / `disabled` 分别是 `enabled !== false` / `enabled === false`。
 *
 * **不引入"在线"概念**：`enabled` 是后台保存的启停事实，不是运行状态；字段缺失按既有约定
 * 视为已启用（`listByUser` 只返回已启用员工），不推断在线与否。
 */
export type EmployeeStatusFilter = 'all' | 'enabled' | 'disabled';

export function matchesEmployeeStatus(row: AiEmployeeRow, status: EmployeeStatusFilter): boolean {
  if (status === 'all') return true;
  return status === 'enabled' ? row.enabled !== false : row.enabled === false;
}

/**
 * 「可使用」页签的本地筛选：关键词 + 状态，都只在**本次已经取回的可用集合内**完成。
 *
 * `listByUser` 已按角色授权范围（`rolesAiEmployees`）与 `enabled=true` 过滤，这里只做展示层的
 * 二次筛选，**不会**为了筛选去请求未授权员工、也不额外发请求；空集合也据实呈现。
 */
export function filterUsableEmployees(
  rows: AiEmployeeRow[],
  keyword: string,
  status: EmployeeStatusFilter,
): AiEmployeeRow[] {
  return filterEmployeesByKeyword(rows, keyword).filter((row) => matchesEmployeeStatus(row, status));
}

/** 状态筛选的中文名，仅用于空态文案，不参与请求。 */
function statusFilterLabel(status: EmployeeStatusFilter): string {
  return status === 'enabled' ? '已启用' : status === 'disabled' ? '已停用' : '全部状态';
}

export function EmployeeDirectoryPage() {
  const { username } = useParams<{ username?: string }>();
  const access = useSessionStore((state) => state.access);
  const canManage = isResourceActionAllowed(access, 'aiEmployees', 'update');
  const [scope, setScope] = useState<'usable' | 'manage'>('usable');
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<EmployeeStatusFilter>('all');
  const [page, setPage] = useState(1);

  /**
   * 「可管理」页签的查询条件：**把状态与名称/岗位搜索合并进同一次后端 list 请求**。
   *
   * 两段条件都落在后端（`$and`），因此 `meta.count` 与分页是后端在整张表上的真实结果，
   * 不会出现"只过滤当前页、其它页的匹配员工丢失"。默认状态为「全部状态」且关键词为空时
   * 返回 `undefined`，与改造前完全一致。
   */
  const filter = useMemo(() => {
    const trimmed = keyword.trim();
    const clauses: Array<Record<string, unknown>> = [];
    if (trimmed.length > 0) {
      clauses.push({
        $or: [
          { username: { $includes: trimmed } },
          { nickname: { $includes: trimmed } },
          { position: { $includes: trimmed } },
        ],
      });
    }
    if (status !== 'all') clauses.push({ enabled: status === 'enabled' });
    if (clauses.length === 0) return undefined;
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  }, [keyword, status]);

  // 「可使用」：自定义动作不支持分页/筛选，一次取回全部后本地过滤。
  const usable = useQuery({
    queryKey: ['ai', 'employees', 'listByUser'],
    queryFn: () => listUsableEmployees({ pageSize: USABLE_FETCH_SIZE, sort: ['-createdAt'] }),
    enabled: scope === 'usable',
  });

  // 「可管理」：标准集合 list 动作，筛选与分页都在后端生效。
  const managed = useQuery({
    queryKey: ['ai', 'employees', 'list', { page, filter }],
    queryFn: () => listEmployees({ page, pageSize: PAGE_SIZE, filter, sort: ['-createdAt'] }),
    enabled: scope === 'manage',
  });

  /**
   * 技能标识 → 可读标题：复用「技能中心」（AI-05）与「员工配置」（AI-02）的**同一份**注册表读取，
   * 以及项目既有的标题解析 `displayTitle`（官方中文资源 → 固定补充表 → 原文）。
   *
   * `skillSettings.skills` 存的是技能标识（如 `document-search`），注册表的同一行才有 `title`；
   * 因此这里**整页只读一次注册表**（`aiSkills:list` 是注册表列表、返回数组、无分页 meta），
   * 解析成标识→标题供所有卡片共用，**不是每张卡片各发一次请求（无 N+1）**；
   * 只用于展示，不回写 `skillSettings`，也不改动任何绑定数据。
   * 注册表里没有的标识（例如读取失败或用户自建）原样显示其标识/自带标题，不猜、不硬编码。
   */
  const skills = useQuery({
    queryKey: ['ai', 'skills', 'list'],
    queryFn: () => listSkills(),
    staleTime: 60_000,
    enabled: !username,
  });
  const skillTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of skills.data?.rows ?? []) {
      if (typeof row.name === 'string' && row.name !== '') map.set(row.name, displayTitle(row.title, row.name));
    }
    return map;
  }, [skills.data]);

  const active = scope === 'usable' ? usable : managed;
  const fetched = active.data?.rows ?? [];
  // 「可使用」只做本地二次筛选（仍在后端授权的可用集合内）；「可管理」的条件已在后端生效。
  const rows = scope === 'usable' ? filterUsableEmployees(fetched, keyword, status) : fetched;
  const state = active.isLoading ? 'loading' : resourceStateOf(active.error, rows.length === 0);
  /** 是否处于筛选态：只影响空态文案，不参与请求；默认「全部状态」+ 空关键词即未筛选。 */
  const statusFiltered = status !== 'all';

  /**
   * 真实数量：两个来源的口径不同，界面据实分开说。
   *  - 「可使用」的 `listByUser` 一次返回全部、**不带 meta.count**，因此报的是当前列出的行数；
   *  - 「可管理」是标准集合 list，`meta.count` 是后端在本次筛选下的真实总数。
   */
  const metaCount = (active.data?.meta as { count?: number } | undefined)?.count;
  const countLabel =
    scope === 'usable'
      ? `显示 ${rows.length} 位员工`
      : typeof metaCount === 'number'
        ? `共 ${metaCount} 位员工`
        : `本页 ${rows.length} 位员工`;

  const detail = useQuery({
    queryKey: ['ai', 'employees', 'get', username ?? ''],
    queryFn: () => getEmployee(username as string),
    enabled: Boolean(username),
  });

  if (username) {
    return (
      <EmployeeDetail
        username={username}
        employee={detail.data ?? null}
        loading={detail.isLoading}
        error={detail.error}
        canManage={canManage}
        onChanged={() => {
          void detail.refetch();
          void usable.refetch();
          void managed.refetch();
        }}
      />
    );
  }

  return (
    <div className={styles.stack}>
      <PageHeader
        title="员工目录"
        description="查看当前角色可以使用的数字员工；有管理权限时可以同时查看全部员工（含已停用）并调整启停。"
      />

      <PageCard title="员工列表" description="按名称或岗位筛选。「全部员工（可管理）」支持翻页；「我可以使用的员工」一次列出当前角色的全部可用员工。">
        <div className={styles.employeeToolbar}>
          <input
            className={`${styles.input} ${styles.employeeSearch}`}
            placeholder="按名称、岗位筛选"
            aria-label="按名称或岗位筛选员工"
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value);
              setPage(1);
            }}
          />
          <div className={styles.chipRow}>
            <button
              type="button"
              className={scope === 'usable' ? `${styles.chip} ${styles.chipActive}` : styles.chip}
              onClick={() => {
                setScope('usable');
                setPage(1);
              }}
            >
              我可以使用的员工
            </button>
            <button
              type="button"
              className={scope === 'manage' ? `${styles.chip} ${styles.chipActive}` : styles.chip}
              onClick={() => {
                setScope('manage');
                setPage(1);
              }}
            >
              全部员工（可管理）
            </button>
          </div>
          <Select
            inline
            value={status}
            onChange={(next) => {
              setStatus(next as EmployeeStatusFilter);
              setPage(1);
            }}
            ariaLabel="按启用状态筛选员工"
            testId="employee-status-filter"
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'enabled', label: '已启用' },
              { value: 'disabled', label: '已停用' },
            ]}
          />
          <span className={styles.employeeCount} data-testid="employee-count">
            {countLabel}
          </span>
          <button type="button" className={styles.button} onClick={() => void active.refetch()}>
            刷新
          </button>
        </div>

        {scope === 'manage' && !canManage ? (
          <Notice tone="warn">
            你的角色没有员工管理权限，「全部员工（可管理）」可能读不到；「我可以使用的员工」仍然可用。
          </Notice>
        ) : null}

        <StateBlock
          state={state}
          message={resourceMessageOf(active.error)}
          onRetry={() => void active.refetch()}
          emptyTitle={
            statusFiltered
              ? scope === 'usable'
                ? `可使用的员工里没有「${statusFilterLabel(status)}」的员工`
                : `没有「${statusFilterLabel(status)}」的员工`
              : scope === 'usable'
                ? '当前角色还没有可使用的员工'
                : '暂时没有员工记录'
          }
          emptyDescription={
            statusFiltered
              ? '可以换一个启用状态，或清空名称/岗位关键词后重试。'
              : scope === 'usable'
                ? '当前角色还没有被分配任何已启用的员工，可以联系管理员补充授权。'
                : '当前没有任何员工记录。'
          }
          deniedDescription="你的角色没有查看这部分员工列表的权限。"
        />
      </PageCard>

      {rows.length > 0 ? (
        <div className={styles.employeeGrid}>
          {rows.map((employee) => (
            <EmployeeCard
              key={employee.username}
              employee={employee}
              canManage={canManage}
              skillTitles={skillTitles}
            />
          ))}
        </div>
      ) : null}

      {scope === 'usable' ? (
        <p className={styles.rowHint}>
          当前角色可使用的员工共 {fetched.length} 位，已一次性全部列出，因此这里没有分页。
          名称/岗位与启用状态只在这次列出的可用集合内筛选。
          「全部员工（可管理）」页签支持翻页与后台筛选。
        </p>
      ) : (
        <ListPager
          meta={(active.data?.meta ?? {}) as { count?: number; hasNext?: boolean }}
          page={page}
          pageSize={PAGE_SIZE}
          isFetching={active.isFetching}
          onChange={setPage}
        />
      )}
    </div>
  );
}

/**
 * 员工卡片（AI-01 目录）。
 *
 * 卡片上的每一项都取自 `aiEmployees:listByUser` / `aiEmployees:list` **同一行返回的真实字段**，
 * 不额外发请求（没有每卡 N+1 的用量/模型查询）：
 *  - 头像：`avatar` 是头像标识字符串，走既有渲染链 `renderEmployeeAvatar`（与原生同一份预设）；
 *    没有标识时用同一套回退样式显示名称首字，不伪造图片；
 *  - 职责：`bio`（没有就不显示这一段，不用岗位或提示词顶替）；
 *  - 技能标签：`skillSettings.skills`（超出 3 个折叠为 `+N`）；标签文字用注册表同一行的
 *    `title` 经既有 `displayTitle` 解析后的可读标题（页面可见文字面向普通用户），注册表没有该标识时
 *    原样显示标识本身；标签数量与绑定数据仍以 `skillSettings.skills` 为准，不改写、不隐藏；
 *  - 底部摘要：`modelSettings` 经 `resolveAllowedModels` 得出的真实结论，以及同行的技能/工具条数。
 *
 * **不把 `enabled` 说成"在线"**：状态药丸只说后台保存的启停事实；`listByUser` 不返回
 * `enabled` 字段时按既有约定视为可用员工（该动作本身只返回已启用员工），不推断在线状态。
 */
function EmployeeCard({
  employee,
  canManage,
  skillTitles,
}: {
  employee: AiEmployeeRow;
  canManage: boolean;
  skillTitles: Map<string, string>;
}) {
  const avatar = useMemo(() => renderEmployeeAvatar(employee.avatar), [employee.avatar]);
  const rawSkills = employee.skillSettings?.skills;
  const skills = useMemo(
    () => (Array.isArray(rawSkills) ? rawSkills.filter((item): item is string => typeof item === 'string' && item.length > 0) : []),
    [rawSkills],
  );
  const toolCount = Array.isArray(employee.skillSettings?.tools) ? employee.skillSettings.tools.length : 0;
  const allowed = resolveAllowedModels(employee);
  const modelSummary = !allowed.enforced
    ? '由全局默认模型决定'
    : allowed.preferred
      ? `${allowed.preferred.model}（${allowed.preferred.llmService}）`
      : allowed.models.length > 0
        ? `${allowed.models.length} 个允许模型`
        : '专用模型允许集为空';
  const name = employee.nickname || employee.username;
  const responsibility = (employee.bio ?? '').trim();
  const visibleSkills = skills.slice(0, 3);
  const restSkills = skills.length - visibleSkills.length;

  return (
    <article className={styles.employeeCard} data-testid="employee-card">
      <div className={styles.employeeCardHead}>
        {avatar ? (
          <img className={styles.employeeAvatar} src={avatar} alt="" width={52} height={52} loading="lazy" />
        ) : (
          <span className={styles.employeeAvatarFallback} aria-hidden="true">
            {name.slice(0, 1)}
          </span>
        )}
        <div className={styles.employeeHeadMain}>
          <div className={styles.employeeNameRow}>
            <span className={styles.employeeName}>{name}</span>
            {employee.builtIn ? <StatusPill tone="neutral">内置员工</StatusPill> : null}
            {employee.enabled === false ? (
              <StatusPill tone="warn">已停用</StatusPill>
            ) : (
              <StatusPill tone="ok">已启用</StatusPill>
            )}
            {employee.deprecated ? <StatusPill tone="warn">已标记为过时</StatusPill> : null}
          </div>
          <span className={styles.employeePosition}>
            {employee.position || '未设置岗位'}　账号：{employee.username}
          </span>
        </div>
      </div>

      {responsibility ? <p className={styles.employeeResponsibility}>{responsibility}</p> : null}

      {visibleSkills.length > 0 ? (
        <div className={styles.employeeSkillRow}>
          {visibleSkills.map((skill) => (
            <span key={skill} className={styles.employeeSkillTag} data-testid="employee-skill-tag">
              {skillTitles.get(skill) ?? skill}
            </span>
          ))}
          {restSkills > 0 ? <span className={styles.employeeSkillMore}>+{restSkills}</span> : null}
        </div>
      ) : null}

      <div className={styles.employeeCardFoot}>
        <span className={styles.employeeModel} title={`模型：${modelSummary}`}>
          <span className={styles.employeeModelText}>{modelSummary}</span>
        </span>
        <span className={styles.employeeUsage}>
          技能 {skills.length} · 工具 {toolCount}
        </span>
      </div>

      <div className={styles.employeeActions}>
        <Link
          className={`${styles.button} ${styles.employeeAction}`}
          to={`/ai/directory/${encodeURIComponent(employee.username)}`}
        >
          查看详情
        </Link>
        <Link
          className={`${styles.button} ${styles.employeeAction} ${styles.employeeActionTest}`}
          to="/ai/conversations"
          title="进入会话工作区，与员工对话测试"
        >
          测试
        </Link>
        {canManage ? (
          <Link
            className={`${styles.button} ${styles.employeeAction}`}
            to={`/ai/employees-config/${encodeURIComponent(employee.username)}`}
          >
            编辑配置
          </Link>
        ) : null}
      </div>
    </article>
  );
}

function EmployeeDetail({
  username,
  employee,
  loading,
  error,
  canManage,
  onChanged,
}: {
  username: string;
  employee: AiEmployeeRow | null;
  loading: boolean;
  error: unknown;
  canManage: boolean;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const state = loading ? 'loading' : resourceStateOf(error, employee === null);
  const allowed = resolveAllowedModels(employee);

  const toggleEnabled = async (next: boolean) => {
    setPending(true);
    setToggleError(null);
    try {
      await updateEmployee(username, { enabled: next });
      onChanged();
    } catch (caught) {
      setToggleError(caught instanceof CrewloomError ? caught.userMessage : '保存失败，请稍后重试。');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.stack}>
      <PageHeader
        title={employee ? `员工详情：${employee.nickname || employee.username}` : '员工详情'}
        description="只显示这位员工记录里实际存在的资料；没有值的项目显示为「—」，不推断也不补默认值。"
        actions={
          <button type="button" className={styles.button} onClick={() => navigate('/ai/directory')}>
            返回目录
          </button>
        }
      />

      <StateBlock
        state={state}
        message={resourceMessageOf(error)}
        onRetry={onChanged}
        deniedDescription="你的角色没有查看这位员工资料的权限。"
      />

      {employee ? (
        <>
          <PageCard title="基本资料">
            <div className={styles.twoColumn} style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
              <div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>员工账号</span>
                  <span className={styles.mono}>{employee.username}</span>
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>显示名称</span>
                  <span>{orDash(employee.nickname)}</span>
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>岗位</span>
                  <span>{orDash(employee.position)}</span>
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>分类</span>
                  <span>{employee.category === 'developer' ? '开发者员工' : employee.category === 'business' ? '业务员工' : orDash(employee.category)}</span>
                </div>
              </div>
              <div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>状态</span>
                  <span>
                    {employee.enabled === false ? <StatusPill tone="warn">已停用</StatusPill> : <StatusPill tone="ok">已启用</StatusPill>}
                    {employee.builtIn ? <StatusPill tone="neutral">内置员工</StatusPill> : null}
                  </span>
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>创建 / 更新时间</span>
                  <span>
                    {formatTime(employee.createdAt)} / {formatTime(employee.updatedAt)}
                  </span>
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>介绍</span>
                  <span>{orDash(employee.bio)}</span>
                </div>
              </div>
            </div>

            {canManage ? (
              <div className={styles.toolbar} style={{ marginTop: 8, marginBottom: 0 }}>
                <span className={styles.rowHint}>启停会立即影响该员工能否被使用。</span>
                <span className={styles.toolbarSpacer} />
                {employee.enabled === false ? (
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonPrimary}`}
                    disabled={pending}
                    onClick={() => void toggleEnabled(true)}
                  >
                    {pending ? '正在保存…' : '启用该员工'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonDanger}`}
                    disabled={pending}
                    onClick={() => void toggleEnabled(false)}
                  >
                    {pending ? '正在保存…' : '停用该员工'}
                  </button>
                )}
              </div>
            ) : (
              <Notice>你的角色可以查看这位员工，但没有修改权限；如需调整启停或资料，请联系管理员。</Notice>
            )}
            {toggleError ? <Notice tone="danger">{toggleError}</Notice> : null}
          </PageCard>

          <PageCard title="能力概览" description="以下内容来自该员工记录里的配置字段。">
            <div className={styles.twoColumn} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <StatTile
                label="专用模型"
                value={allowed.enforced ? `${allowed.models.length} 个` : '未限制'}
                hint={
                  allowed.enforced
                    ? allowed.preferred
                      ? `首选：${allowed.preferred.model}`
                      : '允许集为空，发送消息会被后端拒绝'
                    : '由全局默认模型决定'
                }
              />
              <StatTile
                label="技能"
                value={String(employee.skillSettings?.skills?.length ?? 0)}
                hint="员工绑定的技能数量"
              />
              <StatTile
                label="工具"
                value={String(employee.skillSettings?.tools?.length ?? 0)}
                hint="员工绑定的工具数量"
              />
              <StatTile
                label="数据范围"
                value={String(employee.dataSourceSettings?.collections?.length ?? 0)}
                hint="允许访问的数据集合数量"
              />
            </div>

            <div className={styles.field} style={{ marginTop: 16 }}>
              <span className={styles.fieldLabel}>允许使用的模型</span>
              {allowed.enforced ? (
                allowed.models.length > 0 ? (
                  <div className={styles.chipRow}>
                    {allowed.models.map((item) => (
                      <span key={`${item.llmService}:${item.model}`} className={styles.chip}>
                        {item.model}（{item.llmService}）
                      </span>
                    ))}
                  </div>
                ) : (
                  <Notice tone="warn">
                    这位员工启用了专用模型限制，但允许集为空：按其配置发送消息时后端会拒绝，请先在员工配置里补上模型。
                  </Notice>
                )
              ) : (
                <span className={styles.rowHint}>未启用专用模型限制，由全局默认模型决定。</span>
              )}
            </div>

            <div className={styles.field}>
              <span className={styles.fieldLabel}>绑定的工具</span>
              {employee.skillSettings?.tools && employee.skillSettings.tools.length > 0 ? (
                <div className={styles.chipRow}>
                  {employee.skillSettings.tools.map((tool) => (
                    <span key={tool.name} className={styles.chip}>
                      {tool.name}
                    </span>
                  ))}
                </div>
              ) : (
                <span className={styles.rowHint}>没有绑定工具。</span>
              )}
            </div>

            <div className={styles.field}>
              <span className={styles.fieldLabel}>数据范围</span>
              {employee.dataSourceSettings?.collections && employee.dataSourceSettings.collections.length > 0 ? (
                <div className={styles.chipRow}>
                  {employee.dataSourceSettings.collections.map((item, index) => (
                    <span key={`${item.collection ?? index}`} className={styles.chip}>
                      {item.collection ?? '未命名集合'}
                    </span>
                  ))}
                </div>
              ) : (
                <span className={styles.rowHint}>没有限定数据集合。</span>
              )}
            </div>
          </PageCard>
        </>
      ) : null}
    </div>
  );
}

/** 只读预览：去掉可能含凭据的键（员工记录通常没有，但配置字段是 jsonb，不能假设）。 */
export function redactEmployee(row: AiEmployeeRow): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...row };
  for (const key of Object.keys(clone)) {
    if (/key|token|secret|password|credential/i.test(key)) clone[key] = '（已隐藏）';
  }
  return clone;
}
