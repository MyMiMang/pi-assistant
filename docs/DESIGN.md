# 胡好好 · 基于 Pi 的本地私人助理 —— 设计文档 v0.1

> 状态：设计稿（2026-10-11）。代码仓库目前只有骨架，没有产品代码。
> 参考：Pi 仓库 `earendil-works/pi`（本文基于 `@earendil-works/pi-coding-agent@1.1.0` 的源码和文档阅读结果，API 名称均来自实际代码）。

---

## 1. 产品目标

做一个**跑在用户自己电脑（Mac / Windows）上的私人助理**，体验对标托管版桌面助理：

- 一个聊天窗口，说一句话它就**自己动手**：跑代码、处理文件、上网、操作浏览器、连你的 Gmail/日历/GitHub，做完把结果、文件、截图发回来。
- 它有**自己的“电脑”**（沙箱工作区），文件长期保留，不会碰乱你的个人文件。
- **你不在它也在干活**：后台任务、定时任务、事件触发。
- **手机只是遥控器**：iOS/Android App 只负责显示和输入，所有计算、文件、凭据都在你的电脑上。
- **一步安装**：用户只装我们的 App。Pi、Node 运行时全部内置，不需要另装 Pi / Node / Docker。
- **有后果的操作先问你**：发邮件、删东西、付款、提交表单一律走审批，手机上也能批。

非目标（至少前三期不做）：多用户/团队、云端托管、在手机上本地跑模型或执行任务。

### 核心原则

1. **Pi 是地基，不是外挂**：通过 Pi 的 SDK 把 agent 运行时嵌进我们自己的守护进程，所有能力都用 Pi 的扩展点（工具、事件钩子、MCP、技能）实现，不 fork Pi。
2. **凭据不进沙箱**：模型 key、OAuth token 只在守护进程里；沙箱里跑的代码拿不到。
3. **先落盘再显示**：每条消息、每个任务状态先写 SQLite / Pi 会话文件再推给 UI，进程崩了、电脑重启了都能接着做。
4. **默认安全**：没有 Docker 也能用，但要靠审批闸门 + 路径约束兜底。

---

## 2. 功能清单（对照 9 大能力）

| # | 能力 | 用户看到的 | 实现要点 | 期 |
|---|---|---|---|---|
| 1 | 聊天与交付 | 收到任务先回“好的，我来…”，做完发结果、文件卡片、截图；桌面和手机实时同步 | Gateway WebSocket 推送 Pi 事件流；`deliver_file` / `send_screenshot` 自定义工具；附件存 `data/files/` | P1 |
| 2 | 自己的电脑 | 一个持久工作区，可以跑命令、装工具、生成文件 | 三档沙箱（见 §5.4）：工作区目录 / OS 级沙箱 / Docker；Pi 内置工具重定向到沙箱 | P1 |
| 3 | 浏览器与桌面 | 助理自己开浏览器办事，登录状态保留；遇到验证码/二次验证把画面交给你（手机也能点） | Playwright + 持久化 profile；CDP screencast 推流到 UI；`browser_handoff` 工具 | P3 |
| 4 | 应用连接 | 连 Gmail、日历、GitHub；发信/发消息永远先出草稿 | 连接器层：官方 API + OAuth（PKCE，本地回调）；或 `pi.registerMcpServer()` 接 MCP；写操作统一走审批 | P3 |
| 5 | 后台任务 | 长任务后台跑，你继续聊别的；完成后推送通知 | 每个任务一个独立 Pi `AgentSession`；任务表在 SQLite；完成时推送（桌面通知 + APNs/FCM） | P1 |
| 6 | 定时与事件 | “每天 8 点给我一份摘要”“有新 PR 就提醒我” | Scheduler（cron 表达式，时区感知）+ Webhook/轮询触发器；到点创建后台任务 | P2 |
| 7 | 记忆 | 记住你的名字、偏好、决定 | SQLite：profile 事实 + 按日日志；`before_agent_start` 注入；`memory_write`/`memory_search` 工具 | P2 |
| 8 | 技能 | 把多步流程存成说明书，下次直接照做 | 原生 Pi Skills（`SKILL.md`，Agent Skills 规范）；技能目录 `data/skills/`；助理可自己写新技能 | P2 |
| 9 | 审批闸门 | 有后果的操作弹卡片：批准 / 拒绝 / 修改，桌面手机任一端处理 | `pi.on("tool_call")` 返回 `{ block, reason }`；配合工具 `annotations`；审批请求持久化，可跨设备 | P1 |
| + | 多助理/人设 | 多个助理，各有名字、模型、技能、工作区 | `agents` 表；每个 agent 独立工作区和会话目录 | P3 |
| + | 设置 | 模型与 key、沙箱档位、通知、配对设备、连接器 | Settings 页 + Pi `SettingsManager`（内存/文件） | P1–P3 |
| + | 用量 | 每天/每任务 token 与费用 | 汇总 Pi 消息里的 `usage`；`usage_daily` 表 | P3 |

