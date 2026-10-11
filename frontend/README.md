# Crewloom 前端

Crewloom 自有前端。P1 已交付公共框架、登录、导航、角色与权限对接；当前阶段按模块补齐业务页面。

**默认后端（本轮目标）**：250 主机上的 `http://172.16.88.250:13000`（NocoBase **2.2.20**，`zh-CN`）。
P1 阶段的隔离实例 `http://172.16.88.250:13080`（2.2.22）仍保留作对照，但**不是**产品默认目标，
它的空数据不能当作 13000 的真实数据验收。

历史验收报告：[../docs/acceptance/p1-frontend.md](../docs/acceptance/p1-frontend.md)。
本阶段准备与地基报告：[../docs/acceptance/full-pages-13000/00-preflight.md](../docs/acceptance/full-pages-13000/00-preflight.md)、
[01 逐页实施与分工计划](../docs/acceptance/full-pages-13000/01-page-implementation-plan.md)、
[02 公共地基](../docs/acceptance/full-pages-13000/02-foundation.md)。

## 环境

| 项 | 本机实测 |
| --- | --- |
| Node | v22.22.2（`engines` 要求 `^20.19.0 \|\| >=22.12.0`） |
| 包管理器 | pnpm 10.33.0（`npm 10.9.7` 解析 vitest 可选 peer 依赖时会崩溃，故不用 npm 安装） |
| 浏览器验收 | 本机 Google Chrome 155，通过 Node 内置 WebSocket 直连 DevTools Protocol |
| 后端 | 产品默认 `http://172.16.88.250:13000`（2.2.20）；P1 对照实例 `http://172.16.88.250:13080`（2.2.22，仅夹具账号） |

## 命令

```bash
pnpm install --store-dir .pnpm-store   # 依赖安装（store 在工程内，不改系统全局配置）
pnpm run dev                            # 开发预览：http://127.0.0.1:5277（product 模式，代理 → 13000）
pnpm run typecheck                      # tsc -b
pnpm run test                           # Vitest：受控单测 + 真实后端只读联调（后端不可达时自动跳过后者）
pnpm run test:live                      # 只跑 P1 实例（13080）的真实只读联调测试
pnpm run build                          # tsc -b && vite build
pnpm run check                          # typecheck + test + build
pnpm run verify:13000                   # 13000 严格只读冒烟 + 证据（本轮公共真实联调入口）
pnpm run verify:backend                 # P1 实例（13080）只读核对与证据采集
pnpm run verify:browser                 # P1 真实浏览器验收 + 截图（需 dev 预览已启动）
pnpm run verify:browser:controlled      # 受控浏览器验收（CDP 拦截 + 本机 mock，不连真实后端）
pnpm run verify:fixtures                # ⚠️ 会写后端：默认拒绝运行（见脚本内说明）
```

严格模式（自动验证必须用这一档）：

```bash
CREWLOOM_TRANSPORT_MODE=strict VITE_DEV_PORT=5278 pnpm run dev   # 浏览器端 + 中间件同时收紧
```

停止预览：在前台终端按 Ctrl-C；若是后台启动，先 `lsof -nP -iTCP:5277 -sTCP:LISTEN` 取 PID，再 `kill <PID>`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VITE_DEV_PORT` | `5277` | 本地开发/预览端口，固定绑定 127.0.0.1 |
| `VITE_API_BASE` | `/api` | API 基路径。开发期走 Vite 代理；独立部署到不同来源时才需改成绝对地址 |
| `CREWLOOM_BACKEND_ORIGIN` | `http://172.16.88.250:13000` | **仅开发期**代理目标，读自 Node 进程环境，不进入前端产物 |
| `CREWLOOM_TRANSPORT_MODE` | `product` | 传输策略模式：`product` 正常用户使用 / `strict` Agent 自动验证。设置后同时收紧浏览器端与中间件 |
| `CREWLOOM_SHOT_DIR` | `docs/acceptance/p1-repair/screenshots` | 浏览器验收截图目录 |
| `CONTROLLED_ONLY` | 空 | 只跑某一个受控浏览器场景（如 `role-revoked`） |
| `CREWLOOM_ALLOW_FIXTURE_WRITE` | 未设置 | 仅当为 `1` 时 `verify:fixtures` 才会写后端；默认禁止设置 |
| `CREWLOOM_LIVE_BACKEND_ORIGIN` | `http://172.16.88.250:13080` | P1 夹具账号所在实例；`test:live`/`verify:backend` 用它，不跟随产品默认目标 |
| `CREWLOOM_REPORT_OUT` | 见脚本 | 只读核对的证据输出路径 |

