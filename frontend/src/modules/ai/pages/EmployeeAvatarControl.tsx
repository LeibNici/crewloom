import { useMemo, useState } from 'react';
import { EMPLOYEE_AVATAR_SEEDS, isKnownEmployeeAvatar, renderEmployeeAvatar } from './employeeAvatars';
import styles from '../group-a.module.css';

/**
 * AI-02 员工配置的头像宿主。
 *
 * 真实交互：
 *  - 当前头像按**保存值**真实渲染（与原生组件同一渲染链，见 `employeeAvatars.ts`）；
 *  - 从内置头像清单里点选（清单来自固定源码的 `avatarsMap`，不是自造列表）；
 *  - 也允许直接填写标识（兼容后端已有但不在内置清单里的历史值）；
 *  - 选择结果进入表单状态，由页面既有的「保存」调用真实 `aiEmployees:update`，
 *    这里**不自行发请求**，也不上传文件（该字段是标识字符串，不是文件字段）。
 */
export function EmployeeAvatarControl({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => renderEmployeeAvatar(value), [value]);
  const known = isKnownEmployeeAvatar(value);

  return (
    <div className={styles.avatarHost} data-testid="employee-avatar-host">
      <div className={styles.avatarRow}>
        {preview ? (
          <img className={styles.avatarImage} src={preview} alt="" width={48} height={48} />
        ) : (
          <span className={styles.avatarFallback} aria-hidden="true">
            {(value || '员').slice(0, 1)}
          </span>
        )}
        <div className={styles.avatarText}>
          <span className={styles.fieldHint}>
            {value
              ? known
                ? `当前头像：${value}`
                : `当前头像：${value}（自定义）`
              : '尚未设置头像，将使用默认头像。'}
          </span>
          {!disabled ? (
            <button
              type="button"
              className={styles.button}
              aria-label={open ? '收起头像清单' : '选择头像'}
              onClick={() => setOpen((prev) => !prev)}
            >
              {open ? '收起头像清单' : '选择头像'}
            </button>
          ) : null}
        </div>
      </div>

      {open && !disabled ? (
        <>
          <div className={styles.avatarGrid} role="listbox" aria-label="内置头像">
            {EMPLOYEE_AVATAR_SEEDS.map((seed) => (
              <button
                key={seed}
                type="button"
                role="option"
                aria-selected={seed === value}
                aria-label={seed}
                title={seed}
                className={seed === value ? styles.avatarOptionActive : styles.avatarOption}
                onClick={() => onChange(seed)}
              >
                <img src={renderEmployeeAvatar(seed) ?? ''} alt="" width={36} height={36} loading="lazy" />
              </button>
            ))}
          </div>
          <input
            className={styles.input}
            aria-label="头像标识"
            value={value}
            placeholder="也可以直接填写头像标识"
            onChange={(event) => onChange(event.target.value)}
          />
        </>
      ) : null}
    </div>
  );
}