---

## 3. 总体架构

### 3.1 部署形态

```mermaid
flowchart LR
  subgraph PC["用户的 Mac / Windows 电脑（所有计算都在这里）"]
    direction TB
    Tray["桌面 App（Tauri 托盘 + 窗口）"]
    subgraph Daemon["huhao-daemon（Node 22 sidecar，开机自启）"]
      GW["Gateway<br/>HTTP + WebSocket（Hono）"]
      RT["Agent Runtime<br/>Pi SDK: createAgentSession"]
      SCH["Scheduler / Triggers"]
      CON["Connectors<br/>Gmail / Calendar / GitHub / MCP"]
      DB[("SQLite<br/>data/huhao.db")]
      FS[("data/<br/>sessions · files · skills")]
    end
    subgraph SB["沙箱（三档自动选择）"]
      WS[("workspace/")]
      BR["Chromium（Playwright）"]
    end
    Tray <-- "localhost WS" --> GW
    GW --- RT --- SCH
    RT --- CON
    RT -- "bash/read/write 重定向" --> SB
    GW --- DB
    RT --- FS
  end
  Phone["手机 App（iOS / Android）<br/>瘦客户端"] <-- "WSS（局域网 / 安全隧道）" --> GW
  CON <-- HTTPS --> Cloud["Gmail / Google Calendar / GitHub"]
  RT <-- HTTPS --> LLM["模型提供商<br/>（Pi pi-ai 统一接口）"]
  Push["推送中继（APNs/FCM）"] --> Phone
  GW -- "仅通知标题，不含内容" --> Push
```

### 3.2 一次请求的生命周期（ack → 执行 → 交付）

```mermaid
sequenceDiagram
  participant U as 用户（桌面/手机）
  participant G as Gateway
  participant T as TaskManager
  participant P as Pi AgentSession
  participant A as 审批扩展
  participant S as 沙箱
  U->>G: ws: chat.send {text, attachments}
  G->>G: 写入 messages 表（先落盘）
  G->>P: session.prompt(text) / steer / followUp
  P-->>G: message_update(text_delta) 先回“好的，我来…”
  P->>A: tool_call 事件（bash: rm -rf …）
  A->>G: 创建 approvals 记录（pending）
  G-->>U: 推送审批卡片（所有在线设备 + 手机推送）
  U->>G: approval.resolve {approve}
  G->>A: resolve Promise
  A-->>P: 放行（或 {block:true, reason}）
  P->>S: 在沙箱执行命令
  P->>P: deliver_file 工具 → 文件卡片
  P-->>G: agent_settled
  G-->>U: 结果 + 文件 + 截图；如在后台则发推送
```

### 3.3 为什么用 SDK 而不是 RPC

| 方案 | 结论 |
|---|---|
| **SDK（进程内）** `createAgentSession()` | ✅ 采用。我们本身就是 TypeScript/Node，能拿到完整 API：`session.subscribe()` 事件流、`steer()`/`followUp()`、`SessionManager`、`DefaultResourceLoader({ extensionFactories })` 注入我们自己的扩展、`bindExtensions({ uiContext })` 把扩展的 `ctx.ui.confirm()` 接到我们的审批系统。打包时只有一个进程。 |
| RPC（`pi --mode rpc` 子进程） | 备选。若以后要给每个 agent 做进程级隔离（一个 agent 崩溃不影响别的），可以换成 `RpcClient`；协议里的 `extension_ui_request/response` 同样能接审批。接口层做成 `AgentDriver` 抽象，两种都能插。 |
| `pi-durable` / `pi-server` | 官方标注 Experimental、API 随时变。先不用，P3 之后评估（它的“先提交再显示、崩溃续跑”和我们的目标一致）。 |

---

## 4. 我们依赖的 Pi 扩展点（实际 API）

全部来自 `packages/coding-agent/src/core/extensions/types.ts`、`docs/extensions.md`、`docs/sdk.md`：