约束：所有 `VITE_*` 变量都会被打进前端产物，**禁止**填写密码、令牌或任何后端凭据。
本工程的示例文件只包含端口与 API 基路径。

## 开发期代理与来源校验

该实例对 `auth:signIn` 做可信来源校验：请求带任何非可信 `Origin`（包括
`http://127.0.0.1:5277`）都会返回 403 `Invalid sign-in origin`。因此 Vite 开发代理
只转发到固定后端地址，并在转发时移除 `Origin`/`Referer`。这是开发期最小改动方案，
**未**修改 250 上的任何配置，也**未**使用通配 CORS。正式部署应改为同域部署，
或把前端来源加入实例可信来源。

## 目录结构

```
src/
  api/          请求层：基于 @nocobase/sdk 的 APIClient、传输策略（product/strict）、错误分类、公共取数钩子
    actions/    各模块的只读/产品动作分片（**由对应负责组独占修改**）
  auth/         登录态状态机、会话存储（crewloom.session.*）、本人角色读取、类型定义
  permissions/  权限语义层：三态判定、模块/页面可见性计算（模块声明不在这里）
  modules/      模块注册表 + 各模块目录（三组并行工作区）
    registry.ts 聚合器（公共负责人唯一维护）
    types.ts    模块/页面公共类型与 defineModule
    workbench/ ai/ model/    组 A
    datasource/ access/      组 B
    workflow/ tasks/         组 C
  app/          路由（注册表驱动）、守卫、布局（侧栏/顶栏/窄屏抽屉）
  components/   基础卡片、状态标签、空状态等
  screens/      登录、工作台、模块页、无权限/无法确认/不存在页
  styles/       设计变量与全局样式（浅蓝灰背景、白色圆角卡片、蓝色主操作）
vendor/         @nocobase/utils 的最小本地适配包（SDK 发布产物的未声明依赖，仅两个纯函数）
tests/          受控单测 + 真实后端只读联调测试（live-backend）
scripts/       传输策略、13000/P1 只读核对、真实/受控浏览器验收
```

## 三组并行与文件边界

| 组 | 模块目录（独占） | 动作分片（独占） |
| --- | --- | --- |
| A（AI + LM） | `src/modules/ai/**`、`src/modules/model/**` | `src/api/actions/ai.json`、`model.json` |
| B（DS + AC） | `src/modules/datasource/**`、`src/modules/access/**` | `datasource.json`、`access.json` |
| C（WF + TD） | `src/modules/workflow/**`、`src/modules/tasks/**` | `workflow.json`、`tasks.json` |

**公共负责人唯一维护**：`src/modules/registry.ts`、`src/modules/types.ts`、`src/modules/workbench/**`、
`src/app/**`、`src/api/**`（动作分片除外）、`src/auth/**`、`src/permissions/**`、
`src/components/**`、`src/styles/**`、工程配置（`vite.config.ts` / `tsconfig*` / `package.json` / `pnpm-lock.yaml`）。

组内新增页面：在自己的 `src/modules/<id>/index.tsx` 的 `boards` 里加条目（`path` 可带参数，
如 `conversations/:sessionId`），并把页面组件填到 `Component`；未填时自动回退到公共占位页。
需要新的公共接口时提给公共负责人，不要直接改上面的公共文件。

> 初始化顺序约定：页面组件**不要在模块顶层读取** `src/modules/registry.ts` 或
> `src/permissions/modules.ts` 的导出值（存在单向再导出链），只在组件函数体内使用。

## 请求层与传输层约束

- HTTP、方法选择、参数与响应序列化由 `@nocobase/sdk@2.2.22` 的 `APIClient` 负责；
  本项目只保留最小会话/错误适配（`x-new-token` 续期、401 角色失效与会话失效分开、旧响应隔离）。
