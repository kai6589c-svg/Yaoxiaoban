# reminder-worker

低频微信订阅消息执行器。定时触发器每 15 分钟读取 `yxb_reminder_tasks`，通过数据库状态租约防止多个执行实例同时发送同一任务。

它不负责每日服药提醒；每日提醒由客户端明确授权后写入手机日历。这里只处理：

- `expiry`：药品即将到期。
- `shortage`：按用户的计划和最近盘点，预计库存即将不足。

## 默认绝不发送

只有以下条件全部满足才会调用微信发送接口：

1. `REMINDER_SEND_ENABLED=true`；
2. `REMINDER_ENV_ID` 非空，且定时函数运行环境与其一致；
3. 对应模板 ID 和合法字段映射均已配置；
4. 账号仍有效，且用户设置中的对应订阅开关仍为 `true`。

任一模板缺失时，该类型任务保持待处理但不会取得发送租约；全局开关或环境 ID 缺失时，函数不读取任务。代码仓库中的默认状态不会发送任何消息。

## 环境变量

| 名称                         | 必填           | 示例                                                          |
| ---------------------------- | -------------- | ------------------------------------------------------------- |
| `REMINDER_SEND_ENABLED`      | 是             | `true`                                                        |
| `REMINDER_ENV_ID`            | 是             | `cloud1-prod-xxxx`                                            |
| `COLLECTION_PREFIX`          | 否             | `yxb_`                                                        |
| `EXPIRY_TEMPLATE_ID`         | 到期提醒启用时 | 微信公众平台模板 ID                                           |
| `SHORTAGE_TEMPLATE_ID`       | 不足提醒启用时 | 微信公众平台模板 ID                                           |
| `EXPIRY_TEMPLATE_DATA_MAP`   | 到期提醒启用时 | `{"medicineName":"thing1","date":"date2","message":"thing3"}` |
| `SHORTAGE_TEMPLATE_DATA_MAP` | 不足提醒启用时 | 同上，字段名按获批模板填写                                    |
| `REMINDER_PAGE`              | 否             | `pages/today/index`                                           |
| `MINIPROGRAM_STATE`          | 否             | `developer`、`trial` 或 `formal`；安全默认 `developer`        |

字段映射值只接受微信模板关键字格式（如 `thing1`、`date2`、`phrase3`）。药名和提示被截断到 20 个 Unicode 字符；模板的具体字段限制仍须用最终获批模板真机验证。

## 幂等与失败处理

- API 按账号、药品、提醒类型和来源版本生成确定性任务 ID；同一业务任务不会重复创建。
- Worker 只把 `pending` 且版本匹配的任务原子改为 `sending`，成功后改为 `sent`；再次运行不会重发 `sent` 任务。
- 微信明确拒绝、模板无效或参数无效等永久错误会进入 `failed_permanent`，不骚扰用户。
- 网络和平台瞬时错误最多重试 5 次，按 15 分钟、30 分钟、1 小时递增，最长 24 小时。
- 执行实例在微信返回后、数据库落状态前崩溃时，平台没有可用的端到端幂等键。过期租约会被恢复，因此极端情况下可能重复一次；这是微信接口限制，不能声称“严格恰好一次”。消息文案必须能容忍重复。
- 日志只写错误码，不写 OPENID、模板内容、药名或任务 payload。

## 部署

`config.json` 已声明 `subscribeMessage.send` 权限和 15 分钟定时触发器。部署前：

1. 按 `medicine-api/README.md` 创建集合和索引。
2. 安装云函数依赖并部署，但先保持 `REMINDER_SEND_ENABLED=false` 或不设置。
3. 在测试环境填入环境 ID、测试模板与 `MINIPROGRAM_STATE=developer`，用测试账号完成授权、拒绝、模板错误和重复执行测试。
4. 只有测试环境通过后，才在生产环境设置正式模板、`MINIPROGRAM_STATE=formal` 和发送开关。

本地验证：

```bash
npm install --prefix cloudfunctions/reminder-worker
npm test --prefix cloudfunctions/reminder-worker
```
