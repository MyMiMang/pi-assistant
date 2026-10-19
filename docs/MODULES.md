# 模块地图（MODULES）

**写代码前先在这里找到对应模块，再用 `rg` 搜关键词。** 能复用就复用，不再写一份同功能实现。
每个目录的顶层文件 / 子目录都必须登记在对应小节里（`npm run check:static` 会检查）；新增文件时在这里加一行。
数据流和组件关系见 [ARCHITECTURE.md](ARCHITECTURE.md)，设计细节见 [design/](design/)，已定的决策见 [decisions/](decisions/)。

## 共用工具清单（必须复用）

| 类别 | 现成的 |
|---|---|
| 前端基础组件 | `apps/web/src/components/ui.tsx`：Button、Modal、Badge、Input、Select（不用原生 select）、Avatar、Help（「?」说明气泡）、Fold（折叠/「高级」区）、ErrorBox、useConfirm、useEscLayer、useHoverTip、fmtSize、fmtTime、errorSummary、cleanLog |
| 模型 / 思考 / Fast 选择 | `ModelPicker.tsx`（输入框那一套，助理模型页、群成员、子代理、默认模型都复用）、`modelMenu.ts`（分组规则）、`ThinkingSlider.tsx` + `thinking-slider.ts`、`ModelOptions.tsx`（模型显示名） |
| 保存与草稿 | `latest-write.ts`（「最后一次为准」串行写入）、`composerDrafts.ts`、`replyDrafts.ts`、`skillDrafts.ts`、`DraftModelSettings.tsx` |
| 自适应标签 / 更多 | `ResponsiveTabs.tsx` |
| 附件与预览 | `Attachments.tsx`（单聊/群聊共用）、`FilePreview.tsx`、`ImageViewer.tsx`；服务端 `files.ts`、`attachments.ts` |
| 下载进度 | 服务端 `downloads.ts` + 界面 `Downloads.tsx` |
| 共享常量 / 纯逻辑 | `packages/shared`：thinking-levels、hard-guard、shell-lex、theme-manifest、品牌名 |
| 服务端通用 | `bus.ts`（推事件）、`requests.ts`（审批与提问唯一入口）、`interject.ts`（插话/停止词）、`model-errors.ts`、`thinking.ts`（拆思考内容）、`native-launch-env.ts`（启动子进程环境）、`config.ts`（环境变量）、`db.ts` |
| Pi 接入（唯一入口） | `pi-adapter/index.ts`、`custom-providers.ts`、`relay-protocols.ts`、`model-limits.ts`、`fast-mode.ts`、`mock-provider.ts`（e2e 脚本化回复） |
| 单测工具 | `packages/server/test/setup.ts`、`in-memory-credentials.ts`、`local-asr-harness.ts`（本地语音假环境 + 来源端口）、`channel-credentials.ts`、`test/fixtures/*`（fake-limactl、fake-wsl、mock-mcp） |
| e2e 工具 | `e2e/fixtures/temp-server.mjs`（makeTempRun / startTempServer / browserEnv / cleanupTempRun）、`stable-shot.mjs`、`artifacts.mjs`、`fake-hindsight.mjs`、`mock-mcp.mjs`、`info-pane.mjs`、`page-checks.mjs`；`e2e/mock-openai.mjs`、`e2e/mock-images.mjs` |

## 每类逻辑放在哪
- HTTP 接口：`packages/server/src/routes/*`（`http.ts` 只做组装和中间件）。
- 调 Pi：只在 `pi-adapter/`；工具（给模型用的）在 `packages/ext-*`，用 Pi 的公开扩展 API。
- 调 Hindsight：只在 `memory/hindsight/`，只用它官方 HTTP 接口和配置项。
- 纯逻辑（无 IO）单独成文件便于单测：如 `rooms/logic.ts`、`desktop/computers.ts`、web 的 `message-body.ts`、`replies.ts`。
- 前端通用组件进 `ui.tsx`；跨端共用常量进 `packages/shared`。

## 改动时要连带改的地方
- Mock 模型（`pi-adapter/mock-provider.ts`）按关键词脚本化回复，e2e 依赖它；群聊脚本 `roomReply`（“派给X”“循环”“慢慢”“加个成员”“组个团队”）。改行为时同步改 e2e。
- 改价格格式要同时改 `model-db.ts` 和 `scripts/gen-model-db.mjs`。
- 内置宠物改动后跑 `python3 scripts/pets/gen-presets.py --preview /tmp/pet-previews`。
- `provider-icons.ts` 由 `node scripts/gen-provider-icons.mjs` 生成。
- 升级 cua-driver 要重新核对 BROWSER.md、WORKFLOW.md 和工具参数格式。

