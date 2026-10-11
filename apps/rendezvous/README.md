# @huhao/rendezvous —— 远程入口（Cloudflare Worker + KV + PWA 外壳）

**不内置任何默认域名。** 每个用户在 App「设置 → 远程入口」里填写**自己的**域名（已托管在 Cloudflare）、子域名和**自己的** Cloudflare API Token，
服务端（`packages/server/src/cloudflare.ts`）通过 Cloudflare REST API 把本 Worker 部署到用户自己的账号：

1. 验证 Token → 2. 按域名查 zone（自动得到 account id）→ 3. 创建/复用 KV `huhao-rendezvous-servers` →
4. 上传 PWA 静态资源（assets-upload-session）→ 5. 上传 Worker 模块（`dist/worker.js`，绑定 `SERVERS` KV 与 `ASSETS`）→
6. 绑定 Workers Custom Domain（Cloudflare 自动建 DNS 记录与证书）→ 7. 轮询 `https://<子域名>.<域名>/api/health`。

Token 只用主密钥加密保存在本机，只发给 `api.cloudflare.com`。

## 作用
- 托管 PWA 外壳：手机扫码打开的固定网址；
- `PUT /api/servers/:serverId`：电脑用 Ed25519 签名登记当前隧道地址（首次登记的公钥 TOFU 绑定，防重放）；
- `GET /api/servers/:serverId`：手机查询并用配对时拿到的公钥验签。只交换地址，不经手聊天内容。
- `GET /api/health`：部署检查。

## Token 权限
模板「编辑 Cloudflare Workers」（Edit Cloudflare Workers），区域资源包含你的域名即可。

## 免费套餐额度
Workers 每天 10 万次请求；KV 每天 10 万次读、1000 次写、1 GB；静态资源请求不计费；自定义域名/证书免费。

## 开发
```bash
npm run build -w @huhao/rendezvous     # esbuild → dist/worker.js
npm test -w @huhao/rendezvous
# 命令行部署（与设置页同一流程，需本机胡好好服务在运行）：
CLOUDFLARE_API_TOKEN=... node scripts/deploy-rendezvous.mjs --zone example.com --sub huhao
```
