状态：已实现（通用 ACP 后端 + OpenCode；假命令单测 / e2e + dev:live 真实模型冒烟通过），随 beta.45 打包

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

## 真实模型实测（2026-10-29，OpenCode Go 套餐 `opencode-go/deepseek-v4.1-flash`，用户自己登录；共 12 条请求）
- 只用我们的工具完成任务：✅ 建文件写「你好」再读出来，参数格式正确；真实请求里只有我们的 3 个工具和我们的系统提示（另追加模型名和一小段环境信息），没有标题请求、没有 CLAUDE.md。
- 工具结果等 90 秒（模拟审批慢）：✅ 正常继续。
- 并行调多个工具：✅ 能并行；但 **MCP 请求到达顺序和 ACP 通知顺序不一致**，不能先到先配对，要以「工具桥收到的请求（工具名 + 参数）」为准。
- 停止：✅ 约 0.3 秒停下，桥收到取消；停后再问能带着上文回答。
- 关掉进程后续接：✅ 答对上一轮建的文件名和内容。
- 用量：⚠️ ACP 回包里的用量只是**最后一次模型调用**的，不是整轮合计；要在适配层自己累加。
- 中文正常；思考增量只在部分请求里有（有时是英文），界面要能接受没有思考。
- 首个字约 6–10 秒（单次测量，不作为稳定值）。
- 注意：`opencode/...` 是 Zen 按量扣余额，`opencode-go/...` 才是 Go 套餐；模型列表要把两者分清楚显示。

Grok 本机未登录，没用真实模型测。

## 建议分步
1. 先在 `dev:live` 用新建测试助理、OpenCode 免费模型补一次真实模型实测（工具调用、审批超过 1 分钟、停止、续接）。
2. 写通用 ACP 后端 + OpenCode profile；模型服务页加 OpenCode 卡片（复用 `CliAgentCard`）。
3. 之后每加一家（Copilot、Qwen Code、Goose、Kiro……）先按上表 8 项实测，能做到「只留我们的工具」才接；Grok 等它能直接暴露 MCP 工具再说。
4. 第三期「当帮手」（让命令行用自己的工具干活）也走同一个 ACP 后端，另设计。

## 风险
- 关工具、换提示、超时这些都是各家私有配置，上游升级可能变；每次手动升级命令行后要冒烟复测。
- OpenCode 配置是进程级的，换系统提示要重启进程再续接。
- 用户全局 `~/.config/opencode/AGENTS.md` 可能被读到，实现时要验证并关掉。

