# CloudBase 部署指南

本文是 `0.5.0-beta.18` 的部署和验收手册。它说明代码需要什么云资源，以及哪些步骤必须在真实 CloudBase / 微信开发者工具中完成。仓库内的单元测试和隔离演示不会自动证明生产云环境、真实 AppID 或双账号权限已经通过。

## 1. 准备环境

创建开发、测试、生产三个相互隔离的 CloudBase 环境。生产环境不得使用 `touristappid`，并应确认环境归属于当前微信小程序 AppID 和真实运营主体。

先按 [公开仓库配置说明](github-setup.md) 创建本地正式配置；下列值均由部署者提供：

- AppID：自己的正式小程序 AppID；
- CloudBase 环境：自己的独立云环境；
- 集合前缀：`yxb_`；
- 业务时区：`Asia/Shanghai`；
- `medicine-api`：小程序调用的统一业务入口；
- `reminder-worker`：仅由定时器触发的低频提醒执行器；发送开关默认关闭。
- `maintenance-worker`：独立部署包中的后台分页维护/删除清理执行器，不可依赖部署包外的兄弟函数目录。

部署前先执行：

```bash
npm run build
npm run build:cloudfunctions
npm run verify:release-config
npm run verify:cloudbase-manifest
```

## 2. 创建集合与权限

以 [`cloudbase-database-manifest.json`](cloudbase-database-manifest.json) 为唯一清单创建 15 个集合：

```text
yxb_accounts
yxb_profiles
yxb_medications
yxb_plans
yxb_snapshots
yxb_intake_logs
yxb_settings
yxb_calendar_exports
yxb_idempotency
yxb_reminder_tasks
yxb_media
yxb_deletion_jobs
yxb_subscription_grants
```

每个集合的小程序客户端安全规则必须完全关闭：

```json
{
  "read": false,
  "write": false
}
```

这包括保存上传任务和照片元数据的 `yxb_media`。客户端只可调用 `medicine-api`；源码中不应出现 `wx.cloud.database()`。配置后从控制台逐集合重新打开权限页，回读为 `read: false`、`write: false`；只看到“保存成功”不算验收完成。

## 3. 创建 26 个索引

逐项创建 manifest 中的 26 个复合索引。索引名称可因控制台长度限制调整，但字段、顺序和方向必须保持一致。创建后等待状态变为“可用”，再回读字段顺序。

索引覆盖范围如下：

- `accountId ASC, _id ASC`：所有需要账号分页的业务集合；
- 药盒：账号 + 成员、账号 + 状态和账号 + 成员 + 状态；
- 计划 / 盘点 / 服用记录：账号 + 药盒；
- 日历账本：账号 + fingerprint，以及账号 + 药盒 + staleAt；
- 提醒任务：账号 + 药盒 + 状态、状态 + dueAt、状态 + leaseUntil；
- 媒体账本：账号 + 药盒、账号 + 状态。

先执行清单校验，再用两个测试账号写入隔离数据，完成首页、药箱、详情、计划、盘点、服用记录、历史、日历账本、照片、导出和删除路径，确认没有 `index not found`，且账号 B 永远不能读取、修改或删除账号 A 的资源。

## 4. 部署云函数

在微信开发者工具的“云开发控制台”中，分别从生成的以下目录部署三个函数；不要选择仓库源目录，也不要把 `maintenance-worker` 与包外的 `medicine-api/lib` 拼接上传：

```text
dist/cloudfunctions/medicine-api/
dist/cloudfunctions/reminder-worker/
dist/cloudfunctions/maintenance-worker/
```

每个函数选择“上传并部署：云端安装依赖（不上传 node_modules）”，或使用已证明登录到同一 AppID/环境的 CloudBase CLI。部署后回读函数状态、运行时、更新时间、超时和触发器，并记录对应 `BUILD_ID` 与 `BUILD_MANIFEST.json` SHA-256。若开发工具版本对完整目录部署报目录读取错误，可在同一已登录 CLI 中按生成包的文件清单逐文件增量上传；不得改为上传源目录或仅上传 `index.js`。

函数职责必须分离：

- `medicine-api`：允许小程序调用，从 `getWXContext().OPENID` 取得身份；不配置定时触发器；不申请 `subscribeMessage.send`。
- `reminder-worker`：禁止客户端直接调用，只由定时器运行，不调用 `getWXContext()`；仅在发送开关、环境 ID、模板和用户订阅都满足时发送低频消息。
- `maintenance-worker`：禁止客户端直接调用，只由维护定时器运行；启用前先确认独立包的 `index.main` 冷启动和分页/墓碑收尾。

当前定时器为七段 Cron，每 15 分钟触发一次：

```json
{
  "name": "dispatch-due-reminders",
  "type": "timer",
  "config": "0 */15 * * * * *"
}
```

部署初期保持 `REMINDER_SEND_ENABLED=false` 或不配置发送开关，先完成业务和隐私验收。代码仓库中的订阅模板 ID 为空，不能把模板未配置描述为“已经送达”。

## 5. 药盒照片的 CloudBase 生命周期

照片上传不是把客户端随意传入的 URL 写入药盒。客户端与服务端按以下顺序协作：

```text
prepareMedicationPhoto
  → 服务端检查药盒仍 active、版本匹配
  → 生成 account 隔离的 medication-photos/{owner}/{mediaId}.jpg
  → yxb_media 写入 prepared，票据有效 24 小时
  → 客户端用 wx.cloud.uploadFile 上传
  → commitMedicationPhoto
  → 服务端精确校验 fileId 与 cloudPath、远端大小和图片内容
  → yxb_media = validated，药盒写入 photo 引用
  → yxb_media = attached
```

