状态：已批准，实现中（2026-10-26，[决策 0023](../decisions/0023-cli-agents.md)；§7 已实测，§4 按结果修订；由 Claude 派 Sonnet 子代理实现并审查）

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

### 4.2 怎么启动 claude（每轮用户消息一次；按 §7 实测结果修订）
```
claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose
       --tools "" --strict-mcp-config --mcp-config <私有临时文件的绝对路径>   # 含令牌：目录 0700、文件 0600，运行后删除；不放命令行（ps 看得到）
       --allowedTools "mcp__pia__*"           # 我们的工具不让 claude 再弹它自己的权限确认（审批由 Pi 负责）
       --system-prompt-file <私有临时文件>  --system-prompt-snapshot off   # 系统提示同样走文件（Windows 命令行有长度上限）；兜底时换 --append-system-prompt-file
       --model <opus|sonnet|haiku…>  --effort <思考强度>
       [--resume <claude 会话 id>]
```
- **加载用户自己的 Claude 设置**（用户 2026-10-26 拍板）：不传 `--setting-sources ""`。有的用户把登录或代理写在 `~/.claude/settings.json` 的 `env` 里（实测本机就是），不加载就变成未登录。代价是用户给 Claude Code 装的钩子、插件也会生效，在设置卡片的「?」里说明。
- **挡掉用户的 CLAUDE.md**：环境变量 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`（`--system-prompt` 整个替换也挡不住它，实测 1）。
- **进程环境用白名单**：只带 `HOME`、`PATH`、`USER`、`LANG`、`TMPDIR` 等必要变量，再加下面几个；继承来的 `ANTHROPIC_*` 必须去掉，否则会报 `401 Invalid bearer token`（实测 1）。检测登录（`claude auth status`）也用同一套环境。
- **工具超时调大**：`MCP_TOOL_TIMEOUT=3600000` 加 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`。默认 60 秒就会掐断工具调用，等审批时一定会超时（实测 3）。
- `--system-prompt-snapshot off` 必须加：默认会在第一次请求时把系统提示「定格」，之后续用会话时传新的也不生效（实测 4）；而我们的群规则、权限档位每轮都可能变。
- `--mcp-config` 必须是绝对路径。每次运行建一个私有临时目录（0700），里面放 MCP 配置（含令牌）和系统提示两个 0600 文件，运行结束（含 abort、进程没起来）一定删掉。
- **系统提示兜底**：订阅登录下能否整个替换系统提示还没验证（实测 2）。实现上每个新会话第一轮检查一次：如果回答明显没按系统提示来（比如问它「你是谁」，答的是 Claude Code 而不是助理名字），这个助理以后改用 `--append-system-prompt-file`，并记日志。
- 工作目录用助理工作区（`workspaceOf`），反正内置工具已关掉，它不会自己读写。

