# 药小伴云函数

服务端由两个可独立部署的云函数组成：

- `medicine-api`：唯一面向小程序的业务入口。所有私人数据只能经该函数访问。
- `reminder-worker`：每 15 分钟执行一次，只处理效期和预计不足两类低频订阅任务。

两个函数默认使用 `yxb_` 集合前缀。生产环境必须禁止小程序客户端直接读写这些集合；云函数通过可信微信上下文取得 `OPENID`，请求体中的身份字段会被输入白名单拒绝。

本地验证：

```bash
npm test --prefix cloudfunctions/medicine-api
npm test --prefix cloudfunctions/reminder-worker
```

部署和数据索引细节分别见两个函数目录内的 README。AppID、CloudBase 环境 ID、订阅模板 ID 均不写入仓库。