照片引用从 `null` 变成对象时，CloudStore 必须用
`db.command.set(photo)` 整体替换 `photo` 字段。CloudBase 会把普通对象更新
展开为子字段更新，无法在 `photo: null` 下创建 `photo.fileId`；这会造成
“文件上传成功，但绑定药盒失败”。不能只用直接合并对象的内存 Store 测试
替代这一适配层验证。

服务端使用 SDK 返回的 HTTPS 临时下载链接，执行一次有界 GET：先检查
Content-Length，再限制实际读取最多 2 MiB，10 秒绝对超时。不要对 GET
签名链接执行 HEAD；没有 Content-Length 的分块响应也必须按实际字节限流。
照片接口保留媒体错误码，客户端区分临时服务失败、网络失败与需要重新选图的情况。

照片约束：

- 客户端优先压缩到目标边长约 1280px、质量约 72；
- 上传前和服务端再次限制不超过 2 MiB；
- 服务端只接受可确认完整性的 JPG、PNG、WebP；
- 单边超过 6000px 或总像素超过 20 MP 会拒绝；
- `fileId` 必须与票据生成的完整路径精确相等；路径前缀、后缀、查询串、片段、反斜杠、重复分隔符和 `..` 均不接受；
- 跨账号的媒体票据、文件 ID 和药盒 ID 必须返回无权或任务失效，不能泄露对象是否存在。

媒体状态：

| 状态              | 含义                             | 清理策略                                 |
| ----------------- | -------------------------------- | ---------------------------------------- |
| `prepared`        | 已发票据，尚未确认文件           | 过期、取消或上传失败时删除对象并移除账本 |
| `validated`       | 文件检查通过，药盒引用尚未收尾   | 下次媒体操作对账；没有对应引用则清理     |
| `attached`        | 药盒已引用                       | 更换、移除、删除药盒或删除账号时进入清理 |
| `cleanup_pending` | 已请求清理但对象或账本未全部结束 | 保留账本重试，不把失败误报成已删除       |

以下场景会触发清理：更换照片、移除照片、永久删除药盒、账号删除、票据过期、客户端主动 discard 和服务端校验失败。服务端先移除药盒引用，再尝试删除旧对象；删除失败会保留 `cleanup_pending`，由后续媒体操作或运维任务继续处理。

当前上传协议无法知道用户是否在“上传完成、commit 尚未到达”时直接关闭小程序，因此真实环境仍必须验证孤儿对象的过期清理和重试 SLA。`yxb_media` 的票据和状态只能帮助服务端收敛，不能声称客户端异常断电时绝对零孤儿。

上线前至少用真机验证：相机、相册、拒绝权限、取消选择、超大文件、非图片、上传断网、保存冲突、更换、移除、删除药盒、删除账号和跨账号 fileId。

## 6. 环境变量和低频订阅

订阅模板未配置时 worker 必须安全退出，页面风险卡片不受影响。正式启用低频微信提醒时至少配置：

- `REMINDER_ENV_ID`；
- `REMINDER_SEND_ENABLED=true`；
- `EXPIRY_TEMPLATE_ID` / `SHORTAGE_TEMPLATE_ID`；
- 对应模板字段映射；
- `REMINDER_PAGE`；
- `MINIPROGRAM_STATE=formal`。

禁止把腾讯云密钥、session key 或服务端凭据放进小程序源码。字段映射必须按最终获批模板真机校验；“服务端受理”不能写成“用户已收到”。

## 7. 双账号安全验收

使用账号 A 与 B 分别创建成员、药盒、计划、盘点、记录和照片，然后把 A 的资源 ID、版本号、媒体 ID、fileId 和导出请求带入 B 的读写请求。每次都应返回 `NOT_FOUND`、`FORBIDDEN` 或任务失效等安全错误，不透露 A 的资源是否存在。

同时检查：

- 客户端数据库权限 14 个集合均为关闭；
- 云函数只从运行上下文取 OPENID；
- 日志、错误和临时 URL 不含药名、剂量、备注、原始图片或导出正文；
- 账号删除墓碑不保存可逆 OPENID / accountId；
- 媒体对象路径包含服务端生成的账号隔离片段，不接受客户端自定义路径。

## 8. 删除演练

创建包含全部资源类型（成员、药盒、计划、盘点、服用记录、日历账本、提醒任务和照片）的测试账号，发起删除后确认：

1. 账号立即不能读取原业务数据；
2. 提醒任务停止；
3. 照片对象删除失败时留下可重试的清理状态，不跳过其他安全步骤；
4. 活动业务集合在约定的 24 小时内清理；
5. 相同 requestId 重试不会重复执行或恢复账号；
6. 手机系统日历中的旧事件不会被声称自动清除，用户得到手动清理提示。

## 9. 验收记录与边界

本仓库的自动化证据包括根目录 Vitest、两个云函数测试、TypeScript / ESLint / Prettier、manifest / release config / bundle / security 门禁和隔离演示 E2E。它们分别验证代码确定性、云函数逻辑和本地页面旅程，不能替代：

- 真实 CloudBase 控制台逐集合权限 / 索引回读；
- 两个真实微信账号的 OPENID 隔离；
- iOS / Android 相机、照片上传与系统日历权限；
- 微信订阅模板真实授权与到达；
- 微信公众平台服务类目、备案、隐私保护指引、审核和发布。

部署状态、测试次数和已知工具限制应记录在自己的验收文档中；原始日志和包含个人信息的截图不提交公开仓库。
