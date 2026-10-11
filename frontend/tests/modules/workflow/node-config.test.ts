import { describe, expect, it } from 'vitest';
import {
  CREATABLE_NODE_TYPES,
  defaultConfigFor,
  nodeTypeSpec,
  readPath,
  validateNodeConfig,
  writePath,
} from '../../../src/modules/workflow/nodeTypes';

/**
 * 已知节点类型的配置语义测试。
 *
 * 期望值直接对照固定 2.2.22 源码的 `configSchema`：
 *  - `CalculationInstruction`：`{ engine?, expression? }`
 *  - `ConditionInstruction`：`{ rejectOnFalse(必填), engine, calculation, expression }`
 *  - `MultiConditionsInstruction`：`{ conditions[], continueOnNoMatch? }`
 *  - `QueryInstruction`：`collection(必填) + multiple/params{filter,appends,page,pageSize,sort}/failOnEmpty`
 *  - `CreateInstruction`：`collection(必填) + params{values,appends}`
 *  - `UpdateInstruction`：`collection(必填) + params{filter,values,individualHooks}`
 *  - `DestroyInstruction`：`collection(必填) + params{filter}`
 *  - `OutputInstruction`：`{ value }`
 *  - `EndInstruction`：`{ endStatus: 1 | -1 }`
 *  - `ManualConfig`：`{ schema, forms, assignees?, mode?, title? }`
 */
describe('已知节点类型的配置定义', () => {
  it('覆盖固定源码 registry 的 9 个指令与人工处理节点', () => {
    const types = CREATABLE_NODE_TYPES.map((spec) => spec.type).sort();
    expect(types).toEqual(
      ['calculation', 'condition', 'create', 'destroy', 'end', 'manual', 'multi-conditions', 'output', 'query', 'update'].sort(),
    );
    // 每个类型都有中文题名（页面不显示内部标识）与字段定义。
    for (const spec of CREATABLE_NODE_TYPES) {
      expect(spec.label, spec.type).not.toBe(spec.type);
      expect(spec.fields.length, spec.type).toBeGreaterThan(0);
    }
  });

  it('未知类型不提供表单，交由页面走原始配置边界', () => {
    expect(nodeTypeSpec('some-plugin-node')).toBeNull();
    expect(nodeTypeSpec(null)).toBeNull();
    expect(validateNodeConfig('some-plugin-node', { anything: 1 })).toEqual({});
  });

  it('计算节点按源码要求表达式必填，并做括号体检', () => {
    expect(validateNodeConfig('calculation', { engine: 'math.js', expression: '{{$context.data.a}} + 1' })).toEqual({});
    const missing = validateNodeConfig('calculation', { engine: 'math.js' });
    expect(missing.expression).toContain('计算表达式');
    const unbalanced = validateNodeConfig('calculation', { engine: 'math.js', expression: '(1 + 2' });
    expect(unbalanced.expression).toContain('括号');
  });

  it('条件节点按引擎分别校验：基础条件要有条件组，表达式引擎要有表达式', () => {
    expect(validateNodeConfig('condition', { rejectOnFalse: true, engine: 'basic' }).calculation).toContain('基础条件');
    expect(validateNodeConfig('condition', { rejectOnFalse: true, engine: 'basic', calculation: { logic: 'and' } })).toEqual({});
    expect(validateNodeConfig('condition', { rejectOnFalse: false, engine: 'math.js' }).expression).toContain('条件表达式');
    expect(validateNodeConfig('condition', { rejectOnFalse: false, engine: 'math.js', expression: '1 === 1' })).toEqual({});
  });

  it('多条件节点要求至少一条有内容的条件', () => {
    expect(validateNodeConfig('multi-conditions', { conditions: [] }).conditions).toBe('请至少添加一条条件');
    expect(validateNodeConfig('multi-conditions', { conditions: [{ title: '', engine: 'basic' }] }).conditions).toContain('第 1 条');
    expect(
      validateNodeConfig('multi-conditions', {
        conditions: [{ title: '金额大于 1000', engine: 'math.js', expression: '{{$context.data.amount}} > 1000' }],
        continueOnNoMatch: false,
      }),
    ).toEqual({});
  });

  it('数据类节点要求数据表必填（对应源码 Collection is not configured）', () => {
    for (const type of ['query', 'create', 'update', 'destroy']) {
      expect(validateNodeConfig(type, {}).collection, type).toContain('数据表');
      expect(validateNodeConfig(type, { collection: 'orders' }), type).toEqual({});
    }
  });

  it('新建节点的初始 config 与源码初值一致', () => {
    expect(defaultConfigFor('calculation')).toEqual({ engine: 'math.js', expression: '' });
    expect(defaultConfigFor('condition')).toEqual({ rejectOnFalse: true, engine: 'basic' });
    expect(defaultConfigFor('end')).toEqual({ endStatus: 1 });
    expect(defaultConfigFor('query')).toEqual({ collection: '', multiple: false, params: {}, failOnEmpty: false });
    expect(defaultConfigFor('some-plugin-node')).toEqual({});
  });

  it('点号路径读写不破坏同级字段', () => {
    const base = { collection: 'orders', params: { values: { a: 1 }, appends: ['x'] }, other: true };
    const next = writePath(base, 'params.values', { a: 2, b: 3 });
    expect(readPath(next, 'params.values')).toEqual({ a: 2, b: 3 });
    expect(readPath(next, 'params.appends')).toEqual(['x']);
    expect(readPath(next, 'other')).toBe(true);
    // 原对象不被修改（避免表单编辑污染已加载的快照）。
    expect(readPath(base, 'params.values')).toEqual({ a: 1 });
    const cleared = writePath(next, 'params.appends', undefined);
    expect(readPath(cleared, 'params.appends')).toBeUndefined();
    expect(readPath(cleared, 'params.values')).toEqual({ a: 2, b: 3 });
  });

  it('人工处理节点覆盖已确认的 ManualConfig 字段', () => {
    const spec = nodeTypeSpec('manual');
    expect(spec).not.toBeNull();
    const paths = spec!.fields.map((field) => field.path);
    expect(paths).toEqual(expect.arrayContaining(['title', 'mode', 'assignees', 'forms', 'schema']));
  });
});