**SDK 层**
- `createAgentSession({ cwd, sessionManager, settingsManager, resourceLoader, modelRuntime, model, thinkingLevel, tools, customTools, excludeTools })` → `AgentSession`
- `session.prompt()` / `session.steer()` / `session.followUp()` / `session.abort()` / `session.waitForIdle()` / `session.subscribe(listener)` / `session.dispose()` / `session.getLastAssistantText()`
- `session.bindExtensions({ uiContext, mode, abortHandler, shutdownHandler })`：把 `ctx.ui.select/confirm/input/notify` 实现为我们的 Web 审批与通知
- `SessionManager`（JSONL 持久会话，`SessionManager.inMemory()` 用于临时任务）、`AgentSessionRuntime.newSession()/switchSession()/fork()`
- `DefaultResourceLoader`（`extensionFactories` 注入内联扩展；技能/提示模板目录）、`SettingsManager`、`ModelRegistry`
- 事件：`message_update`（`text_delta` 流式）、`message_end`、`tool_execution_start/update/end`、`agent_end`、**`agent_settled`**（判断任务真正结束）
- `createMcpExtension()`、`createCodemodeExtension()`、`createToolSearchExtension()`（SDK 不默认加载，需手动加入）

**扩展层（`ExtensionAPI`）**
- `pi.registerTool({ name, description, parameters(TypeBox), execute, annotations, exposure })`：注册 `deliver_file`、`memory_*`、`browser_*`、`gmail_create_draft` 等
- `pi.on("tool_call", …)` → `{ block: true, reason }` 或就地修改 `event.input`：**审批闸门核心**
- `pi.on("tool_result", …)`：脱敏、截断大输出、收集产出文件
- `pi.on("before_agent_start", …)` → `{ message }` / `systemPromptOptions`：注入记忆、人设、当前时间时区
- `pi.on("session_start" | "session_shutdown")`：启动/释放浏览器、沙箱连接（文档要求不要在工厂函数里起进程）
- `pi.on("agent_before_settle")`、`pi.on("turn_end")`：任务收尾（写日志、生成摘要）
- `pi.on("input")`：解析附件、斜杠命令
- `pi.getAllTools()` 的 `annotations`（`readOnlyHint` / `destructiveHint` / `openWorldHint`）：审批策略的默认依据
- `pi.registerMcpServer(name, config)` / `pi.unregisterMcpServer()` / `pi.getMcpServers()`：连接器接 MCP
- `pi.sendMessage(msg, { triggerTurn, deliverAs })` / `pi.sendUserMessage()`：定时任务、事件注入
- `pi.appendEntry(customType, data)`：不进上下文的持久状态（如审批记录引用）
- `pi.setActiveTools()` / `pi.getActiveTools()`：按 agent 人设裁剪工具
- `pi.registerProvider()`：自定义模型提供商（如本地 llama.cpp / 公司网关）
- `pi.exec()`、`ctx.executeTool()`、`ctx.modelRegistry.streamSimple()`（嵌套模型调用，如摘要）
- 内置工具重定向：`createBashTool(cwd, { operations })` + `BashOperations`（参考官方 `examples/extensions/gondolin`），同理覆盖 `read/write/edit/grep/find/ls`
- 参考示例：`permission-gate.ts`、`confirm-destructive.ts`、`protected-paths.ts`、`sandbox/`、`gondolin/`、`notify.ts`、`todo.ts`

**技能**：原生 `SKILL.md`（frontmatter `name`、`description`、`disable-model-invocation`），`/skill:name` 强制加载。

---

## 5. 组件设计

### 5.1 huhao-daemon（守护进程，核心）

单个 Node 22 进程，内部模块：

| 模块 | 职责 |
|---|---|
| `gateway` | Hono HTTP + `ws` WebSocket；静态托管 Web UI；鉴权（设备 token）；REST：文件上传下载、配对、OAuth 回调、Webhook 入口 |
| `runtime` | `AgentManager`：每个 agent 一个“主会话” + N 个任务会话；封装 `createAgentSession`；把 Pi 事件翻译成我们的协议事件 |
| `tasks` | `TaskManager`：创建/排队/并发上限（默认 3）/取消/重启恢复 |
| `approvals` | 审批请求的持久化、广播、超时（默认不超时=一直等你）、“本会话内同类操作都允许”的临时授权 |
| `scheduler` | cron（`croner`，时区 Asia/Shanghai 等用户时区）+ 轮询触发器 + Webhook 触发器 |
| `memory` | 事实库 + 日志 + 检索（SQLite FTS5，P3 可加向量） |
| `connectors` | OAuth 管理、token 加密存储、API 客户端、MCP 注册 |
| `sandbox` | 沙箱驱动（三档）+ 健康检查 |
| `notify` | 桌面通知（通过 Tauri）、手机推送（中继）、应用内通知 |
| `usage` | 汇总 token/费用 |