## 仓库顶层 `packages/`、`apps/`

| 路径 | 负责 |
|---|---|
| `server` | 本机服务（Node 22 + Hono），见下节 |
| `shared` | 前后端共用常量和纯逻辑 |
| `ext-approval` | 审批闸门（有后果的工具调用） |
| `ext-sandbox` | 工作区命令 |
| `ext-computer` | 电脑操作（cua） |
| `ext-browser` | 浏览器工具 |
| `ext-connectors` | 邮箱等连接器工具 |
| `ext-delivery` | 发文件 / 提问 / 后台任务 / 子代理派活 |
| `ext-memory` | 记忆工具 |
| `ext-skills` | 技能工具 |
| `ext-routines` | 定时任务工具 |
| `ext-proactive` | 主动性工具 |
| `openclaw-shim` | 微信 ClawBot 官方插件需要的最小 OpenClaw SDK 垫片 |
| `sandbox-desktop` | 助理电脑镜像（Debian + Xfce + noVNC + cua-driver） |
| `wsl-rootfs` | Windows 助理电脑的 WSL2 发行版 |
| `web` | 唯一的界面（React PWA），见下节 |
| `tray` | Tauri 2 桌面程序（托盘、更新、悬浮条、桌宠） |
| `rendezvous` | 可选的 Cloudflare Worker（稳定入口） |

## `packages/server/src`

