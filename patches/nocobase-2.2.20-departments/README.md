# NocoBase 2.2.20 —— 部门成员 / 部门角色 / effectiveRole 最小候选（**未安装、未启用**）

日期：2026-10-11。归属：后端候选组（`completion-backend`）。状态：**本地候选已完成 + 隔离受控核对通过（24 条）+ 纯本机 fixture 的 dry-run / apply / rollback 往返 + 真实 ORM/隔离 PostgreSQL 安装兼容实验通过（17 条，含真实 `SortField` 与树策略）+ 最小真实 2.2.20 Application 可 load/install/start（HTTP 关联链未跑通）；未安装、未启用、未改任何真实数据库。**

相关报告：[14 部门候选](../../docs/acceptance/full-pages-13000/14-department-candidate.md)。
本 README 只讲**这份候选是什么 / 怎么核对 / 怎么装 / 怎么回退 / 有什么风险与未知**。

---

## 1. 结论先行

| 项 | 结论 |
| --- | --- |
| 能力来源 | **原生** `@nocobase/plugin-departments@2.2.20`（13000 上已存在、`enabled=false`、`installed=false`）——先沿用现成原生能力，不自研 |
| 候选变更 B1（必做） | 安装并启用该原生插件（提供 `departments/<id>/members`、`departments/<id>/roles`、`roles/<role>/departments`、`users/<id>/departments` 资源 + `attachRoles` 生效合并） |
| 候选变更 B2（可选、建议） | 1 个文件的 dist 补丁 [`department-compat-2.2.20.patch`](department-compat-2.2.20.patch)：部门↔角色变更时也失效 `departments:<uid>` 缓存，消除 `currentUser.departments[].roles` 载荷陈旧 |
| 是否需要**自定义插件** | **不需要**（原生能力足够）。因此没有走 `nocobase-plugin-development` 的 scaffold 流程（该 Skill 的 Step 0 要求 NocoBase 源码树，本工作树没有；Step 2 又要求在写代码前先与用户确认计划） |
| 自定义 schema 兼容性 | ✅ 用**真实 ORM + 隔离 PostgreSQL** 跑通真实 `install→db2cm→migrate/sync` 生命周期：自定义列/数据/PK/父子结构**完全保留**，插件新增 `title`/`is_leaf`/`sort` 与 through 表（§4.1，12/12 PASS） |
| `migrationRules` 语义 | ✅ 已定论：同版 2.2.20 发布产物中**没有任何运行时读取点**（只作为 collection 定义元数据），实际生效的是 collection-manager 的 `load/migrate` + `sync(alter:{drop:false})`（§4.1） |
| **未做** | 没有在 13000/13080 上安装/启用插件、没有改任何真实数据库、没有 SSH、没有重启；**没有把"数据已存在"当作能力已开通** |
| 不能声称 | "部门成员/部门角色/有效角色已在 13000 生效"；真实实例上尚未执行 enable/disable |

---

## 2. 来源与哈希（可复现）

| 包 | tarball | sha256 |
| --- | --- | --- |
| `@nocobase/plugin-departments@2.2.20` | `.../plugin-departments-2.2.20.tgz` | `d5a0f287f8586601c71c15651f7034f30899d579204f1b268ab3932c240bf31a` |
| `@nocobase/plugin-acl@2.2.20` | `.../plugin-acl-2.2.20.tgz` | `1ae86e0e0ad18e4f855aaf74d35030b961e8654039d959c1f98e1cf98a0b6622` |
| `@nocobase/cache@2.2.20` | `.../cache-2.2.20.tgz` | `830cd389a30b19104eba425d4cf98237faf6ab9da62ec43b875724d651f955fd` |
| `@nocobase/database@2.2.20` | `.../database-2.2.20.tgz` | `123f0c54e6c3f2c887827785ed46ebc59399b9fe1c40dc4dda0b7a0d773f95a2` |
| `@nocobase/server@2.2.20` | `.../server-2.2.20.tgz` | `862c46856facffe01d41da32c5b2fca47ce847f4356b3b704554ba5ee772d19b` |
| `@nocobase/plugin-data-source-main@2.2.20` | `.../ds-main-2.2.20.tgz` | `6985d75cbf10f0c7d2a1f6b19e13fdf4558488b07225728c6f0fe9ae126dd774` |

