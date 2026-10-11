import { describe, expect, it } from 'vitest';
// 真实上游实现（固定 2.2.22 依赖树里的 `@nocobase/utils`）：用来证明我们的移植没有走样，
// 而不是用一份"看起来一样"的自测。
import { transformFilter } from '@nocobase/utils/lib/transformFilter.js';
import { describeFilter, isUiFilter, toEditableFilter, toServerFilter, validateUiFilter } from '../../../src/modules/ai/context/filter';

/**
 * AI-04 结构化筛选 → 服务端筛选的等价性。
 *
 * 为什么必须等价：`content.filter` 会被服务端 `datasource` 策略**原样**交给
 * `repository.find({ filter })`（`server/manager/ai-context-datasource-manager.ts:107-116`），
 * 而 `aiContextDatasources:preview` 走的是上游 `transformFilter`。两处口径不一致就会出现
 * "预览正确、发送时条件不同"的静默错误。
 */
describe('AI-04 筛选形态转换与上游 transformFilter 等价', () => {
  const cases: Array<{ name: string; ui: unknown }> = [
    {
      name: '单条件',
      ui: { logic: '$and', items: [{ path: 'status', operator: '$eq', value: 'open' }] },
    },
    {
      name: '多条件',
      ui: {
        logic: '$and',
        items: [
          { path: 'status', operator: '$eq', value: 'open' },
          { path: 'amount', operator: '$gte', value: 100 },
        ],
      },
    },
    {
      name: '或关系',
      ui: {
        logic: '$or',
        items: [
          { path: 'status', operator: '$eq', value: 'open' },
          { path: 'status', operator: '$eq', value: 'paid' },
        ],
      },
    },
    {
      name: '嵌套条件组',
      ui: {
        logic: '$and',
        items: [
          { path: 'status', operator: '$eq', value: 'open' },
          { logic: '$or', items: [{ path: 'ownerId', operator: '$eq', value: 3 }] },
        ],
      },
    },
    {
      name: '空值条件被丢弃（与 removeNullCondition 同口径）',
      ui: {
        logic: '$and',
        items: [
          { path: 'status', operator: '$eq', value: 'open' },
          { path: 'note', operator: '$includes', value: '' },
        ],
      },
    },
  ];

  for (const item of cases) {
    it(`与 transformFilter 输出一致：${item.name}`, () => {
      expect(toServerFilter(item.ui)).toEqual(transformFilter(item.ui as never));
    });
  }

  it('全部条件为空时返回 undefined（上游 removeNullCondition 的口径）', () => {
    const ui = { logic: '$and', items: [{ path: 'note', operator: '$includes', value: '' }] };
    expect(toServerFilter(ui)).toBeUndefined();
    expect(transformFilter(ui as never)).toBeUndefined();
  });

  it('null 筛选（界面表示"全部记录"）不会构造出空筛选对象', () => {
    expect(toServerFilter(null)).toBeUndefined();
    expect(toServerFilter(undefined)).toBeUndefined();
  });

  it('旧版纯 JSON 筛选原样保留（不猜转换、不静默丢弃）', () => {
    const legacy = { status: { $eq: 'open' } };
    expect(isUiFilter(legacy)).toBe(false);
    expect(toServerFilter(legacy)).toEqual(legacy);
    expect(toEditableFilter(legacy)).toEqual({ logic: '$and', items: [] });
  });

  it('结构化筛选校验会指出缺失的字段/运算符', () => {
    expect(validateUiFilter({ logic: '$and', items: [] })).toBeNull();
    expect(validateUiFilter({ logic: '$and', items: [{ path: '', operator: '$eq' }] })).toContain('字段');
    expect(validateUiFilter({ logic: '$and', items: [{ path: 'id', operator: '' }] })).toContain('运算符');
  });

  it('给人看的摘要是自然语言，不含 JSON 结构', () => {
    const text = describeFilter({ logic: '$and', items: [{ path: 'status', operator: '$eq', value: 'open' }] });
    expect(text).toContain('status');
    expect(text).toContain('open');
    expect(text).not.toContain('$and');
  });
});
