# NocoBase 2.2.20 —— 全局默认模型最小后端候选（**未安装到任何实例**）

日期：2026-10-11。归属：后端候选组（`completion-backend`）。状态：**本地候选已生成并通过隔离受控核对 + 纯本机 fixture 的 dry-run / apply / rollback 往返；未安装到 13000、13080 或任何实例。**

对应产品需求（已确认，见 [方案](../../docs/planning/implementation-plan.md) §模型顺序）：

> 员工专用规则 → 无专用配置时的合法显式选择 → **全局默认** → 未设置全局默认时兼容旧回退。
> 已配置默认不可用时**明确失败**，不静默切换；更改默认只影响之后开始的新调用。

相关报告：[13 默认模型候选](../../docs/acceptance/full-pages-13000/13-defaults-candidate.md)（结论、运行证据、边界）。
本 README 只讲**这份候选是什么 / 怎么核对 / 怎么装 / 怎么回退 / 有哪些限制**。

---

## 1. 这份候选是什么、不是什么

| 项 | 结论 |
| --- | --- |
| 打包对象 | **已发布产物** `@nocobase/plugin-ai@2.2.20` 的 `dist/*.js`（发布包**不含** `src/`，已核对 tarball 清单） |
| 补丁文件 | [`default-model-2.2.20.patch`](default-model-2.2.20.patch)（5060 字节） |
| 机器可读清单 | [`patch-manifest.json`](patch-manifest.json)（原始/补丁后哈希、补丁哈希、tarball 哈希） |
| 已做的验证 | tarball 哈希一致 + 5 个锚点各命中一次 + `patch -p1 --dry-run` 通过 + **受控运行 42 条**（A/B/C/G/H/I/J + K/L 真实下游链 + M aiSettings 真实保存，原始 vs 补丁逐条对比）+ **纯本机 fixture 的 dry-run → apply → verify → rollback → byte-hash 还原** |
| **未做** | **没有安装到 13000/13080 或任何实例**；没有真实 HTTP 联调；没有跑完整 plugin lifecycle；没有真实模型调用；没有改任何插件启用状态、配置或数据库 |
| 因此不能声称 | "2.2.20 生产环境默认模型已生效"、"插件方式已完成"、"可一键用于任意容器路径" |

2.2.22 的对应验证（TS 源码补丁 + 隔离 harness）见
[`experiments/p2-isolated-validation/backend/patches/`](../../experiments/p2-isolated-validation/backend/patches/) 与
[P2 后端路径报告](../../docs/verification/p2-isolated-validation/01-backend-paths.md)。
**2.2.22 的 runner 不能替代 2.2.20 的核对**；本目录的 runner 只跑 2.2.20 发布产物。

---

## 2. 来源与可复现（核实过的哈希）

| 项 | 值 |
| --- | --- |
| 发布包 URL | `https://registry.npmjs.org/@nocobase/plugin-ai/-/plugin-ai-2.2.20.tgz` |
| 发布包 sha256 | `3fb3be5d60c1c8d92dd36917b85449752c74552f983177a64deb613d3a44d16a` |
| 本地缓存（不入库） | `patches/nocobase-2.2.20/.cache/plugin-ai-2.2.20.tgz`（17 MB，`.gitignore`） |
| 补丁 sha256 | `d6523c86bf24e9a570fd835b308fa21cde8acebfbbcf06f3e2689b33f3099ad4` |
| 受控运行 pin 的框架依赖 | `@nocobase/utils@2.2.20`（tarball `e4ee5cf4706b08d778a149beaa7e8e0d0c3fec80b7884cff1cbeb1c6d7ca48d5`，只用于 harness；见 `candidate-check.json` 的 `deps`） |

三个目标文件的**原始哈希**（apply 前的防错依据）：

| 文件（相对 plugin-ai 包根） | 原始 sha256 | 补丁后 sha256 |
| --- | --- | --- |
| `dist/server/manager/ai-manager.js` | `6f62df6a9c228200e64f335d99cfcaac432b3fabc894cd25b7b6c46a8d22ede1` | `e0f9c886df76500ad5d6b87dbc0805128ed9b7f2823a8a852c8a6626a25e2f4a` |
| `dist/server/workflow/nodes/llm/index.js` | `3f3a504412a0cdfb66a2058f29c919ff4b329d28d49c45f0bf0e7379a611803f` | `5f7450130b259282cfe79dd65439e6c5d5ea9aaf23e69710af02d91f126f5707` |
| `dist/ai/tools/sub-agents/dispatch-sub-agent-task.js` | `95de43feb1c40c2b0bf9af252ce8c909f9cc1651943acf96ed90f617b23c26d7` | `77cdad06cdb13e6d88a9be18a7863e57cff19ea903a037e6b5011a1cca98eb58` |