| 文件 / 目录 | 负责 |
|---|---|
| `main.ts` | 启动入口 |
| `http.ts` | 组装路由、中间件、压缩（具体接口在 `routes/`） |
| `routes/` | 全部 HTTP 接口：agents、channels、common（共用 helper）、desktop、host-control、mcp、memory、models、remote、rooms、routines、skills、system、work-items |
| `bus.ts` | 实时事件总线（WS） |
| `config.ts` | 环境变量（PIA_ 前缀） |
| `db.ts` | SQLite 基础表与轻量迁移 |
| `cli.ts` | 服务器版命令行 |
| `runtime.ts` | 运行时门面：对外导出（调用方只 import 它）、启动接线、启动恢复（bootstrap） |
| `agent-runtime/` | 运行时实现：`rows` 助理/任务表读写，`system-rules` 系统提示，`room-hooks` 群聊挂钩，`bind-session` Pi 事件写成消息，`extensions` 每个会话挂的扩展/工具与 MCP，`skill-suggest` 技能建议，`agent-runtime` 每个对话的会话（发消息/插话/停止/整理），`background-tasks` 后台任务与降权即停，`subagent-driver` 子代理会话 |
| `messages.ts` | 消息落库与引用快照 |
| `conversations.ts` | 一个助理多个对话 |
| `fork.ts` | 从消息另开会话分支 |
| `replies.ts` | 引用回复解析与快照 |
| `interject.ts` | 插话与停止词（唯一实现） |
| `thinking.ts` | 拆出正文里的思考内容 |
| `requests.ts` | 审批与提问（唯一入口） |
| `guard.ts` | 硬性保护路径上下文 |
| `pi-adapter/` | Pi SDK 唯一入口：index（会话/模型）、session-tools（续接对话时补新扩展工具、已加载资源）、custom-providers（自定义中转）、relay-protocols（按模型识别协议与路径）、model-limits、fast-mode、mock-provider、compat.json（兼容基线） |
| `pi-packages.ts` | Pi 扩展包（npm/git/本地） |
| `models.ts` | 统一凭据存储接口 |
| `secrets.ts` | 本地凭据加密存储 |
| `model-registry.ts` | 统一模型服务注册表（只读视图） |
| `model-db.ts` | models.dev 模型参数库 |
| `model-errors.ts` | 判断模型请求失败类型 |
| `model-picks.ts` | 常用模型排序 |
| `model-profile.ts` | 模型擅长标签与打分 |
| `llm-proxy.ts` | 给附属进程（如 Hindsight）用的本机 OpenAI 兼容网关 |
| `local-models.ts` | 本地模型服务运行状态缓存 |
| `managed-weights/` | 模型权重校验 |
| `local-asr/` | 本地语音识别（可选模块，用户显式安装）：目录、下载、运行、流式 |
| `voice/` | 语音识别来源与接口 |
| `memory/` | 记忆：basic（SQLite + FTS）、index（选择后端）、types、`hindsight/`（sidecar 安装启动、provider 账本与同步队列、settings 三模型） |
| `skills.ts` | 技能库（Pi Agent Skills） |
| `skill-assignments.ts` | 每个助理启用哪些技能（唯一事实来源） |
| `skill-scope.ts` | 技能有效选集（唯一实现） |
| `skill-import.ts` | 技能导入 |
| `skill-intel.ts` | 技能提议等智能逻辑 |
| `subagents.ts` | 子代理状态与通知 |
| `subagent-routes.ts` | 子代理接口 |
| `subagent-resume.ts` | 失败分类与续跑：重启安全判定 `sessionResumeSafety`、续跑提示 `RESTART_RESUME_PROMPT` / `verifyResumePrompt`（子代理与后台任务共用） |
| `subagent-supervision.ts` | 子代理事件监督规则 |
| `task-waits.ts` | 任务等待调度 |
| `work-items.ts` | 长期任务入口（只做 re-export） |
| `work-items/` | 长期任务：store（表/摘要/看板分组/boardDigest）、guard（看板分组、重复指纹等纯逻辑）、ports（RoomPort：群聊和任务之间唯一接口）、exec（在负责人自己的会话里执行、提交、重复卡点检测）、watch（停滞检测、上报管理者/用户、等你决定）、actions（新建/核验/改派/暂停/全部暂停等动作）、correction（群里纠正任务的上下文）、tools（管理者/成员/执行会话的 work_* 工具） |
| `proactive.ts` | 主动性引擎 |
| `routines.ts` | 定时与 Webhook 触发 |
| `rooms/` | 群聊：logic（@ 解析、发言规则、只聊不干活检测，纯逻辑）、store（群/成员读写、自主模式字段）、scheduler（排队/调度/停止/恢复）、collab（自主推进、唤醒管理者、定时巡检、成员互相 @）、crud（建群/改群/删群）、proposals（建群/加成员提议）、tools（room_* 工具）、index（入口、群规则、钩子）、copy、model-pick、permissions |
| `channels/` | 渠道：index（入站、镜像、卡片转发）、media、caps、types、飞书/钉钉/企微/ClawBot 各自实现 |
| `mirror.ts` | 助理主动消息选哪些渠道镜像 |
| `wechat.ts` | 个人微信（实验） |
| `email.ts` | 邮箱连接器 |
| `email-oauth.ts` | Gmail OAuth |
| `push.ts` | Web Push |
| `files.ts` | 工作区路径与上传 |
| `attachments.ts` | 附件 → 模型输入 |
| `vision.ts` | 识图能力判定与调用 |
| `vision-ext.ts` | 识图 Pi 扩展 |
| `image-gen/` | 图片生成（providers / routes / extension） |
| `browser.ts` | 助理浏览器上下文 |
| `desktop.ts` | 助理电脑开关机、端口、截图 |
| `desktop/` | backend（后端选择）、computers（谁用哪台，纯逻辑）、lima、wsl、names（容器名保护）、image、image-download、idle、resources、settings |
| `sandbox.ts` | 沙箱驱动（工作区 / Docker） |
| `host-control.ts` | 操作用户电脑（cua-driver） |
| `action-log.ts` | 电脑操作记录 |
| `native-launch-env.ts` | 原生子进程启动环境 |
| `mcp-env-launcher.mjs` | 原生 MCP 启动器 |
| `mcp.ts` | MCP 服务器配置 |
| `mcp-install.ts` | MCP 包预装 |
| `downloads.ts` | 统一下载（断点续传、校验） |
| `cloudflared-bin.ts` | cloudflared 下载与校验 |
| `tunnel.ts` | 远程访问隧道 |
| `named-tunnel.ts` | 固定地址命名隧道 |
| `cloudflare.ts` | 一键部署 Rendezvous |
| `identity.ts` | 服务身份密钥 |
| `auth.ts` | 访问控制与配对 |
| `setup-code.ts` | 服务器版首次设置码 |
| `login-flows.ts` | Pi 登录交互桥接到网页 |
| `onboarding.ts` | 首次向导状态 |
| `housekeeping.ts` | 日志与记录定期清理 |
| `usage/` | 用量、价格、费用 |
| `themes/` | 主题与 AI 设计主题 |
| `pet/` | 桌宠状态、宠物包、孵化 |
| `types/` | 第三方类型声明 |

