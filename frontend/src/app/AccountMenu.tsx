import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useSessionStore } from '../auth/store';
import { useActiveRoleTitle } from '../auth/useRoleTitle';
import { api } from '../api/client';
import { toUserMessage } from '../api/errors';
import { languageLabel, useBackendInfo, useSystemSettings } from '../api/systemSettings';
import { AttachmentControl, type AttachmentValue } from '../components/AttachmentControl';
import { useUsersAvatarField } from '../modules/access/operations';
import { DefinitionRow, StatusPill } from '../components/Card';
import styles from './AccountMenu.module.css';

/**
 * 账号菜单（PUB-01 / PUB-06 的落点）。
 *
 * 内容：
 *  - 当前账号与生效角色（角色名来自后端标题，读不到时显示"当前角色"）；
 *  - 修改密码入口（能力由后端 `enableChangePassword` 控制，页面自己会再判一次）；
 *  - **后台信息**：后台应用名称、标志、默认与可用语言、后台版本。
 *
 * 品牌约定：侧栏顶部保持 Crewloom 自己的产品名与标志；这里展示的是**后台应用**的信息
 * （13000 上它是旧实例自己的名称），两者不互相替换，避免把别人的品牌当成 Crewloom。
 */
export function AccountMenu() {
  const user = useSessionStore((state) => state.user);
  const access = useSessionStore((state) => state.access);
  const roles = useSessionStore((state) => state.roles);
  const activeRole = useSessionStore((state) => state.activeRole);
  const signOut = useSessionStore((state) => state.signOut);
  const [logoFailed, setLogoFailed] = useState(false);

  const settings = useSystemSettings();
  const backend = useBackendInfo();
  /**
   * 头像字段能力：`users` 集合没有 `avatar` 时**不渲染上传控件**。
   *
   * 否则用户点了"上传"、文件也真的传上去了，头像却永远不出现——那是把不存在的字段
   * 当作可用能力。判定依据是真实集合字段元数据（与用户详情页同一处判断）。
   */
  const avatarField = useUsersAvatarField();

  const displayName = user?.nickname || user?.username || user?.email || '当前账号';
  const roleValue = activeRole ?? access?.role ?? '';
  const roleTitle = useActiveRoleTitle(roleValue || null, roles);

  const settingsState = settings.isLoading ? 'loading' : settings.isError ? 'unknown' : 'ready';
  const backendTitle = settings.data?.title ?? null;
  const languages = settings.data?.enabledLanguages ?? [];

  // PUB-04：用户头像的真实宿主。`users.avatar` 是 belongsTo attachments 的**文件字段**
  // （与 `aiEmployees.avatar` 不同，后者是头像标识字符串，不是文件），因此这里挂 AttachmentControl。
  // 上传只在真实用户点击时发生；保存走 `users:update`，权限由后端 ACL 判定。
  const queryClient = useQueryClient();
  const userId = typeof user?.id === 'number' ? user.id : null;
  const avatarQuery = useQuery({
    queryKey: ['account', 'avatar', userId],
    enabled: userId !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const result = await api.resourceGet<Record<string, unknown>>('users', userId as number, {
        appends: ['avatar'],
      });
      const avatar = (result.data as { avatar?: unknown } | null)?.avatar;
      return (avatar && typeof avatar === 'object' ? avatar : null) as AttachmentValue | null;
    },
  });
  const saveAvatar = useMutation({
    mutationFn: async (next: AttachmentValue | null) => {
      await api.resourceAction('users', 'update', {
        params: { filterByTk: userId as number },
        values: { avatar: next && next.id != null ? { id: next.id } : null },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['account', 'avatar', userId] });
    },
  });

  return (
    <details className={styles.menu}>
      <summary className={styles.summary} aria-label="账号与后台信息">
        <span className={styles.name}>{displayName}</span>
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </summary>

      <div className={styles.panel}>
        <div className={styles.section}>
          <span className={styles.sectionTitle}>当前账号</span>
          <div className={styles.avatarRow}>
            {avatarField.state === 'available' ? (
              <>
                <AttachmentControl
                  value={avatarQuery.data ?? null}
                  editable={userId !== null}
                  attachmentField="users.avatar"
                  variant="avatar"
                  label="头像"
                  onChange={(next) => saveAvatar.mutate(next)}
                />
                {saveAvatar.isPending ? <span className={styles.hint}>正在保存头像…</span> : null}
                {saveAvatar.isError ? (
                  <span className={styles.hint} role="alert">
                    {toUserMessage(saveAvatar.error)}
                  </span>
                ) : null}
              </>
            ) : avatarField.state === 'loading' ? (
              <span className={styles.hint}>正在确认头像功能…</span>
            ) : avatarField.state === 'missing' ? (
              <span className={styles.hint}>
                本系统还没有开启用户头像功能；如需头像请联系管理员。
              </span>
            ) : (
              <span className={styles.hint}>暂时无法确认头像功能，请稍后重试。</span>
            )}
          </div>
          <DefinitionRow term="登录名">{displayName}</DefinitionRow>
          <DefinitionRow term="邮箱">{user?.email ?? '未设置'}</DefinitionRow>
          <DefinitionRow term="生效角色">{roleTitle ?? '当前角色'}</DefinitionRow>
          <div className={styles.linkRow}>
            <Link className={styles.link} to="/account/password">
              修改密码
            </Link>
          </div>
        </div>

        <div className={styles.section}>
          <span className={styles.sectionTitle}>后台信息</span>
          {settingsState === 'loading' ? (
            <p className={styles.hint}>正在读取后台信息…</p>
          ) : settingsState === 'unknown' ? (
            <p className={styles.hint}>暂时无法读取后台信息，请稍后重试。</p>
          ) : (
            <>
              <div className={styles.brandRow}>
                {settings.data?.logoUrl && !logoFailed ? (
                  <img
                    className={styles.logo}
                    src={settings.data.logoUrl}
                    alt=""
                    onError={() => setLogoFailed(true)}
                  />
                ) : (
                  <span className={styles.logoFallback} aria-hidden="true">
                    {(backendTitle ?? '后').slice(0, 1)}
                  </span>
                )}
                <div className={styles.brandText}>
                  <strong>{backendTitle ?? '未设置应用名称'}</strong>
                  <span>这是后台应用的名称，Crewloom 界面不受它影响</span>
                </div>
              </div>
              <DefinitionRow term="默认语言">
                {languageLabel(settings.data?.appLang) ?? '未设置'}
              </DefinitionRow>
              <DefinitionRow term="可用语言">
                {languages.length > 0
                  ? languages.map((code) => languageLabel(code) ?? code).join('、')
                  : '未设置'}
              </DefinitionRow>
            </>
          )}
          <DefinitionRow term="后台版本">
            {backend.isLoading ? '读取中…' : backend.data?.version ?? '暂时无法读取'}
          </DefinitionRow>
          {settings.data?.roleMode ? (
            <div className={styles.linkRow}>
              <StatusPill tone="neutral">
                {settings.data.roleMode === 'only-use-union'
                  ? '后台强制使用合并角色'
                  : settings.data.roleMode === 'allow-use-union'
                    ? '后台允许使用合并角色'
                    : '后台按单个角色生效'}
              </StatusPill>
            </div>
          ) : null}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.signOut} onClick={() => void signOut()}>
            退出登录
          </button>
        </div>
      </div>
    </details>
  );
}
