# 数字员工目录卡片化 · 变更报告（DSH）

- 仓库：`crewloom` 安全发布仓库；本报告随本次目录改动一并提交。
- 安全基线：`c0a41512c88460b9c1b236ff62233e9235014255`（`origin/main`，未含本次卡片改版）。
- 范围：仅 `/ai/directory`（AI-01 员工目录）的**展示层**改动，以及卡片展示所需的两处最小修正与顶部启用状态筛选。
- 本报告只含功能、测试与本机只读检查的摘要，**不含凭据、真实业务记录 ID、进程/PID/端口原始诊断、工作树路径或本机私有证据路径**。
- **DSH 自检不等于 Main 内置 browser 验收**：本轮只做类型检查、定向单测与构建，未连真实 API、未跑真实 live；页面观感仍由 Main 内置浏览器做最终完整验收。

> **术语更正**：早前报告把「我可以使用 / 全部员工（可管理）」两个页签写成"状态筛选"是不准确的。
> 它们是**查看范围**（决定查哪个接口、看谁的员工）；真正的**启用状态筛选**是本次新增的
> 「全部状态 / 已启用 / 已停用」下拉。两者互相独立。

---

## 1. 变更清单

本次安全增量相对 `origin/main` 只改动下列 5 个路径（4 个源/测试文件 + 本报告）。

### 1.1 卡片化改版

| 文件 | 变更 |
| --- | --- |
| [EmployeeDirectoryPage.tsx](frontend/src/modules/ai/pages/EmployeeDirectoryPage.tsx) | 员工列表由「行卡」改为卡片网格；新增 `EmployeeCard` 卡片组件与真实数量文案；详情视图、查询、筛选、分页逻辑未改 |
| [group-a.module.css](frontend/src/modules/ai/group-a.module.css) | 新增目录卡片样式（3/2/1 列网格、头像、蓝色技能标签、底部摘要与操作），全部为本组新增类，未改既有类 |
| [employee-directory-cards.test.tsx](frontend/tests/modules/ai/employee-directory-cards.test.tsx) | 新增 3 个用例（受控 adapter，不发真实请求）：卡片真实字段、搜索本地过滤与空态、可管理页签真实总数与分页 |

**未改动**：`resources.ts` / `types.ts` / `router.tsx` / `modules/ai/index.tsx`（路由与权限声明）/ 权限模型 / 数据模型 / native runtime / 员工配置页 / 员工详情视图 / 其它模块。未新增依赖、未新增写接口。

### 1.2 技能标签可读 + 卡片底部对齐

| # | 观察 | 根因 | 最小修正 | 未做什么 |
| --- | --- | --- | --- | --- |
| 1 | 蓝色技能标签显示 `document-search` / `data-query` / `data-metadata` 等内部标识，普通用户看不懂 | `skillSettings.skills` 存的是**技能标识**；注册表同一行的 `title` 才可读，卡片此前直接渲染了标识 | 目录页复用「技能中心 / 员工配置」已有的**同一份**注册表读取（`listSkills` → `aiSkills:list`）与既有标题解析 `displayTitle`（官方中文资源 → 固定补充表 → 原文），整页只读一次、解析成标识→标题给所有卡片共用 | 未新建字典、未按 slug 硬编码、未按卡片各发一次请求（无 N+1）、未改写 `skillSettings` 绑定数据、未删标签；注册表里没有的标识原样显示，不猜不伪造 |
| 2 | 1280px 同一行 3 张卡片：职责 1 行与 2 行混排时，底部模型行与三个按钮不在同一 Y，footer 不齐 | 卡片虽因 grid 等高，但底部区紧跟在内容之后，内容高的一列把底部顶下去 | 卡片底部区 `.employeeCardFoot` 加 `margin-top: auto`：在既有的 flex column + 等高网格行里把「底部摘要 + 操作区」推到底边 | 未固定卡片总高度、未改其它共享类；长标题/状态仍自然换行不溢出 |

改动文件（共 3 个）：
- [EmployeeDirectoryPage.tsx](frontend/src/modules/ai/pages/EmployeeDirectoryPage.tsx)：新增整页一次的技能注册表查询与 `displayTitle` 解析，技能标签文字改用解析后的标题；
- [group-a.module.css](frontend/src/modules/ai/group-a.module.css)：`.employeeCardFoot` 增加 `margin-top: auto`（仅本组卡片类）；
- [employee-directory-cards.test.tsx](frontend/tests/modules/ai/employee-directory-cards.test.tsx)：新增「内置标识→中文、未收录标识原样保留、整页只读一次注册表、无 POST」用例。

