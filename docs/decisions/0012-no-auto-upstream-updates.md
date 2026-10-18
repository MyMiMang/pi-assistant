# 0012 Pi / Hindsight 不自动升级
- 日期：2026-10-19
- 状态：有效
- 决定：App 里不做 Pi / Hindsight 的检查更新、提醒或后台升级；删除 `pi-latest.yml`、`hindsight-latest.yml` 工作流，Renovate 不再自动升级它们。版本固定；开发时看到新版，由开发者手动跑 `scripts/pi-update.mjs` / `scripts/hindsight-update.mjs`（`check-pi.mjs` 只提示）升级并跑测试，再随 App 发布。
- 原因：用户决定升级由开发时人工把关。
- 不做什么：不改上游代码；不删 App 自己的自动更新；sidecar 只在固定版本变化时按新版本重装。
- 影响：AGENTS.md 硬规则 3、renovate.json、scripts/pi-update.mjs、scripts/hindsight-update.mjs、DESIGN §5.15、design/memory-health.md。
