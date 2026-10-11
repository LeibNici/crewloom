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
  listUsableEmployees,
  resourceMessageOf,
  resourceStateOf,
  updateEmployee,
} from '../resources';
import type { AiEmployeeRow } from '../types';
import { ListPager, Notice, StateBlock, formatTime, orDash } from '../ui';
import { resolveAllowedModels } from '../resources';
import styles from '../group-a.module.css';

/**
 * AI-01 员工目录。
 *
 * 两条列表严格分开（报告 01 §2）：
 *  - **可使用**：`aiEmployees:listByUser`（仅需登录，按 `rolesAiEmployees` 过滤、`enabled=true`）；
 *  - **可管理**：`aiEmployees:list`（需要员工管理权限，包含已停用的员工）。
 * 因此"能使用"不等于"能编辑"，界面用不同的标记与不同的列表回答这两个问题。
 *
 * 两个来源的**分页与筛选能力不同**，界面据实处理（13000 只读实测）：
 *  - `aiEmployees:list` 是标准集合 list 动作：`page` / `pageSize` / `filter` / `sort` 都由后端生效；
 *  - `aiEmployees:listByUser` 是**自定义动作**：服务端 `findAll` 后整体返回，**忽略 page/pageSize/filter**
 *    （源码 `plugin-ai/src/server/resource/aiEmployees.ts` 的 `listByUser` 只按 enabled + rolesAiEmployees 过滤）。
 *    因此「可使用」页签一次取回全部，关键词用**本地过滤**完成，并且不显示会骗人的分页控件；
 *    界面上只说"已一次性全部列出、因此没有分页"，不解释请求是怎么发的。
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

export function EmployeeDirectoryPage() {
  const { username } = useParams<{ username?: string }>();
  const access = useSessionStore((state) => state.access);
  const canManage = isResourceActionAllowed(access, 'aiEmployees', 'update');
  const [scope, setScope] = useState<'usable' | 'manage'>('usable');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);

  const filter = useMemo(() => {
    const trimmed = keyword.trim();
    if (trimmed.length === 0) return undefined;
    return {
      $or: [
        { username: { $includes: trimmed } },
        { nickname: { $includes: trimmed } },
        { position: { $includes: trimmed } },
      ],
    };
  }, [keyword]);

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

  const active = scope === 'usable' ? usable : managed;
  const fetched = active.data?.rows ?? [];
  const rows = scope === 'usable' ? filterEmployeesByKeyword(fetched, keyword) : fetched;
  const state = active.isLoading ? 'loading' : resourceStateOf(active.error, rows.length === 0);

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
        <div className={styles.toolbar}>
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
          <span className={styles.toolbarSpacer} />
          <input
            className={`${styles.input} ${styles.inputInline}`}
            style={{ minWidth: 220 }}
            placeholder="按名称、岗位筛选"
            aria-label="按名称或岗位筛选员工"
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value);
              setPage(1);
            }}
          />
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
          emptyTitle={scope === 'usable' ? '当前角色还没有可使用的员工' : '暂时没有员工记录'}
          emptyDescription={
            scope === 'usable'
              ? '当前角色还没有被分配任何已启用的员工，可以联系管理员补充授权。'
              : '当前没有任何员工记录。'
          }
          deniedDescription="你的角色没有查看这部分员工列表的权限。"
        />

        {rows.length > 0 ? (
          <div className={styles.rowList}>
            {rows.map((employee) => (
              <EmployeeRow key={employee.username} employee={employee} canManage={canManage} />
            ))}
          </div>
        ) : null}

        {scope === 'usable' ? (
          <p className={styles.rowHint} style={{ marginTop: 12 }}>
            当前角色可使用的员工共 {rows.length} 位，已一次性全部列出，因此这里没有分页。
            「全部员工（可管理）」页签支持翻页。
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
      </PageCard>
    </div>
  );
}

function EmployeeRow({ employee, canManage }: { employee: AiEmployeeRow; canManage: boolean }) {
  return (
    <div className={styles.rowCard}>
      <div className={styles.rowMain}>
        <div className={styles.chipRow}>
          <span className={styles.rowTitle}>{employee.nickname || employee.username}</span>
          {employee.builtIn ? <StatusPill tone="neutral">内置员工</StatusPill> : null}
          {employee.enabled === false ? <StatusPill tone="warn">已停用</StatusPill> : <StatusPill tone="ok">已启用</StatusPill>}
          {employee.deprecated ? <StatusPill tone="warn">已标记为过时</StatusPill> : null}
        </div>
        <span className={styles.rowHint}>
          {employee.position || '未设置岗位'}　账号：{employee.username}
        </span>
        {employee.bio ? <span className={styles.rowHint}>{employee.bio}</span> : null}
      </div>
      <div className={styles.rowActions}>
        <Link className={styles.button} to={`/ai/directory/${encodeURIComponent(employee.username)}`}>
          查看详情
        </Link>
        {canManage ? (
          <Link className={styles.button} to={`/ai/employees-config/${encodeURIComponent(employee.username)}`}>
            编辑配置
          </Link>
        ) : null}
      </div>
    </div>
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