被补丁文件的原始/补丁后哈希写在 [`patch-manifest.json`](patch-manifest.json)（单一事实来源）。
本地缓存全部在 `.cache/`（已忽略），来源 URL 与 sha256 见上表；**只读发布包，只写本目录**。

复现：

```bash
# 依赖：把上面的 tarball 放到 patches/nocobase-2.2.20-departments/.cache/ 下（同名）
node patches/nocobase-2.2.20-departments/tools/verify-2.2.20-departments.mjs   # 退出码 0
node patches/nocobase-2.2.20-departments/tools/candidate-install.mjs roundtrip  # 退出码 0
node patches/nocobase-2.2.20-departments/tools/candidate-install.mjs plan       # 只打印计划
```

---

## 3. 实测的 2.2.20 链路（源码 + 受控运行）

### 3.1 有效角色怎么来（真实代码）

1. `plugin-departments` 的 `setDepartmentsInfo`（注册在 `before: setCurrentRole, after: auth`）：
   读 `users.departments`（**直接部门**，含 `cache.wrap('departments:<uid>', …)`），
   取其 `departmentIds`，再用**实时**查询 `roles.find({ filter: { 'departments.id': { $in: departmentIds } } })`
   写入 `ctx.state.attachRoles`；同时把部门列表（含 append 的 `roles`、`parent(recursively=true)`）挂到
   `ctx.state.currentUser.departments`。
2. `plugin-acl` 的 `setCurrentRole`：把 `attachRoles` 与本人员工角色 `roles:<uid>` 合并去重
   （`rolesMap`，attachRoles 先插入），得到 `ctx.state.currentUser.roles`；再按 `X-Role` / cookie /
   `systemSettings.roleMode` 决定 `currentRole` 与 `currentRoles`。
3. 缓存：`departments:<uid>`（部门载荷）与 `roles:<uid>`（本人角色）走 `@nocobase/cache`，
   默认 `defaultStore="memory"`，cache-manager memory 默认 **ttl 0 = 不过期**。

受控运行（真实函数 + 注入端口）覆盖：

| 组 | 用例 | 结果 |
| --- | --- | --- |
| E | 合并去重、`X-Role` 切换、非本人角色 401、`only-use-union`、`default+union`、仅部门角色可进入、无任何角色 401、同名去重 | 8/8 PASS |
| C | 实时 roles 查询（部门角色变更不影响授权）、缓存命中、部门角色变更后**载荷**陈旧 vs 候选刷新、成员变更绕过失效会陈旧、走原生失效则刷新、成员 add/remove | 10/10 PASS |
| I | 同部门两名用户缓存键与结果互不串 | 1/1 PASS |
| T | 父部门角色**不继承**（只用直接部门）；同属两个部门则都并入 | 2/2 PASS |
| M | 有成员时删除部门被原生 `destroyDepartmentCheck` 拒绝；移除成员后放行；`setDepartmentOwners` 改写 through 表 `isOwner` 并摘掉 `values.owners` | 3/3 PASS |

**框架替身边界**（写在 `department-candidate-check.json.steps.frameworkStubs`）：
`@nocobase/database` 的 `defineCollection/extendCollection` 只回传定义；`@nocobase/utils` 只提供
`getAuthCookieName/getAuthCookieOptions`；假 `db` 仓库 / 假 `ctx` / 无 TTL 内存 cache 是**注入端口**；
被测的 `setDepartmentsInfo` / `resetUserDepartmentsCache` / `setCurrentRole` / `destroyDepartmentCheck` /
`setDepartmentOwners` **都是真实发布产物**。没有把规则复制进 fixture，也没有 fixture 自写合并函数。

