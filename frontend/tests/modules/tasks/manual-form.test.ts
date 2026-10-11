import { describe, expect, it } from 'vitest';
import {
  buildSubmitPayload,
  collectFormBlocks,
  initialValuesOf,
  normalizeSchemaRoot,
  resolveFormKey,
  validateRequired,
} from '../../../src/modules/tasks/manualForm';

/**
 * 人工处理表单的 schema 解析与提交载荷测试。
 *
 * 结构取自固定 2.2.22 的 `ManualInstruction`：
 * `node.config = { schema: {...Formily UI schema...}, forms: { [formKey]: { actions, type, dataSource } } }`。
 * `formKey` 是表单块 schema 的第一个顶层属性名（原生 `FormBlockProvider` 的取值方式）。
 */
const schema = {
  type: 'void',
  properties: {
    form1: {
      type: 'void',
      'x-component': 'Card',
      properties: {
        block1: {
          type: 'void',
          'x-decorator': 'FormBlockProvider',
          'x-component': 'Form',
          'x-component-props': { collection: 'expenses' },
          properties: {
        amount: {
          type: 'number',
          title: '报销金额',
          'x-component': 'InputNumber',
          required: true,
        },
        reason: {
          type: 'string',
          title: '事由',
          'x-component': 'Input',
        },
        urgent: {
          type: 'boolean',
          title: '是否加急',
          'x-component': 'Checkbox',
        },
        category: {
          type: 'string',
          title: '类别',
          'x-component': 'Select',
          enum: [
            { label: '差旅', value: 'travel' },
            { label: '餐费', value: 'meal' },
          ],
        },
          },
        },
      },
    },
  },
};

const forms = {
  form1: {
    type: 'create',
    dataSource: 'main',
    collection: 'expenses',
    actions: [
      { key: 'approve', status: 1, title: '通过' },
      { key: 'reject', status: -5, title: '否决' },
    ],
  },
};

describe('人工处理表单解析', () => {
  it('从 schema 里找出表单块，并按 formKey 关联处理配置', () => {
    const blocks = collectFormBlocks(schema, forms);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.formKey).toBe('form1');
    expect(block.handlerType).toBe('create');
    expect(block.collection).toBe('expenses');
    expect(block.fields.map((field) => field.name)).toEqual(['amount', 'reason', 'urgent', 'category']);
    expect(block.actions.map((action) => action.key)).toEqual(['approve', 'reject']);
    expect(block.actions[0].label).toBe('通过');
  });

  it('没有可识别表单块时返回空数组，不伪造表单', () => {
    expect(collectFormBlocks(undefined, {})).toEqual([]);
    expect(collectFormBlocks({ type: 'void', properties: {} }, {})).toEqual([]);
  });

  it('必填校验拦住空值，并给出字段级中文提示', () => {
    const block = collectFormBlocks(schema, forms)[0];
    const errors = validateRequired(block, { amount: null, reason: '出差' });
    expect(errors).toEqual({ amount: '请填写「报销金额」' });
    expect(validateRequired(block, { amount: 100 })).toEqual({});
  });

  it('提交载荷 `_` 与 formKey 同级（不是嵌在表单对象里）', () => {
    const payload = buildSubmitPayload('form1', 'approve', { amount: 100, reason: '出差' });
    expect(payload).toEqual({
      result: {
        form1: { amount: 100, reason: '出差' },
        _: 'approve',
      },
    });
    // 关键形状：result._ 与 result.form1 同级；body 外层没有 values。
    const result = payload.result as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['_', 'form1']);
    expect(result._).toBe('approve');
  });

  it('初始值优先采用后端已保存的 result[formKey]，schema 默认值兜底', () => {
    const block = collectFormBlocks(schema, forms)[0];
    expect(initialValuesOf(block, { form1: { amount: 42 } })).toEqual({ amount: 42 });
    expect(initialValuesOf(block, undefined)).toEqual({});
  });

  it('未知字段组件被保留并标注，不会从表单里消失', () => {
    const blocks = collectFormBlocks(
      {
        type: 'void',
        properties: {
          form1: {
            'x-decorator': 'FormBlockProvider',
            properties: {
              future: { type: 'string', title: '未来字段', 'x-component': 'SomeFutureWidget' },
            },
          },
        },
      },
      { form1: { actions: [{ key: 'submit' }] } },
    );
    expect(blocks[0].fields.map((field) => field.component)).toEqual(['SomeFutureWidget']);
  });
});

/**
 * 真实配置形状（服务端迁移 `20240325213145-fix-schema.js` 与原生客户端运行时共同确认）：
 * `node.config.schema` 本身是**顶层属性表**，块字段是 `FormBlockProvider` 装饰的 void 容器，
 * 内层才是 `FormV2`；`forms` 的键 = 内层 `FormV2` 字段名。
 */
const nativeSchema = {
  block1: {
    type: 'void',
    'x-decorator': 'FormBlockProvider',
    'x-component': 'CardItem',
    properties: {
      formA: {
        type: 'void',
        'x-component': 'FormV2',
        'x-use-component-props': 'useFormBlockProps',
        properties: {
          grid: {
            type: 'void',
            'x-component': 'Grid',
            properties: {
              row1: {
                type: 'void',
                'x-component': 'Grid.Row',
                properties: {
                  col1: {
                    type: 'void',
                    'x-component': 'Grid.Col',
                    properties: {
                      amount: { type: 'number', title: '报销金额', 'x-decorator': 'FormItem', 'x-component': 'InputNumber', required: true },
                    },
                  },
                },
              },
            },
          },
          actions: {
            type: 'void',
            'x-decorator': 'ActionBarProvider',
            'x-component': 'ActionBar',
            properties: {
              approve: {
                type: 'void',
                title: '通过',
                'x-decorator': 'ManualActionStatusProvider',
                'x-component': 'Action',
                'x-decorator-props': { value: 1 },
              },
            },
          },
        },
      },
    },
  },
};

const nativeForms = {
  formA: { type: 'create', actions: [{ key: 'approve', status: 1, title: '通过' }] },
};

describe('真实 node.config.schema 形状', () => {
  it('schema 是属性表时也能识别块，formKey 取内层 FormV2 字段名', () => {
    const blocks = collectFormBlocks(nativeSchema, nativeForms);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].formKey).toBe('formA');
    expect(blocks[0].fields.map((field) => field.name)).toEqual(['amount']);
    expect(blocks[0].schemaActions).toEqual(['approve']);
  });

  it('normalizeSchemaRoot 兼容属性表与根 schema 两种写法', () => {
    const fromMap = normalizeSchemaRoot(nativeSchema) as Record<string, unknown>;
    expect(fromMap.type).toBe('void');
    expect(Object.keys(fromMap.properties as Record<string, unknown>)).toEqual(['block1']);

    const fromRoot = normalizeSchemaRoot({ type: 'void', properties: nativeSchema }) as Record<string, unknown>;
    expect(Object.keys(fromRoot.properties as Record<string, unknown>)).toEqual(['block1']);

    expect(normalizeSchemaRoot(undefined)).toBeNull();
  });

  it('resolveFormKey 优先内层表单字段名，回退祖先路径上与 forms 匹配的名字', () => {
    expect(resolveFormKey(nativeSchema.block1, nativeForms, ['block1'])).toBe('formA');
    expect(
      resolveFormKey(
        { name: 'block1', properties: { amount: { 'x-component': 'InputNumber' } } },
        { form1: {} },
        ['form1', 'block1'],
      ),
    ).toBe('form1');
  });
});
