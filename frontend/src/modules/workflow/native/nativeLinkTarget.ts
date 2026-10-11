/**
 * 原生画布宿主的链接目标解析（纯函数，不依赖原生运行时，便于单测）。
 *
 * 契约来自固定 vendor 源码与 react-router 的 `useHref` 实现：`react-router-dom` 的
 * `<Link to>` 最终把目标交给 navigator 的 `createHref()`，而 `useHref()` 传进来的是
 * **解析后的路径对象** `{ pathname, search, hash }`，不是原始字符串。
 *
 * 宿主早期实现用 `String(to)` 处理该对象，于是面包屑的 DOM `href` 变成 `[object Object]`
 * （浏览器把相对地址解析成 `/workflow/[object Object]`，点击无法返回）。
 * 这里同时接受字符串与对象两种形态（`useNavigate`/`navigate()` 也会传对象）。
 */
export function resolveNativeLinkTarget(to: unknown): string {
  if (typeof to === 'string') return to;
  if (to && typeof to === 'object') {
    const target = to as { pathname?: unknown; search?: unknown; hash?: unknown };
    const pathname = typeof target.pathname === 'string' ? target.pathname : '';
    const search = typeof target.search === 'string' ? target.search : '';
    const hash = typeof target.hash === 'string' ? target.hash : '';
    return `${pathname}${search}${hash}`;
  }
  return to === null || to === undefined ? '' : String(to);
}

/** 原生 header 面包屑里的「工作流」首页（上游 `WorkflowCanvasHeader` 的 `WORKFLOW_HOMEPAGE`）。 */
export const WORKFLOW_HOMEPAGE_PATTERN = /^\/admin\/(?:settings\/)?workflow\/?$/;

/** 目标（去掉 query/hash 后）是否是原生工作流首页。 */
export function isWorkflowHomeTarget(to: unknown): boolean {
  const target = resolveNativeLinkTarget(to);
  return WORKFLOW_HOMEPAGE_PATTERN.test(target.split(/[?#]/)[0]);
}
