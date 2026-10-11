import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { harness, renderRegisteredBoard, resetHarness } from '../access/page-harness';

/**
 * AI-01 员工目录的**卡片展示**（jsdom + 受控 adapter，不连真实后端）。
 *
 * 这里固定的是本次改造的行为边界：
 *  - 卡片上的每一项都来自列表接口**同一行**的真实字段（头像标识、`bio`、`skillSettings.skills`、
 *    `modelSettings`），字段为空就省略，不补默认值、不发每卡额外请求；
 *  - 技能标签文字走「技能中心 / 员工配置」同一份注册表 + 既有 `displayTitle` 解析，
 *    整页只读一次注册表（无 N+1），未收录的标识原样保留，不改写绑定数据；
 *  - 不把 `enabled` 说成"在线"；
 *  - 顶部两个控件互相独立：**查看范围**（可使用 / 可管理两个页签，保持原样）与
 *    **启用状态**（全部状态 / 已启用 / 已停用）；可管理页把状态与关键词合并进后端 list，
 *    可使用页只在已取回的授权集合内本地筛选，换条件回第 1 页；
 *  - 现有交互（搜索、可使用/可管理切换、真实数量、分页、详情/编辑入口）保持；
 *  - 目录页挂载后**不发任何非 GET 请求**。
 */

const IE_ENGINEER = {
  username: 'ie-cost-engineer',
  nickname: 'IE 工价数字人',
  position: 'IE 工价',
  avatar: 'nocobase-015-male',
  bio: '你负责 IE 工价链路：计时申请审核后采集工时、回填测量值、测算工价。',
  builtIn: false,
  deprecated: false,
  skillSettings: {
    skills: ['IE 工价链路', '工时采集', '工价测算', '报表导出'],
    tools: [{ name: 'tool-a' }, { name: 'tool-b' }],
  },
  modelSettings: { enabled: true, models: [{ llmService: '阿里云百炼（OpenAI 兼容）', model: 'deepseek-v3' }] },
};

const PLAIN_EMPLOYEE = {
  username: 'plain-employee',
  nickname: '基础员工',
  position: '助理',
  avatar: null,
  bio: '',
  builtIn: true,
  deprecated: false,
  skillSettings: { skills: [], tools: [] },
  modelSettings: null,
};

beforeEach(() => {
  resetHarness();
  harness.routes['aiEmployees:listByUser'] = { body: { data: [IE_ENGINEER, PLAIN_EMPLOYEE] } };
});

function cards(): HTMLElement[] {
  return screen.getAllByTestId('employee-card');
}

function listRequests() {
  return harness.captured.filter((item) => item.path === 'aiEmployees:list');
}

function lastListRequest() {
  const all = listRequests();
  return all[all.length - 1];
}

