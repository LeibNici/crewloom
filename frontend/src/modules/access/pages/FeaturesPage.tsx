import { roleLabel } from '../display';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { PageCard, StatusPill } from '../../../components/Card';
import { useResourceList } from '../../../api/hooks';
import type { ModulePageProps } from '../../types';
import {
  ActionBanner,
  Banner,
  BoardPage,
  Chip,
  DataTable,
  Field,
  Pagination,
  SearchBox,
  SelectInput,
  StateView,
  TextInput,
  formatCell,
  localStyles as styles,
  useAsyncAction,
  type Column,
} from '../ui';
import { SaveRow } from '../components';
import {
  addRoleDesktopRoutes,
  addRoleMenuUiSchemas,
  removeRoleDesktopRoutes,
  removeRoleMenuUiSchemas,
  updateRole,
  useAssociatedList,
} from '../operations';
import type { AvailableAction, DesktopRouteRow, RoleCollectionConfigRow, RoleRecord } from '../types';

/**
 * 后端枚举的可读标题（只改显示，不改保存值）。
 *
 * 来源（固定 2.2.20 / 2.2.22 实现，值本身逐字保留）：
 *  - `availableActions[].type`：`new-data`（产生新数据的动作，如新增）/ `old-data`（基于已有数据的动作，如查看、修改、删除）；
 *  - `desktopRoutes[].type`：`group`（分组）/ `page`（页面）/ `link`（链接）；
 *  - `roles/<role>/collections[].usingConfig`：`role`（该角色单独配置）/ `strategy`（跟随角色默认策略）。
 */
const ROUTE_TYPE_LABELS: Record<string, string> = { group: '分组', page: '页面', link: '链接' };
const ACTION_TYPE_LABELS: Record<string, string> = { 'new-data': '新增数据类', 'old-data': '已有数据类' };
const USING_CONFIG_LABELS: Record<string, string> = { role: '按角色单独配置', strategy: '按角色默认策略' };

/** 有中文标题时显示中文，否则显示原始值（未知值不隐藏、不编造）。 */
function enumLabel(labels: Record<string, string>, value: unknown): string {
  const key = typeof value === 'string' ? value : '';
  return labels[key] ?? formatCell(value);
}

/**
 * AC-03 功能与入口授权（`/access/features`）。
 *
 * 两条不同的授权线（02-foundation §7 冻结）：
 *  1. Crewloom 管理入口与操作：由 **ACL 片段 / 资源动作** 判定（后端是最终判定者），
 *     这里只读取并维护 `roles.snippets`，资源动作授权统一在「数据授权」页维护，避免第二套规则；
 *  2. 原 NocoBase 低代码页面入口：`roles/<role>/desktopRoutes` 与 `menuUiSchemas` 按**原关系**
 *     真实读取与维护，不做 UID → Crewloom path 的伪映射。
 */
