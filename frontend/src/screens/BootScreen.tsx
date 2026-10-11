import { createElement } from 'react';
import { useSessionStore } from '../auth/store';
import styles from './screens.module.css';

export function BootScreen({ compact = false }: { compact?: boolean }) {
  return createElement(
    'div',
    { className: compact ? `${styles.boot} ${styles.bootCompact}` : styles.boot },
    createElement('span', { className: styles.bootSpinner, 'aria-hidden': true }),
    createElement('span', null, '正在恢复登录状态…'),
  );
}

/**
 * 无法确认登录状态（网络/服务暂时不可用）时的落地页。
 *
 * 保留令牌、不伪装成未登录、不清权限：提供重试，恢复后按新结果重新判断。
 */
export function UnavailableScreen() {
  const error = useSessionStore((state) => state.error);
  const notice = useSessionStore((state) => state.notice);
  const retry = useSessionStore((state) => state.retryBootstrap);
  return createElement(
    'div',
    { className: styles.boot },
    createElement(
      'div',
      { className: styles.centeredCard },
      createElement('h2', { className: styles.centeredTitle }, '暂时无法确认登录状态'),
      createElement(
        'p',
        { className: styles.centeredText },
        error ?? notice?.message ?? '服务暂时不可用，请稍后重试。',
      ),
      createElement(
        'div',
        { className: styles.centeredActions },
        createElement(
          'button',
          { type: 'button', className: styles.primaryButton, onClick: () => void retry() },
          '重试',
        ),
      ),
    ),
  );
}