## 实现要点
- 分层：`cli-agents/jsonrpc-stdio.ts`（原 `codex-client.ts` 改名，`RpcClient`，codex 与 ACP 共用）→ `acp-events.ts`（纯函数）→ `acp-process.ts`（每个 Pi 会话一个长驻进程）→ `pi-adapter/cli-models/acp.ts`（通用 `CliBackend`，参数是 `AcpChannelConfig`）→ `opencode.ts`（OpenCode 那份配置 + 模型注册）。`process-pool.ts` 抽出 agy 与 ACP 共用的进程池 / 回填 / 收尾。
- **渠道 id 叫 `opencode-cli`，不叫 `opencode`**：Pi 自带一个同名的渠道（OpenCode Zen 的 API 密钥渠道），重名会把它顶掉，模型服务页的过滤也会把它一起藏起来。环境变量仍是 `PIA_OPENCODE_COMMAND`，接口 `/api/models/opencode-cli`，Pi 模型 id 是 OpenCode 的 `<provider>/<model>`（如 `opencode-go/deepseek-v4.1-flash`）。
- **工具收齐**：只认工具桥收到的 MCP `tools/call`，配对键 = MCP 请求 id（`callKey` 返回 undefined，桥用 `rpc-<id>`）。收到第一个后，等「桥收到的数量 ≥ ACP `tool_call` 通知里我们的工具数」且安静 50 毫秒（实测 ACP 报告第二个工具比第一个的 MCP 请求还晚几十毫秒，只比数量会过早收齐），最多等 300 毫秒（`ACP_PARALLEL_WAIT_MS`，没有依据，要调就调这里）。
- **用量**：`usage_update` 一轮只来一次且只是最后一次调用的上下文大小，`session/prompt` 回包的 `usage` 也只是最后一次调用，ACP 没有按次的用量通知，**做不到按次累加，退回最后一次**：被工具打断的中间段没有用量，最后一段有（正好是当前上下文大小）。cost 一律 0。思考 token 算进输出。
- **配置隔离**：OpenCode 没有单独关全局 `AGENTS.md` 的开关（查过 1.18.35 的环境变量；全局指令文件是 `<配置目录>/AGENTS.md`），所以 `XDG_CONFIG_HOME` 指到 `<dataDir>/cli-models/opencode-config`；登录凭据在 `XDG_DATA_HOME`，不动。另加 `OPENCODE_DISABLE_CLAUDE_CODE` / `_PROJECT_CONFIG` / `_EXTERNAL_SKILLS` / `_AUTOUPDATE`。副作用：用户写在全局配置里的自定义 provider 用不了（`opencode auth login` 登录的可以）。工作目录固定为 `<dataDir>/cli-models/opencode-work`（会话续接要在同一目录），每个进程的配置文件在随机运行目录里（0700 / 0600，结束必删，系统提示不进环境变量和命令行）。
- **模型 / 思考强度是会话级的**（`session/set_config_option`），换了不重开进程，所以续用指纹不含模型；系统提示 / 工具集变了弃用旧进程。空闲退出或进程没了，下一轮 `session/resume`；找不到会话就改新开。
- **停止**：`session/cancel`，回包后（或 1.5 秒后）关进程；下一轮用对照表之外的新会话（和 agy 一致，停止后对照表作废，上下文由 Pi 渲染成文字带过去）。
- **登录检测**：只看 `auth.json`（`$XDG_DATA_HOME/opencode/auth.json`）在不在，不读内容；自带免费模型，所以 `requireLogin: false`——装了且 `opencode models --verbose` 能列出支持工具调用的模型就注册，卡片上没登录显示「未登录（可用免费模型）」。
- 假命令 `test/fixtures/fake-opencode.mjs` 的 MCP 请求用 `http.request({agent:false})`：Node 自带的 `fetch` 在已有请求挂着时，第二条连接会被拖慢约 250 毫秒，会把「并行调用晚到」的用例搅乱。

## dev:live 真实冒烟（2026-10-29，测试助理「OpenCode实测」，`opencode-go/deepseek-v4.1-flash`）
- 建文件 → 读出来 → 列目录：3 个工具一次通过，回答正确（所以 `mcpServers` 请求头带令牌在真实 OpenCode 下可用）。
- 第二轮「刚才建的文件叫什么」：不调工具答对（续用正常）。
- 运行 `sleep 15` 时插话：显示「等当前这一步做完送达」，命令跑完后送达，回答里带上了插话内容。
- 运行 `sleep 40` 时点停止：立刻停；界面原来显示红色 `This operation was aborted`——这是 Pi 1.3.0 在停止时把中止记成 error 的毛病，各渠道（中转、Codex）都有，已在适配层（`run-result.ts` 的 `isAbortedMessage`，整句精确匹配，超时不算）按「已中断」处理。
- 中间段没有用量时不再显示「0 → 0 token」（`ChatMessages.tsx` 的 `UsageLine`）。

## 还没验证
- 真实并行多个工具时 50 / 300 毫秒收齐窗口（假命令和实测脚本里通过，dev:live 这几轮模型没有并行调用）。
- 隔离 `XDG_CONFIG_HOME` 后用户自定义 provider 不可用（按设计如此，没用真用户配置试）；Windows / Linux 没测。