复现（只读发布包，只写本目录）：

```bash
# 1) 放置发布包（或用 NB_AI_2_2_20_TARBALL 指定路径）
curl -sSL -o patches/nocobase-2.2.20/.cache/plugin-ai-2.2.20.tgz \
  https://registry.npmjs.org/@nocobase/plugin-ai/-/plugin-ai-2.2.20.tgz
# 1b) harness 需要的 pin 依赖（缺省会回退到本机已装版本，并在证据里记录）
curl -sSL -o patches/nocobase-2.2.20/.cache/utils-2.2.20.tgz \
  https://registry.npmjs.org/@nocobase/utils/-/utils-2.2.20.tgz
# 2) 生成补丁 + 受控运行核对 + 写 patch-manifest.json（只读发布包，只写 patches/nocobase-2.2.20/）
node patches/nocobase-2.2.20/tools/verify-2.2.20-candidate.mjs    # 退出码 0
# 3) 纯本机 fixture 的 dry-run / apply / rollback 往返
node patches/nocobase-2.2.20/tools/candidate-install.mjs roundtrip # 退出码 0
```

最近一次运行的机器可读结果见 [`candidate-check.json`](candidate-check.json)；
本 README 不再手抄运行输出，避免与机器可读证据不一致。

---

## 3. 2.2.20 实测的消费点与补丁内容

三处都是**实际读代码**得到的（不是从 2.2.22 推断），且与 2.2.22 基线逐处对应：

| # | 位置（2.2.20 发布产物） | 2.2.20 原行为 | 补丁后行为 |
| --- | --- | --- | --- |
| **A** | `dist/server/manager/ai-manager.js` → `resolveModel(model)` | 只判显式 `{llmService, model}`；否则取**第一个有启用模型的服务之首模型**；都没有则 `throw LLM service not configured`。**完全不读 `aiSettings`** | 在显式判断之后插入"默认解析"：默认键都未设 → 返回 `null` 走原回退；只设一半 → 明确失败；服务不存在/已禁用/无启用模型 → 明确失败；模型不在启用列表 → 明确失败；都合法 → 返回默认 |
| **B** | `dist/server/workflow/nodes/llm/index.js` → `run()` | `getLLMProvider(llmService, …)`，`llmService` 为空直接抛 `invalid llm service`。**通用 LLM 节点是旁路**，从不经过 `resolveModel` | 仅在 `llmService` 缺失时调用 `plugin.aiManager.resolveModel()` 取默认服务；`modelOptions.model` 未显式设置时才补默认模型。显式配置的节点**完全不受影响** |
| **C** | `dist/ai/tools/sub-agents/dispatch-sub-agent-task.js` | `model: ctx.action?.params?.values?.model ?? employee.get('modelSettings')` —— 把员工 `modelSettings` **整个配置对象**当显式选择传给 `resolveModel`，于是"专用配置已关闭但留有扁平字段"会被误判为显式选择 | 新增 `extractExplicitModelRef()`：只有 `enabled === true` 且能取出合法 `{llmService, model}` 对才算显式，否则传 `null` 让公共回退生效。员工允许集/首选规则**逐字节未动** |

**未触碰**：`dist/server/ai-employees/ai-employees-manager.js` 的允许集与首选逻辑
（G 处 8 条只做"原始 vs 补丁"对照，证明规则未被改）、`aiSettings` 的保存期校验、
`AIManager.getLLMService` 的执行期校验。

### 3.1 三处消费点的实际来源链（受控运行核对，不是静态推断）

| 链路 | 受控运行证明 |
| --- | --- |
| A 公共解析 → 出站 provider | `AIManager.resolveModel()`（真实类）→ `AIManager.getLLMService()`（真实类）→ 捕获 provider 收到的 `modelOptions={llmService:'svc-b',model:'m-b1'}`、`serviceOptions.tag='tag-b'`（H1）；默认未配置时落到 `tag-a`（H2）；默认失效时**根本不会创建 provider**（H3，原始版会静默用首个服务） |
| B 工作流节点 → provider | 真实 `LLMInstruction.run()` 里断言 `getLLMProvider` 实参 + `resolveModel` 调用次数（E1–E3） |
| C 子任务 → `resolveModel(employee, model)` | 真实 `tool.invoke()` 断言交给 `subAgentsDispatcher.run` 的 `model` 实参（F1–F5），并用真实 `AIEmployeesManager.resolveModel` 验证下游效果（G1–G8） |
| 员工专用 → 公共默认 | 员工管理器（**未补丁**）在"专用配置关闭"时回退到 `aiManager.resolveModel()`：补丁前得到旧首个服务，补丁后得到全局默认（G1）；默认失效时员工回退也明确失败（G8） |
| 生命周期 / 设置更新 | 每次调用重新读设置（`settingsReads=2`）；已解析结果是不再变化的快照，更新默认后旧持有仍绑定原服务、新调用用新默认（I1）；设置改成失效后新调用明确失败、已开始的调用仍可用（I2）；清空默认恢复旧回退（I3） |