### 3.2 B2 补丁修的是什么（含一次自我更正）

- 最初的假设是"部门角色变更不失效缓存 → **授权角色**陈旧"。**受控运行否定了这个假设**（C0）：
  `attachRoles` 用的是实时 `roles` 查询，所以部门角色变化**立刻**反映到授权角色里。
- 真正陈旧的是被 `cache.wrap('departments:<uid>')` 缓存起来的**部门载荷**（其中 append 了 `roles`），
  部门↔角色变更不会失效它（C2–C5：pristine 陈旧、候选刷新）。
  这影响的是 `ctx.state.currentUser.departments[].roles` 这类展示/消费者一致性，**不是授权**。
- 同时 C7/C8 证明：缓存的 `departmentIds` **确实**门控授权范围，所以**成员关系**变更必须失效——
  而原生已经覆盖（中间件 `resetUserDepartmentsCache` + `departmentsUsers.afterSave/afterDestroy` 钩子里的
  `cache.del('departments:<userId>')`）。
- 结论：B2 是**一致性改进（可选）**，不是安全修复。若主 PM 认为不值得改上游产物，可以只做 B1。

---

## 4. 真实 13000 的现状与兼容性（只读核对）

数据来源：[`../docs/acceptance/full-pages-13000/department-candidate-evidence/live-13000-departments.json`](../../docs/acceptance/full-pages-13000/department-candidate-evidence/live-13000-departments.json)。

| 项 | 实测值 |
| --- | --- |
| 版本 | `2.2.20` |
| `@nocobase/plugin-departments` | `enabled=false`、`installed=false`、`builtIn=false`、`isCompatible=true`、`removable=true` |
| `departments` 集合 | `template=tree`、`titleField=id`、`filterTargetKey=id`、`autoGenId=false`，**集合元数据里没有 `migrationRules`** |
| 现有字段 | `id(snowflakeId,PK)`、`name(string)`、`dept_code(string)`、`organization_id(bigInt)`、`parentId(bigInt)`、`parent`、`children`、`organization`、`status(select)`、`notes(text)`、created/updated |
| 行数 | 50（root 28 / 有父 22，`status` 全 `active`） |
| 组织 | 1 条 |
| 关联读取 | `departments/<id>/members:list`、`departments/<id>/roles:list`、`roles/<role>/departments:list`、`users/<id>/departments:list` **全部 500**（插件未启用） |

插件定义（来自真实 dist）会**新增**：`title`、`isLeaf`、`members`、`roles`、`owners`（+ `sortable` 带来的排序字段），
以及 through 集合 `departmentsUsers`（`isOwner`/`isMain`）、`departmentsRoles`；并扩展 `users`
（`departments`、`mainDepartment`、`mainDepartmentId`）。
现有自定义字段（`name/dept_code/organization_id/status/notes/organization/...`）**不在**插件定义内。

**兼容性差异（安装前必须知道）**：

1. 原生插件用 **`title`** 作为部门名称（`fieldNames.label: 'title'`），而真实数据在 **`name`**；
   原生插件自己的界面/树选择器因此会显示空名称。这是**原生 UI 展示**问题，不影响
   `members`/`roles`/`attachRoles` 的 API 能力，也不影响我们自己的 AC-06 页面（它读 `name`）。
2. 原生 `isLeaf` 对既有 50 行为 NULL（插件只在后续 create/update/destroy 时维护）。
3. 真实集合没有 `migrationRules`，而插件的 `departments` 定义带 `migrationRules: ["overwrite"]`。

### 4.1 真实 ORM / 隔离 PostgreSQL 的安装兼容实验（本轮新增，12/12 PASS）

