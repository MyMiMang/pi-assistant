状态：草稿（2026-10-26，方向已由用户选定，见 [决策 0023](../decisions/0023-cli-agents.md)；细节待用户确认后交给 grok bot 实现）

# 在 Pi 助理里用 Claude Code、Codex 等编程命令行工具

## 1. 为什么要做

用户原话：「claude 用不了 oauth 来使用，我就只能使用他的桌面端或者是 cli……有什么办法把这些 claude codex 等不同的 cli 在我们这个 pi 助手里面使用」「我打算就是在我们这个 pi 助手上也支持这些 cli 的使用」。

Anthropic 从 2026 年起不许第三方程序直接用 Claude 订阅（Pro / Max）的登录凭证，所以 Pi 助理没法像接普通模型那样接 Claude 订阅。允许的做法是：在用户自己的电脑上，调用用户已经登录好的官方 `claude` 命令行，登录信息始终留在 Claude Code 里。Codex（用 ChatGPT 账号登录）也是同样的思路。

用户已选定（决策 0023）：
- **两种用法都要，先做「当模型」**：助理的模型列表里能直接选「Claude Code」「Codex」，整段对话都由它来答。之后再做「当帮手」：助理把活派给它，让它用自己的工具在某个文件夹里干活。
- **我们自己接，参考 [Paseo](https://github.com/getpaseo/paseo)**（Apache-2.0）。不要求用户另装别的程序。

## 2. 规矩与风险（实现时必须遵守）

- **绝不碰登录凭证**：不读、不存、不转发 Claude / Codex 的 OAuth token 或钥匙串内容，只启动用户本机已登录的官方程序。没登录时只提示用户去终端里自己登录（`claude auth login` / `codex login`），我们不代为登录。
- **不用 `claude --bare`**：bare 模式只认 API key，从不读订阅登录。
- **计费由官方决定**：Anthropic 宣布过 `claude -p` / Agent SDK 这类调用改走单独额度（6 月 15 日起），据报道已暂停。界面上不承诺「走订阅不花钱」；用量照常显示 token 数，不显示按 API 价格算出来的钱（`claude` 回传的 cost 是 API 标价，对订阅用户有误导）。
- **工具是第三方程序，不是上游 Pi**：不 fork、不改 claude / codex，也不 monkeypatch。版本不自动升级；像 `scripts/pi-update.mjs` 那样记录「已测试的版本」，用户装的版本和测试版本不一致时提示一句，不阻止使用。
- **Gemini CLI**：谷歌在 2026-06-18 之后停止给个人订阅用户提供服务，改成 Antigravity CLI。第一期不做 Gemini。
- 新用到的开源项目（借用了 Paseo 的代码；第三期的 ACP SDK）要写进 `THIRD_PARTY_NOTICES.md`。

## 3. 关键思路：Claude Code 当成 Pi 的一个「模型渠道」

Pi 官方支持自定义模型渠道自带流式实现（`registerProvider` + `streamSimple`，见 Pi 文档 `custom-provider.md`「Implement custom streaming」），这是公开接口，不用改 Pi。我们已经在 `pi-adapter` 里用 `registerProvider` 注册渠道。

所以第一期不另造一套运行时，而是把 `claude` 包装成 Pi 的一个模型渠道 `claude-code`：

```
用户 → AgentRuntime → Pi AgentSession（工具、审批、记忆、群规则都照旧）
                         │ 每次要「模型」回答时
                         ▼
               claude-code 渠道（streamSimple）
                         │ 启动 / 续用本机已登录的 claude
                         ▼
        claude -p（内置工具全部关掉，只能用我们的工具）
                         │ 想调用工具时 → 走 MCP
                         ▼
     我们的工具桥（本机 MCP）→ 把调用交回 Pi，由 Pi 照常执行
```

**Claude Code 只当「大脑」，不用它自己的 Bash、Edit 这些内置工具**（`--tools ""`）。它能用的工具就是这个助理在 Pi 里本来就有的工具：命令行（走助理电脑或按权限档位）、读写文件、记忆、发文件、电脑操作、浏览器、群聊工具、技能等。好处是：
- 审批（ext-approval 的 `tool_call` 钩子）、权限档位、助理电脑隔离、记忆的自动想起和写入（`before_agent_start` / `agent_end`）、工具步骤显示、会话文件、整理上下文、插话、停止……全部照旧，因为工具仍然由 Pi 执行。
- 群聊、单聊、帮手、后台任务、定时任务都不用改：它们只认「模型」，选了 `claude-code` 就行。

## 4. 第一期：Claude Code 当模型

### 4.1 放在哪
- `packages/server/src/pi-adapter/cli-models/claude-code.ts`：Pi 渠道（`streamSimple` 实现、模型列表、会话续接），只有这里和 Pi 打交道。
- `packages/server/src/cli-agents/`：与 Pi 无关的部分。`claude-process.ts` 负责启动 `claude`、读写 stream-json；`tool-bridge.ts` 是工具桥（MCP 服务 + 「挂起中的工具调用」登记）；`detect.ts` 负责检测是否安装、版本、是否登录。纯逻辑（事件转换、参数拼接）单独成文件，便于单测。
- 工具桥的 HTTP 入口放 `routes/`（只监听 127.0.0.1，每次运行一个随机令牌）。
- 新文件登记进 `docs/MODULES.md`，单个文件不超过 600 行。

### 4.2 怎么启动 claude（每轮用户消息一次）
```
claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose
       --tools "" --strict-mcp-config --mcp-config <工具桥配置，带令牌>
       --allowedTools "mcp__pia__*"           # 我们的工具不让 claude 再弹它自己的权限确认（审批由 Pi 负责）
       --setting-sources ""                   # 不加载用户自己的 Claude 设置、钩子、插件（待核实空值是否可用，见 §7）
       --system-prompt <Pi 当前的系统提示>  --system-prompt-snapshot off
       --model <opus|sonnet|haiku…>  --effort <思考强度>
       [--resume <claude 会话 id>]
```
- `--system-prompt-snapshot off` 必须加：默认会在第一次请求时把系统提示「定格」，之后续用会话时传新的也不生效；而我们的群规则、权限档位每轮都可能变。
- 工作目录用助理工作区（`workspaceOf`），反正内置工具已关掉，它不会自己读写。
- 进程环境沿用 `native-launch-env.ts`，不传任何模型密钥环境变量。

### 4.3 工具调用怎么交回 Pi（核心机制）
1. Pi 调 `streamSimple(context)`。渠道从 context 里拿到工具清单（`getCurrentTools`），登记到这次运行的工具桥上，claude 通过 MCP 的 `tools/list` 看到它们，名字是 `mcp__pia__<工具名>`。
2. claude 回答时，正文和思考转成 Pi 的 text / thinking 事件。它发出工具调用（stream-json 里 assistant 消息带 `tool_use`）时，渠道把这些调用作为 Pi 的 toolCall 事件发出（id 沿用），然后以 `stopReason: "toolUse"` 结束这条助理消息。
3. 与此同时，claude 会经 MCP 调 `tools/call`。工具桥按「工具名 + 参数 + 顺序」对上刚才那个 toolCall，**把这个 MCP 请求挂起**，claude 进程保持运行。
4. Pi 照常执行工具（先过审批钩子，界面上显示步骤），然后带着工具结果再调 `streamSimple`。渠道发现这是「同一轮的续接」，就把结果回填给挂起的 MCP 请求，claude 接着往下生成，回到第 2 步。
5. claude 这一轮结束（stream-json 的 `result`）时，渠道以 `stopReason: "stop"` 结束。
- 一次多个工具调用：等 claude 那条 assistant 消息完整后一起发给 Pi，结果按 id 分别回填。
- 停止 / 插话：Pi 的 abort signal 一到，就结束 claude 进程并让挂起的 MCP 请求返回「已取消」。插话照 Pi 现有逻辑，在工具边界送达：下一次 `streamSimple` 带着新的用户消息进来时，作为新的用户输入写进 claude 的 stdin（stream-json 输入）。
- 等审批可能要很久：MCP 工具调用不能被 claude 的超时打断（`MCP_TOOL_TIMEOUT` 设大，待核实，见 §7）。

### 4.4 会话续接
- Pi 每次都给完整历史，claude 自己也有一份。渠道按 Pi 会话记一张对照表：`claude 会话 id + 已同步到 Pi 的哪一条`（存在助理目录下，随会话文件走）。
- 新的一轮只把新增的用户内容（文字、图片、插话）发给 claude，用 `--resume` 续用。
- 发现历史对不上（整理过上下文、从某条消息分支、换过模型、对照表丢了），就开一个新的 claude 会话，把 Pi 当前上下文渲染成文字作为第一条消息送进去。
- Pi 整理上下文时，会在主循环外单独调一次模型（`direct` 请求）生成总结：这种请求不续用会话、不给工具，单次 `claude -p` 跑完即可。

### 4.5 界面和设置
- 「模型服务」里加一张「Claude Code（本机）」卡片（复用现有模型服务页的布局，界面标准照旧）：显示是否已安装、版本、是否已登录（`claude auth status`）。没装或没登录时，用大白话说明去终端里怎么做，并给一个「重新检测」按钮。
- 模型列表（`ModelPicker`）里出现 `Claude Code · Opus / Sonnet / Haiku`；思考强度映射到 `--effort`；没有 Fast。
- 支持看图（图片作为用户内容发给 claude）。
- 用量行只显示 token 数，不显示钱。
- Linux 服务器版：claude 装在服务器上、在服务器上登录，同样能用。

### 4.6 这一期不做
- 不用 Claude Code 自己的内置工具、子代理、斜杠命令、CLAUDE.md、用户的 Claude 插件。
- 不支持 API key 方式（API key 用户直接用现有的 Anthropic 渠道就行）。

## 5. 第二期：Codex 当模型

做法和第一期相同：Pi 渠道 `codex` + 工具桥。驱动方式用 Codex 官方的 `codex app-server`（JSON-RPC，Paseo 也用它），工具桥以 MCP 服务的形式配给 Codex。

开工前先核实：能不能关掉 Codex 自带的 shell / 改文件工具，只留我们的工具（或者 app-server 是否支持由客户端提供工具）。
- 能：和 Claude Code 一样当纯大脑。
- 不能：退而求其次，Codex 用自己的工具，开在只读沙箱里，它的命令和改文件请求按我们的权限档位转成审批卡（`requests.ts`），我们的工具照样通过 MCP 给它。界面上把它的工具调用显示成步骤（参考 Paseo 的 `codex/tool-call-mapper.ts`）。

## 6. 第三期：当帮手（让它用自己的工具干活）

适合写代码、改项目：让 Claude Code / Codex 带着自己的全套工具，在用户指定的文件夹里干一件活，做完把结果交回来。
- 作为一种帮手（subagents 新 kind，比如 `cli`），走现有的帮手、执行、群任务那一套（决策 0014），不另造任务系统。
- 它的工具调用显示成步骤，权限请求转成我们的审批卡，按 `hostFileAccess` 档位决定是否免审批；文件夹默认在助理工作区，访问用户电脑上的文件夹要按权限档位来。
- 这一期再接 ACP（`@agentclientprotocol/sdk`），顺带支持 Copilot、OpenCode、Antigravity 等支持 ACP 的工具。

## 7. 开工前要先实测核实的点

全部在开发实测环境（`npm run dev:live`）里，用用户自己登录的 claude，只用新建的测试助理：

1. `--tools ""` 加 `--mcp-config` 时，claude 是否只能用我们的 MCP 工具；`--setting-sources` 能不能传空值；不能的话，怎样屏蔽用户自己的设置和钩子。
2. 订阅登录下，`--system-prompt` 整个替换系统提示能不能正常工作（有说法称订阅登录要求保留官方系统提示开头）。如果不行，改用 `--append-system-prompt`。
3. MCP 工具调用挂起几分钟（等用户审批）会不会超时；超时上限能不能调。
4. `--resume` 加 `--system-prompt-snapshot off` 时，每轮换系统提示是否生效。
5. stream-json 里思考内容、用量字段、`tool_use` 的完整结构，以及多个工具并行时 MCP 调用的顺序。
6. stream-json 输入模式下，进程运行中能否追加用户消息（用于插话）。
7. `claude auth status` 的输出能否判断「已登录 / 未登录 / 订阅类型」。
8. Codex：见 §5 的开工前核实。

核实结果写回本文档，并据此调整 §4.2、§4.3。

## 8. 测试

- 单测：用一个假的 `claude` 脚本（`test/fixtures/fake-claude`，按脚本输出 stream-json，并通过 MCP 调工具桥）测完整一轮，包括多个工具调用、停止、插话、续接、历史对不上时重开、整理上下文时的单次请求。纯逻辑（事件转换、参数拼接、对照表）单独测。
- e2e：同样用假 `claude`，跑「选 Claude Code 模型 → 单聊调工具（带审批）→ 群聊成员用 Claude Code」。按 AGENTS.md 只用临时数据，**绝不在自动化测试里调真实的 claude**。
- 真实实测只在开发实测环境、用新建的测试助理和测试群。

## 9. 分步交付（给接手的 grok bot）

1. 先做 §7 的实测核实，结果写回本文档，有和方案冲突的先问用户。
2. 工具桥 + claude 进程管理 + 事件转换（含单测和假 claude）。
3. `claude-code` Pi 渠道、会话续接、模型列表、检测与设置卡片（含 e2e）。
4. 开发实测环境里用测试助理实测单聊、群聊、帮手，截图放 `artifacts/`。
5. 更新 MODULES、HANDOFF、ROADMAP、THIRD_PARTY_NOTICES。用户说「打包」才发布。
6. 第二期、第三期各自另开设计小节，先给用户看再做。
