import type { ReactNode } from 'react';
import type { RoleRecord } from './types';
import { localStyles as styles } from './ui';
import { roleLabel } from './display';

/** 组 B 权限页共用的勾选与保存零件（access 模块内部，不对外导出）。 */

export function RoleCheckboxList({
  roles,
  selected,
  onChange,
  disabled,
  emptyText = '没有可分配的角色。',
}: {
  roles: RoleRecord[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  emptyText?: string;
}) {
  if (roles.length === 0) return <span className={styles.cellMuted}>{emptyText}</span>;
  return (
    <div className={styles.chips}>
      {roles.map((role) => (
        <label key={role.name} className={styles.checkboxRow}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={selected.includes(role.name)}
            onChange={(event) =>
              onChange(
                event.target.checked ? [...selected, role.name] : selected.filter((name) => name !== role.name),
              )
            }
          />
          <span>{roleLabel(role)}</span>
        </label>
      ))}
    </div>
  );
}

export function SaveRow({
  disabled,
  pending,
  onSave,
  onReset,
  label = '保存',
  extra,
}: {
  disabled?: boolean;
  pending?: boolean;
  onSave: () => void;
  onReset?: () => void;
  label?: string;
  extra?: ReactNode;
}) {
  return (
    <div className={styles.modalFooter} style={{ justifyContent: 'flex-start' }}>
      <button
        type="button"
        className={`${styles.button} ${styles.buttonPrimary}`}
        disabled={disabled || pending}
        onClick={onSave}
      >
        {pending ? '保存中…' : label}
      </button>
      {onReset ? (
        <button type="button" className={styles.button} onClick={onReset}>
          撤销修改
        </button>
      ) : null}
      {extra}
    </div>
  );
}