**防丢数据**：
- 所有消息、任务状态、审批先写 SQLite（WAL 模式）再推送。
- Pi 会话本身就是持久 JSONL（`SessionManager` 默认），存 `data/agents/<id>/sessions/`。
- 守护进程启动时扫描 `tasks.status in (running, waiting_approval)`：用同一会话文件重建 `AgentSession`，`sendUserMessage("（系统）上次执行被中断，请检查进度后继续")` 续跑；审批中的继续等待。
- 运行任务期间阻止系统睡眠（macOS `caffeinate -i`，Windows `SetThreadExecutionState`），任务结束释放。

### 5.2 桌面 App（Tauri 2）

- Tauri 只做外壳：托盘图标、窗口（加载 `http://127.0.0.1:<port>` 的 Web UI）、系统通知、开机自启（`tauri-plugin-autostart`：macOS LaunchAgent / Windows 计划任务）、自动更新（`tauri-plugin-updater`）。
- **daemon 作为 sidecar** 随 App 打包；关掉窗口 daemon 继续跑（托盘常驻）。也提供“无窗口服务模式”：直接注册 LaunchAgent / Windows 服务启动 daemon，不依赖 Tauri 窗口。
- 为什么 Tauri 不选 Electron：安装包小（~15MB + Node 运行时），本身不带第二份 Chromium。

### 5.3 Web UI（桌面 + 手机共用一套）

- React 18 + Vite + TypeScript + Tailwind + shadcn/ui；状态 Zustand；数据 TanStack Query；路由 TanStack Router。
- 页面：聊天（流式文本、工具步骤折叠、文件卡片、截图、审批卡片）、任务列表、定时任务、记忆、技能、连接器、设备配对、设置、用量。
- 实时同步：所有客户端订阅同一 WS 事件流，按 `seq` 增量补齐（断线重连时 `since=<lastSeq>` 拉缺失事件）。

### 5.4 沙箱：“它自己的电脑”（三档，自动选择）

| 档位 | 条件 | 隔离方式 | 说明 |
|---|---|---|---|
| L0 工作区 | 永远可用（兜底） | 进程以当前用户运行，`cwd` 固定为 `~/HuHao/workspace`；路径守卫扩展（参考 `protected-paths.ts`）禁止写工作区外；所有 bash 走审批策略 | 安全性最弱，靠审批兜底；UI 上明确标“基础模式” |
| L1 OS 沙箱 | macOS 自带 / Windows 需额外组件 | macOS：`sandbox-exec` 配置文件（只允许写工作区、可选禁网）；Windows：受限令牌 + Job Object 低完整性进程（P2 研究，先做 L0/L2） | 无需安装任何东西 |
| L2 Docker | 检测到 Docker Desktop / OrbStack / Podman | 守护进程**外置**，只把工具执行放进容器：`huhao-sandbox` 镜像（Debian + Python + Node + git + Chromium + Xvfb + noVNC），挂持久卷 `huhao-workspace:/workspace` | 推荐；凭据永远不进容器 |

实现方式统一：参考 Pi 官方 Gondolin 示例，用 `createBashTool(cwd, { operations })` 和对应的 read/write/edit 等工具工厂，**覆盖 Pi 内置工具**，把实际执行交给 `SandboxDriver`：

```ts
interface SandboxDriver {
  exec(cmd: string, opts: { cwd: string; env?: Record<string,string>; signal?: AbortSignal;
       onData?: (chunk: string) => void; timeoutMs?: number }): Promise<{ exitCode: number }>;
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: Buffer): Promise<void>;
  stat / list / mkdir ...
  hostPathOf(p: string): string | null;  // 交付文件时映射到宿主路径
}
```

- L2 的 `exec` 通过容器里常驻的 `exec-daemon`（一个很小的 Node/Rust 程序，stdin/stdout 帧协议，思路同 `pi-env`）避免每次 `docker exec` 的开销；以后也可直接复用 `@earendil-works/pi-env` 的 `RemoteExecutionEnv`。
- Windows：Pi 内置有 PowerShell 工具（`PowerShellToolCallEvent`），L0 下优先 PowerShell；L2 下统一 bash。
- 首次启动检测 Docker，可用则提示“一键切换到增强沙箱”（拉镜像在后台进行），否则静默使用 L0/L1。**Docker 永远是可选的。**

### 5.5 浏览器自动化（P3）

