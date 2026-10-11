import { useMemo } from 'react';
import { Link } from 'react-router';
import { useSessionStore } from '../auth/store';
import { EmptyState, PageCard, PageHeader, StatusPill } from '../components/Card';
import {
  decideAccess,
  findBoard,
  MODULE_BY_ID,
  resolveBoardVisibility,
  type ModuleDefinition,
} from '../permissions/modules';
import styles from './screens.module.css';

interface ModuleBoardScreenProps {
  moduleId: string;
  boardPath?: string;
}

/**
 * 业务模块页面（公共落点）。
 *
 * 用法分两种，互不冒充：
 *  - **模块首页**（无 `boardPath`）：列出该模块**现在就可以打开**的页面，给出进入入口。
 *    带参数的详情页不在这里列成链接（那会变成 `/users/:id` 这种点不动的死链），
 *    而是说明"从对应列表里选择一条记录进入"。这里只读注册表；某个页面是否真的可用，
 *    仍由各模块自己的页面与权限门决定。
 *  - **单个页面**（有 `boardPath`）且该页没有提供组件时：如实说明这一页还没有开放，
 *    与"整个模块都没有开放"区分开。
 */
export function ModuleBoardScreen({ moduleId, boardPath }: ModuleBoardScreenProps) {
  const access = useSessionStore((state) => state.access);
  const probes = useSessionStore((state) => state.probes);
  const module = MODULE_BY_ID[moduleId] as ModuleDefinition | undefined;

  const visibleBoards = useMemo(
    () => (module ? resolveBoardVisibility(access, module, probes) : []),
    [module, access, probes],
  );

  if (!module) {
    return (
      <PageCard title="未找到该模块">
        <p className={styles.listItemHint}>请求的模块不在当前前端清单中。</p>
      </PageCard>
    );
  }

  if (!boardPath) {
    return <ModuleOverview module={module} visibleBoards={visibleBoards} />;
  }

  const board = findBoard(module, boardPath);

  if (!board) {
    return (
      <PageCard title="未找到该页面">
        <p className={styles.listItemHint}>该模块下没有这个子页面，请从左侧导航选择。</p>
      </PageCard>
    );
  }

  const boardDecision = decideAccess(access, board.access, board.probeId ?? module.probeId, probes);
  const boardUnknown = boardDecision.status === 'unknown';

  if (!boardDecision.allowed) {
    return (
      <div className={styles.stack}>
        <PageHeader title={board.title} description={board.description} />
        <EmptyState
          tone="warn"
          title={boardUnknown ? '暂时无法确认这个页面的权限' : '当前角色无法打开这个页面'}
          description={
            boardUnknown
              ? '当前未能从服务得到明确的权限结果，可能是网络不稳定或服务正在启动。请稍后重试。'
              : '你可以切换到其他角色，或联系管理员为你的账号补充授权后再试。'
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      <PageHeader title={board.title} description={board.description} />
      <PageCard title="这个页面还没有开放" description="它的入口已经在导航里，但功能仍在后续阶段提供。">
        <EmptyState
          title="这一页还没有开放"
          description={`「${board.title}」：${board.description}。可以先用本模块首页列出的其它页面。`}
        />
      </PageCard>
    </div>
  );
}

/**
 * 模块首页：把**已实现且无需参数**的页面列成可点的入口。
 *
 * 只使用注册表里已有的字段（标题/说明/权限判定），不写死业务记录或统计数字；
 * 带参数的详情页按标题提示"从列表进入"，避免出现 `/users/:id` 这类字面死链。
 */
function ModuleOverview({
  module,
  visibleBoards,
}: {
  module: ModuleDefinition;
  visibleBoards: ReturnType<typeof resolveBoardVisibility>;
}) {
  const pages = visibleBoards.filter(
    (item) => item.board.Component && !item.board.path.includes(':'),
  );
  const detailPages = visibleBoards.filter(
    (item) => item.board.Component && item.board.path.includes(':'),
  );

  return (
    <div className={styles.stack}>
      <PageHeader title={module.title} description={module.subtitle} />

      <PageCard title="本模块的页面" description="点击进入；这里列出的是现在就可以使用的页面。">
        {pages.length === 0 ? (
          <p className={styles.listItemHint}>这个模块暂时没有可以直接打开的页面。</p>
        ) : (
          <div className={styles.boardList}>
            {pages.map((item) => (
              <div key={item.board.path} className={styles.boardRow}>
                <div className={styles.boardRowText}>
                  <span className={styles.boardRowTitle}>{item.board.title}</span>
                  <span className={styles.boardRowDescription}>{item.board.description}</span>
                </div>
                {item.decision.allowed ? (
                  <Link className={styles.secondaryButton} to={`${module.path}/${item.board.path}`}>
                    进入
                  </Link>
                ) : (
                  <StatusPill tone="warn">
                    {item.decision.status === 'unknown' ? '暂无法确认' : '无权限'}
                  </StatusPill>
                )}
              </div>
            ))}
          </div>
        )}

        {detailPages.length > 0 ? (
          <p className={styles.listItemHint} style={{ marginTop: 12 }}>
            详情页（{detailPages.map((item) => item.board.title).join('、')}）
            需要先到上面的列表里选择一条记录，再进入对应的详情。
          </p>
        ) : null}
      </PageCard>
    </div>
  );
}
