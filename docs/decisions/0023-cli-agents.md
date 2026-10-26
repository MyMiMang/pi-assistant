# 0023 在 Pi 助理里用 Claude Code、Codex 等编程命令行工具
- 日期：2026-10-26
- 状态：有效
- 决定：支持在 Pi 助理里使用用户本机已登录的 Claude Code、Codex 等命令行工具。两种用法都要，先做「当模型」：在模型列表里直接选，Claude Code 只当大脑，工具仍由 Pi 执行。之后再做「当帮手」：让它带着自己的工具在指定文件夹里干活。由我们自己接入，参考 Paseo（Apache-2.0），不要求用户另装 Paseo 之类的程序。
- 原因：Anthropic 不许第三方程序直接使用 Claude 订阅的登录凭证，但调用用户本机已登录的官方 `claude` 是允许的做法；把它包成 Pi 的自定义模型渠道（公开的 `registerProvider` / `streamSimple`），审批、记忆、助理电脑、群聊等现有能力都不受影响。
- 不做什么：不读、不存、不转发任何 OAuth token；不用 `claude --bare`；不改、不 fork 这些工具；不自动升级它们；自动化测试不调用真实的 claude / codex；第一期不做 Gemini CLI（谷歌已改为 Antigravity CLI）。
- 影响：新增 `pi-adapter/cli-models/`、`cli-agents/`、工具桥接口和模型服务页的检测卡片；设计见 docs/design/cli-models.md。实现交给 grok bot（等它把记忆系统做完）。