### 4.3 工具调用怎么交回 Pi（核心机制；按 §7 实测结果修订）
1. Pi 调 `streamSimple(context)`。渠道从 context 里拿到工具清单（`getCurrentTools`），登记到这次运行的工具桥上，claude 通过 MCP 的 `tools/list` 看到它们，名字是 `mcp__pia__<工具名>`。
2. claude 回答时，正文和思考转成 Pi 的 text / thinking 事件（来源是 `stream_event` 的 `text_delta` / `thinking_delta`）。工具调用以 `content_block_start(tool_use)` + `input_json_delta` 流式到来，id 沿用 claude 的 `toolu_…`。
3. **按 id 精确配对**：claude 每发起一个 MCP `tools/call`，`params._meta["claudecode/toolUseId"]` 就是对应 `tool_use` 块的 id（实测 5）。工具桥把这个请求**挂起**，claude 进程保持运行。`tools/call` 和 `tool_use` 事件几乎同时到，先后不固定，所以桥要两边都能先登记、后配对。
4. **这条助理消息何时结束**：以 `stream_event` 的 `message_delta{stop_reason:"tool_use"}` 为准（工具挂起时它也会立刻到）。这时把这条消息里所有 toolCall 交给 Pi，以 `stopReason: "toolUse"` 结束。多个工具在 claude 那边是同时在途的，Pi 按自己的规则执行，没轮到的 MCP 请求就一直挂着（靠 §4.2 的超时设置）。
5. Pi 照常执行工具（先过审批钩子，界面上显示步骤），然后带着工具结果再调 `streamSimple`。渠道发现这是「同一轮的续接」，就按 id 把结果回填给挂起的 MCP 请求，claude 接着往下生成，回到第 2 步。
6. claude 这一轮结束（stream-json 的 `result`）时，渠道以 `stopReason: "stop"` 结束；`result.is_error` 为真时按 Pi 的错误事件结束，原文放进错误信息（比如 `Not logged in`）。
- **取消**：claude 自己超时或中止时，会给工具桥发 `notifications/cancelled`。桥收到后把对应的挂起请求标记为已取消，之后 Pi 的结果不再回填。Pi 的 abort signal 一到，就结束 claude 进程，并让所有挂起的 MCP 请求返回「已取消」。
- **插话**：直接往 claude 的 stdin 写一条 stream-json 用户消息。实测 6：工具挂起时写入不会报错，会在当前工具返回后并入同一轮。写入时如果这一轮已经 `result` 结束，claude 会把它当成新的一轮。
- **心跳**：工具挂起期间 claude 每 30 秒吐一条 `tool_progress`（heartbeat），可以当成「进程还活着」的信号，对应 Pi 的 `tool_update`。
- **用量**：输入取 `message_start.usage`，输出取 `message_delta.usage.output_tokens`，整轮合计取 `result.usage`。不要读 `assistant.message.usage.output_tokens`（永远是 0），也不信 `thinking_tokens`。界面只显示 token 数，不显示 `total_cost_usd`。

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

   **结果（2026-10-26，claude 2.1.293）：已验证（工具部分）；设置隔离部分只验证了一半。**
   - **实测环境警告（全部实测共用）**：这台机器上 `claude` 在「只读钥匙串/不读用户设置」时是**未登录**状态（`--setting-sources ""` 下报 `Not logged in · Please run /login`）。能用是因为 `~/.claude/settings.json` 里有 `env` 块（`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 指向本机 cc-switch 代理 127.0.0.1:15721，并把模型名映射走）。所以下面除特别注明外，都是**经用户设置里这条代理通道**跑的，**不是订阅 OAuth 通道**。只有 `--model sonnet|opus` 能正常出结果；`--model haiku` 被代理映射到 claude-sonnet-5-5 后报 `400 claude-sonnet-5-5 requires adaptive thinking ...`。
   - **进程环境必须干净**：从宿主 Claude 桌面端继承的 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 会让 claude 报 `Failed to authenticate. API Error: 401 Invalid bearer token`。实测用 `env -i HOME PATH USER LANG` 起进程才对（与 §4.2「沿用 `native-launch-env.ts`、不传密钥环境变量」一致，要确认它也会去掉这些 `ANTHROPIC_*`）。
   - `--tools "" --strict-mcp-config --mcp-config <绝对路径>`：init 事件里 `tools` 只有 `["mcp__pia__echo_text","mcp__pia__slow_wait"]`；让它用 Bash 跑 `ls /`，模型回答「没有 Bash 工具」，没有任何内置工具调用。`--mcp-config` 的路径**按进程工作目录解析**，必须传绝对路径，否则 `MCP config file not found`。
   - 模型自述里还多出一个 `web_search`（init 的 `tools` 列表里没有，应是 claude 自带的服务端工具）。是否能用 `--disallowedTools WebSearch` 关掉，见实测 5 末尾补充。
   - `--setting-sources ""`：**参数被接受**（进程正常起来、MCP 连上），且确实屏蔽了用户设置——证据是它把 settings.json 里的代理 env 也屏蔽了，于是变成 Not logged in。但因为这台机器的登录依赖用户设置，**没法用它跑通完整对话，也就没法单独验证它是否同时挡住用户的钩子 / 插件**（这台机器上用户设置只有 `env`，没有钩子、没有插件）。
   - **用户级 `~/.claude/CLAUDE.md` 会被加载，且 `--system-prompt` 整个替换也挡不住**：问「上下文里有没有 CLAUDE.md / 用户记忆」，默认回答 YES 并转述了「一律用中文」；加环境变量 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` 后回答 NO。结论：隔离 CLAUDE.md 要额外加这个环境变量（`--setting-sources ""` 是否也能挡住没法在这台机器上验证）。
