状态：已批准；第一段已合 main，第二段候选已实现，假程序验收通过，真实工具与跨平台产物未验证（2026-11-09）

# 原生 ACP 编程工具：第一批实施方案

## 2026-11-10 既有四家私有安装补充（开发中，未交付）

用户批准 Claude Code / Codex / OpenCode / Antigravity 仅迁移安装来源和配置目录，保留 brain 接法。三家 npm 清单已核对：@anthropic-ai/claude-code 2.1.322、@openai/codex 0.167.0、opencode-ai 1.19.5；官方元数据见各包 registry.npmjs.org 的固定版本端点。Claude / OpenCode 当前 bin 为原生二进制，依赖 postinstall 放置，Codex 为 JS 启动器；共用 NativeInstaller 增加入口种类。三家 CLI 环境复用 native-env 覆盖 HOME / Windows / XDG，CLAUDE_CONFIG_DIR与 CODEX_HOME 指私有 home，OpenCode 全部 XDG 指私有 home。

当时 Antigravity 暂停；2026-11-10 用户补充官方关闭自更新开关后继续实施，当前状态以 §10 为准。此前 Homebrew / winget 官方存储 URL 与校验值已只读核对。三家继续实施。三家假包安装→假登录→选模型→对话 e2e 已通过；agy-ui / native-acp-ui 回归已通过。官方命令登录取消、假终端进程组取消和三平台窗口命令拼装单测通过。Terminal Auth：macOS 用 Terminal + osascript，Windows 用 cmd start，Linux 用 x-terminal-emulator；环境由私有 Node 启动器全量替换，POSIX 取消进程组、Windows taskkill /T。真实终端/账号和三平台实机未验证。完整 check 通过：1558 tests、1547 pass、11 skipped、0 fail（artifacts/cli-private-check-final.log）；随后改动定向回归62项全过（cli-private-regression-final.log）、最终静态检查通过。五个 e2e 日志为 artifacts/cli-private-{claude,codex,opencode,agy,native}-e2e.log，截图在对应 *-ui 目录。Claude/Codex 最终截图已等登录操作收尾并目视核对。该段为三家合并时的历史结果，Antigravity 后续候选见 §10；没有运行真实安装脚本、登录、模型或用户已安装CLI，没有 commit/push/tag/重启8787。


承接 [原生 ACP 设计](native-acp-agents.md) 和 [决策 0030](../decisions/0030-native-acp-agents.md)。本文 §7 记录用户本次批准的具体取舍；此前设计与本文不一致的本批实施范围，以 §7 为准。批准方案不代表功能已经实现或真实工具验收通过。

## 1. 范围与分段

第一批只接 **Gemini CLI、CodeBuddy Code**。Cursor 保留调研结论，不增加 profile、渠道、卡片或安装入口。

- **第一段（本次开发）**：通用 native 运行、两家薄 profile、会话绑定、原生步骤旁路展示、权限请求、能力协商、停止 / 插话 / 超时、假 ACP 测试、旧渠道回归及 `npm run check`。不安装真实工具，不开发安装 / 登录 / 更新界面，不跑 e2e 或真实模型。
- **第二段**：npm 供应方案 A、私有安装、登录、更新、模型服务卡片、第三方首发固定清单，以及相应安装测试 / e2e；用户自己登录后再做 dev:live 真实验收。第二段不计作第一段已完成。
- 第二段按用户 2026-11-09 的明确任务继续开发于 `dev/native-acp-2`，第一段已合 main（c43a40e4）。同步实际模块登记与交接文档；不 commit、push 或打 tag，不重启 8787，不真实安装或登录。

## 2. 已有证据与工具差异

以下为静态调研证据，不是安装 / 登录 / 运行验收。注册表固定快照为 `4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7`（2026-11-09 获取）。当时本机 `--version` / `--help`：Gemini 0.60.0、CodeBuddy 2.162.0，不能代表注册表候选已验。PATH 中的 `agent` 是 Grok，不能当 Cursor。

