import { Link } from 'react-router';
import { MODULE_BY_ID } from '../permissions/modules';
import { useSessionStore } from '../auth/store';
import styles from './screens.module.css';

/**
 * 无权限页：后端**明确拒绝**（403）时的落地页。
 *
 * 说明用户可采取的操作，并引导到有权限的页面；不展示后端原始报错或状态码。
 */
export function AccessDeniedScreen({ moduleId }: { moduleId?: string }) {
  const module = moduleId ? MODULE_BY_ID[moduleId] : undefined;
  const target = module ?? undefined;

  return (
    <div className={styles.centered}>
      <div className={styles.centeredCard}>
        <h2 className={styles.centeredTitle}>
          {target ? `当前角色无法进入「${target.title}」` : '当前角色无法进入该页面'}
        </h2>
        <p className={styles.centeredText}>
          你正在使用的角色没有访问该模块所需的权限。可以尝试切换到其他角色；如果所有角色都不可用，
          请联系管理员为你的账号补充授权。
        </p>
        <div className={styles.centeredActions}>
          <Link className={styles.primaryButton} to="/">
            返回可用页面
          </Link>
          <Link className={styles.secondaryButton} to="/workbench">
            前往工作台
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * 权限"暂时无法确认"页：网络、超时或服务暂时不可用时的落地页。
 *
 * 与"无权限"严格区分：不放行、不伪装成拒绝，提供重试；恢复后按新结果重新判定。
 */
export function UnknownAccessScreen({ moduleId }: { moduleId?: string }) {
  const module = moduleId ? MODULE_BY_ID[moduleId] : undefined;
  const refreshAccess = useSessionStore((state) => state.refreshAccess);
  const retrying = useSessionStore((state) => state.accessState !== 'ready');

  return (
    <div className={styles.centered}>
      <div className={styles.centeredCard}>
        <h2 className={styles.centeredTitle}>
          {module ? `暂时无法确认「${module.title}」的访问权限` : '暂时无法确认访问权限'}
        </h2>
        <p className={styles.centeredText}>
          当前未能从服务得到明确的权限结果，可能是网络不稳定或服务正在启动。你也可以稍后重试，
          或在恢复后重新打开这个页面。
        </p>
        <div className={styles.centeredActions}>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={retrying}
            onClick={() => void refreshAccess()}
          >
            {retrying ? '正在重试…' : '重试'}
          </button>
          <Link className={styles.secondaryButton} to="/workbench">
            前往工作台
          </Link>
        </div>
      </div>
    </div>
  );
}

export function NoAccessScreen() {
  return (
    <div className={styles.centered}>
      <div className={styles.centeredCard}>
        <h2 className={styles.centeredTitle}>当前账号没有可进入的模块</h2>
        <p className={styles.centeredText}>
          你的账号已成功登录，但当前角色没有任何已授权的业务模块。请联系管理员为你的角色配置入口权限，
          或在右上角切换其他角色后重试。
        </p>
        <div className={styles.centeredActions}>
          <Link className={styles.secondaryButton} to="/workbench">
            刷新工作台
          </Link>
        </div>
      </div>
    </div>
  );
}

export function NotFoundScreen() {
  return (
    <div className={styles.centered}>
      <div className={styles.centeredCard}>
        <h2 className={styles.centeredTitle}>页面不存在</h2>
        <p className={styles.centeredText}>你访问的地址不在 Crewloom 的页面清单中，请从左侧导航重新选择。</p>
        <div className={styles.centeredActions}>
          <Link className={styles.primaryButton} to="/">
            返回可用页面
          </Link>
        </div>
      </div>
    </div>
  );
}