脚本：[`tools/dept-install-lab.mjs`](tools/dept-install-lab.mjs)（退出码 0）。
环境：`initdb` 起的**本机临时 PostgreSQL**（临时 data dir、端口 `15439`、短 socket 目录），
真实 `@nocobase/database@2.2.20` + `@nocobase/plugin-data-source-main@2.2.20`（固定 sha256 见 §2），
`departments`/`organizations` 字段按真实只读元数据、数据用**合成** 50 部门 / 1 组织。

| 断言 | 结果 |
| --- | --- |
| A1 复现自定义 schema：50 部门（28 root / 22 子）+ 1 组织 | PASS |
| B1 安装前 `pg_dump` 备份成功且可读 | PASS |
| C1 `db2cm` 在 metadata 已存在时是 **no-op**（不新增/不覆盖 collection-manager 里的 `departments` 字段） | PASS |
| C2 启用后 50/1 行、PK、父子结构与**内容校验和**完全不变，自定义列保留 | PASS |
| C3 插件新增列（`title` / `is_leaf` / `sort(BIGINT)`）与 through 表（`departments_users` / `departments_roles`）被创建 | PASS |
| H1 `sort` 用**真实** `@nocobase/plugin-field-sort@2.2.20` 的 `SortField`（`dataType=BIGINT`） | PASS |
| H2 合并后 `parent`/`children` 取插件代码定义（`treeParent/treeChildren=true`）；`mergedParent.onDelete=null` | PASS |
| H3/H3b 树策略：新建子部门→`isLeaf`、`children` 查询、换父、有子部门删除 400、清空后放行 | PASS |
| H4 安装的准确差异：`users.main_department_id` + 两张 through 表 + collection-manager 行数 | PASS |
| C4 内存中的 collection **同时**包含自定义字段（`name`…）与插件字段（`title`/`members`） | PASS |
| D1 through 表在真实 PG 上 add / remove / set / readback 正常 | PASS |
| D2 插件关联字段 `members`/`roles`/`owners` 在被合并后的 collection 上存在，target 正确 | PASS |
| E1 `pg_dump` 备份恢复到全新库 → 回到安装前：50/1 行、校验和一致、**没有**插件新增列/表 | PASS |
| F1 停用（`afterDisable`/`remove` 为空）不删结构：行数与 through 表仍在 | PASS |
| F2 失败路径可检出：非法字段类型让真实 `sync` 抛错（不会被当成安装成功） | PASS |
| G1 `migrationRules` 审计：同版 2.2.20 发布产物（database / server / ds-main / departments / acl / cache）中**没有任何非定义的读取点** | PASS |

**由此可以给出的结论**（取代之前"无法证明"的表述）：

1. `migrationRules` 在 2.2.20 运行时是**惰性元数据**；真正生效的是：
   `CollectionRepository.db2cm` → `CollectionModel.load()/loadFields()/migrate()` →
   `Collection.sync({ force:false, alter:{ drop:false } })`。
   确切路径与文件 sha256 见 `department-install-lab.json` 的 `steps.migrationRulesAudit.lifecycleSourceHashes`。
2. `db2cm` 对**已存在** metadata 的 collection 直接 return（实测 C1）→ 插件**不会**覆盖 13000 上
   `departments` 的 collection-manager 记录。
3. `CollectionModel.load()` 在 collection 已存在时走 `updateOptions` + `loadFields`（**不** `resetFields`）
   → 插件的 `title`/`is_leaf`/`members`/`roles`/`owners` 与自定义的 `name`/`dept_code`/`organization_id`/`parentId`/
   `parent`/`children`/`organization`/`status`/`notes` **共存**（实测 C4）。
4. 列级 DDL 只做 `ADD COLUMN`：`title`、`is_leaf`、`sort`；through 表新建；**没有**删列/改列/丢数据（实测 C2/C3）。
5. 回退：`disable` 不回滚结构；**结构回退靠安装前备份**，实测 E1 可回到安装前结构。

**仍未证明（如实保留）**：