`pm.get("ai")` 的已安装/停用边界：`llm` instruction 由 **plugin-ai 自己的 `load()`** 注册
（`dist/server/plugin.js` 第 344 行，位于 `load()` 第 172 行与 `install()` 第 364 行之间，
见 `candidate-check.json` 的 `sourceEvidence.llmRegistration`），而原 `getLLMProvider` 本身就无条件
`pm.get("ai")`。因此"ai 插件缺失但该节点仍在跑"在 2.2.20 不是受支持的生命周期状态；
本组据此**不新增广泛防御**，只在 J1 记录该状态下的实际文案。

### 3.2 与 2.2.22 的差异（只列实测到的）

| 项 | 2.2.22 | 2.2.20 |
| --- | --- | --- |
| A/B/C 三处逻辑结构 | 同结构 | 同结构 |
| 分发形态 | 有 `src/`（TS 源码补丁） | **无 `src/`**，只能补 `dist/*.js` |
| `enabledModels` 形状 | `object`/`array` 均有处理（`getEnabledModels`） | 同（`getEnabledModels` 已兼容两种） |

结论：**三处消费点在两个版本上是同一形态**；差别只在分发形态（TS vs dist），因此 2.2.20
用 dist 补丁、2.2.22 用 TS 补丁。本轮**没有发现导致语义不同的版本差异**。

---

## 4. 安装 / 回退（具体命令，**本组未执行**）

工具：[`tools/candidate-install.mjs`](tools/candidate-install.mjs)（纯 Node，无第三方依赖；只读写本目录与 `--target`）。
它以 [`patch-manifest.json`](patch-manifest.json) 为唯一事实来源。

### 4.1 安装前必须核实的目标环境（**没核实就不要宣称"一键可用"**）

本组**没有接触过** 13000/13080 的容器内布局、用户、权限或 supervisor 配置，因此**不宣称**下面的路径
对未知容器路径可用。安装前必须在目标机上逐项确认并把实际值写进安装记录：

| # | 要确认的项 | 为什么 |
| --- | --- | --- |
| 1 | `@nocobase/plugin-ai` 包根的**实际绝对路径**（可能在镜像层、`node_modules`、pnpm store 或 bind mount 里） | `apply` 打的是**正在被加载的那份 dist**；打错副本等于没生效 |
| 2 | 该包 `package.json` 的 `name`/`version` 必须是 `@nocobase/plugin-ai` / `2.2.20` | `inspect` 会检查；版本不符时锚点校验也会失败 |
| 3 | 三个目标文件的 sha256 == §2 的原始哈希 | `apply` 的硬性前置条件（不一致直接拒绝，不写文件） |
| 4 | 目标目录与三个文件的**属主/权限**，以及执行安装的进程是否可写 | 备份与打补丁都要写文件；只读层（如镜像只读层）无法原地修改 |
| 5 | 该目录是否被**卷挂载覆盖**、是否会在下次 `install/upgrade` 或容器重建时被重置 | 决定补丁是否持久；`node_modules` 里的补丁会被任何 `npm/pnpm/yarn install` 冲掉 |
| 6 | 应用进程的**重启方式**（compose service / supervisor / PM2 / 进程内）与允许的重启窗口 | 服务端 `dist` 不会热重载，必须重启才会生效 |
| 7 | 备份目录的落点与剩余空间（默认写在包根旁，若包根只读则必须显式 `--backup-dir`） | 备份是回退的唯一依据 |
| 8 | 目标实例上 `ai` 插件当前是**启用**状态 | B 处补丁在 `llmService` 缺失时取 `pm.get("ai")`；插件被停用时该节点本就不会注册（见 §3.1） |
| 9 | 该实例是否已配置全局默认（`aiSettings.defaultLLMService/defaultModel`） | 未配置时补丁行为等于旧回退；配置后立即按新规则生效 |

### 4.2 干跑（不写任何文件）

