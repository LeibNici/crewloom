import { displayTitle, roleLabel } from '../display';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageCard, StatusPill } from '../../../components/Card';
import { useResourceList } from '../../../api/hooks';
import type { ModulePageProps } from '../../types';
import {
  ActionBanner,
  Banner,
  BoardPage,
  DataTable,
  Field,
  Modal,
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
  applyDataPermissions,
  buildScope,
  CONDITION_OPERATOR_LABELS,
  createRoleResourceScope,
  updateRoleResource,
  useAssociatedList,
  type ConditionClause,
  type ConditionOperator,
} from '../operations';
import type { AvailableAction, RoleRecord, RolesResourceActionRow, RolesResourceRow } from '../types';

interface ActionDraft {
  enabled: boolean;
  fields: string[];
  scopeChoice: string;
}

/**
 * AC-04 数据授权（`/access/data`）。
 *
 * 真实数据（13000 实测）：
 *  - 资源：`GET roles/<role>/resources:list`（`dataSourcesRolesResources`，实测 1299 条、单角色最多 145 条）；
 *  - 动作：`GET dataSourcesRolesResourcesActions:list`（实测 3109 条，`name` 如 view/create/update…）；
 *  - 范围：`GET dataSourcesRolesResourcesScopes:list`（实测 2 条）；
 *  - 字段：动作行的 `fields[]`，可选字段来自集合真实 schema（`fields:list?filter={"collectionName":…}`）。
 *
 * 保存用原生**事务动作** `roles:applyDataPermissions`，不自己拼多请求 upsert；
 * 单条也可走 `roles/<role>/resources:update`。
 *
 * 保存语义（按既有 52/56 与 fixture 记录的合同，界面文案必须与之一致）：
 *  - `roles:applyDataPermissions` 对该资源的动作集合是**整体替换**；
 *  - `roles/<role>/resources:update` 也是**整体更新该资源**的动作集合。
 * 因此界面**不承诺**"保留未列出的动作/字段"：保存后这个集合就按这里设置的内容授权。
 */