- 依赖 `playwright-core`，浏览器优先用系统已装的 Chrome/Edge（`channel: "chrome" | "msedge"`），没有则首次使用时下载 Chromium 到 `data/browsers/`（不进安装包）。L2 模式下用容器内 Chromium，经 CDP 连接。
- `launchPersistentContext(data/agents/<id>/browser-profile)`：登录状态持久保留（profile 与用户自己的浏览器完全隔离）。
- 工具（`pi.registerTool`）：`browser_open`、`browser_snapshot`（无障碍树 + 可点元素编号）、`browser_click`、`browser_type`、`browser_screenshot`（返回 `ImageContent` 给模型看，同时作为截图交付给用户）、`browser_download`、`browser_handoff`。
- **人工接管**：`browser_handoff(reason)` → 创建 handoff 记录 → UI（含手机）打开实时画面（CDP `Page.startScreencast` 推 JPEG 帧，点击/键盘回传 `Input.dispatch*`）→ 用户点“我弄好了” → 工具返回，agent 继续。验证码、二次验证、付款确认都走这里。
- 提交表单、付款按钮类点击由审批扩展拦截（`browser_click` 带 `intent` 参数，`submit/purchase/send` 需审批）。

### 5.6 连接器层（P3）

- OAuth：daemon 本地回调 `http://127.0.0.1:<port>/oauth/callback`，PKCE；token 用系统钥匙串（macOS Keychain / Windows Credential Manager，经 `@napi-rs/keyring` 或 Tauri 侧存储）加密主密钥，SQLite 只存密文。
- 一等连接器（自己写，体验最好）：
  - Gmail：`gmail_search`、`gmail_read_thread`、`gmail_create_draft`（**只建草稿**）、`gmail_send_draft`（需审批，审批卡片显示完整收件人/主题/正文）
  - Google Calendar：`calendar_list`、`calendar_create_event`（需审批）
  - GitHub：`github_*`（读免审批；建 issue/PR、评论、合并需审批）。也可直接用 `gh` CLI。
- 长尾：用户在设置里添加 MCP 服务器 → `pi.registerMcpServer(name, { command,args,env } | { url, headers, oauth })`，`exposure: "deferred"` 配合 `tool_search` 避免工具太多撑爆上下文。MCP 工具的 `annotations` 直接喂给审批策略。
- 原则：**所有对外发出的内容（邮件、消息、评论、发帖）= 先草稿，后审批，再发送。**

### 5.7 后台任务（P1）

- 聊天里说“帮我…（耗时）”，主会话调用 `spawn_task({ title, instructions })` 工具 → TaskManager 用新的 `AgentSession`（同工作区，独立会话文件）执行 → 主会话立即回复“已经在后台做了”。
- 任务完成：`agent_settled` → 任务结果作为 `custom_message` 注入主会话（`pi.sendMessage({ customType: "task_result", … }, { deliverAs: "nextTurn" })`）+ 推送通知。
- 任务可在 UI 查看实时日志、取消（`session.abort()`）、追加指令（`session.steer()`）。

### 5.8 定时与事件触发（P2）

- `routines` 表：`trigger`（`cron` / `interval` / `webhook` / `poll:gmail` / `poll:github`）、`instructions`（保存时的原话，作为执行依据）、`agent_id`、`enabled`、`last_run_at`。
- 到点 → 创建任务（同 5.7）。电脑睡眠错过的执行：唤醒后按“错过策略”（跳过 / 补跑一次）处理。
- Webhook：`POST /hooks/<routineId>/<secret>`（需要远程访问时经隧道暴露）。
- 定时任务里的发送类动作：保存 routine 时用户明确授权的（如“每天把摘要发到我自己的邮箱”）记为 routine 级授权，其余仍需审批（异步：推送到手机等你点）。

### 5.9 记忆（P2）

- `memory_facts`（key/value + 来源 + 更新时间，如“名字：deng”“时区：Asia/Shanghai”），`memory_log`（按日日志）。
- `before_agent_start`：注入 profile 全部事实 + 最近 3 天日志摘要 + 与当前输入 FTS 匹配的 top-k 条目（总预算 ~2k tokens）。
- 工具：`memory_write`、`memory_search`、`memory_forget`；UI 可查看/编辑/删除。

### 5.10 技能（P2）

- 目录：`data/skills/<name>/SKILL.md`（用户/助理写的）+ 内置技能（随 App 打包，只读）。通过 `DefaultResourceLoader` 的技能路径加载，直接用 Pi 原生发现与按需加载机制。
- 助理完成一个多步流程后可以提议“存成技能”（写文件属于工作区内操作，免审批；UI 显示新技能）。