2. 订阅登录下，`--system-prompt` 整个替换系统提示能不能正常工作（有说法称订阅登录要求保留官方系统提示开头）。如果不行，改用 `--append-system-prompt`。

   **结果：订阅登录下没法验证；经用户代理通道已验证替换可用。**
   - 这台机器没有可用的订阅 OAuth 登录（见 §7.1 的实测环境警告），所以「订阅登录是否强制保留官方开头」**没法验证**，需要换一台真正用订阅登录的机器（或用户在终端 `claude auth login` 后）补测。
   - 代理通道下：`--system-prompt "Always reply with exactly the single word PINEAPPLE..."` 回答 `PINEAPPLE`，`--append-system-prompt` 同样生效；两者区别在缓存读取量：替换后约 1.1k tokens，追加约 8k tokens（官方默认系统提示被整个换掉了）。
   - **不稳定现象（要小心）**：同样的 `--system-prompt PINEAPPLE ... ` + `hello`，5 次里有 1 次回了 `Hey! How can I help you today?`（等于没生效），另一条「小测」提示的两次也没带【小测】。这几次的 assistant 消息 id 格式（`msg_011Cg…`、`toolu_01…`）和其他次（`msg_01…`、`toolu_bdrk_…`）不同，且这条通道上模型自述多出一个 `web_search` 工具（init 的 `tools` 里没有，加 `--disallowedTools WebSearch` 也去不掉）——判断是用户 cc-switch 代理在不同上游之间切换，其中一个上游不守系统提示、自己注入工具。这是**代理的问题，不是 claude 参数的问题**，但也说明这台机器上的结果不能当订阅通道的结论，必须换真订阅账号补测。