标签解析映射与被复用的数据源不新写字典——内置 6 项的可读中文由既有
[display.ts](frontend/src/modules/access/display.ts)（`displayTitle`）与官方 `@nocobase/plugin-ai` 中文资源提供，
既有 [real-skill-labels.test.ts](frontend/tests/modules/ai/real-skill-labels.test.ts) 覆盖这 6 项，本次沿用未改。

### 1.3 顶部「全部状态」启用状态下拉

按参考图补齐首轮遗漏的状态筛选，并把两类控件分清楚：两个页签是**查看范围**（可使用 / 可管理），状态下拉是**启用状态**（全部状态 / 已启用 / 已停用）。

| 项 | 实现 |
| --- | --- |
| 控件 | 复用既有 `Select`（`aria-label="按启用状态筛选员工"`，测试标记 `employee-status-filter`），三态：`全部状态`（默认）/`已启用`/`已停用` |
| 判定字段 | 只用记录里已有的 `aiEmployees.enabled`：`enabled === false` 为已停用，其余（含字段缺失）按既有约定视为已启用。**不引入"在线"概念** |
| 可管理页 | 状态与名称/岗位搜索**合并进同一次** `aiEmployees:list` 请求（后端 `$and`），`meta.count` 与分页仍是整张表的真实结果，不会只过滤当前页让其它页匹配员工丢失 |
| 可使用页 | 继续走 `aiEmployees:listByUser` 的**角色授权范围**（含 `enabled=true`），关键词与状态只在**已取回的可用集合内**本地筛选；不额外发请求、不请求未授权员工 |
| 翻页与清空 | 状态或关键词变化一律回第 1 页；清空（空关键词 + 全部状态）恢复原来的查询与后端总数 |
| 默认行为 | 默认「全部状态」+ 空关键词时 `filter` 仍为 `undefined`，与改造前完全一致 |
| 空态 | 状态筛选下据实说明，例如可使用页选「已停用」显示「可使用的员工里没有『已停用』的员工」（该接口只返回已启用员工） |
| 未做 | 未加 `•••` 菜单、未加"对话创建"、`测试` 仍沿用原会话工作区入口（不动 native）、未改权限/接口/依赖/员工记录 |

改动文件（共 3 个）：
- [EmployeeDirectoryPage.tsx](frontend/src/modules/ai/pages/EmployeeDirectoryPage.tsx)：新增 `EmployeeStatusFilter` 三态、`matchesEmployeeStatus` / `filterUsableEmployees`，把状态并入可管理页的 `filter`（关键词 + 状态 `$and`），工具栏加 `Select`，状态变化回第 1 页，空态与「一次列出」文案据实调整；
- [employee-directory-cards.test.tsx](frontend/tests/modules/ai/employee-directory-cards.test.tsx)：新增「可使用页状态本地筛选、不越权/不发请求」与「可管理页条件合并、后端真实总数、页码回 1、清空恢复」两个用例；
- [ai-behavior.test.ts](frontend/tests/modules/ai/ai-behavior.test.ts)：新增 `matchesEmployeeStatus` / `filterUsableEmployees` 的三态与字段缺失边界用例。

## 2. 与参考图和验收标准的对照