```bash
PLUGIN_AI_DIR=<核实过的 @nocobase/plugin-ai 包根绝对路径>
node patches/nocobase-2.2.20/tools/candidate-install.mjs inspect --target "$PLUGIN_AI_DIR"
node patches/nocobase-2.2.20/tools/candidate-install.mjs dry-run --target "$PLUGIN_AI_DIR"
```

`inspect` 打印三文件哈希与整体状态（`pristine` / `patched` / `mixed-or-unknown` / `incomplete`）。
`dry-run` 只在三文件**全部 pristine** 时执行 `patch -p1 --dry-run`；否则非 0 退出且不写文件。

### 4.3 安装（原文件哈希防错 + 自动备份）

```bash
node patches/nocobase-2.2.20/tools/candidate-install.mjs apply \
  --target "$PLUGIN_AI_DIR" \
  --backup-dir /var/backups/crewloom-default-model-$(date +%Y%m%d%H%M%S) \
  --yes
```

`apply` 的行为，按顺序：

1. 逐个核对三文件 sha256 == `pristineSha256`；**任一不符立即中止，不写任何文件**；
2. 把三个原文件复制到 `--backup-dir`，保留原文件 **mode**，并写 `backup-manifest.json`
   （每个文件的 `pristineSha256` / `backupSha256` / `size` / `mode`）；
3. `patch -p1 -d <target> -i default-model-2.2.20.patch`；
4. 重新计算三文件 sha256，必须全部等于 `patchedSha256`；
5. 任一步失败 → **自动从备份恢复**并再次做字节校验，然后非 0 退出。

成功后需要**重启应用进程**（服务端 `dist` 不热重载）才会生效。

### 4.4 回退（从备份恢复 + 哈希校验；**不用 `npm --force reinstall`**）

```bash
node patches/nocobase-2.2.20/tools/candidate-install.mjs rollback \
  --target "$PLUGIN_AI_DIR" \
  --backup-dir <apply 时打印的备份目录>
```

`rollback` 会：校验 `backup-manifest.json` 存在 → 逐个校验备份文件 sha256 == 记录的 `backupSha256`
（证明备份**未被损坏/替换**）→ 复制回目标并恢复 mode → 校验恢复后 sha256 == `pristineSha256`
（**字节级还原**）。任一步不符即非 0 退出。

回退也**必须重启**应用进程。**`npm i @nocobase/plugin-ai@2.2.20 --force` 不是本候选的回退方式**：
它会覆盖补丁，但同时可能拉入不同解析结果/其它依赖，且没有备份与哈希校验。只有在备份丢失时，
才把"重装同版本包"当作最后手段，并**必须**重新核对原始哈希后再决定。

### 4.5 纯本机 fixture 往返（证明 dry-run / apply / rollback / byte-hash 还原）

```bash
node patches/nocobase-2.2.20/tools/candidate-install.mjs roundtrip   # 退出码 0
```

它把发布包解到 `<patchRoot>/.work/roundtrip/`（已被忽略），在**副本**上依次跑
`pristine → dry-run → apply → patched → rollback → pristine`，最后断言三文件 sha256 逐个等于原始哈希。
最近一次运行：`dry-run OK` / `apply OK` / `rollback OK` / `byte-hash 还原=true`，退出码 **0**。
另已核对反向守卫：对**已打补丁**的目标执行 `apply` 会因原始哈希不符而拒绝（退出码 1，未写文件）；
`rollback` 缺 `--backup-dir` 时拒绝（退出码 2）。

---

## 5. 重启影响、进行中的调用、升级限制

1. **重启是必需的**：服务端 `dist` 不会热重载；不重启 = 不生效。重启会中断当前正在处理的请求
   （含正在生成的 AI 回复），所以要在允许窗口内做。
2. **进行中的调用**：默认值在**每次调用的解析点**读取（`resolveModel` / 节点 `run`），已解析出模型
   的调用持有一个普通对象快照，后续改设置**不会**改写它（I1/I2）。因此"更改默认只影响之后开始的新调用"
   成立；但重启会终止进行中的调用（这是进程级影响，不是补丁语义）。
3. **升级限制**：锚点按 2.2.20 发布产物**逐字节**匹配。升级到 2.2.21+、或换了分发形态（出现 `src/`）、
   或镜像内产物被替换，都必须**重新生成**候选；`verify-2.2.20-candidate.mjs` 在锚点命中数 ≠ 1 时
   直接失败（不会"看起来成功"）。`apply` 在哈希不符时也会拒绝。
4. **持久性**：`node_modules` 里的补丁会被任何 `npm/pnpm/yarn install` 或镜像重建冲掉；需要在
   部署流程里显式重放（本组不提供自动重放钩子，避免扩大改动面）。