3. MCP 工具调用挂起几分钟（等用户审批）会不会超时；超时上限能不能调。

   **结果：已验证。默认 60 秒就超时（不成立）；`MCP_TOOL_TIMEOUT` 调大后 190 秒的挂起正常返回。**
   - 默认（不设任何环境变量）：`slow_wait` 60 秒和 180 秒两次都在约 60 秒时被 claude 掐掉，tool_result 为 `is_error:true`，原文 `The operation timed out.`，模型据此继续回答。MCP 服务端那边请求实际还在跑到结束（`slow_wait(60)` 在 60.0 秒时才返回，已晚了一步）。
   - `MCP_TOOL_TIMEOUT=30000` 时在 30 秒掐断，原文：`MCP server "pia" tool "slow_wait" sent no response or progress for 30s; aborting. If this server is configured in your MCP settings, set a per-server "timeout" (ms) to allow longer silent runs for just this server; otherwise set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms) globally (0 disables).` MCP 服务端随后收到 `notifications/cancelled`。说明：该变量能调，并且 claude 还有一层「空闲超时」`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`（毫秒，0 为关闭）。
   - 调大：`MCP_TOOL_TIMEOUT=600000` 单独设置时 `slow_wait(90)` 正常返回 `waited 90s`；再加 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` 时 `slow_wait(190)` 在 190 秒正常返回，模型拿到结果继续回答。**没有单独验证「只设 MCP_TOOL_TIMEOUT 能不能撑过 180 秒」**，保险起见两个都设。
   - 挂起期间 claude 每 30 秒在 stdout 吐一条 `{"type":"tool_progress","tool_use_id":"<id>-heartbeat-N","tool_name":"mcp__pia__slow_wait","parent_tool_use_id":"<id>","elapsed_time_seconds":30,"heartbeat":true}`，可当作「进程还活着」的心跳。
   - 超时发生时 claude 会向我们的 MCP 服务发 `notifications/cancelled`，工具桥要能处理（挂起的请求被取消、不要再回填）。
4. `--resume` 加 `--system-prompt-snapshot off` 时，每轮换系统提示是否生效。

   **结果：已验证（经代理通道）。**
   - 先用 `--system-prompt "...只回 PINEAPPLE"` 建会话（默认 snapshot on），再 `--resume <同一 id>`：不加 off、换成 `...只回 MANGO` → 回答仍是 `PINEAPPLE`（沿用旧提示）；加 `--system-prompt-snapshot off`、换成 `...只回 KIWI` → 回答 `KIWI`（新提示生效）。
   - `-p` 下 `--resume` 必须给真实的会话 id 或标题，否则报 `Error: --resume requires a valid session ID or session title when used with --print`；续用后 `session_id` **保持不变**（没有新开会话）。会话 id 取自 stream-json 的 `init` / `result` 事件里的 `session_id`。
5. stream-json 里思考内容、用量字段、`tool_use` 的完整结构，以及多个工具并行时 MCP 调用的顺序。

   **结果：已验证。** 事件类型和代表样例（`session_id`/`uuid`/签名截短，下面时间是相对进程启动的秒数）：
   - `system/init`：`{"type":"system","subtype":"init","cwd":…,"session_id":…,"tools":["mcp__pia__echo_text","mcp__pia__slow_wait"],"mcp_servers":[{"name":"pia","status":"connected","source":"dynamic"}],"model":"claude-sonnet-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.293",…}`（另有 slash_commands、skills、agents、plugins 等很长的列表，我们不用）。
   - `system/status`：`{"type":"system","subtype":"status","status":"requesting",…}`，每次向模型发请求前一条。
   - `stream_event`（要 `--include-partial-messages`）：
     - `message_start`：`event.message.usage = {"input_tokens":992,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{…}}`，外层还有 `"ttft_ms":6041`。**输入侧用量在这里**。
     - `content_block_start`：`{"index":0,"content_block":{"type":"tool_use","id":"toolu_bdrk_01Rj…","name":"mcp__pia__echo_text","input":{}}}`；文字块 `{"type":"text","text":""}`；思考块 `{"type":"thinking","thinking":"","signature":""}`。
     - `content_block_delta`：`text_delta{text}` / `thinking_delta{thinking}` / `signature_delta{signature}` / `input_json_delta{partial_json:"{\"text\":\"a\"}"}`。
     - `content_block_stop{index}`、`message_delta{delta:{stop_reason:"tool_use"|"end_turn"},usage:{output_tokens:16}}`（**输出 token 数在这里**）、`message_stop`。
   - `assistant`：**每个内容块一条**，同一个 API 消息的多个块共用同一个 `message.id`。例：`{"type":"assistant","message":{"id":"msg_01oLop…","role":"assistant","content":[{"type":"tool_use","id":"toolu_bdrk_01Rj…","name":"mcp__pia__echo_text","input":{"text":"a"}}],"model":"claude-sonnet-5-5","stop_reason":null,"usage":{"input_tokens":992,"output_tokens":0,…}},"parent_tool_use_id":null,"session_id":…,"tool_use_meta":[{"id":…,"display_name":"Echo Text","server_display_name":"pia-spike"}],"wire_tool_inputs":{"<id>":{"text":"a"}}}`。**这里 `usage.output_tokens` 永远是 0（占位），别用**；`stop_reason` 也是 null。思考块作为独立的 `assistant` 消息出现：`content:[{"type":"thinking","thinking":"<完整思考文字>","signature":"…"}]`（需 `--effort` 等让模型思考；本次代理通道下思考文字是明文）。
   - `system/thinking_tokens`：`{"subtype":"thinking_tokens","estimated_tokens":27,"estimated_tokens_delta":1}`，思考中不断吐，只是估算。
   - `user`（工具结果，claude 自己回填后吐出）：`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_bdrk_01Rj…","type":"tool_result","content":[{"type":"text","text":"ECHO:a"}]}]},"tool_use_result":[…],"tool_result_meta":[{"id":…,"permission_decision":{"decision":"accept","source":"config","reason_type":"rule"}}]}`；超时则 `is_error:true`。
   - `tool_progress`：见实测 3 的心跳。
   - `result`：`{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","result":"<最终文字>","session_id":…,"num_turns":…,"duration_ms":…,"total_cost_usd":0.007,"usage":{"input_tokens":1031,"cache_creation_input_tokens":397,"cache_read_input_tokens":3745,"output_tokens":325,"output_tokens_details":{"thinking_tokens":0},…},"modelUsage":{"claude-sonnet-5":{"inputTokens":…,"outputTokens":…,"cacheReadInputTokens":…,"cacheCreationInputTokens":…,"contextWindow":1000000,"maxOutputTokens":64000,…}},"queued_turn_count":0}`。`usage` 是**整轮累计**（含多次 API 调用），其中 `output_tokens_details.thinking_tokens` 本次为 0（思考文字实际有，字段不可信）。出错时 `is_error:true`、`api_error_status`、`terminal_reason:"api_error"`、`result` 为错误原文（例：`Failed to authenticate. API Error: 401 Invalid bearer token`、`Not logged in · Please run /login`）。
   - **工具调用与 MCP 的顺序**：同一次回答里并行调两个工具（`echo_text a`、`echo_text b`）时，`tool_use` 块依次在 8.24s、8.26s 到达，MCP 的两个 `tools/call` 在服务端相隔约 1 毫秒先后到（先 a 后 b，与 `tool_use` 顺序一致），**不是等整条消息结束才发起，也不是一个做完才发下一个**——claude 每个块一完整就立刻发起调用，两个同时在途。`tools/call` 到达的时刻和 `assistant`（tool_use）事件几乎同时，不保证谁先。
   - **挂起期间 `message_delta{stop_reason:"tool_use"}` 和 `message_stop` 会立即到**（slow_wait 90 秒挂着时，它们在工具开始后 0.01 秒就到了），之后 claude 进程就安静地等工具返回，只有每 30 秒的心跳。`result` 要等工具返回、模型继续答完才来。
   - **每个 MCP `tools/call` 的 `params._meta` 带 `"claudecode/toolUseId":"<和 tool_use 块完全相同的 id>"`**，另有 `progressToken`。这样工具桥可以**按 id 精确配对，不用靠「名字 + 参数 + 顺序」**。
