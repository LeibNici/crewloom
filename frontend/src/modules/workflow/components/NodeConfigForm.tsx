import { useMemo, useState } from 'react';
import { readPath, writePath, type NodeFieldKind, type NodeFieldSpec } from '../nodeTypes';
import styles from '../workflow.module.css';

/**
 * 节点配置表单的字段控件（组 C 独占）。
 *
 * 这些控件把 `nodeTypes.ts` 里"来自固定源码的 config 形状"变成可操作的表单：
 *  - 文本/数字/开关/下拉/多值/键值对/JSON/条件列表/结束状态/schema 编辑；
 *  - 所有值都支持引用工作流变量（字符串原样保存，不做猜测性改写）；
 *  - 未知或不支持的形状**不静默丢弃**：以 JSON 形式保留并明确提示。
 */

export interface FieldProps {
  field: NodeFieldSpec;
  value: unknown;
  disabled?: boolean;
  error?: string;
  onChange: (value: unknown) => void;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function asPretty(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 把用户输入转成尽量贴近原本类型的值：数字、布尔、JSON 对象/数组，否则字符串。 */
function coerce(raw: string): unknown {
  const text = raw.trim();
  if (text === '') return undefined;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      return JSON.parse(text);
    } catch {
      return raw;
    }
  }
  return raw;
}

function ObjectEditor({
  value,
  disabled,
  onChange,
}: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const entries = useMemo(() => {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    return Object.entries(record);
  }, [value]);
  const [draftKey, setDraftKey] = useState('');
  const [draftValue, setDraftValue] = useState('');

  const setEntries = (next: Array<[string, unknown]>) => {
    const record: Record<string, unknown> = {};
    for (const [key, item] of next) {
      if (key.trim() !== '') record[key] = item;
    }
    onChange(record);
  };

  return (
    <div className={styles.kvList}>
      {entries.length === 0 ? <span className={styles.cellHint}>还没有内容，可在下面添加字段。</span> : null}
      {entries.map(([key, item], index) => (
        <div key={`${key}-${index}`} className={styles.kvRow}>
          <span className={styles.kvKey}>{key}</span>
          <input
            className={styles.input}
            aria-label={`${key} 的值`}
            disabled={disabled}
            value={asText(item)}
            onChange={(event) => {
              const next = entries.slice();
              next[index] = [key, coerce(event.target.value)];
              setEntries(next);
            }}
          />
          <button
            type="button"
            className={styles.dangerLinkButton}
            disabled={disabled}
            onClick={() => setEntries(entries.filter((_, itemIndex) => itemIndex !== index))}
          >
            移除
          </button>
        </div>
      ))}
      <div className={styles.kvRow}>
        <input
          className={styles.input}
          aria-label="新字段名"
          placeholder="字段名"
          disabled={disabled}
          value={draftKey}
          onChange={(event) => setDraftKey(event.target.value)}
        />
        <input
          className={styles.input}
          aria-label="新字段值"
          placeholder="值（可引用变量）"
          disabled={disabled}
          value={draftValue}
          onChange={(event) => setDraftValue(event.target.value)}
        />
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={disabled || draftKey.trim() === ''}
          onClick={() => {
            setEntries([...entries, [draftKey.trim(), coerce(draftValue)]]);
            setDraftKey('');
            setDraftValue('');
          }}
        >
          添加字段
        </button>
      </div>
    </div>
  );
}

function StringListEditor({
  value,
  disabled,
  onChange,
}: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const items = Array.isArray(value) ? value : [];
  const [draft, setDraft] = useState('');
  return (
    <div className={styles.kvList}>
      {items.length > 0 ? (
        <div className={styles.tagRow}>
          {items.map((item, index) => (
            <span key={`${String(item)}-${index}`} className={styles.listChip}>
              {String(item)}
              <button
                type="button"
                className={styles.linkButton}
                disabled={disabled}
                onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
              >
                移除
              </button>
            </span>
          ))}
        </div>
      ) : (
        <span className={styles.cellHint}>暂无内容。</span>
      )}
      <div className={styles.kvRow}>
        <input
          className={styles.input}
          placeholder="添加一项后回车"
          disabled={disabled}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || draft.trim() === '') return;
            event.preventDefault();
            onChange([...items, draft.trim()]);
            setDraft('');
          }}
        />
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={disabled || draft.trim() === ''}
          onClick={() => {
            onChange([...items, draft.trim()]);
            setDraft('');
          }}
        >
          添加
        </button>
      </div>
    </div>
  );
}

