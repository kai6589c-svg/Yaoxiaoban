# 公开仓库与本地部署配置

公开版本以 beta.18 源码为基础建立独立初始提交。原工程的开发历史、部署记录、测试照片、原始日志和本机配置不属于公开仓库内容。

## 配置生成

`npm ci` 的 postinstall 和 `npm run build` 的 prebuild 会读取 `deployment.local.json`；文件不存在时使用 `deployment.example.json` 的隔离演示配置。无效配置会直接报错，不会回退。

配置模板为 `project.config.example.json`、`cloudbaserc.example.json` 和 `miniprogram/config/runtime.example.ts`。生成文件被忽略，避免部署配置被意外提交。

正式模式配置样式（全部替换为自己的值）：

```json
{
  "deploymentMode": "production",
  "appId": "wx1234567890abcdef",
  "cloudEnvId": "your-own-environment",
  "subscriptionTemplates": { "dose": "", "expiry": "", "lowStock": "" }
}
```

正式发布运行 `npm run release:check`。该命令拒绝 demo 和占位 AppID；仓库 CI 使用 `npm run check` 验证演示构建，不触碰正式环境。

## 后台任务

提醒 worker 不再内置原项目订阅模板 ID，必须在云函数环境变量中配置 `DOSE_TEMPLATE_ID` 等模板及字段映射，并显式设置发送开关和环境 ID。缺少模板时不会发送对应提醒。

维护 worker 需要显式启用 `MAINTENANCE_ENABLED`，其超时为 60 秒。启用前按数据库清单配置集合及索引。后台 worker 的客户端调用权限应设为拒绝，仅允许定时器和管理员使用。

## Git 操作

```sh
git status
git switch -c codex/your-change
npm run check
git add <changed-source-files>
git commit -m "Describe the change"
git push -u origin codex/your-change
```

不要将原工程的全部历史直接合并或推送到公开仓库；先检查历史内容是否适合公开。公开仓库不包含运行日志或个人用户数据。