export function FeaturesPage({ module, board }: ModulePageProps) {
  const roles = useResourceList<RoleRecord>('roles', { params: { pageSize: 200, sort: ['name'] } });
  const [roleName, setRoleName] = useState('');
  const [collectionKeyword, setCollectionKeyword] = useState('');
  const [collectionPage, setCollectionPage] = useState(1);
  const [selectedRoutes, setSelectedRoutes] = useState<number[]>([]);
  const [customSnippet, setCustomSnippet] = useState('');
  const [menuUidInput, setMenuUidInput] = useState('');
  const [snippets, setSnippets] = useState<string[]>([]);
  const action = useAsyncAction();

  const currentRole = useMemo(
    () => roles.rows.find((role) => role.name === roleName) ?? null,
    [roles.rows, roleName],
  );

  useEffect(() => {
    if (!roleName && roles.rows.length > 0) setRoleName(roles.rows[0].name);
  }, [roles.rows, roleName]);

  useEffect(() => {
    setSnippets(currentRole?.snippets ?? []);
  }, [currentRole]);

  const snippetOptions = useMemo(() => {
    const set = new Set<string>();
    for (const role of roles.rows) for (const snippet of role.snippets ?? []) set.add(snippet);
    return [...set].sort();
  }, [roles.rows]);

  const availableActions = useResourceList<AvailableAction>('availableActions', {});
  const allRoutes = useResourceList<DesktopRouteRow>('desktopRoutes', {
    params: { pageSize: 500, sort: ['sort'] },
  });
  const roleRoutes = useAssociatedList<DesktopRouteRow>('roles', roleName || null, 'desktopRoutes', {
    params: { pageSize: 500, sort: ['sort'] },
  });
  const roleCollections = useAssociatedList<RoleCollectionConfigRow>('roles', roleName || null, 'collections', {
    params: { pageSize: 500, dataSourceKey: 'main' },
  });
  const roleMenuSchemas = useAssociatedList<Record<string, unknown>>('roles', roleName || null, 'menuUiSchemas', {
    params: { pageSize: 200 },
  });

  useEffect(() => {
    setSelectedRoutes(roleRoutes.rows.map((route) => route.id));
  }, [roleRoutes.rows]);

  const collectionRows = useMemo(() => {
    const source = roleCollections.rows;
    if (!collectionKeyword.trim()) return source;
    const keyword = collectionKeyword.trim().toLowerCase();
    return source.filter(
      (row) =>
        row.name?.toLowerCase().includes(keyword) ||
        (row.title ?? '').toLowerCase().includes(keyword) ||
        (row.collectionName ?? '').toLowerCase().includes(keyword),
    );
  }, [roleCollections.rows, collectionKeyword]);

  const collectionPageSize = 20;
  const collectionPageCount = Math.max(1, Math.ceil(collectionRows.length / collectionPageSize));
  const currentCollectionPage = Math.min(collectionPage, collectionPageCount);
  const pagedCollections = collectionRows.slice(
    (currentCollectionPage - 1) * collectionPageSize,
    currentCollectionPage * collectionPageSize,
  );

  const routeColumns: Array<Column<DesktopRouteRow>> = [
    {
      key: 'select',
      title: '授权',
      width: 64,
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`原页面路由 ${row.id}`}
          checked={selectedRoutes.includes(row.id)}
          onChange={(event) =>
            setSelectedRoutes(
              event.target.checked
                ? [...selectedRoutes, row.id]
                : selectedRoutes.filter((id) => id !== row.id),
            )
          }
        />
      ),
    },
    { key: 'title', title: '页面/菜单', render: (row) => formatCell(row.title) },
    {
      key: 'type',
      title: '类型',
      render: (row) => <span className={styles.cellMuted}>{enumLabel(ROUTE_TYPE_LABELS, row.type)}</span>,
    },
    { key: 'parentId', title: '上级', render: (row) => formatCell(row.parentId) },
    {
      key: 'schemaUid',
      title: '页面标识',
      render: (row) => <span className={styles.cellMono}>{row.schemaUid ?? '—'}</span>,
    },
    { key: 'sort', title: '排序', render: (row) => formatCell(row.sort) },
  ];

  const actionColumns: Array<Column<AvailableAction>> = [
    { key: 'displayName', title: '动作', render: (row) => row.displayName || row.name },
    {
      key: 'name',
      title: '内部动作名',
      render: (row) => <span className={styles.cellMono}>{row.name}</span>,
    },
    { key: 'type', title: '类型', render: (row) => enumLabel(ACTION_TYPE_LABELS, row.type) },
    {
      key: 'aliases',
      title: '别名',
      render: (row) => (row.aliases && row.aliases.length > 0 ? row.aliases.join('、') : <span className={styles.cellMuted}>—</span>),
    },
    { key: 'onNewRecord', title: '仅新建记录', render: (row) => formatCell(row.onNewRecord) },
  ];

  const collectionColumns: Array<Column<RoleCollectionConfigRow>> = [
    { key: 'title', title: '集合', render: (row) => row.title || row.collectionName || row.name },
    {
      key: 'name',
      title: '集合标识',
      render: (row) => <span className={styles.cellMono}>{row.name}</span>,
    },
    {
      key: 'usingConfig',
      title: '当前来源',
      render: (row) => <span className={styles.cellMuted}>{enumLabel(USING_CONFIG_LABELS, row.usingConfig)}</span>,
    },
    {
      key: 'exists',
      title: '有独立配置',
      render: (row) => (row.exists ? <StatusPill tone="ok">是</StatusPill> : <span className={styles.cellMuted}>否</span>),
    },
  ];

  async function saveSnippets() {
    if (!currentRole) return;
    const ok = await action.run(
      () => updateRole(currentRole.name, { snippets }),
      '权限片段已保存。',
    );
    if (ok) roles.refetch();
  }

  async function saveRoutes() {
    const currentIds = roleRoutes.rows.map((route) => route.id);
    const toAdd = selectedRoutes.filter((id) => !currentIds.includes(id));
    const toRemove = currentIds.filter((id) => !selectedRoutes.includes(id));
    if (toAdd.length === 0 && toRemove.length === 0) return;
    const ok = await action.run(async () => {
      if (toAdd.length > 0) await addRoleDesktopRoutes(roleName, toAdd);
      if (toRemove.length > 0) await removeRoleDesktopRoutes(roleName, toRemove);
    }, `原页面路由授权已保存（新增 ${toAdd.length}、移除 ${toRemove.length}）。`);
    if (ok) roleRoutes.refetch();
  }

  const routesDirty =
    selectedRoutes.length !== roleRoutes.rows.length ||
    selectedRoutes.some((id) => !roleRoutes.rows.some((route) => route.id === id));

  return (
    <BoardPage module={module} board={board}>
      <PageCard title="选择角色" description="所有维护都针对一个角色进行；先选角色再看它的功能与入口授权。">
        <StateView state={roles.state} message={roles.message} onRetry={roles.refetch} />
        {roles.rows.length > 0 ? (
          <div className={styles.toolbar}>
            <div className={styles.toolbarGrow}>
              <Field label="角色">
                <SelectInput
                  value={roleName}
                  options={roles.rows.map((role) => ({ value: role.name, label: `${roleLabel(role)}（${role.name}）` }))}
                  onChange={(next) => setRoleName(String(next))}
                />
              </Field>
            </div>
            {currentRole ? (
              <span className={styles.chips}>
                {currentRole.allowConfigure ? <StatusPill tone="ok">可配置系统</StatusPill> : null}
                {currentRole.default ? <StatusPill tone="brand">全局默认角色</StatusPill> : null}
              </span>
            ) : null}
          </div>
        ) : null}
      </PageCard>

      {roleName ? (
        <>
          <PageCard
            title="功能权限片段"
            description="片段决定这个角色能用哪些管理功能（如 pm.* / ui.*）；这是 Crewloom 管理入口的判定依据。"
          >
            <ActionBanner action={action} />
            <StateView state={roles.state} message={roles.message} onRetry={roles.refetch} />
            <div className={styles.chips}>
              {snippetOptions.map((snippet) => (
                <label key={snippet} className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={snippets.includes(snippet)}
                    onChange={(event) =>
                      setSnippets(
                        event.target.checked
                          ? [...snippets, snippet]
                          : snippets.filter((item) => item !== snippet),
                      )
                    }
                  />
                  <span>{snippet}</span>
                </label>
              ))}
            </div>
            <div className={styles.toolbar} style={{ marginTop: 8 }}>
              <div className={styles.toolbarGrow}>
                <TextInput
                  value={customSnippet}
                  placeholder="自定义权限片段名（需与系统已有片段一致）"
                  onChange={setCustomSnippet}
                />
              </div>
              <button
                type="button"
                className={styles.button}
                disabled={customSnippet.trim() === ''}
                onClick={() => {
                  const value = customSnippet.trim();
                  if (value && !snippets.includes(value)) setSnippets([...snippets, value]);
                  setCustomSnippet('');
                }}
              >
                添加片段
              </button>
            </div>
            {snippets.length > 0 ? (
              <div className={styles.chips} style={{ marginTop: 8 }}>
                {snippets.map((snippet) => (
                  <Chip key={snippet} onRemove={() => setSnippets(snippets.filter((item) => item !== snippet))}>
                    {snippet}
                  </Chip>
                ))}
              </div>
            ) : null}
            <SaveRow
              label="保存片段"
              pending={action.pending}
              onSave={() => void saveSnippets()}
              onReset={() => setSnippets(currentRole?.snippets ?? [])}
            />
            <Banner tone="info">
              这个角色能查看或修改哪些数据（哪个集合能查/能改、字段可见可写、记录范围）统一在「数据授权」里设置，这里只管管理功能与入口。
              按钮级权限仍由系统权限判定。
            </Banner>
          </PageCard>

          <PageCard
            title="可用动作枚举"
            description="当前实例可用的动作用来给数据授权勾选；这里只做只读展示。"
          >
            <StateView state={availableActions.state} message={availableActions.message} onRetry={availableActions.refetch} />
            {availableActions.rows.length > 0 ? (
              <DataTable columns={actionColumns} rows={availableActions.rows} rowKey={(row) => row.name} />
            ) : null}
          </PageCard>

          <PageCard
            title="原页面路由授权"
            description="原桌面页面的入口授权，按页面关系读写；与管理入口是两条线。"
          >
            <StateView state={allRoutes.state} message={allRoutes.message} onRetry={allRoutes.refetch} />
            <StateView state={roleRoutes.state} message={roleRoutes.message} onRetry={roleRoutes.refetch} />
            {allRoutes.rows.length > 0 ? (
              <>
                <DataTable columns={routeColumns} rows={allRoutes.rows} rowKey={(row) => row.id} />
                <p className={styles.notice}>
                  已勾选 {selectedRoutes.length} / {allRoutes.rows.length} 条；保存时只处理有变化的项（新勾选的会新增，取消勾选的会移除）。
                </p>
                <SaveRow
                  label="保存入口授权"
                  pending={action.pending}
                  disabled={!routesDirty}
                  onSave={() => void saveRoutes()}
                  onReset={() => setSelectedRoutes(roleRoutes.rows.map((route) => route.id))}
                />
              </>
            ) : null}
          </PageCard>

          <PageCard
            title="菜单界面授权"
            description="该角色额外授权的桌面菜单项；当前该角色可能没有记录。"
          >
            <StateView
              state={roleMenuSchemas.state}
              message={roleMenuSchemas.message}
              onRetry={roleMenuSchemas.refetch}
              emptyTitle="没有菜单界面授权记录"
              emptyDescription="该角色当前没有单独配置菜单界面（数量为 0 是真实结果，不是加载失败）。"
            />
            {roleMenuSchemas.rows.length > 0 ? (
              <DataTable
                columns={[
                  { key: 'uid', title: '菜单标识', render: (row) => <span className={styles.cellMono}>{formatCell(row['x-uid'] ?? row.uid)}</span> },
                  { key: 'name', title: '名称', render: (row) => formatCell(row.name ?? row.title) },
                ]}
                rows={roleMenuSchemas.rows}
                rowKey={(row, index) => String(row['x-uid'] ?? row.uid ?? index)}
              />
            ) : null}
            <div className={styles.toolbar}>
              <div className={styles.toolbarGrow}>
                <TextInput
                  value={menuUidInput}
                  placeholder="要绑定到该角色的菜单标识（x-uid）"
                  onChange={setMenuUidInput}
                />
              </div>
              <button
                type="button"
                className={styles.button}
                disabled={action.pending || menuUidInput.trim() === ''}
                onClick={() =>
                  void action.run(async () => {
                    await addRoleMenuUiSchemas(roleName, [menuUidInput.trim()]);
                    setMenuUidInput('');
                    roleMenuSchemas.refetch();
                  }, '菜单界面授权已保存。')
                }
              >
                绑定菜单项
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={action.pending || roleMenuSchemas.rows.length === 0}
                onClick={() =>
                  void action.run(async () => {
                    await removeRoleMenuUiSchemas(
                      roleName,
                      roleMenuSchemas.rows.map((row) => String(row['x-uid'] ?? row.uid)),
                    );
                    roleMenuSchemas.refetch();
                  }, '菜单界面授权已清空。')
                }
              >
                清空该角色的菜单授权
              </button>
            </div>
            <Banner tone="warn">
              菜单授权针对的是原桌面菜单本身（用菜单标识 x-uid 指定），与 Crewloom 自己的页面导航是两条线；
              这里按原菜单关系保存，不会把原菜单标识改写成 Crewloom 的路由。
            </Banner>
          </PageCard>

          <PageCard
            title="可授权集合"
            description="该角色在集合维度的配置状态；没有独立配置的集合按角色默认策略处理。"
          >
            <div className={styles.toolbar}>
              <div className={styles.toolbarGrow}>
                <SearchBox
                  value={collectionKeyword}
                  onChange={(value) => {
                    setCollectionKeyword(value);
                    setCollectionPage(1);
                  }}
                  placeholder="集合名称或标识"
                />
              </div>
            </div>
            <StateView
              state={roleCollections.state}
              message={roleCollections.message}
              onRetry={roleCollections.refetch}
              emptyTitle="没有可授权集合"
            />
            {pagedCollections.length > 0 ? (
              <DataTable
                columns={collectionColumns}
                rows={pagedCollections}
                rowKey={(row) => row.name}
              />
            ) : null}
            <Pagination
              page={currentCollectionPage}
              pageSize={collectionPageSize}
              total={collectionRows.length}
              onPageChange={setCollectionPage}
            />
            <p className={styles.notice}>
              要维护具体集合的查询/新增/修改/删除与字段、记录范围，请到 <Link to="/access/data">数据授权</Link>。
            </p>
          </PageCard>
        </>
      ) : null}
    </BoardPage>
  );
}
