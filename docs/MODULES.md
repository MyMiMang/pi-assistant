# 模块地图（MODULES）

**写代码前先在这里找到对应模块，再用 `rg` 搜关键词。** 能复用就复用，不再写一份同功能实现。
每个目录的顶层文件 / 子目录都必须登记在对应小节里（`npm run check:static` 会检查）；新增文件时在这里加一行。
数据流和组件关系见 [ARCHITECTURE.md](ARCHITECTURE.md)，设计细节见 [design/](design/)，已定的决策见 [decisions/](decisions/)。

## 共用工具清单（必须复用）

| 类别 | 现成的 |
|---|---|
| 前端基础组件 | `apps/web/src/components/ui.tsx`：Button、Modal、Badge、Input、Select（不用原生 select）、Avatar、Help（「?」说明气泡）、Fold（折叠/「高级」区）、ErrorBox、useConfirm、useEscLayer、useHoverTip、fmtSize、fmtTime、errorSummary、cleanLog |
| 模型 / 思考 / Fast 选择 | `ModelPicker.tsx`（输入框那一套，助理模型页、群成员、子代理、默认模型都复用）、`modelMenu.ts`（分组规则）、`ThinkingSlider.tsx` + `thinking-slider.ts`、`ModelOptions.tsx`（模型显示名） |
| 保存与草稿 | `latest-write.ts`（「最后一次为准」串行写入）、`composerDrafts.ts`、`replyDrafts.ts`、`DraftModelSettings.tsx` |
| 自适应标签 / 更多 | `ResponsiveTabs.tsx` |
| 复制 / 右键菜单 | `clipboard.ts`（copyText：所有「复制」都走它，手机局域网 http 也能复制；selectionBeforeRightClick）、`ContextMenu.tsx`（ContextMenu 小菜单 + 全局右键接管，不用浏览器自带菜单） |
| 附件与预览 | `Attachments.tsx`（单聊/群聊共用）、`FilePreview.tsx`、`ImageViewer.tsx`；服务端 `files.ts`、`attachments.ts` |
| 下载进度 | 服务端 `downloads.ts` + 界面 `Downloads.tsx` |
| 共享常量 / 纯逻辑 | `packages/shared`：thinking-levels、hard-guard、shell-lex、theme-manifest、model-limit-error（额度 / 限流 / 冷却报错→带恢复时间的中文）、品牌名 |
| 服务端通用 | `bus.ts`（推事件）、`requests.ts`（审批与提问唯一入口）、`interject.ts`（插话/停止词）、`model-errors.ts`、`thinking.ts`（拆思考内容）、`native-launch-env.ts`（启动子进程环境）、`config.ts`（环境变量）、`db.ts` |
| Pi 接入（唯一入口） | `pi-adapter/index.ts`、`custom-providers.ts`、`relay-protocols.ts`、`model-limits.ts`、`fast-mode.ts`、`mock-provider.ts`（e2e 脚本化回复）、`mock-room-provider.ts`（群聊部分的 Mock，从 mock-provider.ts 拆出来控制单文件行数）、`mock-collab-provider.ts`（成员直接协作的 Mock：任务要求含「先问一下」「上游有问题」，或看到提问编号时接管）、`mock-chat-plan-provider.ts`（单聊「大事走方案」的 Mock：用户消息含「做个大事」→ chat_plan 两阶段方案卡；用户说「可以」/ 点按钮确认后依次写文件、chat_stage_done ×2、chat_project_done；带「慢」的方案先 sleep 一下留出进行中的窗口；只在有 chat_plan 工具的单聊里接管） |
| 单测工具 | `packages/server/test/setup.ts`、`in-memory-credentials.ts`、`local-asr-harness.ts`（本地语音假环境 + 来源端口）、`channel-credentials.ts`、`test/fixtures/*`（fake-limactl、fake-wsl、mock-mcp、fake-codex：假 codex app-server（JSON-RPC，场景文件 FAKE_CODEX_SCENARIO_FILE 每轮重读；场景含 meta / one-tool / steer / hang / image-tool / server-requests / crash / not-logged-in / e2e-bash；「未登录」用 CODEX_HOME 下的 logged-out 文件表示）、fake-claude：假 claude，按 FAKE_CLAUDE_SCENARIO 出 stream-json 并调工具桥；场景含 meta 回报收到的参数、one-tool / tool-interject / image-tool、stall、resume-missing、think） |
| e2e 工具 | `e2e/fixtures/temp-server.mjs`（makeTempRun / startTempServer / browserEnv / cleanupTempRun）、`stable-shot.mjs`、`artifacts.mjs`、`fake-hindsight.mjs`、`mock-mcp.mjs`、`info-pane.mjs`、`page-checks.mjs`；`e2e/mock-openai.mjs`、`e2e/mock-images.mjs` |