- **HTTP 关联链未跑通**：最小真实 2.2.20 Application 可以 `load → install → start → 监听`（12 个同版插件，
  含 `plugin-departments`）。第四轮已定位并修复 404：根因是手工 bootstrap 缺 resourcer 前缀，真实启动代码为
  `app-options-factory.js:77 resourcer:{prefix:process.env.API_BASE_PATH}` / `gateway/index.js:204`；
  修复后 `authenticators:publicList` → **200**，但 `auth:signIn` 仍 500（`Authenticator [basic] is not found`）。因此 HTTP 的
  members/roles add·remove·set·readback、effectiveRole、隔离与撤销**仍未证明**。
  见 [14 报告](../../docs/acceptance/full-pages-13000/14-department-candidate.md) §3.9 与
  `department-candidate-evidence/app-bootstrap-attempt.log`。
- 未在真实 NocoBase 应用（含真实 13000 库）上跑 enable/disable；本实验用的是真实 ORM + ds-main 的
  `db2cm/load/migrate/sync` 代码 + 真实 `SortField`，但整应用的 HTTP 层未跑通。
- `migrationRules`：六包非定义读取点扫描为 0 **只界定检查范围**；"真实实例不会覆盖"是由
  `db2cm` no-op + `CollectionModel.load` 合并 + 隔离 PG 实测三者推出的结论，未在完整应用证明。
- 未验证真实 13000 上 `parent`/`children` 的 collection-manager 记录是否也带 `treeParent/treeChildren`
  （自定义集合 `template=tree`，实测合并后两者共存且关联定义指向正确 target；但"合并后 tree 语义由哪一份定义决定"
  需在真实实例上确认）。
- 未验证并发写入、事务边界与多节点缓存。

---

## 5. 生命周期行为（源码事实；**未在真实实例执行**）

`@nocobase/plugin-departments@2.2.20` 的 `dist/server/plugin.js`：

| 阶段 | 行为 |
| --- | --- |
| `beforeLoad()` | 注册 `DepartmentModel`；给 `collections:destroy` 加固定过滤，禁止删除 `departments` / `departmentsUsers` / `departmentsRoles` 三个集合 |
| `load()` | 注册 `users:listExcludeDept`、`departments:aggregateSearch/setOwner/removeOwner`；注册 ACL snippet；挂 5 个中间件（`setDepartmentsInfo` 在 `before: setCurrentRole, after: auth`）；挂 `departmentsUsers.afterSave/afterDestroy` 缓存失效、`users.afterSaveWithAssociations/beforeSave` 主部门同步；`beforeSignOut` 清缓存 |
| `install()` | `collections` 仓库 `db2cm('departments')`；若缺则创建 `users.departments` / `users.mainDepartment` 字段记录 |
| `afterEnable()` / `afterDisable()` / `remove()` | **都是空实现** |

**对回退的含义**：`disable` 只回到"行为不生效"，**不会**删除它新增的列/表；因此
"彻底回到变更前结构"要靠数据库备份，而不是 disable。反过来说，disable 是低风险、可逆的一步。

---

## 6. 安装 / 回退（具体命令，**本组未执行**）

工具：[`tools/candidate-install.mjs`](tools/candidate-install.mjs)（纯 Node；以 [`patch-manifest.json`](patch-manifest.json) 为事实来源）。