- **登录/退出走 SDK 的请求管线**（`api.request` POST `auth:signIn` / `auth:signOut`），
  **不用** `Auth.signIn/signOut` 便捷方法——后者会在 `await` 之后自行写当前存储。
  令牌/角色/认证方式的写入与清理都在 `auth/store.ts` 的**操作 ID（authOpSeq）**校验之后执行，
  因此"旧退出响应晚于换号返回"不会清掉新账号。
- **角色失效广播带角色上下文判定**：只有请求发出时的角色与当前角色一致时才广播，
  旧角色的晚到 401 不再清掉用户已切换到的合法角色（真实失效与 `x-new-token` 续期不受影响）。
- 令牌/角色/认证方式持久化在 `crewloom.session.token` / `.role` / `.auth`（由 SDK 的存储适配器读写）。
- 传输策略唯一来源是 `src/api/transport-policy.json` + `src/api/actions/*.json`（由 `src/api/policy.ts` 静态合并）。
  浏览器 axios 拦截器、Vite 中间件、Node 验证脚本三处共用同一判定，且都在**请求发出前**执行。
  两种模式：
  - `product`（缺省，正常用户使用）：只固定目的地与 `/api` 前缀，动作由后端认证与 ACL 最终判定
    ——**真实用户可以保存**；
  - `strict`（Agent 自动验证）：默认拒绝，只放行允许清单内的只读 GET 与登录/退出 POST，
    并硬拦有外部副作用的动作（`ai:listModels`、`aiMcpClients:listTools`、`flow_nodes:test`…），
    **不靠"是不是 GET"来判断有没有副作用**。
  自动真实验证必须用 strict；产品的保存能力不受自动测试限制。
  网络层审计证据见 [传输模式网络审计](../docs/acceptance/full-pages-13000/evidence/checks/transport-mode-network-audit.md)。
- `@nocobase/sdk` 的发布产物未声明 `@nocobase/utils/client`（只用到一个纯函数），
  由 `vendor/nocobase-utils-client` 通过 `link:` 依赖提供最小实现，避免引入整个 utils 包
  及其未声明依赖（`flat` 等）。

## 权限模型（前端侧）

1. 登录态、权限上下文与菜单可见性来自真实后端；前端不按角色名（`admin`/`root`）硬编码。
2. 菜单与入口以**运行期只读探测**为准（登录或切换角色后立即执行）；`roles:check`
   的片段/显式资源授权/显式否定/动作别名语义用于可解释的兜底判断。
3. 探测结果分三类：`allowed`（明确允许）、`denied`（403 明确拒绝）、`unknown`
   （401 认证/角色失效、网络、超时、5xx）。**unknown 不放行、也不显示为无权限**，
   界面提供"重试"，恢复后按新结果重新判定；后端鉴权始终保留。
4. **角色候选的唯一来源是 `GET /api/auth:check` 的 `data.roles`**（该用户全部所属角色，
   含 `name`/`title`；只需 `loggedIn`，不需要 `roles:view`），与原生角色切换 UI 一致。
   不再调用 `users/<id>/roles:list`，也没有"换默认角色再查询"的回退。
   `roles:check.roles` 是"当前生效角色集合"，不作为候选来源。
   证据见 [p1-repair.md](../docs/acceptance/p1-repair.md)。
5. 401 按原生错误码分开处理：`ROLE_NOT_FOUND_FOR_USER` / `ROLE_NOT_FOUND_ERR` →
   清本地角色选择（保留令牌）并重新读取本人角色与权限（**仅当该 401 来自当前角色上下文**；
   旧角色的晚到 401 只影响它自己的调用方）；`AuthErrorCode`
   （EMPTY/EXPIRED/INVALID_TOKEN、TOKEN_RENEW_FAILED、BLOCKED_TOKEN、EXPIRED_SESSION、
   NOT_EXIST_USER、SKIP_TOKEN_RENEW、USER_HAS_NO_ROLES_ERR）→ 真正的会话失效，退出登录。
