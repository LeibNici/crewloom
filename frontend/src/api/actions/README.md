# 模块动作分片（`src/api/actions/*.json`）

每个业务模块一个文件，**由该模块的负责组独占修改**，这样三组并行时不会同时改
`src/api/transport-policy.json`。

## 文件格式

```json
{
  "module": "workflow",
  "owner": "组 C（WF + TD）",
  "readActions": ["workflows:get", "flow_nodes:list"],
  "productActions": ["flow_nodes:update"],
  "notes": "说明边界"
}
```

| 字段 | 含义 | 生效方式 |
| --- | --- | --- |
| `readActions` | 严格验证模式下允许的**只读 GET** 动作 | 静态合并进 `transport-policy.json` 的 `readActions` |
| `productActions` | 真实用户在产品中可主动触发的动作（写入、外呼、流程推进） | **只登记不合并**；产品模式本来就不做动作白名单，严格模式一律拦截 |
| `notes` | 该模块的边界说明 | 仅文档 |

## 动作名规则

动作名取自请求路径最后一段 `:<action>` 前的资源名，例如：

| 实际请求 | 策略里的动作名 |
| --- | --- |
| `GET /api/flow_nodes:list?filter=...` | `flow_nodes:list` |
| `POST /api/roles/member/resources:create` | `resources:create` |
| `POST /api/collections:update` | `collections:update` |

关联资源（父资源 + 子资源）只按**最后一段**记账，因此 `roles/<name>/resources:list` 记为 `resources:list`。

## 修改约定

1. 只改自己模块的分片文件；不要改 `transport-policy.json`（公共负责人唯一所有）。
2. 新增只读动作前确认它**不产生外部副作用**（不建连、不外呼、不推进流程），否则放进 `productActions`。
3. 合并是**静态导入**（见 `src/api/policy.ts`），没有生成流水线、没有代码生成步骤。
4. 合并结果里重复动作会自动去重；顺序稳定（基础清单在前，分片按声明顺序在后）。
