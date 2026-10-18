# 0003 不改 Hindsight 本体，经适配层跟上游
- 日期：2026-10-19
- 状态：有效
- 决定：Hindsight 的问题（超时、思考模式、重排序慢等）一律在 `memory/hindsight/` 里，只用它官方 HTTP 接口和配置项解决；版本固定在 third-party.json，定期升级拉取上游修复和新功能。
- 原因：用户要求「不要动它这个本体，直接拉取它们的更新」。
- 不做什么：不 fork、不打补丁进 Hindsight 源码。
- 影响：`packages/server/src/memory/hindsight/`、`third-party.json`。
