# openclaw（垫片，不是 OpenClaw）

腾讯官方微信 ClawBot 插件 `@tencent-weixin/openclaw-weixin`（MIT）是一个 OpenClaw 渠道插件，peer 依赖 `openclaw`。
Pi Assistant 只复用它与宿主无关的**协议层**（`dist/src/api/*`、`cdn/*`、`media/*`、`messaging/send*.js`），
这些模块在加载时只用到 OpenClaw SDK 的 3 个小函数（账号 ID 规范化、配置写入、临时目录）。本包按 OpenClaw 的
`plugin-sdk/*` 子路径提供这几个函数的最小实现，满足 npm 的 peer 依赖，不安装完整的 OpenClaw。

- 状态目录由服务端强制设为数据目录内（`OPENCLAW_STATE_DIR`），永远不读写用户自己的 `~/.openclaw`。
- 插件版本在 `third-party.json` 固定，每周升级流程跑 `test/wechat-clawbot.test.ts`；官方插件若开始用到新的 SDK 函数，测试会失败并开 issue。
- 其它子路径故意没有实现：调用即报错，避免静默走到 OpenClaw 专有逻辑。