| 参考图元素 | 本轮实现 | 数据来源（真实字段） |
| --- | --- | --- |
| 浅色页面 + 白色圆角卡片 | 顶部工具条仍是既有 `PageCard`（白底圆角），卡片网格直接铺在浅色页面上 | — |
| 宽屏 3 列 → 2 → 1 | CSS grid：`repeat(3, minmax(0,1fr))`；`≤1180px` 2 列；`≤720px` 1 列 | 实测 1600px=3 列、1024px=2 列、640px=1 列 |
| 头像 + 名称 | 复用既有渲染链 `renderEmployeeAvatar`（dicebear + 项目已锁定的 `@nocobase/ai-employee-avatars` 预设）；无标识时用名称首字回退（同既有样式），不造假图片、不新增素材 | `aiEmployees.avatar`（标识字符串） |
| 状态 | `StatusPill`：已启用 / 已停用 / 内置员工 / 已标记为过时 | `enabled` / `builtIn` / `deprecated`。**不把 `enabled` 说成"在线"**（页面无"在线"字样，自检断言） |
| 职责两行截断 | `-webkit-line-clamp: 2`；`bio` 为空时**整段不显示**（不用岗位或提示词顶替） | `aiEmployees.bio` |
| 蓝色技能标签 | 前 3 个标签 + 超出折叠为 `+N`；蓝色 = `--brand-soft` 底 + `--brand-deep` 字 + 999px 圆角 | `skillSettings.skills` |
| 底部模型摘要 | `resolveAllowedModels` 的真实结论：`模型（服务商）` / `N 个允许模型` / 专用模型允许集为空 / 未启用限制则"由全局默认模型决定" | `aiEmployees.modelSettings` |
| 底部使用统计 | `技能 N · 工具 N`（与卡片同一行字段，**不发每卡额外请求**） | `skillSettings.skills` / `skillSettings.tools` |
| 底部操作 | 查看详情 / 测试 / 编辑配置（编辑仅在角色有 `aiEmployees:update` 时出现，沿用既有权限判断） | 既有路由 `/ai/directory/:username`、`/ai/conversations`、`/ai/employees-config/:username` |
| 顶部搜索 | 保留既有筛选（"可使用"页签本地过滤用户名/昵称/岗位；"可管理"页签后端 `filter`） | 不变 |
| **查看范围** | 保留既有 `我可以使用的员工` / `全部员工（可管理）` 两个页签——它们决定**查哪个接口、看谁的员工**，不是状态筛选 | `aiEmployees:listByUser` / `aiEmployees:list` |
| **启用状态筛选** | 顶部下拉「全部状态 / 已启用 / 已停用」，默认全部状态；可管理页与名称/岗位搜索合并进同一次后端查询，可使用页只在已授权集合内本地筛选 | `aiEmployees.enabled`（`enabled === false` 为已停用） |
| 真实数量 | "可使用"显示 `显示 N 位员工`（`listByUser` 一次返回的行数）；"可管理"显示 `共 N 位员工`（后端 `meta.count`，无 count 时退化为"本页 N 位"） | 后端真实返回 |
| 新增入口 | **未开发"对话创建"**；既有员工配置新建入口保持原样 | — |

## 3. 明确未做与原因（供 Main 决策）

1. **卡片右上角 `•••` 菜单**：参考图有，但现有页面没有对应功能，新增属于扩大功能，本轮不做。
2. **"今日 N 会话"**：现有接口没有"单次请求按员工取会话数"的能力（`aiConversations:list` 不按员工聚合；逐卡查询会变成 N+1）。按"无字段就据实省略、不额外每卡 N+1 请求、不虚构会话数"处理，改为显示同一行真实字段（技能/工具计数）。
3. **`测试` 的去向**：指向真实会话工作区 `/ai/conversations`（既有会话入口，原生 ChatBox 可在其中选择员工对话），**不新建会话、不预选员工、不发消息**。现有代码没有"按员工直接开启会话"的能力，如需"点某位员工直接进入该员工会话"，要改 native chat 宿主，属新功能与新授权范围。
4. 员工详情视图、会话页、配置页、工作流页均未改动。

## 4. 定向检查（本机，只读自检）

> 下列结果为记录在案的既有运行结果；本次安全发布**没有源码变化**，因此**未重跑测试与构建**，也没有重做真实联调。定向最终结果为 **29 个用例 / 3 个文件**（卡片 6、行为 19、既有技能标题 4），typecheck 与独立构建退出码均为 0。