## 每类逻辑放在哪
- HTTP 接口：`packages/server/src/routes/*`（`http.ts` 只做组装和中间件）。
- 调 Pi：只在 `pi-adapter/`；工具（给模型用的）在 `packages/ext-*`，用 Pi 的公开扩展 API。
- 调 Hindsight：只在 `memory/hindsight/`，只用它官方 HTTP 接口和配置项。
- 纯逻辑（无 IO）单独成文件便于单测：如 `rooms/logic.ts`、`desktop/computers.ts`、web 的 `message-body.ts`、`replies.ts`。
- 前端通用组件进 `ui.tsx`；跨端共用常量进 `packages/shared`。

## 改动时要连带改的地方
- Mock 模型（`pi-adapter/mock-provider.ts`）按关键词脚本化回复，e2e 依赖它；群聊脚本 `roomReply`（`mock-room-provider.ts`：“派给X”“循环”“慢慢”“加个成员”“组个团队”“定个目标/立项”→ room_plan、“可以/就这么干”→ room_project_start；`mock-team-provider.ts`：阶段完成通知回进度、目标含「关键点」时第一阶段完成后 room_checkpoint、目标含「交付卡」时全部完成后 room_project_done）。改行为时同步改 e2e。
- 改价格格式要同时改 `model-db.ts` 和 `scripts/gen-model-db.mjs`。
- 内置宠物改动后跑 `python3 scripts/pets/gen-presets.py --preview /tmp/pet-previews`。
- `provider-icons.ts` 由 `node scripts/gen-provider-icons.mjs` 生成。
- 开发实测环境（真实模型）：`npm run dev:live` → `scripts/dev-live.mjs`（数据 `~/.pi-assistant-dev`、端口 8788、`PIA_SECRETS=file` 不碰钥匙串）。
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
| `routes/` | 全部 HTTP 接口：agents、channels、chat-projects（单聊项目：列项目 / 确认 / 先不做 / 停下，写法照 rooms 的项目路由）、common（共用 helper）、desktop、host-control、mcp、memory、models、remote、rooms、routines、skills、system、tool-bridge（Claude Code 工具桥的 MCP 入口，不在 /api 下：只收 127.0.0.1 + 随机令牌）、work-items |
| `bus.ts` | 实时事件总线（WS） |
| `config.ts` | 环境变量（PIA_ 前缀） |
| `db.ts` | SQLite 基础表与轻量迁移 |
| `cli.ts` | 服务器版命令行 |
| `runtime.ts` | 运行时门面：对外导出（调用方只 import 它）、启动接线、启动恢复（bootstrap） |
| `agent-runtime/` | 运行时实现：`rows` 助理/任务表读写，`system-rules` 系统提示，`room-hooks` 群聊挂钩，`bind-session` Pi 事件写成消息，`extensions` 每个会话挂的扩展/工具与 MCP，`skill-suggest` 技能建议，`agent-runtime` 每个对话的会话（发消息/插话/停止/整理），`background-tasks` 后台 / 定时 / 巡检的帮手入口、旧 tasks 表迁移与降权即停，`subagent-driver` 子代理会话，`agent-session` 建助理会话（主会话 / 后台任务 / 子代理共用 `createAgentSession`） |
| `messages.ts` | 消息落库与引用快照 |
| `conversations.ts` | 一个助理多个对话 |
| `fork.ts` | 从消息另开会话分支 |
| `replies.ts` | 引用回复解析与快照 |
| `interject.ts` | 插话与停止词（唯一实现） |
| `thinking.ts` | 拆出正文里的思考内容 |
| `requests.ts` | 审批与提问（唯一入口） |
| `guard.ts` | 硬性保护路径上下文 |
| `pi-adapter/` | Pi SDK 唯一入口：index（会话/模型）、session-tools（续接对话时补新扩展工具、已加载资源）、custom-providers（自定义中转）、relay-protocols（按模型识别协议与路径）、model-limits、fast-mode、mock-provider + mock-room-provider（群聊部分）、mcp-protocol（pi-mcp 协议类型 / 常量转出，给 cli-agents/tool-bridge 用）、compat.json（兼容基线）、`cli-models/`（把本机编程命令行当模型渠道，**三家共用一套骨架**：`channel-core.ts` 的 `createCliChannel(backend, store)` 管 `streamSimple` 入口 / 事件队列 / SegmentBuilder 收尾 / abort / 工具交回 Pi 后同一轮续接 / 对照表续用 / 对不上或续用失败就重开 / 单次请求 / 三个钩子；每家只实现 `CliBackend`：`label`、`composite`（续用指纹）、`launch`（启动并发首条输入，失败抛中文错误）、`resume`（交插话 + 回填工具结果）、`abort`、`step`（原生事件 → `Step`：content / usage / responded / tool_use / finish / fail）、`isResumeFailure`、可选 `release` / `dispose`；`provider.ts` 的 `registerCliProvider`（注册样板，cost 恒 0）、`describeCliError`（报错中文说明）、`CLI_PROVIDER_IDS`（用量不按名字猜价）；`claude-code.ts` / `codex.ts` 各是一份 `CliBackend` + 注册入口；convert 纯逻辑：Pi 内容 ↔ claude / codex 输入 / 历史渲染 / 思考强度映射 / 同一轮续接判断；sync-map 跨轮续用对照表 + 前缀指纹 + 小 JSON 文件；segment 把事件拼成 Pi 的助理消息和事件流；event-queue 事件队列）；方案 docs/design/cli-models.md） |
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
| `skills.ts` | 技能库（Pi Agent Skills）；内置技能在 `packages/server/skills/<名字>/SKILL.md`（只读，要在助理上显式启用；`team-onboarding` 是「全能培训师」模板用的组建团队与入职强化） |
| `skill-assignments.ts` | 每个助理启用哪些技能（唯一事实来源） |
| `skill-scope.ts` | 技能有效选集（唯一实现） |
| `skill-import.ts` | 技能导入 |
| `skill-intel.ts` | 技能提议等智能逻辑 |
| `subagents.ts` | 子代理状态与通知 |
| `subagent-routes.ts` | 子代理接口 |
| `subagent-resume.ts` | 失败分类与续跑：重启安全判定 `sessionResumeSafety`、续跑提示 `RESTART_RESUME_PROMPT` / `verifyResumePrompt`（子代理与后台任务共用） |
| `subagent-supervision.ts` | 子代理事件监督规则与回报文案 `subagentNotifyText` |
| `stuck.ts` | 卡住检测共用规则（没进展 `stallStep` / 反复卡在同一处 `fingerprint`+`repeatLevel` / 只聊不干活 `chatterStep`），群任务、群对话、单聊帮手共用 |
| `subagent-stuck.ts` | 帮手卡住处理：先诊断（慢但在动不打断），真卡住由主会话按阶梯自己解决（带纠正重启 → 换做法 → 失败总结），同一原因第 3 次起拒绝原样续跑；只为批准 / 凭据等找用户 |
| `subagent-models.ts` | 帮手的模型候选池、思考强度与 Fast 设置读写（从 subagents.ts 拆出） |
| `helper-scope.ts` | 群里的帮手：角色范围说明（代表谁、职责、不归它管的角色，下一层继承）、别的成员列帮手只给概况、点名查才给完整过程、群里人人能看的帮手概况、上一层收下一层结果 |
| `subagent-resume-info.ts` | 帮手行 + 能否续跑的摘要（subagent_list / 接口用，从 subagents.ts 拆出） |
| `task-waits.ts` | 任务等待调度 |
| `work-items.ts` | 长期任务入口（只做 re-export） |
| `work-items/` | 长期任务：store（表/摘要/看板分组/boardDigest）、guard（看板分组、重复指纹等纯逻辑）、deps（任务依赖：解析 after/编号或名字、防环 wouldCycle、哪些下游可以自动开始 readyDependents、取消时标受阻的下游）、ports（RoomPort：群聊和任务之间唯一接口）、exec（在负责人自己的会话里执行、提交、重复卡点检测、交接单+文件拼进下游执行提示）、watch（停滞检测、上报管理者/用户、等你决定）、actions（新建/编辑（含 after/stage）/改派/暂停/全部暂停等动作、reopenWorkItem 负责人被点名时可重开自己的任务）、launch（launch 开始一次执行、retryLimitReached、前置核验通过后下游自动开始 advanceDependents / 放行暂缓的 startReleased）、verify（核验：通过 / 退回 / 这条路走不通）、lifecycle（成员移出 / 删群时任务的衔接 onRoomWorkEvent）、rework（resumeWithNote 带着回答接着做、reworkByOwner 负责人重做自己的成果）、upstream（上游重新通过核验后把新版本交给下游：在跑的插话、已完成的叫醒管理者）、correction（群里纠正任务的上下文）、tools（管理者/成员/执行会话的 work_* 工具） |
| `proactive.ts` | 主动性引擎 |
| `routines.ts` | 定时与 Webhook 触发 |
| `chat-projects/` | 单聊也走方案流程（docs/design/group-team.md §13）：store（表 chat_projects，字段和 room_projects 对齐、用 conversation_id；propose / confirm / dismiss / stop / 标阶段完成 / 交付，方案卡沿用 room-plan + conversationId、交付卡沿用 project-delivery）、progress（纯逻辑：已完成阶段名 → 和群聊同形状的 ProjectProgress、findStage、阶段进度文字）、rules（CHAT_PLAN_RULE 大事门槛与流程 + 这个对话里的方案 / 进度，agent-runtime 建单聊会话时拼进系统提示；confirmWakeText 点按钮确认后叫醒助理）、tools（chat_plan / chat_project_start / chat_stage_done / chat_project_done，只挂在用户可见的单聊主会话，免审批） |
| `rooms/` | 群聊：ask-logic（可追踪提问的纯逻辑：askStep / MAX_ASK_ROUNDS / ASK_TIMEOUT_MS / findByName / askIntro）、asks（表 room_asks、asksOfItem 给任务详情）、ask-flow（发问 / 追问 / 回答 / 上游有问题 / 交给管理者 / 超时检查 / 提问回合里用工具回答过就不再把结尾短话发群 dropAnsweredTail）、ask-tools（ask_colleague / answer_colleague / report_upstream / work_rework，任务会话和群会话共用）、logic（@ 解析、发言规则、只聊不干活检测，纯逻辑；INTENT_PLAN_RULE / PROJECT_NEXT_STEP / MANAGER_WAKE_RULE / PROJECT_IDLE_WAKE；交付记忆内容 deliveryMemory、整理要求 TIDY_INSTRUCTIONS）、plan（ProjectPlan 规范化 / 校验 checkPlan（solo = 单聊，分工可不写）/ 渲染 planText、ProjectError，纯逻辑；单聊项目共用）、plan-schema（出方案卡的工具参数 PLAN_FIELDS，room_plan / chat_plan 共用）、file-refs（文件引用解析 resolveFileRefs / findRoomFile，群聊关键点 / 交付卡和单聊交付卡共用）、progress（项目进度清单纯逻辑：projectProgress 按阶段分组 / renderProgress 渲染文字 / projectSig 进展指纹 / projectStallStep 卡住阶梯 / newlyDoneStages 刚完成的阶段 / stageDoneReason 阶段通知原因）、after-delivery（项目交付后：用户原话 + 交付摘要写进管理者记忆、群空闲且没有别的项目时整理成员群会话，整理期间下一轮先等 tidyingOf；决策 0022）、stages（阶段完成通知：任务核验通过后 stageMaybeDone，每阶段只通知一次）、checkpoint（关键点确认：room_checkpoint 复用提问卡，项目表 waiting；用户答复发回群里）、hold-logic（关键点前暂缓的纯逻辑：shouldHold 阶段刚完成且方案有关键点时别的阶段下游暂缓 / splitHeld 放行时分出该开始的）、hold（暂缓的落地：RoomPort.holdForCheckpoint 记 room_projects.held、管理者回合结束 / 服务重启后放行，调 work-items 的 startReleased）、deliver（resolveFiles 在群附件里找、找不到按管理者工作区路径登记（实现在 file-refs.ts），postFiles 发到群里，关键点和交付卡共用）、projects（表 room_projects：propose / confirm / dismiss / stop / resume / finish / replan，项目级卡住计数 checkProjectStall，迁移旧 rooms.autonomy）、store（群/成员读写）、scheduler（调度/停止/恢复；有 active 项目时不按每轮发言次数暂停）、queue（发言队列与状态：RoomState / states / enqueue 去重认领 / 撤回排队）、turn-prompt（群回合给模型的提示：按原因的说明 REASON_LINE、群附件 roomFiles、没看过的群消息转录）、collab（唤醒管理者（暂停中也唤醒）、项目兜底唤醒 idleWake、项目级进度检查、定时巡检、成员互相 @）、crud（建群/改群/删群）、proposals（建群/加成员提议）、tools（room_assign 含附件交给负责人 findRoomFile / handOverFiles、room_propose_member）、project-tools（room_plan / room_project_start / room_project_resume / room_project_replan / room_checkpoint / room_project_done 发交付卡）、index（入口、群规则、钩子）、copy、model-pick、permissions |
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
| `cli-channel-service.ts` + `cli-services.ts` + `routes/models.ts` 里的 `/api/models/<渠道名>`（`/recheck`） | 本机命令行模型渠道的**通用服务**：`createCliChannelService(adapter)` 管启动注册（找得到命令才注册，codex 还要已登录；Mock/单测默认关，`PIA_CLAUDE_COMMAND` / `PIA_CODEX_COMMAND` 指定或置空）、检测与重新检测（装好后就地注册、已注册则刷新模型列表）、关闭时 disposeAll；`cli-services.ts` 是适配表（每家一份 `CliChannelAdapter`：find / detect / register / refresh / requireLogin / extra），models.ts、main.ts、路由都遍历 `cliServices`；加新的一家 = 在适配表加一项。界面卡片 `apps/web/src/components/CliAgentCard.tsx`（claude-code / codex 共用，`KINDS` 放每家文案，挂在 ModelServices 里）；e2e `e2e/claude-code-ui.mjs`、`e2e/codex-ui.mjs`（独立脚本，`node e2e/<名>.mjs`，不在 run.mjs 的步骤里），单测 `test/claude-code-service-http.test.ts`、`test/codex-service-http.test.ts` |
| `cli-agents/` | 把本机已登录的编程命令行（claude、codex）当模型用的底层，与 Pi 无关（docs/design/cli-models.md）：launch（拼 claude 参数和白名单环境，复用 native-launch-env）、events（stream-json 一行 → 简单事件，用量取法见 §4.3）、tool-bridge（最小 MCP 服务：每次运行一个随机令牌，tools/call 按 toolUseId 挂起、外部回填，取消 / 结束时全部取消）、claude-process（ClaudeRun：起进程、读事件、写 stdin 插话、回填工具结果、abort）、detect（找 claude / codex、版本、`claude auth status` / `codex login status` 只看退出码，不读凭证）、launch 里的 `buildCliEnv`（白名单环境，claude / codex 共用）；codex：codex-launch（`codex app-server` 的 `--disable` / `-c` 参数 + MCP 逐个按名字关 + 环境）、codex-events（通知 / 服务端请求 → 事件，和 claude 同形；审批一律拒绝、提问回不可用）、codex-client（JSON-RPC over stdio）、codex-hub（全局唯一 app-server：按需起、空闲 10 分钟退、崩溃下次重启、起前用 `config/read` 取用户 MCP 名字、`model/list`）；Pi 渠道在 `pi-adapter/cli-models/` |
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
| `slowStep.ts` | 一步跑太久时的提示文字（可能在等系统权限弹窗） |
| `member-status.ts` | 助理工作状态纯逻辑（群成员条和单聊顶部共用）：`memberActivity` 群成员（等你 > 在群里说话 > 帮手做任务 > 排队 > 空闲）、`agentActivity` 单聊、`roomSummary` 群总状态（几人在干活 / 有人等你 / 都停下了）、`pendingCardOf` 没处理的审批 / 提问卡 |
| `composerDrafts.ts` | 输入框草稿 |
| `replyDrafts.ts` | 引用草稿 |
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
| `clipboard.ts` | 复制文字（带非安全上下文兜底）、右键前的选区 |
| `macosWindow.ts` | macOS 标题栏 |
| `desktopChrome.ts` | Windows / Linux 桌面：所有滚动区域统一细滚动条（.pa-classic-sb）、窗口标题栏跟 App 明暗走（set_theme） |
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
| `RoomCards.tsx` | 群提议卡片、方案卡 `RoomPlanCard`（room-plan：就这么干 / 先不做；带 conversationId 的是单聊方案卡，按钮走单聊接口）、方案正文 `PlanBody`（方案卡和项目面板共用）、项目状态文字 `PROJECT_STATUS`、旧版群目标确认卡（room-goal，新的不再产生，历史卡片只读显示目标和完成标准，没有输入框和按钮） |
| `ChatProjects.tsx` | 单聊顶部的项目入口 `ChatProjectsButton`：取 /api/conversations/:cid/projects，复用 `RoomWork` 的 `ProjectsPanel`（solo）；消息一变就重新取（只认最后一次请求），不另开推送事件 |
| `RoomDelivery.tsx` | 交付卡 `ProjectDeliveryCard`（群消息 meta.kind=project-delivery）：做成了什么 / 交付的文件（复用 `Attachments` 预览下载）/ 怎么用 / 还没做的；长文字超 6 行折叠；不显示花费 |
| `RoomProjectFilter.tsx` | 群里 ≥2 个进行中项目时的「按项目看」：顶部筛选 `ProjectFilter`（复用 `Select`，按群记在 localStorage）、`useProjectRows` / `filterByProject`（只留该项目消息 + 用户自己的消息）、`ProjectTagged`（气泡上的项目名小标签） |
| `RoomPeer.tsx` | 成员之间的提问 / 回答（群消息 peer-ask / peer-answer）：`PeerWrap` 加「提问 / 回答 · 第 n 轮」标签、「问 @对方」、回答回指提问（点了跳过去，复用 `.pa-quoted`）；`WorkAsks`：任务详情的「在等同事回答」 |
| `MemberStatus.tsx` | 工作状态显示：`RoomMembers` 群顶部成员条（最左总状态 + 每个成员状态圆点和在做什么）、`AgentStatusLine` 单聊顶部名字下那行、`ActDot` 状态圆点；规则在 `member-status.ts`，帮手列表用 `Subagents.tsx` 的 `useHelperBriefs`（和「执行」入口共用同一个轮询） |
| `WorkItems.tsx` | 群任务看板（等你决定/卡住/进行中/已完成·已停止、全部暂停）、任务提交卡 |
| `RoomWork.tsx` | 群聊顶部干活入口 `RoomWorkButtons`（任务看板 + 项目筛选 + 项目）；项目有 waiting 时 chip 标「等你看一眼」、面板里 `WaitingBlock` 显示关键点；`ProjectsPanel`：待确认 / 进行中项目的 chip + 面板（看方案、停下项目、展开已结束的项目），群聊 `ProjectsButton` 和单聊 `ChatProjectsButton` 共用（solo = 单聊：说话对象是「我」，没有关键点等待 / 任务清单 / 接着做） |
| `WorkItemDetail.tsx` | 任务详情、新建任务、等你决定回答框 |
| `Sidebar.tsx` | 侧边栏 |
| `Conversations.tsx` | 对话菜单 |
| `CompactDialog.tsx` | 整理上下文弹窗 |
| `ContextRing.tsx` | 上下文圆环 |
| `ModelPicker.tsx` | 模型 + 思考 + Fast 选择（全应用唯一一套） |
| `ModelOptions.tsx` | 模型显示名 |
| `ThinkingSlider.tsx` | 思考强度滑块 |
| `VoiceInput.tsx` | 语音输入按钮 |
| `Attachments.tsx` | 附件上传与托盘 |
| `FilePreview.tsx` | 文件预览 |
| `MediaPlayer.tsx` | 视频 / 音频播放器（聊天附件 + 文件预览共用，签名播放链接） |
| `ImageViewer.tsx` | 图片查看器 |
| `Markdown.tsx` | Markdown 渲染 |
| `MessageReply.tsx` | 引用 / 复制按钮与消息右键菜单 |
| `JumpToLatest.tsx` | 单聊 / 群聊「回到最新」圆按钮（翻上去超过一屏出现，带新消息数） |
| `ContextMenu.tsx` | 通用右键小菜单 + 应用级右键接管（选了字给复制、链接给复制链接，输入框 / 图片保留系统菜单） |
| `Cards.tsx` | 审批/提问/任务卡片 |
| `Tasks.tsx` | 任务展示共用件 |
| `Subagents.tsx` | 子代理入口与详情 |
| `InfoPane.tsx` | 助理设置（经典布局，八分类，单聊/群成员共用） |
| `AgentEditor.tsx` | 助理资料编辑；新建助理的模板 `PRESETS`（模板可带 `skills`，新建时一并启用，如全能培训师 → `builtin/team-onboarding`） |
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
| `CliAgentCard.tsx` | 本机命令行模型卡片（Claude Code / Codex 共用；`KINDS` 放每家文案，`CliAgentCards` 渲染全部，`CLI_KINDS` 供模型服务页过滤） |
| `ClaudeCodeCard.tsx` | 模型服务页的「Claude Code（本机）」卡片：检测状态、重新检测、登录提示 |
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
| `HostControl.tsx` | 操作这台电脑（设置 + 档位）；输入栏「权限」按钮 `HostTierButton`（复用助理档位那块内容） |
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
| `temp-server.mjs` | 临时数据 + Mock 的测试服务（makeTempRun / startTempServer / browserEnv / cleanupTempRun；服务进程不继承 *_API_KEY / *_TOKEN / ANTHROPIC_* 等真实服务商凭据环境变量） |
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
