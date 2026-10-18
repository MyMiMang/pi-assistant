# 0002 不改 Pi 本体，经适配层接入
- 日期：2026-10-11（2026-10-19 重申）
- 状态：有效
- 决定：不修改 / 不 fork Pi SDK、不改 node_modules、不 monkeypatch 私有 API；服务端只经 `pi-adapter/` 用 Pi，工具经 Pi 公开扩展 API。
- 原因：Pi 持续更新，我们要能直接用上它的修复和新功能（模块化开发）；升级方式见 0012（开发时手动升级）。
- 不做什么：不在业务代码里直接调 Pi 内部 API；不手改依赖版本。
- 影响：`pi-adapter/compat.json`、`scripts/pi-update.mjs`、`scripts/check-pi.mjs`；DESIGN §5.15。
