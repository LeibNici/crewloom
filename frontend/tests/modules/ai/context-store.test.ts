import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../../src/auth/store';
import { CODE_WORKSPACE_UID } from '../../../src/modules/ai/context/payload';
import {
  __resetForTests,
  getProposals,
  getSelections,
  recordProposal,
  upsertSelection,
} from '../../../src/modules/ai/context/store';
import type { CodeSelection } from '../../../src/modules/ai/context/types';

/**
 * AI-04 上下文存储的**世代隔离**。
 *
 * 选择里可能带真实业务内容（记录主键、代码、图表配置），因此令牌/会话世代、生效角色或当前
 * 用户任何一项变化都必须立刻作废——不是等用户下次打开页面才清。
 */

const SELECTION: CodeSelection = {
  kind: 'code',
  uid: CODE_WORKSPACE_UID,
  title: '代码工作区',
  scene: 'crewloom-code-workspace',
  language: 'typescript',
  code: 'const total = 1;',
  data: null,
};

beforeEach(() => {
  useSessionStore.setState({ activeRole: 'role_admin', user: { id: 13 } as never });
  __resetForTests();
});

afterEach(() => {
  useSessionStore.setState({ activeRole: null, user: null });
  __resetForTests();
});

describe('AI-04 上下文存储的世代隔离', () => {
  it('生效角色变化时立即清空选择与待确认提案', () => {
    upsertSelection(SELECTION);
    recordProposal({
      id: 'p-1',
      uid: CODE_WORKSPACE_UID,
      toolName: 'apply_code_change',
      args: { code: 'x' },
      preview: null,
      at: new Date().toISOString(),
      status: 'pending',
    });
    expect(getSelections()).toHaveLength(1);
    expect(getProposals()).toHaveLength(1);

    useSessionStore.setState({ activeRole: 'role_limited' });

    expect(getSelections()).toHaveLength(0);
    expect(getProposals()).toHaveLength(0);
  });

  it('当前用户变化时同样清空（重新登录不会带出上一身份的内容）', () => {
    upsertSelection(SELECTION);
    useSessionStore.setState({ user: { id: 99 } as never });
    expect(getSelections()).toHaveLength(0);
  });

  it('同一身份下的正常写入不会互相清空', () => {
    upsertSelection(SELECTION);
    useSessionStore.setState({ access: { allowAll: true } as never });
    expect(getSelections()).toHaveLength(1);
  });
});
