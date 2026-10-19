# 0015 主密钥读不到时停下，绝不另造一把覆盖
- 日期：2026-10-20
- 状态：有效
- 决定：凭据主密钥（加密 API Key、订阅登录、渠道 / 邮箱等凭据用的那把）只在**确实从没有过**时新建。系统钥匙串里「有但读不到」（Mac 上弹窗点了拒绝、登录钥匙串锁着；Windows 上 DPAPI 解不开 master.key）时，服务抛 `MasterKeyUnreadable` 停下，报错写清原因和怎么处理（App 启动失败页会显示）。写钥匙串一律不带 `-U`，永远不覆盖已有条目；钥匙串里没有但数据目录有 master.key 文件时继续用文件那把。
- 原因：2026-10-19 在用户的 Mac 上发现，`secrets.ts` 把「读不到」当成「没有」，生成新密钥后用 `-U` 覆盖旧条目，已存的凭据会全部解不开。当时是测试直接启动 `src/main.ts` 触发的，已拦下，条目没被改。用户决定：读不到就停下提示，不要覆盖。
- 不做什么：不在读不到时自动退回文件密钥（会和钥匙串里的那把分叉）；不自动删除或迁移用户的钥匙串条目。
- 影响：packages/server/src/secrets.ts（`macMasterKey` / `windowsMasterKey`）、test/secrets.test.ts、test/setup.ts（单测 PATH 上放假的 `security`，绝不碰真钥匙串）；直接起服务的 e2e / smoke 统一走 `test/launch-memory.ts`。
