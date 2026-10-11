import { createAvatar } from '@dicebear/core';
import * as avatarStyle from '@nocobase/ai-employee-avatars';
import seeds from './employeeAvatarSeeds.json';

/**
 * 数字员工头像的真实渲染（AI-02 员工配置的头像宿主）。
 *
 * **为什么不是附件上传**：`aiEmployees.avatar` 在固定源码里是**头像标识字符串**
 * （如 `nocobase-015-male`），不是文件字段——
 *  - 集合定义：`plugin-ai` 的 `aiEmployees.avatar` 是 `string`；
 *  - 原生配置页 `plugin-ai/src/client-v2/pages/EmployeesPage.tsx` 的 `AvatarSelect`
 *    从 `avatarsMap` 里挑标识，保存的就是这个字符串；
 *  - 公共负责人已在 07-public-pages §4.3 把"AI-02 头像挂附件控件"的说法**证据纠正**掉。
 *
 * 因此这里复用**原生同一条渲染链**：`@dicebear/core` 的 `createAvatar` +
 * `@nocobase/ai-employee-avatars`（都是本仓库已锁定的真实依赖），
 * 每个标识对应固定源码里那份预设（`employeeAvatarSeeds.json`），
 * 保证 Crewloom 页面与原生组件对同一个标识渲染出**同一张头像**。
 *
 * 数据来源（只读复制，不改 vendor 原字节）：
 * `vendor/nocobase-2.2.22/packages/plugins/@nocobase/plugin-ai/src/client-v2/ai-employees/avatars.ts`
 * 的 `avatarsMap`（60 个标识，逐字段原样保留；`undefined` 项在 JSON 里省略，
 * 与原生 `{...avatarsMap[seed], mask: undefined, scale: 100}` 的展开等价）。
 */

export const EMPLOYEE_AVATAR_SEEDS: string[] = Object.keys(seeds);

const SEED_OPTIONS = seeds as Record<string, Record<string, unknown>>;

/** 是否是该实例真实存在的头像标识（未知标识不当成内置头像）。 */
export function isKnownEmployeeAvatar(seed: string | null | undefined): boolean {
  return typeof seed === 'string' && seed !== '' && Object.prototype.hasOwnProperty.call(SEED_OPTIONS, seed);
}

/**
 * 渲染头像为 data URI。
 *
 * 未知标识（后端存在但不在内置清单里）按**同一个 seed** 渲染，
 * 保证界面始终能显示一张确定性的头像，而不是空白或伪造的图片地址。
 */
export function renderEmployeeAvatar(seed: string | null | undefined): string | null {
  if (typeof seed !== 'string' || seed === '') return null;
  const preset = SEED_OPTIONS[seed];
  return createAvatar(avatarStyle as never, {
    ...(preset ?? { seed }),
    mask: undefined,
    scale: 100,
  } as never).toDataUri();
}
