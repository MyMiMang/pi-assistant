# @huhao/rendezvous —— 入口域名（Cloudflare Worker + KV）

作用：
1. 托管 PWA 外壳（`apps/web/dist`），即手机扫码打开的固定网址 `https://app.dengdengyun.shop`；
2. “地址簿”：保存 `serverId → 当前隧道地址`。各用户电脑上的服务用自己的 Ed25519 私钥签名上报；
   首次上报登记公钥（TOFU），之后只接受同一公钥；手机端用配对时保存的公钥再次校验，Rendezvous 无法伪造地址。

多用户：任意多台服务注册到同一个 Rendezvous，每部手机只知道自己配对过的 serverId。**它从不经手聊天内容、文件或模型凭据。**

## API
| 方法 | 路径 | 说明 |
|---|---|---|
| `PUT` | `/api/servers/:serverId` | `{url, ts, sig, publicKey}`；签名内容 `huhao-rendezvous-v1\n{serverId}\n{url}\n{ts}`；ts 需在 ±10 分钟内且单调递增 |
| `GET` | `/api/servers/:serverId` | `{url, ts, sig}`（手机端自行验签） |

记录 30 天无更新自动过期（服务每 30 分钟心跳一次）。

## 部署（需要用户提供 Cloudflare API Token）
Token 权限（Cloudflare Dashboard → My Profile → API Tokens → Create Custom Token）：
- Account · **Workers Scripts: Edit**
- Account · **Workers KV Storage: Edit**
- Zone（dengdengyun.shop）· **Workers Routes: Edit**
- Zone（dengdengyun.shop）· **DNS: Edit**（custom_domain 自动创建 DNS 记录需要）
- Zone · Zone: Read

```bash
export CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=...
npm run deploy -w @huhao/rendezvous            # 默认 app.dengdengyun.shop
HUHAO_ENTRY_DOMAIN=hh.example.com npm run deploy -w @huhao/rendezvous   # 自建
```
建议在 Cloudflare 上为 `/api/servers/*` 配一条 Rate Limiting 规则（例如每 IP 每分钟 60 次）。

## 自建
任何人都可以用自己的域名部署一份，然后在 App「设置 → 入口域名」里填写，无需重新安装。