| 工具 | 注册表候选 / 启动 | 隔离与能力证据 |
|---|---|---|
| Gemini CLI | npm `@google/gemini-cli@0.67.0`；`gemini --acp` | `GEMINI_CLI_HOME=<工具目录>/home`，实际配置在其下 `.gemini`；`context.memoryBoundaryMarkers:[]` 关闭父目录规则发现；声明 `loadSession:true`、HTTP / SSE MCP；未声明独立 resume |
| CodeBuddy Code | npm `@tencent-ai/codebuddy-code@2.181.0`；`codebuddy --acp` | `CODEBUDDY_CONFIG_DIR=<工具目录>/home`；`--setting-sources user`、`--strict-mcp-config`；`CODEBUDDY_DISABLE_PARENT_MEMORY=1`、`CODEBUDDY_DISABLE_AUTO_MEMORY=1`；声明 load 与 HTTP / SSE MCP |
| Cursor（仅研究） | 注册表 2026.11.05 / 86047df；`cursor-agent acp` | 六平台 archive 已列出，但官方 SHA256、隔离 / 权限 / 登录 / 恢复的实际能力未查实，本批不接 |

两家都保留工作区自身的规则与原生系统提示。Gemini 不使用 `GEMINI_SYSTEM_MD` 替换提示；CodeBuddy 虽有 `--append-system-prompt`，本批也统一首条消息注入 Pi 环境与 persona，不另走参数分支。

Gemini 的 `.env` 会从工作区向上发现；`advanced.ignoreLocalEnv` 不能挡住全部 `.gemini/.env`。用户已批准在 **Pi 管理的 Gemini 工作区**准备空 `.gemini/.env` 以截断祖先搜索；不覆盖已有非空文件，遇到冲突说明原因，不声称已经完全隔离。该行为仍待假测试与后续真实验收。

两家部分原生读取不发权限请求，Keychain / 其他凭据后端也可能跨目录共享。用户接受这些边界；后续卡片复用 Help 说明，不加“实验性”标签，也不以证明完全隔离作为额外开放门槛。Pi 不读、复制或转发这些凭据。

认证证据：两家返回的是 Agent Auth，使用 ACP `authenticate` 由工具开启官方登录。CodeBuddy authenticate 可能先注销已有会话，不能拿来做登录检测。第一批不做 Terminal Auth。

来源：