5. **不改变前端**：前端不得用"在设置页填默认值"冒充后台已生效；默认是否真正参与解析由这份后端候选决定。
6. **本地备份数据完整性**：`backup-manifest.json` 记录 sha256/size/mode；`rollback` 先验备份再恢复。
   若目标包根只读，必须用可写的 `--backup-dir`，否则 `apply` 会在创建备份时失败且不写目标文件。
7. **配置写入载体**：`defaultLLMService`/`defaultModel` 是 `aiSettings` 的**原生字段**，用真实
   `update`/`get`/`publicGet` 已受控验证（README §6 的 M 组，见 [13 报告](../../docs/acceptance/full-pages-13000/13-defaults-candidate.md) §3.4c）。
   本组**没有**在 13000 上写这两个字段。

---

## 6. 测试覆盖与未覆盖

| 覆盖 | 方式 |
| --- | --- |
| tarball 与三文件哈希 | `verify-2.2.20-candidate.mjs` |
| 五个锚点各命中一次 | 同上（命中数 ≠ 1 即非 0 退出） |
| 补丁可应用 | `patch -p1 --dry-run`（3 个文件全部 OK） |
| A 处 8 条规则 | 受控运行：真实**补丁后** `AIManager` 类 + 假 `plugin.db` 仓库替身 |
| K 处 2 条（B 的真实下游链） | 受控运行：**不替换** `LLMInstruction.getLLMProvider`，走真实 `AIManager.llmProviders` 注册表到 provider 边界 |
| L 处 3 条（C 的真实下游链） | 受控运行：真实 `tool.invoke` → 真实 `SubAgentsDispatcher.run` → 真实 `AIEmployeesManager`/`AIManager` → 真实 `AIEmployee.buildChatContext` → 真实 `getLLMService` → provider 边界 |
| M 处 6 条（`aiSettings` 持久化） | 受控运行：真实 `resource/aiSettings.js` 的 `get`/`update`/`publicGet`，保存后再交给真实 `AIManager.resolveModel` 选型 |
| B 处 3 条规则 | 受控运行：**原始**与**补丁后**的真实 `LLMInstruction.run()` |
| C 处 5 条规则 | 受控运行：**原始**与**补丁后**的真实 `tool.invoke()` |
| G 处 8 条（员工允许集/首选/显式/回退） | 受控运行：真实 `AIEmployeesManager.resolveModel`，原始 vs 补丁 |
| H 处 3 条（尾链到 provider） | 受控运行：真实 `resolveModel` → `getLLMService` → 捕获 provider 入参 |
| I 处 3 条（生命周期/设置更新） | 受控运行：真实 `AIManager` + 可变设置 + 读取计数 |
| J1（`pm.get("ai")` 边界） | 受控运行 + `plugin.js` 注册位置源码证据（只记录，不加防御） |
| dry-run / apply / rollback / byte-hash | 纯本机 fixture 往返（`roundtrip`） |

受控环境说明（**不是**完整应用、**不是**真实实例）：

- 只连本机已装好的 `lodash` / `zod` / `axios` / `dayjs` / `@langchain/core` 与 pin 的
  **完整** `@nocobase/utils@2.2.20`（脚本扫描 bare require 后软链 `.pnpm` 真实目录，不下载依赖包）；
- 框架基类用**最小替身**：`@nocobase/plugin-workflow` 只提供 `Instruction` / `JOB_STATUS` /
  `isWorkflowTimeoutError`；`@nocobase/ai` 只提供 `defineTools`/`listSystemTools`/`SYSTEM_TOOLS`；
  `@nocobase/database` 只提供 `Op`/`UniqueConstraintError` 符号。跑的是**本插件里的真实逻辑**；
- K/L 组额外链接本机已装的 `langchain` / `@langchain/langgraph(-checkpoint)` / `@langchain/core`（只为加载真实
  `ai-employee.js`）；L 组在 provider 边界**之后**会因缺 `plugin.toolsManager` 报错，证据里记为 `postBoundaryError`；
- **无网络、无模型、无后端、不安装**。

未覆盖（如实列出，也是不能声称"已生效"的原因）：

- 真实 HTTP / 真实模型调用 / 完整 plugin lifecycle（插件加载顺序、`pm.get('ai')` 的真实就绪时机）；
- 并发与异常路径、多节点并发下的设置更新；
- 目标实例上的实际安装、重启与生效（**需要主 PM 的精确最终批准**）；
- 未核实的容器内路径与权限（见 §4.1）。
