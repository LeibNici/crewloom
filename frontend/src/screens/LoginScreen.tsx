import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useSessionStore } from '../auth/store';
import { describePasswordRecovery, requestPasswordReset } from '../auth/api';
import { resolveAuthenticator } from '../auth/store';
import { CrewloomError } from '../api/errors';
import { sanitizeReturnTo, defaultLandingPath } from '../app/landing';
import styles from './LoginScreen.module.css';

/**
 * 登录页。
 *
 * 约束：
 *  - 用户必须真实输入邮箱/用户名与密码；不预填、不使用管理员或内置后门。
 *  - 密码只在组件内存中短暂存在，提交后立即清空；不写入 localStorage、
 *    不进入任何日志或构建变量。
 *  - 登录成功后的返回地址只接受站内相对路径（sanitizeReturnTo）。
 *  - 「忘记密码」按后端真实能力显示：认证方式公开选项里 `enableResetPassword === true`
 *    才给出提交入口，否则只说明"当前未开通自助找回"（13000 就是后者）。
 */
export function LoginScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const status = useSessionStore((state) => state.status);
  const access = useSessionStore((state) => state.access);
  const error = useSessionStore((state) => state.error);
  const notice = useSessionStore((state) => state.notice);
  const signIn = useSessionStore((state) => state.signIn);
  const authenticators = useSessionStore((state) => state.authenticators);
  const authenticatorState = useSessionStore((state) => state.authenticatorState);
  const clearNotice = useSessionStore((state) => state.clearNotice);
  const loadAuthenticators = useSessionStore((state) => state.loadAuthenticators);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);

  const recovery = useMemo(() => describePasswordRecovery(authenticators), [authenticators]);

  const requestedReturn = useMemo(
    () => sanitizeReturnTo(new URLSearchParams(location.search).get('returnTo')),
    [location.search],
  );

  // 登录方式来自原生 authenticators:publicList；失败时提示可重试，不硬编码。
  useEffect(() => {
    void loadAuthenticators();
  }, [loadAuthenticators]);

  useEffect(() => {
    if (status === 'authenticated') {
      navigate(requestedReturn ?? defaultLandingPath(access), { replace: true });
    }
  }, [status, requestedReturn, access, navigate]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const trimmed = email.trim();
    if (!trimmed || !password) {
      setLocalError('请填写邮箱或用户名与密码。');
      return;
    }
    setLocalError(null);
    clearNotice();
    setSubmitting(true);
    const ok = await signIn({ email: trimmed, password });
    // 不论成功失败都立刻清空内存中的密码；成功后的跳转由状态监听完成。
    setPassword('');
    setSubmitting(false);
    if (!ok) return;
  }

  const message = localError ?? error ?? notice?.message ?? null;
  const messageTone = localError || error ? styles.alertError : styles.alertInfo;
  const authenticatorBlocked = authenticatorState === 'error';

  function recoveryErrorMessage(recoveryError: unknown): string {
    if (recoveryError instanceof CrewloomError) {
      if (recoveryError.status === 401) return '这个邮箱不在系统中，请确认后重试。';
      if (recoveryError.status === 403) return '当前未开通自助找回密码，请联系管理员协助重置。';
      if (recoveryError.status === 400) return '请填写正确的邮箱地址。';
      return recoveryError.userMessage;
    }
    return '暂时无法提交找回申请，请稍后重试。';
  }

  async function handleRecovery(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (recoveryBusy) return;
    setRecoveryMessage(null);
    const target = resolveAuthenticator(authenticators);
    if (!target) {
      setRecoveryMessage('暂时无法确认可用的登录方式，请稍后重试。');
      return;
    }
    const trimmed = recoveryEmail.trim();
    if (!trimmed) {
      setRecoveryMessage('请填写你的邮箱地址。');
      return;
    }
    setRecoveryBusy(true);
    try {
      await requestPasswordReset(trimmed, target);
      setRecoveryMessage('如果这个邮箱在系统中存在，重置密码的邮件已经发出，请查收并按邮件里的提示操作。');
    } catch (recoveryError) {
      setRecoveryMessage(recoveryErrorMessage(recoveryError));
    } finally {
      setRecoveryBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.brandRow}>
          <span className={styles.brandMark} aria-hidden="true">
            C
          </span>
          <div className={styles.brandText}>
            <strong>Crewloom</strong>
            <span>数字员工协作平台</span>
          </div>
        </div>

        <h1 className={styles.title}>登录</h1>
        <p className={styles.subtitle}>使用你的账号登录，界面将按你的角色显示可用模块。</p>

        {message ? (
          <div className={messageTone} role={messageTone === styles.alertError ? 'alert' : 'status'}>
            {message}
          </div>
        ) : null}
        {authenticatorBlocked ? (
          <div className={styles.alertError} role="alert">
            暂时无法确认可用的登录方式，请检查网络后重试。
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => void loadAuthenticators()}
            >
              重试
            </button>
          </div>
        ) : null}

        <form className={styles.form} onSubmit={handleSubmit} autoComplete="off" noValidate>
          <label className={styles.field}>
            <span className={styles.label}>邮箱或用户名</span>
            <input
              className={styles.input}
              type="text"
              name="crewloom-account"
              value={email}
              autoComplete="off"
              autoFocus
              spellCheck={false}
              disabled={submitting}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>密码</span>
            <input
              className={styles.input}
              type="password"
              name="crewloom-secret"
              value={password}
              autoComplete="new-password"
              disabled={submitting}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          <button className={styles.submit} type="submit" disabled={submitting || authenticatorBlocked}>
            {submitting ? '正在登录…' : '登录'}
          </button>
        </form>

        <div className={styles.recoveryBlock}>
          <button
            type="button"
            className={styles.recoveryToggle}
            aria-expanded={recoveryOpen}
            onClick={() => {
              setRecoveryOpen((open) => !open);
              setRecoveryMessage(null);
            }}
          >
            忘记密码？
          </button>
          {recoveryOpen ? (
            recovery.available ? (
              <form className={styles.recoveryForm} onSubmit={handleRecovery} noValidate>
                <p className={styles.recoveryHint}>
                  填写账号邮箱，我们会发送一封重置密码的邮件。
                </p>
                <label className={styles.field}>
                  <span className={styles.label}>邮箱</span>
                  <input
                    className={styles.input}
                    type="email"
                    autoComplete="off"
                    value={recoveryEmail}
                    disabled={recoveryBusy}
                    onChange={(event) => setRecoveryEmail(event.target.value)}
                  />
                </label>
                <button className={styles.submit} type="submit" disabled={recoveryBusy}>
                  {recoveryBusy ? '正在提交…' : '发送重置邮件'}
                </button>
              </form>
            ) : (
              <p className={styles.recoveryHint}>
                {recovery.reason ?? '当前未开通自助找回密码，请联系管理员协助重置。'}
              </p>
            )
          ) : null}
          {recoveryMessage ? (
            <p className={styles.recoveryHint} role="status">
              {recoveryMessage}
            </p>
          ) : null}
        </div>

        <p className={styles.hint}>登录遇到问题请联系管理员。</p>
      </div>
    </div>
  );
}