- 注册表：[Gemini](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/gemini/agent.json)、[CodeBuddy](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/codebuddy-code/agent.json)、[Cursor](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/cursor/agent.json)。
- Gemini 固定官方 [v0.67.0 源码](https://github.com/google-gemini/gemini-cli/tree/dc6602cec4a6e823aa33937144245dc421e5165f)：`paths.ts`、`storage.ts`、`memoryDiscovery.ts`、`settings.ts`、`acpRpcDispatcher.ts`、`acpSessionManager.ts`、`acpSession.ts`；[配置](https://github.com/google-gemini/gemini-cli/blob/v0.67.0/docs/reference/configuration.md)、[系统提示](https://github.com/google-gemini/gemini-cli/blob/v0.67.0/docs/cli/system-prompt.md)。
- CodeBuddy：[ACP](https://www.codebuddy.ai/docs/cli/acp)、[参数](https://www.codebuddy.ai/docs/cli/cli-reference)、[环境变量](https://www.codebuddy.ai/docs/cli/env-vars)、[目录](https://www.codebuddy.ai/docs/cli/codebuddy-dir)、[权限](https://www.codebuddy.ai/docs/cli/permission-modes)、[固定发布实现](https://unpkg.com/@tencent-ai/codebuddy-code@2.181.0/dist/codebuddy-headless.js)。
- Cursor：[ACP](https://cursor.com/docs/cli/acp)；本次其他官方文档多次超时，未取得足够运行证据。查不到不等于官方没有该能力。

## 3. 第一段运行实现

### 3.1 复用现有 ACP 骨架

在现有 `AcpChannelConfig` / `AcpProfile` 增加明确的 `brain` / `native` 模式，复用 `createAcpChannel`、`AcpProcess`、`RpcClient`、`ProcessPool`、`SyncStore`、`channel-core`、`SegmentBuilder`。已有 Claude Code / Codex / Antigravity / OpenCode 保持原行为，不迁移，不另写两套渠道。

native 使用已绑定助理的 `workspaceOf(agentId)`，保留工具原生读写与命令，不套用 OpenCode 的全部 deny、系统提示替换或固定 work 目录。profile 仅声明两家的启动参数、隔离环境和能力差异。进程启动复用 `buildCliEnv` / `nativeLaunchEnv`，在最终环境明确覆盖工具专用配置目录，不能被真实 HOME 的恢复逻辑覆盖；不继承终端模型密钥。

经 `agent-runtime/agent-session.ts` 共用入口，按 Pi sessionId 绑定 agentId、conversationId、taskId / subagentId、workspace、权限上下文及取消信号，结束释放。不得按 modelId / 路径猜身份或使用全局“当前助理”。底层进程接收回调，不直接引用运行时数据库或审批模块。

Pi 工具仍通过现有 HTTP MCP 工具桥提供，只有真实 MCP `tools/call` 才能进入 Pi 工具执行与回填。两家已有 HTTP 证据，不写 stdio→HTTP 备用桥；不声明客户端 fs / terminal 执行能力，未知客户端方法按协议拒绝。

### 3.2 原生步骤旁路与真实顺序

ACP `tool_call` / `tool_call_update` 仅供展示，经公开 `onProviderStreamEvent` 旁路落到现有 App `messages` 表的 **`role: tool`** 消息。保留已有 Fast / instrumentation 钩子，不伪造 Pi `toolCall` / `toolResult`，不交给 Pi 再执行。

- 解析并合并 toolCallId、title、kind、status、受限 content / locations / rawInput / rawOutput。补丁没带的字段不清空；不把 content 擅自当增量文字。以进程运行、ACP sessionId 和 toolCallId 共同定位，处理早到 update、重复 start、迟到 running，终态不回滚。
- 对话中保持“正文 → 原生步骤 → 后续正文”的实际顺序。**若现有结构必须拆分正文消息才能做到，先向主助理说明原因和最小改动，再实施；不得自行增加正文分组、片段偏移或同 entry 多片段机制。**
- 复用 Steps 与现有工具消息组件，仅显示工具方名称、步骤标题、状态及受限输出。原生步骤不设置假的 Pi entry / 分支锚点，不提供再次执行按钮。
- 原生进展计入本轮可见输出，纯步骤一轮不误报“未收到回复”。结束、取消或进程退出时收尾仍在运行的步骤，卸载订阅，刷新后历史可读。
- 桥工具仍只按桥请求执行；原生通知不能靠标题或先后次序配对成桥调用，也不因通知多出一次执行。

中途切模型 / 换工具只复用已有 **`renderTranscript`**：原生步骤仅加入一行“成功 / 失败（或结果未确认）＋标题”的文字记录。不补原始日志，不建操作摘要注入、分组偏移、未知副作用恢复或额外模型复查机制。

### 3.3 权限请求

所有权限档均开放 native。对工具实际发来的每一个 `session/request_permission`，按以下规则处理：

1. 确认请求属于当前运行，归一化明确的路径 / 命令；复用现有凭据路径拒绝判断，不另写一套凭据正则。凭据拒绝在 full 放行之前；无法观察的工具内部读取不因此获得全量保护保证。
2. 暂停、取消、权限撤销时拒绝待审批请求并 `session/cancel` 当前运行，沿用进程清理兜底；不能只拒绝下一次请求而让原生任务继续。
3. 仅在有效完全权限（复用 `hostFileAccess`，含启用、助理授权与未暂停）时自动选择 **allow_once**。其他每个档位的每个请求都交现有 `requests.approval` 出卡，不另设 observe / bounded 禁用或原生写入门槛。
4. 只使用工具原样提供的 **allow_once / reject_once** 选项。缺少任一个必需选项就拒绝，能返回 reject_once 时返回它，否则返回 cancelled；不退到 allow_always / 任意 allow，不加“本任务都允许”。
5. 审批等待异步，不能堵通知与取消。停止时清理本运行的待审批请求；不新增批准后的额外复查流程。

Pi MCP 工具继续走现有 ext-approval 与 tool-guard，既有凭据拒绝、暂停及系统权限边界不变。原生 request_permission 是工具主动发来的询问，不是操作系统沙箱；Help 如实说明工具可能自行读取、执行未逐项上报的动作及 Keychain 共享风险。

### 3.4 能力、续用、插话与超时

- initialize 读取真实能力与配置选项；模型 / 思考档位 / 图片 / HTTP MCP 按实际声明使用，不硬猜配置名或虚构能力。
- 同进程继续用当前会话；跨进程只在声明 **loadSession** 时走 `session/load` 并避免历史回放重复展示，否则 fresh，复用已有历史文字输入。**不走 session/resume**，不因实现里存在方法就调用；不加未知副作用恢复机制。
- persona 与 Pi 环境说明统一加在新会话首条消息中，不替换原系统提示，也不按工具分别增加追加参数路径。
- 有 Pi 桥结果边界时沿用现有插话路径；纯 native 运行等当前 prompt 完成再发送排队插话，准确提示“这轮结束后送达”，不并发 prompt，不取消重开以插话。
- native 的卡死保护只按 **连续 10 分钟没有 ACP 事件、且当前没有待审批请求** 判断，触发 cancel。ACP 事件刷新活动时间，审批等待不触发；结束清计时器。**不抽取或改造 tool-guard，不按原生 toolCallId 建活跃执行计时器。**
- 群聊 / 帮手沿用共用会话绑定与既有行为，本批不加专门的让位、进展监督、执行上限或恢复分支。整理上下文继续复用既有入口，不新建另一套总结 / 复查流程。

## 4. 第二段安装、登录与更新

### 4.1 npm 供应：方案 A 已批准

已核对 App 当前只带 Node，不带完整 npm；构建机有 npm 不能代表用户机器有 npm。第二段从现有已校验官方 Node 分发保留 npm 完整目录，用 App Node 和绝对 `npm-cli.js` 路径启动；npm 不作为新项目依赖。不改用户全局 npm、不用全局安装，也不要求用户另装 npm。

复用 `mcp-install.ts` 的 prefix / bin 定位和 inflight 思路、`downloads.ts` 的进度与取消。不能直接复用其继承全部环境、依赖 PATH npm 的旧执行方式；必要共享提取以实际实现为准，避免提前创建闲置层。

### 4.2 私有目录与更新

安装位置 `<dataDir>/cli-agents/<id>/<version>`，home 单独为 `<id>/home`，npm cache / 配置也私有化，不读取用户 `.npmrc` 或凭据。新版 staging 完成安装与入口校验后再切换，失败保留旧版，更新不删除 home；正在运行的旧进程用完再换。

**首发**在第二段将两家候选的固定版本、来源、许可证与官方 npm integrity 登记到 `third-party.json` / notices；注册表快照仅为可追溯依据，不要求锁文件固定传递依赖。

**更新**由用户点击触发：读取 npm 官方 registry 的 **latest** 元数据，以该版本的官方 tarball / integrity 自校验后安装到新版本目录。记录实际版本与验证状态；未经 Pi 实测的版本提示一句，不阻止使用。不要求 Pi 另发审核清单、锁文件或等待随 App 发新版；不自动更新。安装脚本与平台可选依赖的实际可用性在第二段验证，不提前承诺六平台通过。

### 4.3 Agent Auth 与卡片

同一受管安装 / 隔离环境 initialize，用户点登录才调用实际返回的 Agent Auth 方法，工具自己打开官方流程；取消结束本次认证进程。不以 authenticate 作只读检测，不读账户秘密，不暗中发付费 prompt 验证登录。没有无副作用检测能力时准确显示待验证状态。

复用 `CliAgentCard`、`cli-channel-service`、`cli-services`、现有模型路由与 `models.changed`；每家卡片展示状态、版本、安装 / 登录 / 更新 / 重试 / 取消的当前主要动作。限制放 **Help**，不加实验标签。Terminal Auth、Cursor 卡片和 stdio MCP 桥不在本批。

## 5. 复用与文件登记

已按 AGENTS / MODULES 查找：运行复用 ACP、channel-core、ProcessPool、SyncStore；权限复用 requests、hostFileAccess 及已有凭据拒绝；消息复用 bind-session / Steps；换模型复用 renderTranscript；第二段安装 / 卡片复用 MCP 安装思路、downloads 和 CliAgentCard。只经 Pi 公开接口，不改 SDK、node_modules、依赖版本，不加依赖。

第一段预计触及 ACP 进程 / 事件、渠道适配与历史渲染、共用会话绑定 / 事件落库、权限接线、两家 profile、fake ACP 与相关单测；**实际文件清单由主助理确认后再登记 MODULES**。不为行数估算先建模块，不提前登记第二段安装 / 登录 / 界面文件。新增源码 <600 行，已有大文件只许变短。

## 6. 验证边界

第一段自动化仅临时数据、内存凭据、假 ACP / 假工具桥和 Mock，不联网安装、不调用真实 CLI、不启动真实模型 / 用户 Chrome / 电脑驱动。

| 类别 | 第一段验收 |
|---|---|
| 原生事件 | start / update 合并、乱序、重复、收尾；仅落 role:tool，不产生 Pi 重复执行；正文与步骤顺序可核验 |
| 权限 | 所有档可接入；full 只 allow_once，其他每请求出卡；凭据拒绝、暂停拒绝且 cancel；缺 allow_once / reject_once 拒绝；取消可清理等待 |
| 会话 | 两家统一首条 persona；同进程续用；仅 load 能力恢复，否则 fresh；load 回放不重复；无 resume 调用 |
| 运行 | 纯 native 插话轮后送达；停止收尾；可注入时钟模拟 10 分钟无 ACP 事件触发取消，审批等待不触发，有事件刷新计时 |
| 隔离 / 历史 | 捕获 fake 环境与工作目录；Gemini 空 `.gemini/.env` 与不覆盖非空文件；切模型只用 renderTranscript 加一行步骤状态标题 |
| 回归 | 现有 Claude Code / Codex / Antigravity / OpenCode 相关假测试；完整 `npm run check` |

第一段 **不跑 e2e、不安装、不登录、不做 dev:live**。文档批准、假测试、check 通过都不能写成真实工具已经可用。

第二段再验 npm A、私有安装 / 登录 / 点击更新及对应 UI / e2e；真实工具只在 dev:live 用新测试助理、由用户自己登录后验收。跨平台结果分别记录未验证 / 通过，不用 Mac 结果外推其他平台。

## 7. 用户已批准的取舍（本批执行依据）

| 事项 | 已批准结论 |
|---|---|
| 第一批与本次范围 | Gemini + CodeBuddy；Cursor 只留研究。本次第一段仅 native 运行、假测试 / 旧渠道回归 / check，无 e2e、无安装 |
| npm 供应 | 选 A：随 App 保留完整 npm；放第二段，第一段不动打包 / 供应链 |
| 权限开放 | 全部权限档可用；有效 full 自动 allow_once，其他每个 request 都出卡；复用凭据拒绝；暂停拒绝并 cancel |
| 一次性选项 | 只用 allow_once / reject_once；缺少必需选项就拒绝，不能选永久允许或任意 allow |
| 已知边界 | 接受原生读取不逐次审批、Keychain 可能共享；在 Help 明说，不加实验标签，不新增开放门槛 |
| Gemini 环境 | 在 Pi 管理的 Gemini 工作区准备空 `.gemini/.env`，不覆盖已有非空文件 |
| 原生过程 | role:tool 旁路展示、保持实际顺序；正文若必须拆分，先说明再实施；禁止正文分组 / 片段偏移机制 |
| 换模型历史 | 只复用 renderTranscript，每步骤一行成功 / 失败（或结果未确认）与标题；不加摘要注入 / 原始日志 / 额外复查 |
| 插话 | 纯 native 轮后送达；有 Pi 桥边界沿用现有路径，不取消重开 |
| 卡死保护 | 10 分钟无 ACP 事件且无待审批时 cancel；不抽 tool-guard，不做每工具活跃执行计时 |
| persona | 两家统一新会话首条消息追加，不替换原生系统提示，不另分启动参数策略 |
| 跨进程续用 | 仅声明 loadSession 才 load，否则 fresh；不 resume，不增加未知副作用恢复机制 |
| 版本与更新 | 第三方首发固定清单第二段做；用户点更新时读 npm registry latest 并用官方 integrity 自校验，不要求锁文件或额外 Pi 审核清单 |
| 明确不做 | Terminal Auth、stdio→HTTP 桥、Cursor 接入、未知副作用恢复、额外复查，以及群 / 帮手专用处理 |

这些是已批准决定，不再列为“待拍板”。尚未完成的真实验证如实标注，不因未知项扩充第一段或自行改设计。

## 8. 第一段历史验证状态

第一段已合 main（c43a40e4），未随本次发布。以下为第一段交接时的历史验证记录：当时命令只经 PIA_GEMINI_COMMAND / PIA_CODEBUDDY_COMMAND 显式绝对路径配置，默认模型为工具自行选择的别名；第二段的受管安装与模型发现会替代该入口限制。

- 原生事件走公开 provider hook，App 步骤落库；正文按必要边界做最小片段，未加分组或偏移机制；原生标题随实际 assistant 对象持久化并由 renderTranscript 渲染。
- 假程序与旧渠道定向回归首轮 130/130 通过；最终追加 hook 稀疏更新回归通过；typecheck、check:static 通过，完整 npm run check 通过：1541项，1530通过、11跳过、0失败；最后接线调整另跑定向47项及hook 3项通过，typecheck/check:static复核通过。
- e2e、真实安装 / 登录 / 更新、dev:live、跨平台执行、凭据后端隔离、真实 cancel 效果：未验证，留第二段。仅新增 Node 前端静态单测，未运行浏览器 e2e。
- MODULES、HANDOFF、ROADMAP 已同步。没有改依赖或上游，没有 commit、push 或打 tag。
- 第一段限制：当时仅提供工具默认模型别名（第二段已加入实际 configOptions 模型发现）；无工具的独立摘要调用没有原生宿主上下文，会明确报错。Gemini load 后迟到的历史文字缺少协议结束标记，真实回放时序仍未实测；当前抑制 load 阶段历史及已识别历史工具事件。

## 9. 第二段候选与验证（2026-11-09）

- 分支 `dev/native-acp-2`，未提交、推送、打包或发布；没有重启 8787、真实安装 CLI、真实登录或调用模型，没有改依赖版本或上游。
- 三处打包脚本保留现有已校验官方 Node 分发内完整 npm；统一 `app-node-npm.ts` 路径与 bin 定位供 MCP / native 共用。正式包缺 npm 明确报错，开发态只查当前 Node 旁 npm。
- 私有 npm home / config / cache；先 pack 并校验官方 SHA512，再安装本地校验包到 staging，校验入口后原子切 current.json。旧版本下次启动清理，保留 home 和不认识的目录；失败保留旧指针。两顶层包无 postinstall；未真实验证全部传递依赖脚本需求，因此安装阶段保留正常依赖脚本，pack 阶段禁脚本。
- Agent Auth 仅用户点击触发；initialize + session/new 探测并缓存，不发 prompt，不读取凭据。取消关闭认证进程。实际 configOptions(category=model) 注册；无目录时仅默认模型。
- 手动检查读取 npm latest 版本及完整性，缓存具体版本；用户点更新才装该版本。非首发固定版本提示“这个版本还没测过”。卡片复用 CliAgentCard / Help；模型选择与审批复用现有入口。
- 最终 `npm run check`：1554 tests，1543 pass，11 skipped，0 fail；日志 `artifacts/native-acp-2-check-final.log`。网页 build 通过。
- `native-acp-ui` 通过：两家安装、取消登录、登录、检查更新/更新、保留登录；选模型、消息、原生步骤、审批/批准、临时文件、刷新历史、390 窄屏。截图 `artifacts/native-acp-ui/`，审批与完成截图已等稳定并目视核对。
- 旧模型服务 e2e：`claude-code-ui`、`codex-ui`、`agy-ui`、`opencode-ui` 全部通过，全部临时数据与假程序。原联网 MCP 安装单测已改本地假 npm/uv，自动化无联网安装。
- 未验证：真实两工具安装 / 登录 / 模型调用、真实取消效果、session/new 真实无费用表现、Mac 钥匙串隔离、Gemini 真实 load 回放时序，以及 macOS / Windows / Linux 发布产物和执行。静态包元数据核验不代表实装可运行。

## 10. Antigravity 私有安装候选（2026-11-10）

- 分支 dev/agy-private-install，基于 origin/main d91c5c96；三家已合 main b1dc632d。仅迁移安装、配置与登录，保留 brain 后端及 provider antigravity。未 commit / push / tag，未改旧副本、依赖版本或上游，未重启8787。
- 复用 NativeInstaller 的 downloads 下载进度 / 校验与取消、staging、原子 current、启动清旧版；新增官方 binary 来源，固定六平台版本 1.5.4-5037094733742080、URL、SHA256。tar 仅读取普通文件 antigravity；专有许可、用户点击从 Google 下载，不随 App 分发。
- 所有检测、模型枚举、登录与对话复用 managed-env，HOME / Windows / XDG 覆盖为 cli-agents/antigravity/home，官方 AGY_CLI_DISABLE_AUTO_UPDATE=true 固定且不能被 extra 覆盖。配置与会话在 HOME/.gemini/antigravity-cli；不搜索用户 PATH，不读写用户 .gemini，不读取凭据。系统钥匙串是否共用未验证。
- 登录证据：[Google 官方仓库 README](https://github.com/google-antigravity/antigravity-cli/blob/main/README.md) 说明浏览器 / SSH 登录和系统钥匙串；[官方 CHANGELOG 1.5.0](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md) 明确 agy acp --login。本次下载官方 darwin-arm 归档仅做 SHA256 与静态字符串检查，匹配 196e6777…65834、入口 antigravity，内含“Log in with Google interactively, then exit (ACP terminal auth)”和 AGY_CLI_DISABLE_AUTO_UPDATE。没有执行真实二进制。证据保存在 artifacts/agy-official-* 与 agy-inspect/。
- 关闭自更新证据来自用户查实的 [Google troubleshooting](https://antigravity.google/docs/cli/troubleshooting)；本次 Google 文档与官方更新清单直连 SSL 失败，不能声称实网清单验收。静态二进制可佐证开关存在，不能代替真实运行验证。
- 手动检查固定官方 manifests/{darwin|linux|windows}_{arm64|amd64}.json，解析 version / url / sha256；URL 必须为同版本、同平台 Google storage 路径。有 SHA256 才允许安装；无 SHA256 只显示新版并等待 App 固定清单。字段以官方二进制静态标签和假清单验证，实际回包未取得。
- 卡片复用 CliAgentCard / Help，提供安装 / 登录 / 取消 / 手动更新，去掉本机 / 实验性 / 旧终端提示；边界放 Help。旧会话找不到时沿用 channel-core 的 renderFreshInput 自动退回。
- 测试：本地假 binary 覆盖下载 SHA / tar / current / 取消更新 / 缺或有 SHA；假程序捕获检测、终端登录、对话的私有环境；登录取消与三平台终端拼装、旧续接失败退回。agy-ui 从未安装→安装假 binary→取消与完成假登录→更新保留登录→选模型→对话 / 工具审批，另四个 UI 串行回归。最终 npm run check：1564 tests、1553 pass、11 skipped、0 fail（artifacts/agy-check-final.log）；网页 build 通过（agy-web-build-final.log）。五个 e2e 串行通过：agy-e2e-final.log、agy-regression-{claude,codex,opencode,native}-final.log。截图 artifacts/agy-ui/ 的八张及三家 ready / native approved 已目视核对；批准后结果截图复用 stableShot 等有限动画完成，正文清晰可见。
- 未验证：真实安装、真实账号登录 / 模型、真实终端与取消效果、Windows / Linux 执行和发布产物、钥匙串隔离、实际更新清单回包与实际新版。
