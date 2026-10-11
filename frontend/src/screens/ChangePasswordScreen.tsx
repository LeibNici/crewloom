import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { changePassword, changePasswordErrorMessage } from '../auth/api';
import { useSystemSettings } from '../api/systemSettings';
import { PageCard, PageHeader, UnavailableState } from '../components/Card';
import styles from './screens.module.css';

/**
 * 修改密码（PUB-01 账号页）。
 *
 * 真实能力（依据 plugin-auth `actions/auth.ts` 与 `plugin-users` 的 `systemSettings`）：
 *  - 已登录用户 `POST auth:changePassword`，请求体 `{ oldPassword, newPassword, confirmPassword }`；
 *  - 后端系统设置 `enableChangePassword === false` 时整条能力被关闭（403），此时页面只说明原因；
 *  - 旧密码不正确的 401 是"输入不对"，**不是**会话失效（请求层已按 `broadcast: false` 处理）。
 *
 * 安全约定：三个口令只存在于组件内存，提交后立即清空；不预填、不写存储、不进日志。
 */
export function ChangePasswordScreen() {
  const queryClient = useQueryClient();
  const settings = useSystemSettings();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function clearSecrets() {
    setOldPassword('');
    setNewPassword('');
    setConfirmPassword('');
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setDone(false);
    if (!oldPassword || !newPassword || !confirmPassword) {
      setError('请把三项都填写完整。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致，请重新确认。');
      return;
    }
    if (newPassword === oldPassword) {
      setError('新密码不能和原密码相同。');
      return;
    }
    setSubmitting(true);
    try {
      await changePassword({ oldPassword, newPassword, confirmPassword });
      clearSecrets();
      setDone(true);
      // 权限上下文本身没变，但重新确认一次可以让"读不到权限"的页面自己恢复。
      void queryClient.invalidateQueries({ queryKey: ['roles', 'check'] });
    } catch (submitError) {
      clearSecrets();
      setError(changePasswordErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  // 只有后端明确关闭改密能力（enableChangePassword === false）时才整页改为"未开通"；
  // 读取失败不挡用户，提交时后端仍会判定。
  if (settings.data && !settings.data.allowChangePassword) {
    return (
      <div className={styles.stack}>
        <PageHeader title="修改密码" description="修改你自己的登录密码。" />
        <PageCard title="修改密码">
          <UnavailableState
            title="自助修改密码"
            reason="当前后台已关闭自助修改密码，请联系管理员协助重置。"
            hint="这与「暂时没有数据」不同：后台明确关闭了这项能力。"
          />
        </PageCard>
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      <PageHeader
        title="修改密码"
        description="在这里修改你自己的登录密码。修改后当前登录仍然有效，其它设备需要重新登录。"
      />
      <PageCard
        title="修改密码"
        description="为了安全，需要先输入当前使用的密码。"
        actions={
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => {
              clearSecrets();
              setError(null);
              setDone(false);
            }}
          >
            清空
          </button>
        }
      >
        <form className={styles.form} onSubmit={handleSubmit} autoComplete="off" noValidate>
          {error ? (
            <div className={`${styles.alert} ${styles.alertError}`} role="alert">
              {error}
            </div>
          ) : null}
          {done ? (
            <div className={`${styles.alert} ${styles.alertOk}`} role="status">
              密码已修改。下次登录请使用新密码。
            </div>
          ) : null}

          <label className={styles.field}>
            <span className={styles.label}>当前密码</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              disabled={submitting}
              onChange={(event) => setOldPassword(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>新密码</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={newPassword}
              disabled={submitting}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>确认新密码</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              disabled={submitting}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
          <div className={styles.formActions}>
            <button className={styles.primaryButton} type="submit" disabled={submitting}>
              {submitting ? '正在提交…' : '确认修改'}
            </button>
          </div>
        </form>
      </PageCard>
    </div>
  );
}