6. stream-json 输入模式下，进程运行中能否追加用户消息（用于插话）。

   **结果：已验证。排队，不报错，也不立即打断：在当前工具返回之后、下一次请求模型之前插进同一轮。**
   - 做法：`slow_wait(190)` 挂起 40 秒时，往 stdin 再写一条 `{"type":"user","message":{"role":"user","content":"New message: when you finish, also end your reply with the word BANANA."}}`。claude 没有任何输出、没有报错，继续等工具；190 秒工具返回后，下一次请求把这条消息一起带给模型（模型的思考里看到它是「放在用户回合里的 system-reminder」），最终回答 `DONE: "waited 190s"\n\nBANANA`。
   - **整个过程只有一个 `result`**（`queued_turn_count` 为 0），追加的消息并入了同一轮，不会另起一轮；输出里也不回显这条用户消息。
   - 对应方案 §4.3：和 Pi 的 steer「在工具边界送达」语义一致，所以「Pi 下一次 `streamSimple` 带着新消息进来时再写进 stdin」和「Pi 一收到插话就立刻写」效果相同。要注意：如果写入时 claude 这一轮已经 `result` 结束了，它会当作新的一轮处理。
7. `claude auth status` 的输出能否判断「已登录 / 未登录 / 订阅类型」。

   **结果：已登录/未登录能判断；订阅类型没法验证。**
   - 默认输出就是 JSON（`--json` 是默认，`--text` 是人类可读）。字段名：`loggedIn`（布尔）、`authMethod`、`apiProvider`、`analyticsDisabled`、`projectsDirectory`、`configDirectory`。
   - 已登录：退出码 0、`loggedIn:true`。未登录（用空的 `CLAUDE_CONFIG_DIR` 模拟）：退出码 **1**、`loggedIn:false`、`authMethod:"none"`；`--text` 为 `Not logged in. Run claude auth login to authenticate.`。
   - **这台机器上看不到订阅类型**：没有 `subscriptionType`、邮箱等字段（用户设置里是代理 token，`authMethod` 显示 `oauth_token`，`--text` 显示 `Auth token: ANTHROPIC_AUTH_TOKEN` 和 `Anthropic base URL: http://127.0.0.1:15721`）。真 OAuth 订阅登录是否会多出字段没法验证。
   - **注意：结果受环境影响**：从宿主 Claude 桌面端继承的 `ANTHROPIC_*` 环境变量下同一个命令返回 `loggedIn:false`；用 `env -i` 的干净环境才返回 `true`。检测时要用和真正启动一致的干净环境。
   - **`auth status` 说「已登录」不等于能用订阅**：用户设置里写了代理 token 的机器也显示已登录（`authMethod:"oauth_token"`，`--text` 里能看到 `ANTHROPIC_BASE_URL` 不是官方地址）。可以靠 `--text` 里的 base URL 是不是 `https://api.anthropic.com` 来提示。
8. Codex：见 §5 的开工前核实。

核实结果写回本文档，并据此调整 §4.2、§4.3。

## 8. 测试

- 单测：用一个假的 `claude` 脚本（`test/fixtures/fake-claude`，按脚本输出 stream-json，并通过 MCP 调工具桥）测完整一轮，包括多个工具调用、停止、插话、续接、历史对不上时重开、整理上下文时的单次请求。纯逻辑（事件转换、参数拼接、对照表）单独测。
- e2e：同样用假 `claude`，跑「选 Claude Code 模型 → 单聊调工具（带审批）→ 群聊成员用 Claude Code」。按 AGENTS.md 只用临时数据，**绝不在自动化测试里调真实的 claude**。
- 真实实测只在开发实测环境、用新建的测试助理和测试群。

## 9. 分步交付