interface ConditionItem {
  uid?: string;
  title?: string;
  engine?: string;
  calculation?: unknown;
  expression?: string;
}

function ConditionsEditor({
  value,
  disabled,
  onChange,
}: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const conditions: ConditionItem[] = Array.isArray(value) ? (value as ConditionItem[]) : [];

  const update = (index: number, patch: Partial<ConditionItem>) => {
    const next = conditions.slice();
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= conditions.length) return;
    const next = conditions.slice();
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    onChange(next);
  };

  return (
    <div className={styles.conditionList}>
      {conditions.length === 0 ? <span className={styles.cellHint}>还没有分支条件，点击下面按钮添加。</span> : null}
      {conditions.map((condition, index) => (
        <div key={condition.uid ?? `condition-${index}`} className={styles.conditionItem}>
          <div className={styles.conditionHeader}>
            <span className={styles.jobIndex}>第 {index + 1} 条</span>
            <input
              className={styles.input}
              aria-label={`第 ${index + 1} 条条件标题`}
              placeholder="条件标题（例如：金额大于 1000）"
              disabled={disabled}
              value={condition.title ?? ''}
              onChange={(event) => update(index, { title: event.target.value })}
            />
            <button
              type="button"
              className={styles.linkButton}
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
            >
              上移
            </button>
            <button
              type="button"
              className={styles.linkButton}
              disabled={disabled || index === conditions.length - 1}
              onClick={() => move(index, 1)}
            >
              下移
            </button>
            <button
              type="button"
              className={styles.dangerLinkButton}
              disabled={disabled}
              onClick={() => onChange(conditions.filter((_, itemIndex) => itemIndex !== index))}
            >
              删除
            </button>
          </div>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>计算引擎</span>
              <select
                className={styles.select}
                aria-label={`第 ${index + 1} 条条件引擎`}
                disabled={disabled}
                value={condition.engine ?? 'basic'}
                onChange={(event) => update(index, { engine: event.target.value })}
              >
                <option value="basic">基础条件</option>
                <option value="math.js">Math.js 表达式</option>
                <option value="formula.js">Formula.js 表达式</option>
              </select>
            </label>
            {(condition.engine ?? 'basic') === 'basic' ? (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>基础条件（JSON）</span>
                <textarea
                  className={styles.textarea}
                  aria-label={`第 ${index + 1} 条基础条件`}
                  rows={3}
                  spellCheck={false}
                  disabled={disabled}
                  value={asPretty(condition.calculation ?? {})}
                  onChange={(event) => {
                    const text = event.target.value;
                    try {
                      update(index, { calculation: text.trim() === '' ? undefined : JSON.parse(text) });
                    } catch {
                      update(index, { calculation: text });
                    }
                  }}
                />
              </label>
            ) : (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>条件表达式</span>
                <input
                  className={styles.input}
                  aria-label={`第 ${index + 1} 条条件表达式`}
                  disabled={disabled}
                  value={condition.expression ?? ''}
                  onChange={(event) => update(index, { expression: event.target.value })}
                />
              </label>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        className={styles.secondaryButton}
        disabled={disabled}
        onClick={() => onChange([...conditions, { uid: `cond-${Date.now()}`, title: '', engine: 'basic' }])}
      >
        添加条件
      </button>
    </div>
  );
}

/** 单个配置字段的控件。 */
export function NodeFieldControl({ field, value, disabled, error, onChange }: FieldProps) {
  const common = { disabled, 'aria-label': field.label } as const;

  const control = (() => {
    const kind: NodeFieldKind = field.kind;
    switch (kind) {
      case 'boolean':
        return (
          <label className={styles.checkboxField}>
            <input
              type="checkbox"
              aria-label={field.label}
              disabled={disabled}
              checked={value === true}
              onChange={(event) => onChange(event.target.checked)}
            />
            <span>是</span>
          </label>
        );
      case 'number':
        return (
          <input
            {...common}
            className={styles.input}
            type="number"
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
          />
        );
      case 'select':
        return (
          <select
            {...common}
            className={styles.select}
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') return onChange(undefined);
              if (raw === 'true') return onChange(true);
              if (raw === 'false') return onChange(false);
              onChange(field.options?.some((option) => typeof option.value === 'string' && option.value === raw) ? raw : coerce(raw));
            }}
          >
            {!field.required ? <option value="">（不设置）</option> : null}
            {(field.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );
      case 'key-value':
        return <ObjectEditor value={value} disabled={disabled} onChange={onChange} />;
      case 'string-list':
        return <StringListEditor value={value} disabled={disabled} onChange={onChange} />;
      case 'condition-list':
        return <ConditionsEditor value={value} disabled={disabled} onChange={onChange} />;
      case 'end-status':
        return (
          <select
            {...common}
            className={styles.select}
            value={String(value ?? '1')}
            onChange={(event) => onChange(Number(event.target.value))}
          >
            <option value="1">成功结束</option>
            <option value="-1">失败结束</option>
          </select>
        );
      case 'json':
      case 'schema':
        return (
          <textarea
            {...common}
            className={styles.textarea}
            rows={kind === 'schema' ? 8 : 4}
            spellCheck={false}
            value={typeof value === 'string' ? value : asPretty(value)}
            onChange={(event) => {
              const text = event.target.value;
              if (text.trim() === '') return onChange(undefined);
              try {
                onChange(JSON.parse(text));
              } catch {
                // JSON 未写完时保留文本，保存前统一校验。
                onChange(text);
              }
            }}
          />
        );
      case 'textarea':
        return (
          <textarea
            {...common}
            className={styles.textarea}
            rows={3}
            spellCheck={false}
            value={asText(value)}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      case 'text':
      default:
        return (
          <input
            {...common}
            className={styles.input}
            value={asText(value)}
            onChange={(event) => onChange(event.target.value)}
          />
        );
    }
  })();

  return (
    <div className={styles.formField}>
      <span className={styles.fieldLabel}>
        {field.label}
        {field.required ? <span className={styles.requiredMark}>*</span> : null}
      </span>
      {control}
      {field.hint ? <span className={styles.cellHint}>{field.hint}</span> : null}
      {error ? <span className={styles.fieldError}>{error}</span> : null}
    </div>
  );
}

export interface NodeConfigFormProps {
  fields: NodeFieldSpec[];
  config: Record<string, unknown>;
  disabled?: boolean;
  errors: Record<string, string>;
  onChange: (config: Record<string, unknown>) => void;
}

/**
 * 已知节点类型的配置表单。
 *
 * `advanced` 字段默认折叠，避免常见配置被 JSON 字段淹没；展开后与普通字段同样可编辑。
 */
export function NodeConfigForm({ fields, config, disabled, errors, onChange }: NodeConfigFormProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const basic = fields.filter((field) => !field.advanced);
  const advanced = fields.filter((field) => field.advanced);
  const render = (field: NodeFieldSpec) => (
    <NodeFieldControl
      key={field.path}
      field={field}
      value={readPath(config, field.path)}
      disabled={disabled}
      error={errors[field.path]}
      onChange={(value) => onChange(writePath(config, field.path, value))}
    />
  );
  return (
    <div className={styles.formBlocks}>
      <div className={styles.formGrid}>{basic.map(render)}</div>
      {advanced.length > 0 ? (
        <div>
          <button type="button" className={styles.secondaryButton} onClick={() => setShowAdvanced((value) => !value)}>
            {showAdvanced ? '收起高级配置' : `展开高级配置（${advanced.length} 项）`}
          </button>
          {showAdvanced ? <div className={styles.formGrid}>{advanced.map(render)}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