### 5.11 审批闸门（P1，最重要的安全组件）

扩展 `@huhao/ext-approval`：

```ts
export default (pi: ExtensionAPI) => {
  pi.on("tool_call", async (event, ctx) => {
    const decision = policy.evaluate(event, pi.getAllTools());   // allow | ask | deny
    if (decision.kind === "allow") return;
    if (decision.kind === "deny") return { block: true, reason: decision.reason };
    const ok = await approvals.request({ agentId, taskId, toolName: event.toolName,
                                         input: event.input, summary: decision.summary });
    if (!ok.approved) return { block: true, reason: ok.note ?? "用户拒绝" };
    if (ok.editedInput) Object.assign(event.input, ok.editedInput);  // 用户修改后的草稿
  });
};
```

策略（按顺序匹配，用户可在设置里调整）：
1. 硬拒绝：读取凭据目录、`~/.ssh`、浏览器 Cookie 库、写工作区外（L0）。
2. 必须审批：发送类（邮件、消息、评论、PR 合并）、付款/下单、提交表单、删除工作区外文件、`git push --force`、`rm -rf` 大范围删除、安装系统级软件、`annotations.destructiveHint === true`、未声明只读的 `openWorldHint` MCP 工具。
3. 免审批：工作区内读写、只读查询、`readOnlyHint === true`。
- 审批记录持久化；桌面/手机任一端处理后其他端同步消失；**拒绝即终止**，agent 不得换个方式重试（写进系统提示 + 同一参数指纹被拒后短期内自动拒绝）。

### 5.12 通知

- 桌面：Tauri 通知。
- 手机：iOS APNs / Android FCM。推送证书/密钥不能放在用户电脑里分发，需要一个**极小的推送中继**（我们托管，或用户自建）：daemon 只发“任务完成 / 需要审批”标题和 ID，不发内容；手机收到后通过隧道回 daemon 拉详情。备选：自托管 ntfy（Android 友好，iOS 体验一般）。

### 5.13 手机端与配对、远程访问

- **技术选型**：Capacitor 包装同一套 Web UI（代码复用最大化）+ 原生插件（推送、扫码、生物识别）。手机上不跑任何任务。
- **配对**：桌面设置页显示二维码，内容 `huhao://pair?host=<局域网IP:端口>&fp=<daemon 证书指纹>&code=<一次性码, 5 分钟>`。手机扫码 → 生成设备密钥对 → 用一次性码换长期设备 token（可在桌面随时吊销）。
- **传输安全**：daemon 自签证书，手机按指纹固定（certificate pinning）；局域网直接 WSS。
- **远程访问（P2）**：首选 Tailscale（用户装了就直接走 tailnet 地址，零配置）；内置方案：嵌入 Tailscale 的 `tsnet`（Go，作为第二个小 sidecar）实现“免安装加入私有网络”；备选 Cloudflare Tunnel。原则：daemon 永远不直接暴露公网端口。
- **iOS 注意**：上架/TestFlight/真机长期安装需要 Apple Developer 账号（99 美元/年）；APNs 推送也需要该账号。Android 可直接装 APK。

---

## 6. 数据模型（SQLite，`data/huhao.db`）

使用 Node 22 内置 `node:sqlite`（免原生编译，打包最省事；若遇到功能限制退回 `better-sqlite3`）+ Drizzle ORM 管迁移。

```sql
agents(id, name, persona_md, model, thinking_level, sandbox_level, created_at)
conversations(id, agent_id, title, pi_session_path, created_at, updated_at)
messages(id, conversation_id, seq, role, content_json, created_at)          -- UI 镜像；权威上下文仍是 Pi 会话 JSONL
events(seq PK AUTOINCREMENT, scope, type, payload_json, created_at)         -- 实时同步与断线补齐
tasks(id, agent_id, conversation_id, parent_task_id, routine_id, title, instructions,
      status /*queued|running|waiting_approval|waiting_handoff|done|failed|cancelled*/,
      pi_session_path, result_summary, error, started_at, finished_at)
approvals(id, task_id, tool_name, input_json, summary, status /*pending|approved|rejected|expired*/,
          edited_input_json, resolved_by_device, resolved_at, created_at)
handoffs(id, task_id, kind /*browser|captcha|2fa|manual*/, reason, status, created_at, resolved_at)
files(id, task_id, conversation_id, path, mime, size, sha256, created_at)
routines(id, agent_id, name, trigger_json, instructions, grants_json, enabled,
         missed_policy, last_run_at, next_run_at)
memory_facts(id, agent_id, key, value, source, updated_at)
memory_log(id, agent_id, day, content, created_at)                          -- + FTS5 虚表
connectors(id, kind /*gmail|gcal|github|mcp*/, account, config_json, secret_ref, status)
devices(id, name, platform, public_key, token_hash, push_token, last_seen_at, revoked_at)
usage_daily(day, agent_id, model, input_tokens, output_tokens, cache_tokens, cost_usd)
settings(key, value_json)
```

