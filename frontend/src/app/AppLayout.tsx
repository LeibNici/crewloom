import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useSessionStore } from '../auth/store';
import { useActiveRoleTitle } from '../auth/useRoleTitle';
import {
  buildRoleChoices,
  isUnionAllowed,
  shouldShowRoleSwitcher,
  UNION_ROLE,
} from '../permissions/model';
import { filterVisibleModules, findModuleByPath, resolveModuleVisibility } from '../permissions/modules';
import { hasUnknownProbe } from '../permissions/probes';
import { RoleBadge } from '../components/Card';
import { AccountMenu } from './AccountMenu';
import styles from './AppLayout.module.css';

/** 侧栏图标：简洁线性图形，不复制参考图中的品牌或菜单图形。 */
function NavIcon({ moduleId }: { moduleId: string }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (moduleId) {
    case 'workbench':
      return createElement('svg', common, createElement('path', { d: 'M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6V11h-6v9Zm0-16v4h6V4h-6Z' }));
    case 'ai':
      return createElement(
        'svg',
        common,
        createElement('circle', { cx: 12, cy: 8, r: 3.4 }),
        createElement('path', { d: 'M5.5 20c.6-3.6 3.2-5.6 6.5-5.6s5.9 2 6.5 5.6' }),
      );
    case 'tasks':
      return createElement(
        'svg',
        common,
        createElement('path', { d: 'M4.5 7.5 6.5 9.5 10 6' }),
        createElement('path', { d: 'M4.5 16.5 6.5 18.5 10 15' }),
        createElement('path', { d: 'M13 8h7M13 17h7' }),
      );
    case 'workflow':
      return createElement(
        'svg',
        common,
        createElement('rect', { x: 3.5, y: 4, width: 6, height: 5, rx: 1.4 }),
        createElement('rect', { x: 14.5, y: 15, width: 6, height: 5, rx: 1.4 }),
        createElement('path', { d: 'M6.5 9v4.5a2 2 0 0 0 2 2H14' }),
      );
    case 'datasource':
      return createElement(
        'svg',
        common,
        createElement('ellipse', { cx: 12, cy: 6, rx: 7, ry: 2.6 }),
        createElement('path', { d: 'M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6' }),
        createElement('path', { d: 'M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6' }),
      );
    case 'model':
      return createElement(
        'svg',
        common,
        createElement('rect', { x: 7.5, y: 7.5, width: 9, height: 9, rx: 2 }),
        createElement('path', { d: 'M10 3.5v4M14 3.5v4M10 16.5v4M14 16.5v4M3.5 10h4M3.5 14h4M16.5 10h4M16.5 14h4' }),
      );
    case 'access':
      return createElement(
        'svg',
        common,
        createElement('path', { d: 'M12 3.5 5 6.2v5.4c0 4.3 2.9 7.5 7 8.9 4.1-1.4 7-4.6 7-8.9V6.2L12 3.5Z' }),
        createElement('path', { d: 'M9.4 12.2 11.3 14l3.4-3.6' }),
      );
    default:
      return createElement('svg', common, createElement('circle', { cx: 12, cy: 12, r: 7 }));
  }
}