6. 角色模式遵循原生语义：`only-use-union` **不显示**切换控件并显示合并身份；
   `allow-use-union` 允许已授权单角色与合并角色；`default` 不提供合并角色。
   `roleMode` **缺省/空值**按原生 `|| SystemRoleMode.default` 落到 `default`；
   **非空但不在原生三个枚举内**（只能来自直接写库/历史数据）保持 `unknown`：不提供合并角色，
   也不悄悄当成 `default`（原生只有 `default`/`allow-use-union`/`only-use-union`，见
   `src/permissions/model.ts` 注释与 [p1-repair.md](../docs/acceptance/p1-repair.md) §3.4）。
   权限上下文读取失败仍是可重试的 `unknown`，不放行。
7. **与原生仍保留的差异**：角色选择只写本地（`X-Role` + SDK 角色 Cookie），
   不调用 `users:setDefaultRole`，因此不跨设备持久化。
   **导航授权仍用运行期探测，不把 13000 上的原页面路由授权（`roles/<role>/desktopRoutes`，
   member 135 条）伪映射成 Crewloom 页面 path**：那是 NocoBase 低代码页面的入口控制，
   由 AC-03 页面按原关系真实读取与维护（写入只在受控验证环境），与 Crewloom 管理页面的入口是两条线。
   详见 [p1-repair.md](../docs/acceptance/p1-repair.md) 与
   [01 逐页实施计划](../docs/acceptance/full-pages-13000/01-page-implementation-plan.md) §12 DC-3。
8. 角色名称读不到时界面显示"当前角色"，不回退展示内部角色标识，也不靠扩大权限来修复显示。
9. 后端始终是最终判定者：界面隐藏入口不是安全边界。

## 安全约定

- 令牌只用于本机会话恢复，不写入源码、示例、构建变量、日志或截图。
- 测试夹具凭据位于 `.secrets/crewloom-p1-fixtures.json`（600，已被 `.gitignore` 排除）；
  管理员凭据位于 `.secrets/250-crewloom-dev.env`（600）。两者内容都不进入报告。
- 报告中出现的 `crewloom_p1_*@crewloom.test` 是**公开的夹具登录邮箱**，不是口令或令牌。
- `scripts/setup-fixtures.mjs` 会写后端，P1 修复轮默认拒绝运行（需 `CREWLOOM_ALLOW_FIXTURE_WRITE=1`）。
- 真实联调：产品默认目标是 `http://172.16.88.250:13000`（只读，凭据仅在进程内存读取）；
  自动验证脚本强制 `strict` 模式，未授权写入与外部副作用动作在发出前拦截。
  P1 夹具账号只存在于 `http://172.16.88.250:13080`，`test:live` / `verify:backend` 显式固定该实例。
- 13000 的只读核对脚本为 `scripts/verify-13000-readonly.mjs`（`pnpm run verify:13000`），
  凭据只从 `.secrets/full-pages-13000-20261011.json`（600）在进程内读取，不进 argv/环境变量/日志/证据。

## 测试：默认为本机，真实联调需显式启用

- `pnpm run test`（= `vitest run`）与任何 `pnpm exec vitest run <目录/文件>` **只收集本机用例**：
  `vitest.config.ts` 默认排除 `tests/**/live-*.test.*`、`tests/**/*-live-13000*.test.*`、
  `tests/**/*live-read-13000*.test.*`。被排除的文件**不会被收集**，因此它们模块顶层的
  `.secrets/**` 读取与真实 HTTP 都不会发生。
- 需要真实联调时**显式**启用：`pnpm run test:live`（= `CREWLOOM_LIVE_TESTS=1 vitest run`），
  或 `pnpm run test:live:backend`（只跑 P1/13080 那一个文件）。真实用例、断言与覆盖范围均未删减。
- 真实联调用例范围（7 个文件）：`tests/live-13000-sdk.test.ts`、`tests/live-backend.test.ts`、
  `tests/modules/access/access-live-13000.test.ts`、`tests/modules/ai/live-13000-group-a.test.ts`、
  `tests/modules/ai/live-13000-group-a-pages.test.tsx`、`tests/modules/datasource/datasource-live-13000.test.ts`、
  `tests/modules/workflow/live-read-13000.test.ts`。运行前请自行确认目标可达与授权范围。
- 收集自检：`pnpm exec vitest list`（默认，应为 0 个 live 文件）与
  `CREWLOOM_LIVE_TESTS=1 pnpm exec vitest list`（显式，应列出上述 7 个文件）。