1. 先做 §7 的实测核实，结果写回本文档，有和方案冲突的先问用户。
2. 工具桥 + claude 进程管理 + 事件转换（含单测和假 claude）。
3. `claude-code` Pi 渠道、会话续接、模型列表、检测与设置卡片（含 e2e）。
   - 3a 服务端渠道已实现（3e32e0e）：`pi-adapter/cli-models/`（`registerClaudeCodeProvider`、streamSimple、工具交回 Pi、`--resume` 对照表）。
   - 3b 已实现（未提交）：`claude-code-service.ts`（启动时找得到 claude 才注册；Mock / 单测默认不注册，`PIA_CLAUDE_COMMAND` 指定路径才启用、空串明确关闭；关闭服务时 `disposeAll`）、`GET /api/models/claude-code` 与 `POST /api/models/claude-code/recheck`（装好后就地注册，不用重启）、模型服务页 `ClaudeCodeCard`、用量行 cost 为 0 不显示钱；单测 `claude-code-service-http.test.ts`，e2e `e2e/claude-code-ui.mjs`（假 claude：没装 → 未登录 → 已登录、单聊选 Sonnet、bash 审批卡、390 宽）。
4. 开发实测环境里用测试助理实测单聊、群聊、帮手，截图放 `artifacts/`。
5. 更新 MODULES、HANDOFF、ROADMAP、THIRD_PARTY_NOTICES。用户说「打包」才发布。
6. 第二期、第三期各自另开设计小节，先给用户看再做。

### 需要改方案的地方（实测发现，未改 §4，请用户/审查决定）

1. **环境必须干净**（§4.2「进程环境」）：不只是「不传模型密钥」，还要把继承来的 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 等 `ANTHROPIC_*` 全部去掉，否则 `401 Invalid bearer token`。建议用白名单（`HOME`、`PATH`、`USER`、`LANG` 等）而不是黑名单；同时加 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`（用户的 `~/.claude/CLAUDE.md` 会被加载，`--system-prompt` 整个替换也挡不住，实测 1）。
2. **`--setting-sources ""` 的取舍**（§4.2）：参数可用，也确实屏蔽用户设置；但有的用户把登录/代理写在 `~/.claude/settings.json` 的 `env` 里（本机就是，cc-switch 代理），带上它会变成 `Not logged in`。纯 OAuth 订阅用户不受影响（未验证）。需要用户定：是否要兼容「登录写在 settings.json 里」的用户（兼容就不能加这个参数，改用环境变量屏蔽 CLAUDE.md，并接受用户的钩子/插件会生效）；`auth status` 判不出这种情况，只能看 `--text` 里的 base URL。
3. **MCP 超时**（§4.3 最后一条）：确认「必须设」——默认 60 秒就掐；启动 claude 时同时设 `MCP_TOOL_TIMEOUT`（毫秒，足够大，如 `3600000`）和 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`。工具桥要处理 claude 超时/中止时发来的 `notifications/cancelled`。
4. **工具调用配对**（§4.3 第 3 步）：不用「工具名 + 参数 + 顺序」，改成按 `tools/call` 的 `params._meta["claudecode/toolUseId"]` 与 `tool_use` 块的 `id` 精确配对；`tools/call` 和 `assistant(tool_use)` 事件几乎同时到，谁先谁后不固定，桥要两边都能先登记、后配对。
5. **「一次多个工具调用：等 claude 那条 assistant 消息完整后一起发给 Pi」**（§4.3）：claude 的 `assistant` 事件是**一个内容块一条**，同一 `message.id` 共用；更可靠的「这条消息结束」信号是 `stream_event` 的 `message_delta{stop_reason:"tool_use"}`/`message_stop`（挂起时也立即到）。多个工具在 claude 那边是**同时在途**的，Pi 若串行执行，后面的 MCP 请求要一直挂着（受第 3 点的超时影响）。
6. **用量**：别读 `assistant.message.usage.output_tokens`（永远 0）；输入用量取 `message_start`，输出取 `message_delta.usage.output_tokens`，整轮累计取 `result.usage`。`result.usage.output_tokens_details.thinking_tokens` 不可信。
7. **订阅通道没验证**：本机没有可用的订阅 OAuth 登录，实测 2（订阅下 `--system-prompt` 能否整个替换）、以及实测 1 里 `--setting-sources ""` 是否同时屏蔽钩子/插件，都要在真正订阅登录的机器上补测，补测前不要把「订阅下可用」写进给用户的说明。
8. **`--mcp-config` 必须是绝对路径**（相对路径按进程工作目录解析）；方案里「带令牌的配置」若想避免令牌落盘，可尝试传内联 JSON 字符串（`--help` 说支持，**本次未测**）。

