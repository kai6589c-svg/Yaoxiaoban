# medicine-api

药小伴的统一业务云函数。它负责身份、所有权、输入校验、版本冲突、请求幂等、数据导出和账号删除。客户端不得直接访问数据库。

## 调用协议

请求固定为：

```json
{
  "action": "medication.create",
  "requestId": "device-uuid-00000001",
  "payload": {
    "profileId": "profile_xxx",
    "name": "药品名称",
    "expiry": { "precision": "month", "value": "2027-06" }
  }
}
```

- 所有写操作必须提供 8–128 字符的 `requestId`；同一个 `requestId` 重试会返回第一次的结果。
- 更新和删除在 `payload` 中提供 `expectedVersion`；计划保存/停止使用 `expectedMedicationVersion`。
- 不接受 `OPENID`、`accountId` 或任意未知字段。身份只取自 `cloud.getWXContext()`。
- 日期为 `YYYY-MM-DD`，月份为 `YYYY-MM`，钟点为 `HH:mm`，时间戳必须是带时区的 ISO 8601。

成功响应：

```json
{ "ok": true, "data": {}, "requestId": "device-uuid-00000001" }
```

失败响应：

```json
{
  "ok": false,
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "记录已在其他设备上更新，请刷新后重试"
  },
  "requestId": "device-uuid-00000001"
}
```

## Actions

| Action                                        | 用途                             | 关键 payload                                        |
| --------------------------------------------- | -------------------------------- | --------------------------------------------------- |
| `bootstrap`                                   | 创建默认“我”和默认设置           | 空                                                  |
| `today.get`                                   | 今日计划与效期/预计不足风险      | 空                                                  |
| `cabinet.get`                                 | 药箱、最近盘点和预计库存         | 空                                                  |
| `profile.list/create/update/delete`           | 代管成员                         | 名称、关系、颜色；更新/删除带版本                   |
| `medication.get/create/update/archive/delete` | 私人药品                         | 成员、名称、规格、单位、有效期、开封期限、备注      |
| `plan.list/save/stop`                         | 版本化服药计划                   | `daily`、`weekdays` 或 `prn`；保存/停止校验药品版本 |
| `snapshot.list/create`                        | 实际库存盘点                     | 数量、单位、盘点时间                                |
| `intake.list/record/undo`                     | 已服、未服、额外服用与撤销       | 计划任务由 `planId + scheduledAt` 唯一确定          |
| `settings.get/update`                         | 提前天数、隐私标题、低频订阅开关 | 更新带版本                                          |
| `data.export`                                 | 返回该账号的可移植 JSON          | 空；超过安全体积会拒绝并提示人工支持                |
| `account.delete`                              | 删除业务数据和账号映射           | 空；必须有 `requestId`                              |

稳定错误码包括：`INVALID_ARGUMENT`、`UNAUTHENTICATED`、`NOT_FOUND`、`VERSION_CONFLICT`、`IDEMPOTENCY_KEY_REUSED`、`OPERATION_IN_PROGRESS`、`UNIT_MISMATCH`、`PROFILE_IN_USE`、`LIMIT_EXCEEDED` 和 `INTERNAL`。客户端应按错误码处理，不解析中文文案。

## 数据与计算语义

- `version` 从 1 开始。更新使用数据库条件 `accountId + _id + version`，并原子加一。
- 用户可不打卡。预计库存从最近一次 `inventory_snapshot` 开始，计划时间到达即按计划消耗；`taken` 不重复扣减，`skipped` 返还，`extra` 额外扣减，已撤销日志不参与计算。
- 月精度有效期按该月最后一天计算并保留原始精度。包装期限与开封后期限取较早者。
- 每次新计划生成不可变版本，药品的 `activePlanId` 是当前计划的权威引用；旧计划只用于历史估算。
- 对外预计库存不会出现负数，缺口单独放在 `deficit`；无盘点、单位不一致或按需计划时明确返回不能预测的原因。
- `plan.save` / `plan.stop` 同时返回更新后的 `medication`，前端必须保存其新版本号。

## CloudBase 初始化

创建以下集合（默认前缀 `yxb_`）：

```text
accounts
profiles
medications
plans
snapshots
intake_logs
settings
idempotency
reminder_tasks
deletion_jobs
```

最少索引：

| 集合                                  | 索引字段                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 所有账号业务集合                      | `accountId ASC, _id ASC`                                                                             |
| `medications`                         | `accountId ASC, profileId ASC, _id ASC`；`accountId ASC, status ASC, _id ASC`                        |
| `plans` / `snapshots` / `intake_logs` | `accountId ASC, medicationId ASC, _id ASC`                                                           |
| `reminder_tasks`                      | `status ASC, dueAt ASC`；`status ASC, leaseUntil ASC`；`accountId ASC, medicationId ASC, status ASC` |
| `settings`                            | `accountId ASC`                                                                                      |

数据库安全规则必须对小程序端设为完全拒绝；不要使用“仅创建者可读写”，因为所有访问都应走云函数并经过版本与所有权校验。云函数日志只记录 action、错误码和随机 trace ID，不记录药名、剂量、备注、照片、请求体或 OPENID。

可选环境变量：

| 名称                | 默认值 | 说明                                   |
| ------------------- | ------ | -------------------------------------- |
| `COLLECTION_PREFIX` | `yxb_` | 只允许字母开头的字母、数字、下划线前缀 |

部署前在微信开发者工具中为 `medicine-api` 安装云端依赖并上传部署。使用真实环境做两账号越权测试前，不得把本地 mock 结果当成生产权限验证。

## 删除与保留

`account.delete` 在删除前创建只含散列标识的墓碑，随后逐集合清除该 `accountId` 的业务数据和账号中的原始 OPENID。相同 `requestId` 可安全重试。完成墓碑不含药品或服药信息，建议在 CloudBase 中配置 30 天 TTL；`idempotency.expiresAt` 建议配置 7 天 TTL，`deletion_jobs.expiresAt` 建议配置 30 天 TTL。

## 测试

```bash
npm install --prefix cloudfunctions/medicine-api
npm test --prefix cloudfunctions/medicine-api
```

测试不需要微信账号，覆盖日期/时区、计划边界、预计库存、字段白名单、OPENID 身份失败、写请求幂等和删除重试。部署后仍需补做真实 CloudBase 集合、索引、OPENID 与跨账号权限测试。
