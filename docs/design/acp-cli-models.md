状态：草稿（实测完，待用户决定）

# 用通用 ACP 接入更多本机命令行当模型（OpenCode 等）

接 [cli-models.md](cli-models.md)。用户想像 [orca](https://github.com/stablyai/orca) 那样支持更多命令行（OpenCode、Grok、Copilot、Qwen Code……）。

## 和 orca 的区别
orca 把每个命令行原样放进终端里跑，自己只管工作区和显示，所以「能在终端跑的都能接」。我们是把命令行当助理的「大脑」：自带工具全关、只给 Pi 的工具（走审批、记忆、助理电脑），所以每家都要能做到「只看得到我们的工具、能换系统提示、工具调用能挂起等审批」。不能照搬 orca。

## 做法
不再一家手写一个 `CliBackend`，改成**一个通用 ACP 后端 + 每家一份适配配置（profile）**。ACP（Agent Client Protocol）已有 50 多家命令行支持。

通用部分（写一次）：
- 每个会话起一个进程，stdio 上跑 JSON-RPC：`initialize` → `session/new` 或 `session/resume`（带 http 类型 `mcpServers` 挂现有工具桥）→ `set_config_option`（模型、思考强度）→ `session/prompt`。
- 文字、思考按增量通知（`agent_message_chunk` / `agent_thought_chunk`）转成步骤；**工具调用以「工具桥收到 MCP 请求」为准**（ACP 通知里没有能和 MCP 请求配对的 id，两家都是），桥的配对键改成请求 id。
- 停止用 `session/cancel`（实测约 0.3 秒）；续接用 `session/resume`（跨进程、不回放历史）；用量从回包里取。
- 命令行自己的权限请求（`session/request_permission`）一律回「允许一次」：审批已经在 Pi 这边做过。
- 插话：ACP 不支持运行中插话，第二条会排队。做法和 Antigravity 一样：等它用完当前工具后再交给它（工具结果里带上）。

每家 profile 写：启动命令、只留我们工具的办法、换系统提示的办法、MCP 超时、去掉隐藏额外请求、关掉对 `~/.claude/CLAUDE.md` 等全局指令的读取、登录检测、模型列表来源。

## 实测结果（2026-10-29，假模型服务 + 假 MCP 服务，没花钱；OpenCode 1.18.35、Grok 1.0.34）
| | OpenCode | Grok |
|---|---|---|
| 只留我们的工具 | ✅ `permission` 全 deny、只 allow 我们的 | ⚠️ 只能缩到 `search_tool` / `use_tool` 两个，Pi 工具要先搜再用，关不掉 |
| 换系统提示 | ✅ 整个替换，只追加约 250 字环境信息（进程级配置） | ✅ 会话级替换；但另塞约 1000 字 user 消息关不掉；中途切模型会丢 |
| 工具调用挂起等审批 | ✅ 需配 `mcp_timeout`（默认 60 秒超时），配后 75 秒通过 | ✅ 130 秒通过，不用配 |
| 不读用户的 CLAUDE.md | ✅ 环境变量可关 | ✅ 环境变量可关 |
| 隐藏额外模型请求 | ✅ 标题请求可关，没有别的 | ⚠️ 摘要类可关，标题请求只能改道 |
| 模型列表 / 思考强度 | ✅ 不发提示词就能拿到，可按会话切 | ✅ 能拿到；模型要启动时选定 |
| 停止 / 续接 / 流式 | ✅ | ✅ |
| 登录 | 自带免费模型（OpenCode Zen），装了就能用 | 本机未登录；未登录时建会话直接报错，可免费检测 |
| 结论 | **能当大脑** | 能跑，但体验差，暂缓 |

本机没有 OpenCode / Grok 的登录凭据，没用真实模型测。

## 建议分步
1. 先在 `dev:live` 用新建测试助理、OpenCode 免费模型补一次真实模型实测（工具调用、审批超过 1 分钟、停止、续接）。
2. 写通用 ACP 后端 + OpenCode profile；模型服务页加 OpenCode 卡片（复用 `CliAgentCard`）。
3. 之后每加一家（Copilot、Qwen Code、Goose、Kiro……）先按上表 8 项实测，能做到「只留我们的工具」才接；Grok 等它能直接暴露 MCP 工具再说。
4. 第三期「当帮手」（让命令行用自己的工具干活）也走同一个 ACP 后端，另设计。

## 风险
- 关工具、换提示、超时这些都是各家私有配置，上游升级可能变；每次手动升级命令行后要冒烟复测。
- OpenCode 配置是进程级的，换系统提示要重启进程再续接。
- 用户全局 `~/.config/opencode/AGENTS.md` 可能被读到，实现时要验证并关掉。