| 阶段 | 命令 | 退出码 / 结果 |
| --- | --- | --- |
| 卡片改版 | `npx tsc -b --pretty false` | 0 |
| 卡片改版 | `npx vitest run tests/modules/ai tests/workbench-cross-links.test.tsx` | 0；16 文件 / 102 用例通过（含新增 3 个） |
| 卡片改版 | `npx vitest run tests/modules/ai/employee-directory-cards.test.tsx` | 0；3 用例通过 |
| 技能标签双修 | `npx tsc -b --pretty false` | 0 |
| 技能标签双修 | `npx vitest run tests/modules/ai/employee-directory-cards.test.tsx tests/modules/ai/real-skill-labels.test.ts` | 0；2 文件 / 8 用例通过（卡片 4、既有技能标题 4） |
| 状态筛选 | `npx tsc -b --pretty false` | 0（`tsconfig.test.json` 已包含 tests，测试类型一并检查） |
| 状态筛选 | `npx vitest run tests/modules/ai/employee-directory-cards.test.tsx tests/modules/ai/ai-behavior.test.ts` | 0；2 文件 / 25 用例通过（卡片 6 例、行为 19 例） |
| 独立构建 | `NODE_OPTIONS=--max-old-space-size=6144 npx vite build`（输出到 ignored 独立目录，不动 `frontend/dist`） | 0；产物可用于产物核对 |
| 产物核对 | 构建产物 JS/CSS 的 sha256 与预览所服务文件一致；CSS 含 `margin-top:auto`，JS 含技能标题映射与状态控件（`testId:"employee-status-filter"`、`onChange` 回第 1 页、三个选项文案） | 一致 |
| 未运行 | 全量测试（只改 AI-01 展示层，按约定不跑全量）、真实 live（无真实 API/SSH/model/写）、真实工作流执行 | — |

本次新增/更新的测试断言了需求点：
- **三个状态**：`matchesEmployeeStatus` / `filterUsableEmployees` 覆盖 `all` / `enabled` / `disabled` 与 `enabled` 字段缺失的边界；
- **可使用页只做本地筛选**：切换状态不产生新的 `listByUser`/`list` 请求，也**不会**去请求可管理范围；
- **可管理页条件合并**：只改状态时请求 filter 为 `{enabled:false}`；状态 + 关键词时为
  `{$and:[{$or:[username/nickname/position $includes]},{enabled:false}]}`——两条件都在原 list 请求里；
- **真实总数 / 分页回 1**：总数取自后端 `meta.count`；先翻到第 2 页再改状态，请求回到 `page=1`；
- **原 Scope 保持**：两个查看范围页签仍在，默认「全部状态」时 `filter` 为 `undefined`（既有行为不变），清空筛选恢复原总数。

## 5. 工作流列表为空的结论（非产品回归）

用户看到的"工作流没有了"来自一个**既有本机合成环境预览实例**：它连接的是本机合成 fixture 后端，而合成环境按设计不含真实工作流，因此列表为 0 条。连接真实后端的预览实例显示真实流程版本列表，页面可正常打开画布。结论：**真实工作流没有被删除，也不是产品回归**；给用户的正式预览应使用连接真实后端的端口。

## 6. 安全范围与边界

- 无任何真实写入：全程只有正常登录 + 只读读取；非 GET 请求仅 `auth:signIn`、`aiEmployees:listByUser`、`aiConversations:unreadCounts`、`ai:listAllEnabledModels`（均为只读动作，后者为原生会话取已启用模型清单，非外呼推理）。
- 未执行工作流、未做模型发现/推理、未发送消息、未上传、未 SSH、未部署、未重启任何服务；未停止或替换任何既有预览进程。
- 未改动根私人仓库与真实实例配置。
- 凭据仅从根 `.secrets` 指定任务文件私下读取，不打印、不落盘、不进 argv；报告与本文件均不含凭据值、真实业务记录 ID 或本机私有诊断路径。
- 预览服务运行期间由既有传输守卫自动产生的运行审计（仅方法/路径/结论/状态码，无凭据）按约定**不入库**，保留在本机 ignored 证据目录，未删、未回退、未 stage。

## 7. 待 Main 最终验收

1. 用内置 browser 打开安全预览的 `/ai/directory` 做一次最终完整验收：
   - 顶部三项控件齐全且互相独立：搜索、查看范围两页签（我可以使用 / 全部员工可管理）、启用状态下拉（全部状态 / 已启用 / 已停用）；
   - 三个状态在**可管理**页都能筛出结果，且数量/分页是后端真实值；状态或关键词变化后回到第 1 页；清空后恢复原总数；
   - **可使用**页保持原角色范围，只在可用集合内筛选（选「已停用」应据实为空，而不是越权或伪造）；
   - 同时复核两处修正：技能标签为可读中文、同一行卡片底部模型行与按钮底边对齐；
   - 复核搜索、分页、详情/测试/编辑入口与角色限制。
2. 仍不在本轮范围（如需请另开范围）：卡片 `•••` 菜单、"对话创建"入口、`测试` 的"按员工直达会话"（要改 native chat 宿主）。