## `apps/web/src`

| 文件 / 目录 | 负责 |
|---|---|
| `main.tsx` | 入口 |
| `App.tsx` | 应用外壳 |
| `api.ts` | 接口调用与连接管理 |
| `store.ts` | 全局状态（zustand） |
| `types.ts` | 前端类型 |
| `i18n.ts` | 极简多语言 |
| `latest-write.ts` | 「最后一次为准」写入守卫（必须复用） |
| `composer.ts` | 输入栏按钮标签规则 |
| `composerDrafts.ts` | 输入框草稿 |
| `replyDrafts.ts` | 引用草稿 |
| `skillDrafts.ts` | 本次选用技能草稿 |
| `replies.ts` | 引用回复纯逻辑 |
| `replies-api.ts` | 引用回复接口 |
| `fork-api.ts` | 会话分支接口 |
| `message-body.ts` | 助手消息正文显示规则 |
| `modelMenu.ts` | 模型菜单分组 |
| `thinking.ts` | 拆思考内容（与服务端一致） |
| `thinking-slider.ts` | 思考强度滑块纯逻辑 |
| `fast-mode.ts` | Fast 状态文案 |
| `selection.ts` | 助理/对话选择持久化 |
| `layout.ts` | 布局偏好 |
| `viewport.ts` | 手机可视高度 |
| `esc-layer.ts` | Esc 关闭顺序 |
| `externalLinks.ts` | 外链交给系统浏览器 |
| `macosWindow.ts` | macOS 标题栏 |
| `migrate.ts` | 旧存储键迁移 |
| `appearance-migration.ts` | 外观存储迁移 |
| `preview.ts` | 文件预览纯逻辑 |
| `routine-schedule.ts` | 定时计划可编辑识别 |
| `voice-input.ts` | 语音输入纯逻辑 |
| `voice-stream.ts` | 流式语音纯逻辑 |
| `voice-pref.ts` | 本地语音模块状态归一化 |
| `local-asr-api.ts` | 本地语音目录接口 |
| `local-asr-intent.ts` | 本地语音 intent 守卫 |
| `novnc.d.ts` | noVNC 类型 |
| `styles.css` | 全局样式入口 |
| `hooks/` | useVoiceInput、useDefaultVoicePrep、useLocalAsrCatalog |
| `themes/` | 主题 CSS 与注册表（开关、帮助气泡、下载条样式在 `app.css` 末尾） |
| `pet/` | 桌宠页面与孵化 |
| `components/` | 见下节 |

## `apps/web/src/components`