export function DataPermissionsPage({ module, board }: ModulePageProps) {
  const roles = useResourceList<RoleRecord>('roles', { params: { pageSize: 200, sort: ['name'] } });
  const availableActions = useResourceList<AvailableAction>('availableActions', {});
  const scopes = useResourceList<{ id: number; key: string; name: string; resourceName: string; dataSourceKey: string }>(
    'dataSourcesRolesResourcesScopes',
    { params: { pageSize: 200, sort: ['name'] } },
  );

  /**
   * 角色选择的初始值来自链接参数（DS-05「数据源访问配置」选好角色跳进来时带上 `?role=`）。
   * 没有参数或参数里的角色不存在时，仍按原有默认行为选第一个角色。
   */
  const [searchParams] = useSearchParams();
  const [roleName, setRoleName] = useState(() => searchParams.get('role') ?? '');
  const [resourceKeyword, setResourceKeyword] = useState('');
  const [selectedResource, setSelectedResource] = useState<RolesResourceRow | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ActionDraft>>({});
  const [fieldEditor, setFieldEditor] = useState<string | null>(null);
  const [fieldKeyword, setFieldKeyword] = useState('');
  const [clauses, setClauses] = useState<ConditionClause[]>([
    { id: 'c1', field: '', operator: 'eq', value: '' },
  ]);
  const [scopeName, setScopeName] = useState('');
  const action = useAsyncAction();

  useEffect(() => {
    if (roles.rows.length === 0) return;
    if (roleName && roles.rows.some((role) => role.name === roleName)) return;
    setRoleName(roles.rows[0].name);
  }, [roles.rows, roleName]);

  const resources = useAssociatedList<RolesResourceRow>('roles', roleName || null, 'resources', {
    params: { pageSize: 300, sort: ['name'] },
  });

  const filteredResources = useMemo(() => {
    if (!resourceKeyword.trim()) return resources.rows;
    const keyword = resourceKeyword.trim().toLowerCase();
    return resources.rows.filter((row) => row.name.toLowerCase().includes(keyword));
  }, [resources.rows, resourceKeyword]);

  const resourceActions = useResourceList<RolesResourceActionRow>('dataSourcesRolesResourcesActions', {
    params: {
      pageSize: 200,
      appends: ['scope'],
      filter: selectedResource ? { rolesResourceId: selectedResource.id } : undefined,
    },
    enabled: Boolean(selectedResource),
    keySuffix: selectedResource?.id ?? null,
  });

  const collectionFields = useResourceList<{ name: string; type?: string; interface?: string | null; description?: string | null }>(
    'fields',
    {
      params: {
        pageSize: 300,
        sort: ['sort'],
        filter: selectedResource ? { collectionName: selectedResource.name } : undefined,
      },
      enabled: Boolean(selectedResource),
      keySuffix: selectedResource?.name ?? null,
    },
  );

  // 选中资源后，用真实动作行重建草稿（已勾选动作、字段、范围）。
  useEffect(() => {
    if (!selectedResource) return;
    const next: Record<string, ActionDraft> = {};
    for (const definition of availableActions.rows) next[definition.name] = { enabled: false, fields: [], scopeChoice: 'none' };
    for (const row of resourceActions.rows) {
      next[row.name] = {
        enabled: true,
        fields: row.fields ?? [],
        scopeChoice: row.scopeId ? String(row.scopeId) : 'none',
      };
    }
    setDrafts(next);
  }, [selectedResource, resourceActions.rows, availableActions.rows]);

  const enabledActions = useMemo(
    () => availableActions.rows.filter((definition) => drafts[definition.name]?.enabled),
    [availableActions.rows, drafts],
  );

  const resourceColumns: Array<Column<RolesResourceRow>> = [
    {
      key: 'name',
      title: '资源（集合）',
      render: (row) => <span className={styles.cellMono}>{row.name}</span>,
    },
    {
      key: 'usingActionsConfig',
      title: '动作配置',
      render: (row) =>
        row.usingActionsConfig ? <StatusPill tone="ok">自定义</StatusPill> : <span className={styles.cellMuted}>按策略</span>,
    },
  ];

  const fieldOptions = useMemo(() => {
    const keyword = fieldKeyword.trim().toLowerCase();
    const rows = collectionFields.rows.map((field) => ({
      name: field.name,
      label: `${field.name}${field.interface ? `（${field.interface}）` : ''}`,
    }));
    if (!keyword) return rows;
    return rows.filter((row) => row.name.toLowerCase().includes(keyword));
  }, [collectionFields.rows, fieldKeyword]);

  function toggleAction(name: string, enabled: boolean) {
    setDrafts((prev) => ({
      ...prev,
      [name]: { ...(prev[name] ?? { fields: [], scopeChoice: 'none' }), enabled },
    }));
  }

  function setActionFields(name: string, fields: string[]) {
    setDrafts((prev) => ({ ...prev, [name]: { ...prev[name], fields } }));
  }

  function setActionScope(name: string, scopeChoice: string) {
    setDrafts((prev) => ({ ...prev, [name]: { ...prev[name], scopeChoice } }));
  }

  async function savePermissions() {
    if (!selectedResource) return;
    const payloadActions = enabledActions.map((definition) => {
      const draft = drafts[definition.name];
      const scopeId = draft.scopeChoice !== 'none' ? Number(draft.scopeChoice) : null;
      return {
        name: definition.name,
        ...(draft.fields.length > 0 ? { fields: draft.fields } : {}),
        ...(scopeId ? { scopeId } : {}),
      };
    });
    const values = {
      dataSourceKey: selectedResource.dataSourceKey || 'main',
      resources: [
        {
          name: selectedResource.name,
          usingActionsConfig: true,
          actions: payloadActions,
        },
      ],
    };
    const ok = await action.run(
      () => applyDataPermissions(roleName, values),
      `已保存「${selectedResource.name}」的 ${payloadActions.length} 个动作授权。`,
    );
    if (ok) {
      resources.refetch();
      resourceActions.refetch();
    }
  }

  async function saveSingleResource() {
    if (!selectedResource) return;
    const payloadActions = enabledActions.map((definition) => {
      const draft = drafts[definition.name];
      const scopeId = draft.scopeChoice !== 'none' ? Number(draft.scopeChoice) : null;
      return {
        name: definition.name,
        ...(draft.fields.length > 0 ? { fields: draft.fields } : {}),
        ...(scopeId ? { scopeId } : {}),
      };
    });
    const ok = await action.run(
      () =>
        updateRoleResource(roleName, selectedResource.name, {
          name: selectedResource.name,
          usingActionsConfig: true,
          actions: payloadActions,
        }),
      '已保存这个集合的授权。',
    );
    if (ok) resourceActions.refetch();
  }

  async function saveCustomScope() {
    if (!selectedResource) return;
    const scope = buildScope(clauses);
    // 条件不完整时不发任何请求（按钮同时为禁用态），避免空写探针。
    if (scope === null || scopeName.trim() === '') return;
    const key = `${selectedResource.name}_${scopeName.trim()}`.replace(/[^\w-]/g, '_');
    const ok = await action.run(
      () =>
        createRoleResourceScope({
          key,
          name: scopeName.trim() || `${selectedResource.name} 自定义范围`,
          dataSourceKey: selectedResource.dataSourceKey || 'main',
          resourceName: selectedResource.name,
          scope,
        }),
      `自定义范围已保存（${key}）。保存授权时可在范围内选择它。`,
    );
    if (ok) {
      setScopeName('');
      scopes.refetch();
    }
  }

  const scopeOptions = useMemo(
    () => [
      { value: 'none', label: '全部记录（不限定范围）' },
      ...scopes.rows.map((scope) => ({
        value: String(scope.id),
        // 后台内置范围的名称是 i18n 模板（`{{t("All records")}}`），这里按可读名称显示；
        // 保存用的仍然是范围记录的真实 id（`value`），不改既定范围策略。
        label: `${displayTitle(scope.name, scope.key)}${
          scope.resourceName ? `（${scope.resourceName}）` : ''
        }`,
      })),
    ],
    [scopes.rows],
  );

  return (
    <BoardPage module={module} board={board}>
      <PageCard title="选择角色" description="先选角色和集合，再设置它能执行的动作、可见或可写的字段，以及能看到哪些记录。">
        <StateView state={roles.state} message={roles.message} onRetry={roles.refetch} />
        {roles.rows.length > 0 ? (
          <div className={styles.toolbar}>
            <div className={styles.toolbarGrow}>
              <Field label="角色">
                <SelectInput
                  value={roleName}
                  options={roles.rows.map((role) => ({ value: role.name, label: `${roleLabel(role)}（${role.name}）` }))}
                  onChange={(next) => {
                    setRoleName(String(next));
                    setSelectedResource(null);
                  }}
                />
              </Field>
            </div>
            <span className={styles.chips}>
              <StatusPill tone="neutral">{`资源 ${resources.total ?? '—'}`}</StatusPill>
              <StatusPill tone="neutral">{`记录范围 ${scopes.total ?? '—'}`}</StatusPill>
            </span>
          </div>
        ) : null}
      </PageCard>

      {roleName ? (
        <div className={styles.splitLayout}>
          <PageCard title="资源" description="选择要配置的集合。">
            <SearchBox value={resourceKeyword} onChange={setResourceKeyword} placeholder="集合标识" />
            <StateView
              state={resources.state}
              message={resources.message}
              onRetry={resources.refetch}
              emptyTitle="该角色还没有资源授权"
              emptyDescription="当前角色没有独立的资源授权记录时不是加载失败；核心资源可能按角色默认策略放行。"
            />
            {filteredResources.length > 0 ? (
              <div className={styles.listButtons} style={{ marginTop: 10 }}>
                {filteredResources.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={`${styles.listButton} ${
                      selectedResource?.id === row.id ? styles.listButtonActive : ''
                    }`}
                    onClick={() => setSelectedResource(row)}
                  >
                    <span className={styles.listButtonTitle}>{row.name}</span>
                    <span className={styles.listButtonHint}>
                      {row.usingActionsConfig ? '自定义动作配置' : '按角色策略'}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <DataTable columns={resourceColumns} rows={[]} rowKey={(row) => row.id} emptyText="没有匹配的资源。" />
            )}
          </PageCard>

          <div className={styles.stack}>
            {!selectedResource ? (
              <PageCard title="动作与字段" description="从左侧选择一个集合开始配置。">
                <StateView
                  state="empty"
                  emptyTitle="尚未选择集合"
                  emptyDescription="选择后可以看到该角色在这个集合上已有的动作、字段与记录范围。"
                />
              </PageCard>
            ) : (
              <>
                <PageCard
                  title={`动作授权：${selectedResource.name}`}
                  description="勾选动作；字段为空表示沿用服务端默认（不额外限定）。保存会一次性提交本页的改动。"
                >
                  <ActionBanner action={action} />
                  <StateView
                    state={availableActions.state}
                    message={availableActions.message}
                    onRetry={availableActions.refetch}
                  />
                  <StateView
                    state={resourceActions.state}
                    message={resourceActions.message}
                    onRetry={resourceActions.refetch}
                    loadingText="正在读取该集合已有的动作授权…"
                  />
                  <div className={styles.tableScroll}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th style={{ width: 70 }}>启用</th>
                          <th>动作</th>
                          <th>字段（可见/可写）</th>
                          <th style={{ width: 220 }}>记录范围</th>
                        </tr>
                      </thead>
                      <tbody>
                        {availableActions.rows.map((definition) => {
                          const draft = drafts[definition.name] ?? { enabled: false, fields: [], scopeChoice: 'none' };
                          return (
                            <tr key={definition.name}>
                              <td>
                                <input
                                  type="checkbox"
                                  aria-label={`启用动作 ${definition.name}`}
                                  checked={draft.enabled}
                                  onChange={(event) => toggleAction(definition.name, event.target.checked)}
                                />
                              </td>
                              <td>
                                {definition.displayName || definition.name}
                                <br />
                                <span className={styles.cellMono}>{definition.name}</span>
                              </td>
                              <td>
                                {draft.fields.length === 0 ? (
                                  <span className={styles.cellMuted}>未限定</span>
                                ) : (
                                  <span className={styles.cellMuted}>{draft.fields.slice(0, 6).join('、')}
                                    {draft.fields.length > 6 ? ` 等 ${draft.fields.length} 个` : ''}
                                  </span>
                                )}{' '}
                                <button
                                  type="button"
                                  className={`${styles.button} ${styles.buttonLink}`}
                                  onClick={() => setFieldEditor(definition.name)}
                                >
                                  选择字段
                                </button>
                              </td>
                              <td>
                                <SelectInput
                                  value={draft.scopeChoice}
                                  options={scopeOptions}
                                  onChange={(next) => setActionScope(definition.name, String(next))}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <SaveRow
                    label={`保存 ${enabledActions.length} 个动作`}
                    pending={action.pending}
                    disabled={availableActions.rows.length === 0}
                    onSave={() => void savePermissions()}
                    extra={
                      <button
                        type="button"
                        className={styles.button}
                        disabled={action.pending}
                        onClick={() => void saveSingleResource()}
                      >
                        只保存这个集合
                      </button>
                    }
                  />
                  <Banner tone="info">
                    记录范围为空＝全部记录；「仅本人记录」等内置范围为系统保护项，只可选择、不在这里改写。
                    保存后，这个集合将按你在这里设置的操作、字段和记录范围授权。
                  </Banner>
                </PageCard>

                <PageCard
                  title="条件编辑器（记录范围）"
                  description="条件用来限定这个范围里包含哪些记录；保存为命名范围后可以在动作上引用。"
                >
                  <ActionBanner action={action} />
                  {clauses.map((clause, index) => (
                    <div className={styles.conditionRow} key={clause.id} style={{ marginBottom: 8 }}>
                      <TextInput
                        value={clause.field}
                        placeholder="字段名"
                        onChange={(field) =>
                          setClauses(clauses.map((item, i) => (i === index ? { ...item, field } : item)))
                        }
                      />
                      <SelectInput
                        value={clause.operator}
                        options={CONDITION_OPERATOR_LABELS}
                        onChange={(operator) =>
                          setClauses(
                            clauses.map((item, i) =>
                              i === index ? { ...item, operator: operator as ConditionOperator } : item,
                            ),
                          )
                        }
                      />
                      <TextInput
                        value={clause.value}
                        placeholder="值（in/notIn 用逗号分隔）"
                        onChange={(value) =>
                          setClauses(clauses.map((item, i) => (i === index ? { ...item, value } : item)))
                        }
                      />
                      <button
                        type="button"
                        className={styles.button}
                        disabled={clauses.length <= 1}
                        onClick={() => setClauses(clauses.filter((_, i) => i !== index))}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                  <div className={styles.toolbar}>
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() =>
                        setClauses([
                          ...clauses,
                          { id: `c${clauses.length + 1}-${Date.now()}`, field: '', operator: 'eq', value: '' },
                        ])
                      }
                    >
                      添加条件（多个条件为「且」）
                    </button>
                  </div>
                  <div className={styles.toolbar} style={{ marginTop: 10 }}>
                    <div className={styles.toolbarGrow}>
                      <Field label="范围名称" required>
                        <TextInput value={scopeName} onChange={setScopeName} placeholder="例如：仅本人创建" />
                      </Field>
                    </div>
                  </div>
                  <p className={styles.notice}>{describeScope(clauses)}</p>
                  <SaveRow
                    label="保存为命名范围"
                    pending={action.pending}
                    disabled={scopeName.trim() === '' || buildScope(clauses) === null}
                    onSave={() => void saveCustomScope()}
                  />
                  <p className={styles.notice}>
                    内置范围（如仅本人记录）由系统保护，不能在这里改写；已有范围见下方列表。
                  </p>
                  <DataTable
                    columns={[
                      { key: 'name', title: '范围', render: (row) => displayTitle(row.name, row.key) },
                      { key: 'key', title: '标识', render: (row) => <span className={styles.cellMono}>{row.key}</span> },
                      { key: 'resourceName', title: '适用集合', render: (row) => formatCell(row.resourceName) },
                    ]}
                    rows={scopes.rows}
                    rowKey={(row) => row.id}
                    emptyText="当前实例还没有独立记录范围。"
                  />
                </PageCard>
              </>
            )}
          </div>
        </div>
      ) : null}

      <Modal
        open={fieldEditor !== null}
        title={`字段：${fieldEditor ?? ''}`}
        description="勾选这个动作可以读写的字段。"
        onClose={() => setFieldEditor(null)}
        wide
        footer={
          <button type="button" className={styles.button} onClick={() => setFieldEditor(null)}>
            完成
          </button>
        }
      >
        <StateView state={collectionFields.state} message={collectionFields.message} onRetry={collectionFields.refetch} />
        <div className={styles.toolbar} style={{ marginTop: 8 }}>
          <div className={styles.toolbarGrow}>
            <TextInput value={fieldKeyword} onChange={setFieldKeyword} placeholder="搜索字段" />
          </div>
          <button
            type="button"
            className={styles.button}
            onClick={() => fieldEditor && setActionFields(fieldEditor, fieldOptions.map((field) => field.name))}
          >
            全选
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => fieldEditor && setActionFields(fieldEditor, [])}
          >
            清空
          </button>
        </div>
        <div className={styles.chips} style={{ marginTop: 10 }}>
          {fieldOptions.map((field) => {
            const selected = fieldEditor ? (drafts[fieldEditor]?.fields ?? []) : [];
            return (
              <label key={field.name} className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={selected.includes(field.name)}
                  onChange={(event) =>
                    fieldEditor &&
                    setActionFields(
                      fieldEditor,
                      event.target.checked
                        ? [...selected, field.name]
                        : selected.filter((name) => name !== field.name),
                    )
                  }
                />
                <span>{field.label}</span>
              </label>
            );
          })}
        </div>
        <p className={styles.notice}>
          查看类动作的字段是「可见字段」，新增/修改类动作的字段是「可写字段」；留空表示不额外限定。
        </p>
      </Modal>

      <p className={styles.notice}>
        数据源维度的只读视图见 <Link to="/datasource/access">数据源访问配置</Link>。
      </p>
    </BoardPage>
  );
}

/**
 * 条件行的可读摘要（替代原来直接展示内部过滤条件对象的做法）。
 *
 * 只描述用户填了什么：字段、关系、值；不展示任何内部键名或存储形状。
 * 条件不完整时只说"尚未填写完整"，由保存按钮的禁用态阻止提交。
 */
function describeScope(clauses: ConditionClause[]): string {
  const parts: string[] = [];
  for (const clause of clauses) {
    const field = clause.field.trim();
    const value = clause.value.trim();
    if (field === '' || value === '') continue;
    const operator =
      CONDITION_OPERATOR_LABELS.find((item) => item.value === clause.operator)?.label ?? clause.operator;
    parts.push(`${field} ${operator} ${value}`);
  }
  return parts.length === 0 ? '尚未填写条件。' : `满足：${parts.join('，且 ')}`;
}
