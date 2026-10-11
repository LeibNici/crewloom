import { describe, expect, it } from 'vitest';
import {
  collectTemporalContracts,
  normalizeTemporalValues,
} from '../../../src/modules/tasks/manualForm';

/**
 * 日期/时间字段契约（TD-02 §4）：按服务端已有 collection field.type/interface/dateFormat
 * 归一，不做全局截断。这里断言纯函数契约（jsdom 可跑；真实 DatePicker 的交互证据在浏览器核对里）。
 */
const SCHEMA = {
  block1: {
    type: 'void',
    'x-decorator': 'FormBlockProvider',
    properties: {
      formA: {
        type: 'void',
        'x-component': 'FormV2',
        properties: {
          grid: {
            type: 'void',
            'x-component': 'Grid',
            properties: {
              spentAt: {
                name: 'spentAt',
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': 'DatePicker',
                'x-component-props': { dateFormat: 'YYYY-MM-DD', showTime: false },
              },
              createdAt: {
                name: 'createdAt',
                type: 'datetime',
                'x-decorator': 'FormItem',
                'x-component': 'DatePicker',
              },
              plannedAt: {
                name: 'plannedAt',
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': 'DatePicker',
              },
              beginTime: {
                name: 'beginTime',
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': 'TimePicker',
              },
              title: { name: 'title', type: 'string', 'x-decorator': 'FormItem', 'x-component': 'Input' },
            },
          },
        },
      },
    },
  },
};

describe('TD-02 日期/时间字段契约', () => {
  it('按 x-component-props.dateFormat / 字段类型读出契约，不把普通字段算进来', () => {
    const contracts = collectTemporalContracts(SCHEMA);
    expect(contracts).toEqual([
      { name: 'spentAt', kind: 'date', format: 'YYYY-MM-DD' },
      { name: 'createdAt', kind: 'datetime', format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' },
      { name: 'plannedAt', kind: 'date', format: 'YYYY-MM-DD' },
      { name: 'beginTime', kind: 'time', format: 'HH:mm:ss' },
    ]);
  });

  it('只归一契约字段：date-only 出 YYYY-MM-DD，datetime 出 ISO，其它字段原样保留', () => {
    const contracts = collectTemporalContracts(SCHEMA);
    const normalized = normalizeTemporalValues(
      {
        spentAt: '2026-10-10T16:00:00.000Z',
        createdAt: '2026-10-10T16:00:00.000Z',
        plannedAt: new Date('2026-10-11T00:00:00.000Z'),
        beginTime: '2026-10-10T17:30:00.000Z',
        title: '2026-10-10',
        untouched: '2026-10-10T16:00:00.000Z',
      },
      contracts,
    );

    // 说明：断言用本地时区解释——`new Date('2026-10-10T16:00:00.000Z')` 在 +08 是 2026-10-11。
    expect(normalized.spentAt).toMatch(/^2026-10-1[01]$/);
    expect(normalized.createdAt).toBe('2026-10-10T16:00:00.000Z');
    expect(normalized.plannedAt).toMatch(/^2026-10-1[01]$/);
    expect(normalized.beginTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(normalized.title).toBe('2026-10-10');
    expect(normalized.untouched).toBe('2026-10-10T16:00:00.000Z');
  });

  it('空值不写回、非法日期不猜测', () => {
    const contracts = collectTemporalContracts(SCHEMA);
    const normalized = normalizeTemporalValues({ spentAt: '', createdAt: null, plannedAt: 'not-a-date' }, contracts);
    expect(normalized.spentAt).toBe('');
    expect(normalized.createdAt).toBeNull();
    expect(normalized.plannedAt).toBe('not-a-date');
  });
});