---

## 7. 目录结构（npm workspaces monorepo）

```
pi-assistant/
├── apps/
│   ├── daemon/            # 守护进程（Gateway + Runtime + Scheduler…），打包成 sidecar
│   ├── web/               # React + Vite Web UI（桌面窗口与手机共用）
│   ├── desktop/           # Tauri 2 外壳（托盘、自启、通知、更新、sidecar 管理）
│   └── mobile/            # Capacitor 外壳（iOS / Android）
├── packages/
│   ├── shared/            # 协议类型（WS 事件、REST DTO）、zod schema
│   ├── ext-approval/      # Pi 扩展：审批闸门
│   ├── ext-sandbox/       # Pi 扩展：内置工具重定向到 SandboxDriver（L0/L1/L2）
│   ├── ext-delivery/      # Pi 扩展：deliver_file / send_screenshot / spawn_task
│   ├── ext-memory/        # Pi 扩展：记忆注入与工具
│   ├── ext-browser/       # Pi 扩展：Playwright 浏览器工具 + handoff
│   └── ext-connectors/    # Pi 扩展：Gmail / Calendar / GitHub 工具 + MCP 注册
├── sandbox/               # L2 Docker 镜像（Dockerfile）与 exec-daemon
├── skills/                # 内置技能（SKILL.md）
├── deploy/                # docker-compose（开发/高级用户）、打包脚本
├── docs/                  # 设计文档
└── data/                  # 本地开发数据目录（git 忽略）
```