export function AppLayout() {
  const status = useSessionStore((state) => state.status);
  const access = useSessionStore((state) => state.access);
  const roles = useSessionStore((state) => state.roles);
  const activeRole = useSessionStore((state) => state.activeRole);
  const error = useSessionStore((state) => state.error);
  const notice = useSessionStore((state) => state.notice);
  const probes = useSessionStore((state) => state.probes);
  const accessState = useSessionStore((state) => state.accessState);
  const switchRole = useSessionStore((state) => state.switchRole);
  const clearNotice = useSessionStore((state) => state.clearNotice);
  const refreshAccess = useSessionStore((state) => state.refreshAccess);
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);

  const isNarrowScreen = () =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;

  const shouldReturnFocus = useRef(false);
  const drawerWasOpen = useRef(false);

  /** 关闭抽屉；`returnFocus` 为真时在关闭后把键盘焦点交还给“导航”按钮。 */
  const closeDrawer = (returnFocus = false) => {
    shouldReturnFocus.current = returnFocus;
    setDrawerOpen(false);
  };

  // 抽屉由开到关后，把焦点交还给触发按钮（在渲染完成后执行，确保按钮标签已更新）。
  useEffect(() => {
    if (drawerOpen) {
      drawerWasOpen.current = true;
      return;
    }
    if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      if (shouldReturnFocus.current) {
        shouldReturnFocus.current = false;
        drawerTriggerRef.current?.focus();
      }
    }
  }, [drawerOpen]);

  // 抽屉打开时：把焦点移入抽屉、Esc 关闭、Tab 焦点限制在抽屉内。
  useEffect(() => {
    if (!drawerOpen) return undefined;
    drawerCloseRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        shouldReturnFocus.current = true;
        setDrawerOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !isNarrowScreen()) return;
      const container = drawerRef.current;
      if (!container) return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const visibleModules = useMemo(
    () => filterVisibleModules(resolveModuleVisibility(access, probes)),
    [access, probes],
  );
  const unionAllowed = isUnionAllowed(access?.roleMode);
  const roleChoices = useMemo(
    () => buildRoleChoices(roles, { allowUnion: unionAllowed }),
    [roles, unionAllowed],
  );
  // 原生语义：only-use-union 不渲染切换控件；default 不提供合并角色；候选为空/未知不提供。
  const showRoleSwitcher = shouldShowRoleSwitcher(access?.roleMode, roles.length, unionAllowed);
  const permissionUnknown = accessState === 'unknown' || hasUnknownProbe(probes);

  const currentModule = findModuleByPath(location.pathname);
  const roleValue = activeRole ?? access?.role ?? '';
  const roleTitle = useActiveRoleTitle(roleValue || null, roles);

  async function handleRoleChange(next: string) {
    if (!next || next === roleValue) return;
    setSwitching(true);
    clearNotice();
    await switchRole(next);
    setSwitching(false);
  }

  if (status !== 'authenticated') {
    return createElement('div', { className: styles.loading }, '正在准备界面…');
  }

  const navItems = probes === null || accessState === 'unknown' ? [] : visibleModules;
  const sidebar = createElement(
    'aside',
    {
      className: styles.sidebar,
      'aria-label': '主导航',
      id: 'crewloom-sidebar',
      ref: (node: HTMLElement | null) => {
        drawerRef.current = node;
      },
    },
    createElement(
      'div',
      { className: styles.brand },
      createElement(
        'button',
        {
          type: 'button',
          className: styles.drawerClose,
          'aria-label': '收起导航',
          ref: (node: HTMLButtonElement | null) => {
            drawerCloseRef.current = node;
          },
          onClick: () => closeDrawer(true),
        },
        createElement('span', { 'aria-hidden': true }, '✕'),
      ),
      createElement('span', { className: styles.brandMark, 'aria-hidden': true }, 'C'),
      createElement(
        'div',
        { className: styles.brandText },
        createElement('strong', null, 'Crewloom'),
        createElement('span', null, '数字员工协作平台'),
      ),
    ),
    createElement(
      'nav',
      { className: styles.nav },
      navItems.map((module) =>
        createElement(
          NavLink,
          {
            key: module.id,
            to: module.path,
            className: ({ isActive }: { isActive: boolean }) =>
              isActive || currentModule?.id === module.id
                ? `${styles.navItem} ${styles.navItemActive}`
                : styles.navItem,
            onClick: () => setDrawerOpen(false),
          },
          createElement(NavIcon, { moduleId: module.id }),
          createElement('span', null, module.title),
        ),
      ),
    ),
    createElement(
      'div',
      { className: styles.sidebarFooter },
      createElement(
        'span',
        { className: styles.sidebarHint },
        accessState === 'unknown'
          ? '暂时无法确认可用模块'
          : probes === null
            ? '正在确认可用模块…'
            : '这里只显示你可以使用的模块',
      ),
    ),
  );

  return createElement(
    'div',
    { className: drawerOpen ? `${styles.shell} ${styles.shellOpen}` : styles.shell },
    createElement(
      'div',
      { className: styles.mobileBar },
      createElement(
        'button',
        {
          type: 'button',
          className: styles.drawerButton,
          'aria-expanded': drawerOpen,
          'aria-label': drawerOpen ? '收起导航' : '展开导航',
          ref: (node: HTMLButtonElement | null) => {
            drawerTriggerRef.current = node;
          },
          onClick: () => (drawerOpen ? closeDrawer(true) : setDrawerOpen(true)),
        },
        createElement('span', { 'aria-hidden': true }, drawerOpen ? '✕' : '☰'),
        createElement('span', null, '导航'),
      ),
      createElement('span', { className: styles.mobileTitle }, currentModule?.title ?? 'Crewloom'),
    ),
    createElement('div', {
      className: styles.drawerBackdrop,
      'aria-hidden': true,
      onClick: () => closeDrawer(true),
    }),
    sidebar,
    createElement(
      'div',
      { className: styles.main },
      createElement(
        'header',
        { className: styles.topbar },
        createElement(
          'div',
          { className: styles.topbarTitle },
          createElement('h1', null, currentModule?.title ?? 'Crewloom'),
          createElement('p', null, currentModule?.subtitle ?? '数字员工协作平台'),
        ),
        createElement(
          'div',
          { className: styles.topbarActions },
          // 只有一个角色时没有可切换项：不渲染空下拉，避免看起来像加载失败。
          // only-use-union 下不渲染（服务端强制合并，单项选择无效），与原生一致。
          showRoleSwitcher
            ? createElement(
                'label',
                { className: styles.rolePicker },
                createElement('span', null, '切换角色'),
                createElement(
                  'select',
                  {
                    value: roleValue,
                    disabled: switching,
                    'aria-label': '切换当前角色',
                    onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                      void handleRoleChange(event.target.value),
                  },
                  roleChoices.map((choice) =>
                    createElement('option', { key: choice.value, value: choice.value }, choice.label),
                  ),
                ),
              )
            : null,
          createElement(
            'div',
            { className: styles.account },
            createElement(AccountMenu),
          ),
        ),
      ),
      createElement(
        'main',
        { className: styles.content },
        error
          ? createElement(
              'div',
              { className: `${styles.banner} ${styles.bannerError}`, role: 'alert' },
              error,
            )
          : null,
        notice
          ? createElement(
              'div',
              { className: `${styles.banner} ${styles.bannerWarning}`, role: 'status' },
              createElement('span', null, notice.message),
              createElement(
                'button',
                {
                  type: 'button',
                  className: styles.ghostButton,
                  onClick: () => clearNotice(),
                },
                '知道了',
              ),
            )
          : null,
        permissionUnknown
          ? createElement(
              'div',
              { className: `${styles.banner} ${styles.bannerWarning}`, role: 'status' },
              createElement(
                'span',
                null,
                '暂时无法确认当前角色的可用范围，可能是网络不稳定或服务正在启动。',
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  className: styles.ghostButton,
                  onClick: () => void refreshAccess(),
                },
                '重试',
              ),
            )
          : null,
        access
          ? createElement(
              'div',
              { className: styles.contextBar },
              createElement('span', null, '当前角色'),
              createElement(RoleBadge, { role: roleValue, label: roleTitle ?? '当前角色' }),
              createElement(
                'span',
                null,
                activeRole === UNION_ROLE
                  ? '正在使用全部角色的合并权限'
                  : showRoleSwitcher
                    ? '切换角色后，可使用的模块与数据范围会随之更新'
                    : '当前账号只有一个可用角色',
              ),
            )
          : null,
        createElement(Outlet),
      ),
    ),
  );
}
