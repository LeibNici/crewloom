import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { useSessionStore } from '../../../auth/store';
import { isResourceActionAllowed } from '../../../permissions/model';
import { PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { CrewloomError } from '../../../api/errors';
import { displayTitle } from '../../access/display';
import { api } from '../../../api/client';
import {
  createEmployee,
  getEmployee,
  listEmployees,
  listSkills,
  listTools,
  resourceMessageOf,
  resourceStateOf,
  updateEmployee,
} from '../resources';
import type { AiEmployeeRow, AiModelSettings, AiSkillSettings } from '../types';
import { EMPLOYEE_CATEGORIES } from '../types';
import { EmployeeAvatarControl } from './EmployeeAvatarControl';
import { Checkbox, Field, ListPager, Notice, Select, StateBlock, TextArea, TextInput, orDash } from '../ui';
import styles from '../group-a.module.css';

/**
 * AI-02 员工配置。
 *
 * 表单字段按固定源码集合定义（`plugin-ai/src/collections/ai-employees.ts`）：
 * `nickname/position/avatar/bio/about/defaultPrompt/greeting/category/deprecated/enabled`
 * 与三个 jsonb 配置 `modelSettings`（专用模型允许集与首选）、`skillSettings`（技能 + 工具）、
 * `dataSourceSettings`（数据范围）。
 *
 * `builtIn` 的约束沿用原生：**基本资料字段禁用**（`EmployeesPage.tsx:435-447` 的 `disabled={builtIn}`），
 * 其余配置仍可保存；不新增原生没有的强制禁用规则。
 *
 * 保存走 `aiEmployees:update`；服务端会把未知键原样保留（jsonb 顶层键写入）。
 * 因此本表单**只提交自己管理的字段**，不整体替换记录。
 */

interface NewEmployeeFormState {
  username: string;
  nickname: string;
  position: string;
  category: string;
}

const PAGE_SIZE = 12;

export function EmployeeConfigPage() {
  const { username } = useParams<{ username?: string }>();
  const navigate = useNavigate();
  const access = useSessionStore((state) => state.access);
  const canManage = isResourceActionAllowed(access, 'aiEmployees', 'update');

  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['ai', 'employees', 'config-list', page],
    queryFn: () => listEmployees({ page, pageSize: PAGE_SIZE, sort: ['-createdAt'] }),
    enabled: !username,
  });

  if (username) {
    return <EmployeeConfigEditor username={username} canManage={canManage} onBack={() => navigate('/ai/employees-config')} />;
  }

  const rows = list.data?.rows ?? [];
  const state = list.isLoading ? 'loading' : resourceStateOf(list.error, rows.length === 0);

  return (
    <div className={styles.stack}>
      <PageHeader
        title="员工配置"
        description="新建或编辑数字员工的资料、提示词、专用模型、技能工具与数据范围，保存后立即生效。"
      />

      <NewEmployeeCard
        canManage={canManage}
        onCreated={(created) => {
          void list.refetch();
          navigate(`/ai/employees-config/${encodeURIComponent(created)}`);
        }}
      />

      <PageCard title="员工记录" description="包含已停用的员工；点「编辑」进入完整配置。">
        <StateBlock
          state={state}
          message={resourceMessageOf(list.error)}
          onRetry={() => void list.refetch()}
          emptyTitle="还没有员工记录"
          deniedDescription="你的角色没有查看员工配置列表的权限。"
        />
        {rows.length > 0 ? (
          <div className={styles.rowList}>
            {rows.map((employee) => (
              <div key={employee.username} className={styles.rowCard}>
                <div className={styles.rowMain}>
                  <div className={styles.chipRow}>
                    <span className={styles.rowTitle}>{employee.nickname || employee.username}</span>
                    {employee.builtIn ? <StatusPill tone="neutral">内置员工</StatusPill> : null}
                    {employee.enabled === false ? <StatusPill tone="warn">已停用</StatusPill> : <StatusPill tone="ok">已启用</StatusPill>}
                  </div>
                  <span className={styles.rowHint}>
                    {employee.position || '未设置岗位'}　账号：{employee.username}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  <Link
                    className={styles.button}
                    to={`/ai/employees-config/${encodeURIComponent(employee.username)}`}
                  >
                    编辑
                  </Link>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <ListPager
          meta={(list.data?.meta ?? {}) as { count?: number; hasNext?: boolean }}
          page={page}
          pageSize={PAGE_SIZE}
          isFetching={list.isFetching}
          onChange={setPage}
        />
      </PageCard>
    </div>
  );
}

function NewEmployeeCard({ canManage, onCreated }: { canManage: boolean; onCreated: (username: string) => void }) {
  const [form, setForm] = useState<NewEmployeeFormState>({
    username: '',
    nickname: '',
    position: '',
    category: 'business',
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const username = form.username.trim();
    if (username.length === 0) {
      setError('请先填写员工账号。');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await createEmployee({
        username,
        nickname: form.nickname.trim(),
        position: form.position.trim(),
        category: form.category,
        enabled: true,
        builtIn: false,
        enableKnowledgeBase: false,
        skillSettings: {},
        modelSettings: {},
        dataSourceSettings: {},
      });
      onCreated(username);
    } catch (caught) {
      setError(caught instanceof CrewloomError ? caught.userMessage : '新建失败，请稍后重试。');
    } finally {
      setPending(false);
    }
  };

  return (
    <PageCard title="新建员工" description="新员工默认启用、非内置；创建后可以在下面的完整配置里继续设置。">
      {canManage ? (
        <>
          <div className={styles.fieldRow}>
            <Field label="员工账号" required hint="唯一标识，创建后不可更改。">
              <TextInput
                value={form.username}
                onChange={(next) => setForm((prev) => ({ ...prev, username: next }))}
                placeholder="例如 assistant-01"
              />
            </Field>
            <Field label="显示名称">
              <TextInput
                value={form.nickname}
                onChange={(next) => setForm((prev) => ({ ...prev, nickname: next }))}
              />
            </Field>
            <Field label="岗位">
              <TextInput value={form.position} onChange={(next) => setForm((prev) => ({ ...prev, position: next }))} />
            </Field>
            <Field label="分类">
              <Select
                value={form.category}
                onChange={(next) => setForm((prev) => ({ ...prev, category: next }))}
                options={EMPLOYEE_CATEGORIES}
              />
            </Field>
          </div>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className={styles.toolbar} style={{ marginTop: 8, marginBottom: 0 }}>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              disabled={pending}
              onClick={() => void submit()}
            >
              {pending ? '正在创建…' : '创建员工'}
            </button>
          </div>
        </>
      ) : (
        <Notice tone="warn">你的角色没有新建员工的权限（需要员工管理权限）。</Notice>
      )}
    </PageCard>
  );
}

function EmployeeConfigEditor({
  username,
  canManage,
  onBack,
}: {
  username: string;
  canManage: boolean;
  onBack: () => void;
}) {
  const detail = useQuery({
    queryKey: ['ai', 'employees', 'get', username],
    queryFn: () => getEmployee(username),
  });

  const state = detail.isLoading ? 'loading' : resourceStateOf(detail.error, detail.data === null);

  return (
    <div className={styles.stack}>
      <PageHeader
        title={`员工配置：${username}`}
        description="设置这位员工的资料、提示词、可用模型、技能工具与数据范围。"
        actions={
          <button type="button" className={styles.button} onClick={onBack}>
            返回列表
          </button>
        }
      />
      <StateBlock
        state={state}
        message={resourceMessageOf(detail.error)}
        onRetry={() => void detail.refetch()}
        deniedDescription="你的角色没有查看这位员工配置的权限。"
      />
      {detail.data ? (
        <EmployeeForm
          key={detail.data.username}
          employee={detail.data}
          canManage={canManage}
          onSaved={() => void detail.refetch()}
        />
      ) : null}
    </div>
  );
}

export interface EmployeeFormState {
  nickname: string;
  position: string;
  avatar: string;
  bio: string;
  about: string;
  defaultPrompt: string;
  greeting: string;
  enabled: boolean;
  category: string;
  deprecated: boolean;
  modelEnabled: boolean;
  modelLlmService: string;
  modelModel: string;
  modelList: Array<{ llmService: string; model: string }>;
  skills: string[];
  tools: Array<{ name: string; autoCall: boolean }>;
  collections: string[];
}

export function employeeToFormState(employee: AiEmployeeRow): EmployeeFormState {
  const model: AiModelSettings = employee.modelSettings ?? {};
  const skill: AiSkillSettings = employee.skillSettings ?? {};
  const models = Array.isArray(model.models)
    ? model.models
        .filter((item) => typeof item?.llmService === 'string' && typeof item?.model === 'string')
        .map((item) => ({ llmService: item.llmService as string, model: item.model as string }))
    : [];
  const single =
    typeof model.llmService === 'string' && typeof model.model === 'string'
      ? { llmService: model.llmService, model: model.model }
      : null;
  const merged = models.length > 0 ? models : single ? [single] : [];
  return {
    nickname: employee.nickname ?? '',
    position: employee.position ?? '',
    avatar: employee.avatar ?? '',
    bio: employee.bio ?? '',
    about: employee.about ?? '',
    defaultPrompt: employee.defaultPrompt ?? '',
    greeting: employee.greeting ?? '',
    enabled: employee.enabled !== false,
    category: employee.category ?? 'business',
    deprecated: employee.deprecated === true,
    modelEnabled: model.enabled === true,
    modelLlmService: merged[0]?.llmService ?? '',
    modelModel: merged[0]?.model ?? '',
    modelList: merged,
    skills: Array.isArray(skill.skills) ? skill.skills.filter((item): item is string => typeof item === 'string') : [],
    tools: Array.isArray(skill.tools)
      ? skill.tools
          .filter((item) => typeof item?.name === 'string')
          .map((item) => ({ name: item.name as string, autoCall: item.autoCall === true }))
      : [],
    collections: Array.isArray(employee.dataSourceSettings?.collections)
      ? employee.dataSourceSettings!.collections!
          .map((item) => (typeof item?.collection === 'string' ? item.collection : ''))
          .filter((item) => item.length > 0)
      : [],
  };
}

/**
 * 表单状态 → 提交值。
 *
 * 只包含本表单管理的四个字段（加基本资料），**不整体替换**记录：
 * `chatSettings`、`knowledgeBase*`、`builtIn` 等未在此编辑的字段不提交，由后端保留原值。
 */
export function formStateToValues(state: EmployeeFormState): Record<string, unknown> {
  const models = state.modelEnabled
    ? state.modelList.length > 0
      ? state.modelList
      : state.modelLlmService && state.modelModel
        ? [{ llmService: state.modelLlmService, model: state.modelModel }]
        : []
    : state.modelList;
  const first = models[0];
  return {
    nickname: state.nickname,
    position: state.position,
    avatar: state.avatar,
    bio: state.bio,
    about: state.about,
    defaultPrompt: state.defaultPrompt,
    greeting: state.greeting,
    enabled: state.enabled,
    category: state.category,
    deprecated: state.deprecated,
    modelSettings: {
      enabled: state.modelEnabled,
      llmService: first?.llmService,
      model: first?.model,
      models,
    },
    skillSettings: {
      skills: state.skills,
      tools: state.tools.map((tool) => ({ name: tool.name, autoCall: tool.autoCall })),
    },
    dataSourceSettings: {
      collections: state.collections.map((collection) => ({ collection })),
    },
  };
}

function EmployeeForm({
  employee,
  canManage,
  onSaved,
}: {
  employee: AiEmployeeRow;
  canManage: boolean;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EmployeeFormState>(() => employeeToFormState(employee));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'danger' | 'warn'; text: string } | null>(null);
  const builtIn = employee.builtIn === true;

  useEffect(() => {
    setForm(employeeToFormState(employee));
  }, [employee]);

  const services = useQuery({
    queryKey: ['ai', 'llm-services', 'for-employee'],
    queryFn: async () => {
      const result = await api.resourceAction<Array<Record<string, unknown>>>('llmServices', 'list', {
        params: { pageSize: 100, sort: ['-createdAt'] },
      });
      return Array.isArray(result.data) ? result.data : [];
    },
    retry: false,
    staleTime: 60_000,
  });

  const tools = useQuery({
    queryKey: ['ai', 'tools', 'for-employee'],
    queryFn: () => listTools({ pageSize: 300 }),
    staleTime: 60_000,
  });

  const skills = useQuery({
    queryKey: ['ai', 'skills', 'for-employee'],
    queryFn: () => listSkills({ pageSize: 300 }),
    staleTime: 60_000,
  });

  const collections = useQuery({
    queryKey: ['ai', 'collections', 'for-employee'],
    queryFn: async () => {
      const result = await api.resourceAction<Array<Record<string, unknown>>>('collections', 'list', {
        params: { pageSize: 200, sort: ['name'] },
      });
      return Array.isArray(result.data) ? result.data : [];
    },
    retry: false,
    staleTime: 60_000,
  });

  const serviceOptions = useMemo(
    () =>
      (services.data ?? []).map((row) => {
        const name = String(row.name ?? '');
        const title = typeof row.title === 'string' && row.title.length > 0 ? row.title : name;
        return { value: name, label: `${title}（${name}）` };
      }),
    [services.data],
  );

  const save = async () => {
    setPending(true);
    setMessage(null);
    try {
      await updateEmployee(employee.username, formStateToValues(form));
      setMessage({ tone: 'info', text: '已保存。' });
      onSaved();
    } catch (caught) {
      setMessage({
        tone: 'danger',
        text: caught instanceof CrewloomError ? caught.userMessage : '保存失败，请稍后重试。',
      });
    } finally {
      setPending(false);
    }
  };

  const disabled = !canManage;

  return (
    <>
      <PageCard title="基本资料" description={builtIn ? '内置员工的基本资料由系统维护，不能在这里修改。' : undefined}>
        <div className={styles.fieldRow}>
          <Field label="显示名称">
            <TextInput
              value={form.nickname}
              disabled={disabled || builtIn}
              onChange={(next) => setForm((prev) => ({ ...prev, nickname: next }))}
            />
          </Field>
          <Field label="岗位">
            <TextInput
              value={form.position}
              disabled={disabled || builtIn}
              onChange={(next) => setForm((prev) => ({ ...prev, position: next }))}
            />
          </Field>
          <Field label="头像" hint="从预设头像里挑一个，或直接填写头像标识；保存后立即生效。">
            <EmployeeAvatarControl
              value={form.avatar}
              disabled={disabled || builtIn}
              onChange={(next) => setForm((prev) => ({ ...prev, avatar: next }))}
            />
          </Field>
          <Field label="分类">
            <Select
              value={form.category}
              disabled={disabled}
              onChange={(next) => setForm((prev) => ({ ...prev, category: next }))}
              options={EMPLOYEE_CATEGORIES}
            />
          </Field>
        </div>
        <Field label="简介（列表里展示）">
          <TextArea
            value={form.bio}
            rows={2}
            disabled={disabled || builtIn}
            onChange={(next) => setForm((prev) => ({ ...prev, bio: next }))}
          />
        </Field>
        <Field label="详细介绍">
          <TextArea
            value={form.about}
            rows={3}
            disabled={disabled || builtIn}
            onChange={(next) => setForm((prev) => ({ ...prev, about: next }))}
          />
        </Field>
        <Field label="问候语" hint="打开会话时展示给用户的开场白。">
          <TextArea
            value={form.greeting}
            rows={2}
            disabled={disabled || builtIn}
            onChange={(next) => setForm((prev) => ({ ...prev, greeting: next }))}
          />
        </Field>
        <div className={styles.fieldRow}>
          <Checkbox
            label="启用这位员工"
            checked={form.enabled}
            disabled={disabled}
            onChange={(next) => setForm((prev) => ({ ...prev, enabled: next }))}
          />
          <Checkbox
            label="标记为过时"
            checked={form.deprecated}
            disabled={disabled}
            onChange={(next) => setForm((prev) => ({ ...prev, deprecated: next }))}
          />
        </div>
      </PageCard>

      <PageCard title="提示词" description="员工收到消息时使用的系统提示词。">
        <Field label="默认提示词" hint="留空表示由后端使用该员工的默认提示词。">
          <TextArea
            value={form.defaultPrompt}
            rows={5}
            disabled={disabled}
            onChange={(next) => setForm((prev) => ({ ...prev, defaultPrompt: next }))}
          />
        </Field>
      </PageCard>

      <PageCard
        title="专用模型"
        description="启用后，这位员工只能使用下面列出的模型；列表第一个是首选模型。"
      >
        <Checkbox
          label="限制为下面这些模型"
          checked={form.modelEnabled}
          disabled={disabled}
          onChange={(next) => setForm((prev) => ({ ...prev, modelEnabled: next }))}
        />
        {form.modelEnabled && form.modelList.length === 0 ? (
          <Notice tone="warn">
            已启用限制但允许集为空：按当前配置发送消息时后端会拒绝。请至少添加一个模型。
          </Notice>
        ) : null}
        {services.error ? (
          <Notice tone="warn">
            读取服务列表失败，无法从下拉选择：{resourceMessageOf(services.error)} 可以直接填写服务标识与模型标识。
          </Notice>
        ) : null}
        <div className={styles.rowList} style={{ marginTop: 12 }}>
          {form.modelList.map((item, index) => (
            <div key={`${item.llmService}:${item.model}:${index}`} className={styles.rowCard}>
              <div className={styles.rowMain}>
                <span className={styles.rowTitle}>
                  {item.model || '（未填写模型）'} {index === 0 ? <StatusPill tone="brand">首选</StatusPill> : null}
                </span>
                <span className={styles.rowHint}>服务：{item.llmService || '—'}</span>
              </div>
              <div className={styles.rowActions}>
                {index > 0 ? (
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonSmall}`}
                    disabled={disabled}
                    onClick={() =>
                      setForm((prev) => {
                        const next = prev.modelList.slice();
                        const [picked] = next.splice(index, 1);
                        next.unshift(picked);
                        return { ...prev, modelList: next };
                      })
                    }
                  >
                    设为首选
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonSmall} ${styles.buttonDanger}`}
                  disabled={disabled}
                  onClick={() =>
                    setForm((prev) => ({ ...prev, modelList: prev.modelList.filter((_, i) => i !== index) }))
                  }
                >
                  移除
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className={styles.fieldRow} style={{ marginTop: 12 }}>
          <Field label="服务">
            {serviceOptions.length > 0 ? (
              <Select
                value={form.modelLlmService}
                disabled={disabled}
                placeholder="请选择服务"
                options={serviceOptions}
                onChange={(next) => setForm((prev) => ({ ...prev, modelLlmService: next }))}
              />
            ) : (
              <TextInput
                value={form.modelLlmService}
                disabled={disabled}
                placeholder="服务标识（name）"
                onChange={(next) => setForm((prev) => ({ ...prev, modelLlmService: next }))}
              />
            )}
          </Field>
          <Field label="模型标识" hint="可从模型配置页的可用模型里查到。">
            <TextInput
              value={form.modelModel}
              disabled={disabled}
              onChange={(next) => setForm((prev) => ({ ...prev, modelModel: next }))}
            />
          </Field>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>&nbsp;</span>
            <button
              type="button"
              className={styles.button}
              disabled={disabled || form.modelLlmService.length === 0 || form.modelModel.length === 0}
              onClick={() =>
                setForm((prev) => ({
                  ...prev,
                  modelList: [
                    ...prev.modelList.filter(
                      (item) => !(item.llmService === prev.modelLlmService && item.model === prev.modelModel),
                    ),
                    { llmService: prev.modelLlmService, model: prev.modelModel },
                  ],
                  modelLlmService: '',
                  modelModel: '',
                }))
              }
            >
              添加到允许集
            </button>
          </div>
        </div>
      </PageCard>

      <PageCard title="技能与工具" description="选择这位员工可以使用的技能与工具；开启「自动执行」后，员工调用该工具时不再询问。">
        <Field
          label="技能"
          hint={skills.error ? `技能清单读取失败：${resourceMessageOf(skills.error)}` : '点击下方标签加入或移除。'}
        >
          <div className={styles.chipRow}>
            {(skills.data?.rows ?? []).map((skill) => {
              const active = form.skills.includes(skill.name);
              return (
                <button
                  key={skill.name}
                  type="button"
                  className={active ? `${styles.chip} ${styles.chipActive}` : styles.chip}
                  disabled={disabled}
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      skills: active
                        ? prev.skills.filter((name) => name !== skill.name)
                        : [...prev.skills, skill.name],
                    }))
                  }
                >
                  {displayTitle(skill.title, skill.name)}
                </button>
              );
            })}
            {(skills.data?.rows ?? []).length === 0 ? <span className={styles.rowHint}>暂无可选技能。</span> : null}
          </div>
        </Field>

        <Field label="已绑定工具" hint={tools.error ? `工具清单读取失败：${resourceMessageOf(tools.error)}` : undefined}>
          {form.tools.length === 0 ? <span className={styles.rowHint}>没有绑定工具。</span> : null}
          <div className={styles.rowList}>
            {form.tools.map((tool, index) => (
              <div key={tool.name} className={styles.rowCard}>
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>{tool.name}</span>
                  <Checkbox
                    label="自动执行（不询问）"
                    checked={tool.autoCall}
                    disabled={disabled}
                    onChange={(next) =>
                      setForm((prev) => ({
                        ...prev,
                        tools: prev.tools.map((item, i) => (i === index ? { ...item, autoCall: next } : item)),
                      }))
                    }
                  />
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonSmall} ${styles.buttonDanger}`}
                    disabled={disabled}
                    onClick={() =>
                      setForm((prev) => ({ ...prev, tools: prev.tools.filter((_, i) => i !== index) }))
                    }
                  >
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Field>

        <Field label="可添加的工具">
          <div className={styles.chipRow}>
            {(tools.data?.rows ?? [])
              .filter((tool) => {
                const name = tool.definition?.name;
                return typeof name === 'string' && name.length > 0 && !form.tools.some((item) => item.name === name);
              })
              .slice(0, 120)
              .map((tool) => {
                const name = tool.definition?.name as string;
                return (
                  <button
                    key={name}
                    type="button"
                    className={styles.chip}
                    disabled={disabled}
                    title={tool.introduction?.about ?? tool.definition?.description ?? ''}
                    onClick={() =>
                      setForm((prev) => ({ ...prev, tools: [...prev.tools, { name, autoCall: false }] }))
                    }
                  >
                    + {tool.introduction?.title || name}
                  </button>
                );
              })}
          </div>
        </Field>
      </PageCard>

      <PageCard
        title="数据范围"
        description="限定这位员工可以访问的数据集合（格式为 数据源:集合名，主数据源可只写集合名）。"
      >
        <div className={styles.chipRow}>
          {form.collections.map((collection, index) => (
            <span key={`${collection}-${index}`} className={styles.chip}>
              {collection}
              <button
                type="button"
                aria-label={`移除 ${collection}`}
                className={styles.buttonSmall}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}
                disabled={disabled}
                onClick={() =>
                  setForm((prev) => ({ ...prev, collections: prev.collections.filter((_, i) => i !== index) }))
                }
              >
                ×
              </button>
            </span>
          ))}
          {form.collections.length === 0 ? <span className={styles.rowHint}>没有限定数据集合。</span> : null}
        </div>
        <CollectionAdder
          disabled={disabled}
          options={(collections.data ?? [])
            .map((row) => (typeof row.name === 'string' ? row.name : ''))
            .filter((name) => name.length > 0)}
          unavailableHint={
            collections.error ? `集合清单读取失败：${resourceMessageOf(collections.error)}` : undefined
          }
          onAdd={(value) =>
            setForm((prev) =>
              prev.collections.includes(value) ? prev : { ...prev, collections: [...prev.collections, value] },
            )
          }
        />
      </PageCard>

      <PageCard title="保存">
        {!canManage ? <Notice tone="warn">你的角色没有修改员工配置的权限。</Notice> : null}
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        <div className={styles.toolbar} style={{ marginTop: 8, marginBottom: 0 }}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            disabled={disabled || pending}
            onClick={() => void save()}
          >
            {pending ? '正在保存…' : '保存配置'}
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={pending}
            onClick={() => setForm(employeeToFormState(employee))}
          >
            放弃改动
          </button>
          <span className={styles.rowHint}>
            当前记录：{orDash(employee.nickname)}（{employee.username}）
          </span>
        </div>
      </PageCard>
    </>
  );
}

function CollectionAdder({
  disabled,
  options,
  unavailableHint,
  onAdd,
}: {
  disabled: boolean;
  options: string[];
  unavailableHint?: string;
  onAdd: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <div className={styles.fieldRow} style={{ marginTop: 12 }}>
      <Field label="添加集合" hint={unavailableHint ?? '可以手动填写，也可以从下拉建议里选。'}>
        <input
          className={styles.input}
          list="crewloom-ai-collections"
          value={value}
          disabled={disabled}
          placeholder="例如 customers 或 main:customers"
          onChange={(event) => setValue(event.target.value)}
        />
        <datalist id="crewloom-ai-collections">
          {options.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>&nbsp;</span>
        <button
          type="button"
          className={styles.button}
          disabled={disabled || value.trim().length === 0}
          onClick={() => {
            onAdd(value.trim());
            setValue('');
          }}
        >
          添加
        </button>
      </div>
    </div>
  );
}