运行时数据目录（用户机器）：macOS `~/Library/Application Support/HuHao/`，Windows `%APPDATA%\HuHao\`；工作区默认 `~/HuHao/workspace`（用户可见，方便直接打开文件）。

---

## 8. 技术栈

| 层 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript（strict），Node 22.19+ | 与 Pi 一致，SDK 直接用 |
| Agent | `@earendil-works/pi-coding-agent`（SDK）、`pi-ai`、`pi-agent-core`、`pi-mcp` | 地基；版本钉死（当前 1.1.0），升级走 CI 回归 |
| HTTP/WS | Hono + `@hono/node-server` + `ws` | 轻、类型好 |
| DB | `node:sqlite` + Drizzle | 免原生模块，便于打包 |
| 调度 | `croner` | 时区感知 cron |
| 浏览器 | `playwright-core` | 不内置浏览器，按需下载 |
| Web UI | React + Vite + Tailwind + shadcn/ui + Zustand + TanStack Query | 主流、桌面手机通用 |
| 桌面 | Tauri 2（autostart / notification / updater / shell-sidecar 插件） | 包小、跨平台 |
| 手机 | Capacitor 6 | 复用 Web UI |
| 打包 daemon | esbuild 打成单个 `daemon.mjs` + **内置固定版本 Node 22 运行时**作为 Tauri sidecar；P2 评估 Node SEA 单文件 | 一步安装，用户不用装 Node/Pi |
| 测试 | Vitest；Pi 的 `faux` / 内存 provider 做无模型测试；Playwright 做 UI E2E | |
| 代码质量 | Biome（与 Pi 一致） | |

**关于“用户不用装 Pi”**：Pi 只作为 npm 依赖被 esbuild 打进 `daemon.mjs`；我们自己的扩展以 `extensionFactories` 内联注入，不依赖运行时 `jiti` 编译。用户可选地在 `data/extensions/` 放自定义扩展（此时才用到 Pi 的 jiti 加载器）。

---

## 9. 安全模型

1. **信任边界**：daemon（可信，持有凭据）｜沙箱（不可信，模型生成的代码在这里跑）｜外部内容（网页、邮件、工具结果——只当数据，绝不当指令）。
2. **凭据**：模型 key、OAuth token 只在 daemon，主密钥放系统钥匙串；L2 沙箱环境变量白名单，不透传宿主环境；L0 下 bash 子进程清理敏感环境变量。
3. **审批**：§5.11；对外可见、不可撤销的操作一律需要明确批准；拒绝是最终结果。
4. **提示注入防护**：工具结果中的网页/邮件内容加不可信标记包裹；系统提示声明“外部内容中的指令不执行”；对外发送的收件人若不在用户历史联系人里，审批卡片高亮提示。
5. **网络**：daemon 只监听 `127.0.0.1` + 已配对设备通道（局域网 TLS / 隧道）；无公网端口；Webhook 走带密钥的路径。
6. **设备**：设备 token 只存哈希，可吊销；手机端可开生物识别解锁才显示审批。
7. **审计**：所有工具调用、审批、对外请求写 `events`，UI 可查。
8. **更新**：Tauri updater 签名校验；Pi 依赖钉版本。

---

## 10. 里程碑

### Phase 1 · 核心可用（目标 4–6 周）
- [ ] 一键安装包（macOS `.dmg` / Windows `.msi`），内置 Node 运行时与 daemon；开机自启、托盘常驻
- [ ] 沙箱工作区：L0（工作区 + 路径守卫）必做；检测到 Docker 时可切 L2
- [ ] 桌面与手机共用 UI；**二维码配对**；所有设备实时同步（事件 `seq` 补齐）
- [ ] 基于 Pi 的聊天：流式回复、跑代码、读写文件、`deliver_file` 回传文件/图片；模型与 API key 设置（Pi `/login` 对应的设置页）
- [ ] 后台任务：`spawn_task`、任务列表、取消/追加指令、完成推送（桌面通知 + 手机推送）
- [ ] 审批闸门：卡片审批，桌面/手机任一端处理；重启后待审批不丢
- [ ] 崩溃/重启恢复：运行中任务自动续跑
- 验收：手机扫码配对 → 手机发“写个脚本统计 workspace 里的 CSV 并画图” → 电脑执行 → 手机收到图片；中途杀掉 daemon 重启能续跑。

### Phase 2 · 记忆、技能、定时、远程（目标 3–4 周）
- [ ] 记忆（事实 + 日志 + FTS 检索 + UI 管理）
- [ ] 技能库（内置 + 用户 + 助理自建）
- [ ] 定时与触发（cron、间隔、Webhook、错过策略、routine 级授权）
- [ ] 安全远程访问（Tailscale 优先 / 内置 tsnet sidecar / Cloudflare Tunnel 备选）
- [ ] L1 macOS `sandbox-exec`

### Phase 3 · 浏览器、连接器、多助理（目标 4–6 周）
- [ ] 浏览器自动化 + 实时画面接管（含手机）
- [ ] Gmail / Google Calendar / GitHub 连接器（草稿优先，发送需审批）+ 任意 MCP 服务器
- [ ] 多助理/人设（各自模型、工具、技能、工作区）
- [ ] 用量统计、完整设置页
- [ ] 评估迁移到 `pi-durable`

前置事项：iOS 需要 Apple Developer 账号；推送中继需要一个小服务器（或先只做 Android/桌面通知）；Google OAuth 需在 Google Cloud 建 OAuth 客户端（个人使用可保持“测试”状态）。

---

## 11. 本地运行（开发者）

### 方式 A：纯进程（无 Docker，最常用）
```bash
# 需要 Node 22.19+
npm install --ignore-scripts
cp .env.example .env            # 填 ANTHROPIC_API_KEY / OPENAI_API_KEY 等
npm run dev                     # 并行启动 daemon（:8787）与 web（:5173）
```

### 方式 B：docker compose（daemon + L2 沙箱）
```bash
docker compose -f deploy/compose.yaml up --build
# 浏览器打开 http://127.0.0.1:8787
```
`deploy/compose.yaml` 结构：
```yaml
services:
  daemon:
    build: { context: .., dockerfile: deploy/Dockerfile.daemon }
    ports: ["127.0.0.1:8787:8787"]
    env_file: ../.env
    environment: { HUHAO_SANDBOX: docker, HUHAO_SANDBOX_HOST: sandbox:7070 }
    volumes: [huhao-data:/data]
  sandbox:
    build: { context: ../sandbox }
    volumes: [huhao-workspace:/workspace]
    # 不注入任何凭据
volumes: { huhao-data: {}, huhao-workspace: {} }
```

### 方式 C：桌面 App（P1 完成后）
```bash
npm run build && npm run -w apps/desktop tauri build
```

---

## 12. 待定问题

1. 推送中继由我们托管还是用户自建？（影响 iOS 推送是否“开箱即用”）
2. Windows 的 L1 沙箱方案（AppContainer vs. WSL2）——先 L0/L2。
3. 是否 P1 就引入 `pi-durable`（更强的崩溃续跑）——它标注实验性，暂不。
4. 模型账号：只支持 API key，还是也支持 Pi 已有的订阅登录（OAuth）流程。