describe('AI-01 员工目录卡片', () => {
  it('按真实字段渲染卡片：头像、职责、技能标签、模型摘要与底部统计', async () => {
    renderRegisteredBoard('ai', 'directory', { route: '/ai/directory', path: '/ai/directory' });

    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 5000 });

    const [first, second] = cards();
    expect(first.textContent).toContain('IE 工价数字人');
    expect(first.textContent).toContain('你负责 IE 工价链路');
    // 技能超出 3 个折叠成 +N，真实数量仍在底部统计里。
    expect(within(first).getByText('IE 工价链路')).toBeInTheDocument();
    expect(within(first).getAllByTestId('employee-skill-tag')).toHaveLength(3);
    expect(within(first).getByText('+1')).toBeInTheDocument();
    expect(within(second).queryAllByTestId('employee-skill-tag')).toHaveLength(0);
    expect(first.textContent).toContain('技能 4 · 工具 2');
    // 模型摘要来自 modelSettings（服务商 + 模型名），不是猜的默认值。
    expect(first.textContent).toContain('deepseek-v3（阿里云百炼（OpenAI 兼容））');
    // 头像走既有 dicebear 渲染链（同标识同图），不是外部图片地址。
    const avatar = first.querySelector('img');
    expect(avatar?.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true);
    // 状态只说后台保存的启停事实，不冒充"在线"。
    expect(first.textContent).toContain('已启用');
    expect(first.textContent).not.toContain('在线');

    // 无 avatar / 无 bio / 无技能 / 未启用专用模型的员工：如实省略或说明，不补默认值。
    expect(second.textContent).toContain('基础员工');
    expect(second.querySelector('img')).toBeNull();
    expect(second.textContent).toContain('基');
    expect(second.textContent).toContain('由全局默认模型决定');
    expect(second.textContent).toContain('技能 0 · 工具 0');
    expect(second.textContent).not.toContain('你负责 IE 工价链路');

    // 现有入口保持：详情 / 测试 / 编辑。
    expect(within(first).getByRole('link', { name: '查看详情' })).toHaveAttribute(
      'href',
      '/ai/directory/ie-cost-engineer',
    );
    expect(within(first).getByRole('link', { name: '测试' })).toHaveAttribute('href', '/ai/conversations');
    expect(within(first).getByRole('link', { name: '编辑配置' })).toHaveAttribute(
      'href',
      '/ai/employees-config/ie-cost-engineer',
    );

    // 真实数量 + 既有的"一次列出"说明。
    expect(screen.getByTestId('employee-count').textContent).toBe('显示 2 位员工');
    expect(document.body.textContent).toContain('已一次性全部列出');
    // 目录页不自动发写请求。
    expect(harness.posts()).toHaveLength(0);
    expect(harness.captured.map((item) => item.path)).toContain('aiEmployees:listByUser');
  });

  it('技能标签复用注册表的可读标题：内置标识显示中文，未收录标识原样保留，且只读一次注册表', async () => {
    harness.routes['aiEmployees:listByUser'] = {
      body: {
        data: [
          {
            username: 'trade-manager',
            nickname: '贸易经理',
            position: '贸易经理',
            avatar: null,
            bio: '负责看贸易进度。',
            builtIn: false,
            deprecated: false,
            // 真实 `skillSettings.skills` 存的是标识，不是标题。
            skillSettings: { skills: ['document-search', 'data-query', '客户问答'], tools: [] },
            modelSettings: null,
          },
          {
            username: 'plain-employee',
            nickname: '基础员工',
            position: '助理',
            avatar: null,
            bio: '',
            builtIn: true,
            deprecated: false,
            skillSettings: { skills: ['unknown-skill'], tools: [] },
            modelSettings: null,
          },
        ],
      },
    };
    // 注册表：内置技能给 i18n 键（官方中文资源 / 既有 displayTitle 补充表），用户自定义给明文标题。
    harness.routes['aiSkills:list'] = {
      body: {
        data: [
          { name: 'document-search', title: '{{t("ai.skills.documentSearch.title", { ns: "@nocobase/plugin-ai" })}}' },
          { name: 'data-query', title: 'ai.skills.dataQuery.title' },
          { name: '客户问答', title: '客户问答' },
        ],
      },
    };

    renderRegisteredBoard('ai', 'directory', { route: '/ai/directory', path: '/ai/directory' });
    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 5000 });

    const [first, second] = cards();
    // 内置标识经既有解析映射显示中文，用户自定义标题原样保留。
    expect(within(first).getAllByTestId('employee-skill-tag').map((tag) => tag.textContent)).toEqual([
      '文档检索',
      '数据查询',
      '客户问答',
    ]);
    // 注册表里没有的标识不猜、不硬编码，原样显示标识本身。
    expect(within(second).getAllByTestId('employee-skill-tag').map((tag) => tag.textContent)).toEqual(['unknown-skill']);
    // 整页只读一次注册表（不是每张卡片一次），也没有任何写请求。
    expect(harness.captured.filter((item) => item.path === 'aiSkills:list')).toHaveLength(1);
    expect(harness.posts()).toHaveLength(0);
  });

  it('搜索保持本地过滤（不发新请求），无命中时是空态而不是全部', async () => {
    renderRegisteredBoard('ai', 'directory', { route: '/ai/directory', path: '/ai/directory' });
    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 5000 });

    const input = screen.getByLabelText('按名称或岗位筛选员工');
    fireEvent.change(input, { target: { value: 'ie' } });
    await waitFor(() => expect(cards()).toHaveLength(1), { timeout: 5000 });
    expect(cards()[0].textContent).toContain('IE 工价数字人');

    fireEvent.change(input, { target: { value: '不存在的人' } });
    await waitFor(() => expect(screen.queryAllByTestId('employee-card')).toHaveLength(0), { timeout: 5000 });
    // 关键词不再命中时，列表按空结果呈现，而不是回退成全部。
    expect(screen.getByText('当前角色还没有可使用的员工')).toBeInTheDocument();
  });

  it('切到「全部员工（可管理）」走标准 list 动作，数量用后端真实 count，并保留分页', async () => {
    harness.routes['aiEmployees:list'] = {
      body: { data: [PLAIN_EMPLOYEE], meta: { count: 21, page: 1, pageSize: 12, hasNext: true } },
    };
    renderRegisteredBoard('ai', 'directory', { route: '/ai/directory', path: '/ai/directory' });
    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 5000 });

    fireEvent.click(screen.getByRole('button', { name: '全部员工（可管理）' }));

    await waitFor(() => expect(screen.getByTestId('employee-count').textContent).toBe('共 21 位员工'), {
      timeout: 5000,
    });
    expect(harness.captured.map((item) => item.path)).toContain('aiEmployees:list');
    expect(cards()).toHaveLength(1);
    expect(harness.posts()).toHaveLength(0);
  });

  it('顶部状态下拉默认「全部状态」；「可使用」页签在已授权集合内本地筛选，不发新请求', async () => {
    renderRegisteredBoard('ai', 'directory', { route: '/ai/directory', path: '/ai/directory' });
    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 5000 });

    // 原「查看范围」两个页签保持不动，状态下拉是独立的新控件。
    expect(screen.getByRole('button', { name: '我可以使用的员工' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全部员工（可管理）' })).toBeInTheDocument();
    const select = screen.getByTestId('employee-status-filter') as HTMLSelectElement;
    expect(select.value).toBe('all');
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['全部状态', '已启用', '已停用']);

    const listByUserCalls = () => harness.captured.filter((item) => item.path === 'aiEmployees:listByUser').length;
    const before = listByUserCalls();

    // 已启用：mock 的可用集合里两条都不是 enabled=false，仍在本地筛出 2 张，且不发任何新请求。
    fireEvent.change(select, { target: { value: 'enabled' } });
    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 5000 });
    expect(listByUserCalls()).toBe(before);
    expect(listRequests()).toHaveLength(0);

    // 已停用：listByUser 只返回已启用员工，本地筛出 0 张，按空态据实呈现，不越权去请求可管理范围。
    fireEvent.change(select, { target: { value: 'disabled' } });
    await waitFor(() => expect(screen.queryAllByTestId('employee-card')).toHaveLength(0), { timeout: 5000 });
    expect(screen.getByText('可使用的员工里没有「已停用」的员工')).toBeInTheDocument();
    expect(listByUserCalls()).toBe(before);
    expect(listRequests()).toHaveLength(0);

    // 回到「全部状态」：恢复原来的两张卡片（默认值不改变既有行为）。
    fireEvent.change(select, { target: { value: 'all' } });
    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 5000 });
    expect(harness.posts()).toHaveLength(0);
  });

  it('「可管理」把状态与名称/岗位搜索合并进原 list 请求：总数/分页来自后端，换条件回第 1 页', async () => {
    // 后端按筛选条件给出真实总数：带 enabled:false 时 5，否则 21。
    harness.respond((request) => {
      if (request.path !== 'aiEmployees:list') {
        return harness.routes[request.path] ?? { body: { data: [] } };
      }
      const filter = String(request.params.filter ?? '');
      const count = filter.includes('"enabled":false') ? 5 : 21;
      return {
        body: {
          data: [PLAIN_EMPLOYEE],
          meta: { count, page: Number(request.params.page ?? 1), pageSize: 12, hasNext: count > 12 },
        },
      };
    });

    renderRegisteredBoard('ai', 'directory', { route: '/ai/directory', path: '/ai/directory' });
    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 5000 });

    fireEvent.click(screen.getByRole('button', { name: '全部员工（可管理）' }));
    await waitFor(() => expect(screen.getByTestId('employee-count').textContent).toBe('共 21 位员工'), {
      timeout: 5000,
    });
    // 默认「全部状态」不带任何 filter，原查询不变。
    expect(lastListRequest()?.params.filter).toBeUndefined();

    // 先翻到第 2 页。
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(String(lastListRequest()?.params.page)).toBe('2'), { timeout: 5000 });

    // 只改状态：条件进入同一次后端请求，总数换成后端给的 5，并且回到第 1 页。
    fireEvent.change(screen.getByTestId('employee-status-filter'), { target: { value: 'disabled' } });
    await waitFor(() => expect(screen.getByTestId('employee-count').textContent).toBe('共 5 位员工'), {
      timeout: 5000,
    });
    expect(String(lastListRequest()?.params.page)).toBe('1');
    expect(JSON.parse(String(lastListRequest()?.params.filter))).toEqual({ enabled: false });

    // 再叠加名称/岗位关键词：两个条件在后端 $and 合并，仍是第 1 页、总数仍是后端真实值。
    fireEvent.change(screen.getByLabelText('按名称或岗位筛选员工'), { target: { value: '采' } });
    await waitFor(() =>
      expect(JSON.parse(String(lastListRequest()?.params.filter))).toEqual({
        $and: [
          {
            $or: [
              { username: { $includes: '采' } },
              { nickname: { $includes: '采' } },
              { position: { $includes: '采' } },
            ],
          },
          { enabled: false },
        ],
      }),
    );
    expect(String(lastListRequest()?.params.page)).toBe('1');
    expect(lastListRequest()?.params.pageSize).toBe(12);
    expect(screen.getByTestId('employee-count').textContent).toBe('共 5 位员工');

    // 清空筛选（关键词清空 + 回到全部状态）：恢复原来的查询与后端总数。
    fireEvent.change(screen.getByLabelText('按名称或岗位筛选员工'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('employee-status-filter'), { target: { value: 'all' } });
    await waitFor(() => expect(screen.getByTestId('employee-count').textContent).toBe('共 21 位员工'), {
      timeout: 5000,
    });
    expect(lastListRequest()?.params.filter).toBeUndefined();
    expect(String(lastListRequest()?.params.page)).toBe('1');
    expect(harness.posts()).toHaveLength(0);
  });
});