```bash
# 0) 先看计划（只打印，不执行）
node patches/nocobase-2.2.20-departments/tools/candidate-install.mjs plan

# 1) B1：安装并启用原生插件（示例；真实命令取决于目标实例的 CLI/容器）
nb plugin enable @nocobase/plugin-departments     # 或平台等价的 enable 操作
#    之后按目标实例方式重启应用进程

# 2) B2（可选）：先干跑，再打补丁
PLUGIN_DEPARTMENTS_DIR=<核实过的 @nocobase/plugin-departments 包根绝对路径>
node .../candidate-install.mjs inspect  --target "$PLUGIN_DEPARTMENTS_DIR"
node .../candidate-install.mjs dry-run  --target "$PLUGIN_DEPARTMENTS_DIR"
node .../candidate-install.mjs apply    --target "$PLUGIN_DEPARTMENTS_DIR" \
  --backup-dir /var/backups/crewloom-departments-$(date +%Y%m%d%H%M%S) --yes
#    之后重启

# 3) 回退
node .../candidate-install.mjs rollback --target "$PLUGIN_DEPARTMENTS_DIR" --backup-dir <备份目录>   # B2
nb plugin disable @nocobase/plugin-departments                                                        # B1（行为回退）
#    彻底结构回退 → 用安装前的数据库备份恢复
```

`apply` / `rollback` 的保证与 B1 候选同源：**原始哈希防错**（不符即中止、不写文件）、
**自动备份 + 备份完整性校验**、**恢复后字节级校验**、缺 `--backup-dir` 时拒绝（不以 `npm --force` 作回退）。
实测反向守卫：对已打补丁的目标 `apply` → 退出码 1；缺 `--backup-dir` 的 `rollback` → 退出码 2。
纯本机 fixture 往返（`roundtrip`）→ `EXIT=0`，`byte-hash 还原=true`。

### 6.1 安装前必须核实（本组没接触过容器内部，因此不宣称"一键可用"）

1. 数据库备份可用且**已校验**，记录备份时间与校验方式；
2. 只读 schema 快照（`collections/departments/fields` + 50 行计数），供回退后比对；
3. **隔离实例先试** enable/disable（同版本、同自定义 schema）；
4. `migrationRules` 语义仍属未知（§4）——隔离实例试完再评估；
5. `@nocobase/plugin-departments` 包根的实际绝对路径与权限（B2 需要可写）；
6. 应用重启方式与允许窗口；
7. 目标实例 `ai`/`user-data-sync` 等插件状态（`load()` 里对 `user-data-sync` 是可选依赖）。

---

## 7. 未覆盖 / 不能声称

- 没有在**真实 NocoBase 应用**上 enable/disable（本实验是"真实 ORM + ds-main 生命周期代码 + 隔离 PostgreSQL"，
  不是完整应用；`sort` 字段类型用同族 `IntegerField` 做框架 shim）；
- 没有真实 HTTP 写、没有重启、没有在 13000 上做任何操作；
- 没有验证原生插件启用后 `title`/`isLeaf` 与既有 `name` 数据共存时的**实际 UI**表现（§4 兼容性差异 1）；
- 没有验证 `departmentsUsers.isMain`（已 deprecated）与 `users.mainDepartmentId` 同步在真实数据上的结果；
- 没有验证 `parent`/`children` 合并后 tree 语义由哪一份定义决定（§4.1 剩余未知）；
- 部门有效角色合并（E/C/I/T/M 组）仍是**受控运行**（真实中间件 + 注入端口），未在真实应用中间件链里跑。

---

## 8. 关于自定义插件（结论：本轮不需要）

按 `nocobase-plugin-development` Skill 的要求先核实环境：该 Skill 的 **Step 0 是硬门禁 —— 需要 NocoBase 源码树**
（`packages/core/`），本工作树没有；且 **Step 2 要求在写任何代码前先与用户确认计划**。
由于原生 `plugin-departments@2.2.20` 已提供所需的成员/角色/生效合并能力，**本轮不需要新建自定义插件**，
因此没有执行 scaffold，也没有安装/启用任何插件。若后续隔离实例试跑证明原生插件与自定义 schema 不兼容、
必须新建桥接插件，则应另开流程：先取得计划确认 → 用源码树 scaffold → 编译/安装说明 → 再回到本候选的
备份/回退要求。许可：`@nocobase/plugin-departments` 随包 `LICENSE` 为 NocoBase 双许可（AGPL-3.0 / 商业），
本候选只做本机只读分析与 dist 补丁，不重新分发该包。
