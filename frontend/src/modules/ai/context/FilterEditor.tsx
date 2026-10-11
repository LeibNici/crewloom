/**
 * 结构化筛选编辑器。
 *
 * 产出的是**存储形态**（`{logic, items:[{path, operator, value}]}`）：
 * 服务端 `aiContextDatasources:preview` 与上游 v1 表单都用这一形态，
 * 因此这里不做"另一种筛选语言"，只把服务端需要的形状可视化。
 */
import { FILTER_OPERATORS } from './types';
import type { UiFilterCondition, UiFilterGroup } from './types';
import { Field, Select, TextInput } from '../ui';
import styles from '../group-a.module.css';

interface FilterEditorProps {
  value: UiFilterGroup;
  onChange: (next: UiFilterGroup) => void;
  fields: Array<{ name: string; title?: string }>;
  disabled?: boolean;
  depth?: number;
}

const OPERATOR_OPTIONS = FILTER_OPERATORS.map((item) => ({ value: item.value, label: item.label }));

const NO_VALUE_OPERATORS = new Set(['$empty', '$notEmpty']);

export function FilterEditor({ value, onChange, fields, disabled, depth = 0 }: FilterEditorProps) {
  const fieldOptions = fields.map((field) => ({
    value: field.name,
    label: field.title && field.title !== field.name ? `${field.title}（${field.name}）` : field.name,
  }));

  const replaceItem = (index: number, next: UiFilterCondition | UiFilterGroup) => {
    onChange({ ...value, items: value.items.map((item, at) => (at === index ? next : item)) });
  };

  const removeItem = (index: number) => {
    onChange({ ...value, items: value.items.filter((_item, at) => at !== index) });
  };

  return (
    <div className={styles.stack}>
      <Field label="条件关系">
        <Select
          value={value.logic}
          disabled={disabled}
          onChange={(next) => onChange({ ...value, logic: next === '$or' ? '$or' : '$and' })}
          options={[
            { value: '$and', label: '全部满足（并且）' },
            { value: '$or', label: '任一满足（或者）' },
          ]}
        />
      </Field>

      {value.items.map((item, index) =>
        'logic' in item ? (
          <div key={`group-${index}`} className={styles.rowCard}>
            <FilterEditor
              value={item}
              onChange={(next) => replaceItem(index, next)}
              fields={fields}
              disabled={disabled}
              depth={depth + 1}
            />
            <button type="button" className={styles.buttonSmall} disabled={disabled} onClick={() => removeItem(index)}>
              删除这组
            </button>
          </div>
        ) : (
          <div key={`condition-${index}`} className={styles.fieldRow}>
            <Field label="字段">
              <Select
                value={item.path}
                disabled={disabled}
                onChange={(next) => replaceItem(index, { ...item, path: next })}
                options={fieldOptions}
              />
            </Field>
            <Field label="运算符">
              <Select
                value={item.operator}
                disabled={disabled}
                onChange={(next) => replaceItem(index, { ...item, operator: next })}
                options={OPERATOR_OPTIONS}
              />
            </Field>
            <Field label="值">
              <TextInput
                value={NO_VALUE_OPERATORS.has(item.operator) ? '' : String(item.value ?? '')}
                disabled={disabled || NO_VALUE_OPERATORS.has(item.operator)}
                onChange={(next) => replaceItem(index, { ...item, value: next })}
              />
            </Field>
            <button type="button" className={styles.buttonSmall} disabled={disabled} onClick={() => removeItem(index)}>
              删除
            </button>
          </div>
        ),
      )}

      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.button}
          disabled={disabled}
          onClick={() =>
            onChange({
              ...value,
              items: [...value.items, { path: fieldOptions[0]?.value ?? 'id', operator: '$eq', value: '' }],
            })
          }
        >
          添加条件
        </button>
        {depth < 2 ? (
          <button
            type="button"
            className={styles.button}
            disabled={disabled}
            onClick={() => onChange({ ...value, items: [...value.items, { logic: '$and', items: [] }] })}
          >
            添加条件组
          </button>
        ) : null}
        {value.items.length > 0 ? (
          <button type="button" className={styles.button} disabled={disabled} onClick={() => onChange({ ...value, items: [] })}>
            清空
          </button>
        ) : null}
      </div>
    </div>
  );
}