| 文件 | 负责 |
|---|---|
| `ui.tsx` | 通用基础组件（见共用工具清单） |
| `Chat.tsx` | 单聊页与输入框工具栏 |
| `ChatMessages.tsx` | 共用消息展示 |
| `RoomChat.tsx` | 群聊页 |
| `RoomCards.tsx` | 群提议卡片、群目标确认卡（room-goal） |
| `WorkItems.tsx` | 群任务看板（等你决定/卡住/进行中/已完成·已停止、自主推进、全部暂停） |
| `WorkItemDetail.tsx` | 任务详情、新建任务、等你决定回答框 |
| `Sidebar.tsx` | 侧边栏 |
| `Conversations.tsx` | 对话菜单 |
| `CompactDialog.tsx` | 整理上下文弹窗 |
| `ContextRing.tsx` | 上下文圆环 |
| `ModelPicker.tsx` | 模型 + 思考 + Fast 选择（全应用唯一一套） |
| `ModelOptions.tsx` | 模型显示名 |
| `ThinkingSlider.tsx` | 思考强度滑块 |
| `SkillPicker.tsx` | 输入栏技能入口 |
| `VoiceInput.tsx` | 语音输入按钮 |
| `Attachments.tsx` | 附件上传与托盘 |
| `FilePreview.tsx` | 文件预览 |
| `ImageViewer.tsx` | 图片查看器 |
| `Markdown.tsx` | Markdown 渲染 |
| `MessageReply.tsx` | 引用 UI |
| `Cards.tsx` | 审批/提问/任务卡片 |
| `Tasks.tsx` | 任务展示共用件 |
| `Subagents.tsx` | 子代理入口与详情 |
| `InfoPane.tsx` | 助理设置（经典布局，八分类，单聊/群成员共用） |
| `AgentEditor.tsx` | 助理资料编辑 |
| `AgentSkills.tsx` | 助理技能 |
| `AgentExtensions.tsx` | 助理扩展 |
| `AgentComputer.tsx` | 助理单独电脑 |
| `MemoryTab.tsx` | 助理记忆 |
| `RoutinesTab.tsx` | 助理定时任务 |
| `Proactive.tsx` | 主动跟进 |
| `DraftModelSettings.tsx` | 创建/编辑表单的模型草稿 |
| `ResponsiveTabs.tsx` | 自适应标签 + 更多 |
| `Resizer.tsx` | 拖动调栏宽 |
| `Settings.tsx` | 设置导航与各页组装 |
| `ChatSettings.tsx` | 设置 › 聊天与输入 |
| `Models.tsx` | provider 列表、登录、默认模型 |
| `ModelServices.tsx` | 统一模型服务 |
| `CustomProvider.tsx` | 自定义服务表单 |
| `RelayDetail.tsx` | 中转服务详情（单列） |
| `provider-icons.ts` | 自动生成的服务图标（勿手改） |
| `ModelStrengths.tsx` | 模型擅长标签 |
| `ImageModels.tsx` | 图片生成模型 |
| `HindsightSettings.tsx` | 高级记忆设置 |
| `MemoryHealthDot.tsx` | 高级记忆健康角标（正常 / 慢 / 出错） |
| `VoiceSettings.tsx` | 语音配置 |
| `LocalAsrModels.tsx` | 本地语音模型 |
| `DefaultVoicePrep.tsx` | 本地语音识别可选模块卡（安装 / 进度 / 取消 / 设为来源） |
| `DesktopSettings.tsx` | 设置 › 助理电脑 |
| `DesktopView.tsx` | 「电脑」标签画面 |
| `HostControl.tsx` | 操作这台电脑（设置 + 档位） |
| `HostFloatBar.tsx` | 托盘悬浮条 |
| `Channels.tsx` | 渠道设置 |
| `Email.tsx` | 邮箱设置 |
| `ExtensionsTab.tsx` | MCP / Pi 扩展包设置 |
| `SkillsTab.tsx` | 技能库 |
| `Usage.tsx` | 用量 |
| `usage-fmt.ts` | 币种与汇率 |
| `PetSettings.tsx` | 桌宠设置 |
| `ThemeDesigner.tsx` | AI 主题设计 |
| `ThemeImagePicker.tsx` | 主题图片选择 |
| `ThemePreview.tsx` | 主题预览 |
| `Downloads.tsx` | 统一下载状态 |
| `AppUpdate.tsx` | 版本与更新 |
| `Onboarding.tsx` | 首次运行向导 |
| `PairPage.tsx` | 手机配对页 |
| `DeviceApproval.tsx` | 确认新设备配对 |

## `e2e/fixtures`

| 文件 | 负责 |
|---|---|
| `temp-server.mjs` | 临时数据 + Mock 的测试服务（makeTempRun / startTempServer / browserEnv / cleanupTempRun） |
| `stable-shot.mjs` | 稳定截图 |
| `artifacts.mjs` | 截图与日志写 artifacts/ |
| `fake-hindsight.mjs` | 假 Hindsight |
| `page-checks.mjs` | 弹出菜单溢出检查、群聊发言 / 等空闲 / 按成员取消息、等本地语音模型区（openLocalAsrModels）、选本地模型 / 取安装按钮（先选再装与装后两种界面通用：pickLocalAsrModel / localAsrInstallButton） |
| `default-voice-backend.mjs` | default-voice-flow 的可控语音后端（来源视图、本地语音模块状态、窄接口安装 / 取消、目录补丁、流式会话脚本） |
| `safe-memory-server.mjs` | 安全记忆测试服务 |
| `mock-mcp.mjs` | 假 MCP 服务 |
| `info-pane.mjs` | 助理设置面板操作 helper |
| `seed-subagent.mjs` | 预置子代理数据 |
| `native-launch-env.mjs` | 原生启动环境测试 helper |
| `csp-probe.mjs` | CSP 探测 |
| `demo-pi-package` | 示例 Pi 扩展包 |
| `chat-generated-image.png` | 图片查看器测试用的示例图 |
