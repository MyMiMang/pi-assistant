# 交接文档（HANDOFF）

> 当前公开版本 **v0.1.0-beta.21**（已公开 Latest）；上一版 v0.1.0-beta.20。本轮仅 macOS arm64，已构建、Mac 安装冒烟与更新资产校验通过并公开 Latest。接手前先读根目录 [AGENTS.md](../AGENTS.md)（规则和流程），再读本页（进度），然后看 [ARCHITECTURE.md](ARCHITECTURE.md)（组件）和 [DESIGN.md](DESIGN.md)（完整设计，下面写的 § 是它的章节号）。

## 1. 这是什么

Pi Assistant 是基于 [Pi](https://github.com/earendil-works/pi) SDK 的本地私人助理，由这几部分组成：
- 本机服务 `packages/server`（Node 22）
- 唯一的界面 `apps/web`（React PWA，电脑和手机共用）
- 桌面程序 `apps/tray`（Tauri 2：托盘、自动更新、悬浮条、桌宠，内置 Node 和服务端）
- Linux 服务器版

手机通过内置的 Cloudflare 隧道远程使用。界面文字是中文。用户只通过安装包的自动更新来测试。

## 2. 进度（按版本）

2026-10-22 助理电脑资源可配 + 空闲关机实测（`vm-resource-settings` 树，分支 `vm-resource-settings`，基线 `next-release-integration` = `13e717b`，**未 push / 未 tag，待负责人合入**）：
- **用户自定义虚拟机资源**（macOS Lima）：新增 `packages/server/src/desktop/resources.ts`（建议值 / 可调范围 / 整数校验 / `mergeInstanceResources` 关机后合并 / `checkDiskGrowOnly`）。`settings.ts` 的 `desktop.resources`（`{cpus?,memoryGiB?,diskGiB?}`，默认空）；`lima.ts` 的 `instanceResources()` 读现有实例、`configForInstance()` 写配置时用户选择 > 现有值 > 建议值、磁盘只扩不缩；`http.ts` 的 `/api/desktop` 返回 `resources{supported,choice,suggested,bounds,applied,note}`、PUT 拒绝缩小磁盘并以 400 拒非法值。只 macOS Lima 可调，Docker / WSL2 界面明示不可调。**未动真实虚拟机 / 用户设置 / 凭据。**
- **空闲自动关机实测**：`startIdleWatcher` 改为依赖可注入（`now/tracker/running/stop/release/engineRunning/stopEngine/fixedPorts/settings`），新增 `test/desktop-idle-watcher.test.ts`（假时钟 + 假后端）：10 分钟整点关、差 1 秒不关、busy 阻关且结束后重计时、有人在看画面阻关且关掉后重计时、服务重启（新 tracker）不立即关、虚拟机空转 10 分钟关、设为从不永不关。根因：touch 来自启动 / 状态查询 / 电脑工具 `log`/`before`（`touchAgent`）与 noVNC `viewerOpen/Close`；busy = 对话回合 / 后台任务 / 子代理在跑；休眠唤醒后 `Date.now()` 跳变会让首个 tick 立即判空闲（符合“整机空闲”语义）。
- **设置 UI**：`apps/web/src/components/ui.tsx` 新增 `Select`（按钮 + portal 弹出列表，`role=listbox`，Esc 关、上下键选、窄屏不溢出）；`DesktopSettings.tsx` 空闲时间与 CPU / 内存 / 磁盘全部换掉原生 `<select>`，新增资源区（显示当前虚拟机值与“有改动，关机后生效”）。`e2e/run.mjs` 的 `desktop-idle` 从 `selectOption` 改为点击按钮 + 选项。
- 验证：服务端 `tsc --noEmit -p packages/server` exit 0；`tsc --noEmit -p apps/web` exit 0；定向单测 `desktop-runtime` + `desktop-idle-watcher` + `desktop-lima` + `desktop-image-download` + `desktop-wsl*` 共 49 项（44 通过 5 跳过）0 失败。**未做**：真实 VM 资源调整 / 全量 e2e / web 生产构建（本工作树 symlink/hardlink node_modules 下 brand 插件 `closeBundle` 报 `dist/manifest.webmanifest` 缺失，属环境问题，`tsc` 与 2491 模块 transform 均通过）；磁盘实际已用与上限的差异只在 UI 文案说明，未读稀疏文件实际占用。详见 `progress-snapshots/vm-resource-settings.md`。

2026-10-22 token 效率与主动能力（`proactive-efficiency` 树，分支 `proactive-efficiency`，基线 `origin/main` = `5b6cf11`，**未 push / 未 tag，待负责人 cherry-pick 合入**）：修子代理终态双唤醒（`task_wait` 与自动 notify 跨机制只唤醒一次，复用 `task_waits` 持久投递状态，取消/彻底失败时 notify 补位，不丢不重）、`resumed` 只更新卡片、notify 只带短标题 + 结果摘要（全文 `subagent_list` 按需查）；主动巡检改变化驱动（bus 信号 + 已有跟进/定时，无变化零模型空巡，未闭环事项低频有界兜底最低 4 小时，提示只带差量）、`proactive_surface` 支持相关对话、新增心跳专用 `proactive_advance`（在相关对话主会话按正常权限推进；心跳不给额外权限）。实测：`subagents` 22/22、`task-waits` 38/38、`proactive` 16/16、新增 `proactive-signal` 1/1（真实 Pi + mock：无变化零模型、一次信号恰好一次回合）；服务端 typecheck 0。未跑全量 e2e；识图/图片生成用量未补（公开接口未暴露 usage）；记忆缓存/截图未实测不盲改。详见 `progress-snapshots/proactive-efficiency-state.md`。

2026-10-21 beta.21 已公开 Latest：https://github.com/MyMiMang/pi-assistant/releases/tag/v0.1.0-beta.21 。Actions https://github.com/MyMiMang/pi-assistant/actions/runs/38621370349 成功：prepare、唯一 macOS-arm64 build（5m50s）、mac-smoke、publish；linux / windows-smoke skipped，Intel 未入矩阵。tag 与提交固定 `9215c83`（先 fetch 确认远端 main 仍在 `a48e27f`，快进 push，未 force、未移动 tag）。公开四项资产：latest.json、`Pi.Assistant_0.1.0-beta.21_aarch64.dmg`、`Pi.Assistant_aarch64.app.tar.gz`、`....sig`；独立核验 `latest.json` version=0.1.0-beta.21、notes 非空、仅 darwin-aarch64 / darwin-aarch64-app、签名非空、URL 正式下载地址。未安装/替换用户 App。

beta.21 内容：子代理模型改为每个助理的候选池（全局只留并发/最长运行，助理设置可搜索/按服务分组/多选；派活在池内按能力挑，可恢复模型故障只在池内有限 fallback 并从已保存会话续跑，每候选最多一次，用尽即停；工具失败/权限拒绝/未知错误/用户停止都不换、不用池外模型；旧设置幂等迁移）；任务等待 `task_wait`（程序等待、去重唤醒、取消连带、投递失败有限重试与重启补投，不承诺 exactly-once）；自定义服务推理档位认得出的补回 xhigh/max。保留 beta.18 完全权限应用层免审批。整合树 `integration-beta21`；唯一代码冲突在 `runtime.ts` 顶部 import（取两边），并修复复核发现的初始化失败候选未并入 `tried`（新增单测守护），跨重启 `tried` 不落库边界写准 DESIGN §21.5。验证：两端 typecheck、定向单测 62/62、web+rendezvous 构建、真实 Mock fallback 冒烟、e2e model-ui 六组与 subagents 全过。

- beta.21 候选（未发布）主会话复核：投递索引移至旧等待表补列后创建，避免升级启动失败；使用旧表结构启动的回归用例与等待/真实 Pi mock 会话测试共 21/21 通过。等待为合作式结束，mock 已验证 settle 后等待期不增加模型步骤，不承诺任意模型强制停止。

2026-10-22 **next-release 整合树 `next-release-integration`（beta.22 候选，基线 `origin/main` = `5b6cf11`）**：把 beta.21 之后的几条 WIP 合到一条线上。
- **设置 › 模型 的品牌图标**：内置服务改用**真实品牌 logo**（`apps/web/src/components/provider-icons.ts`，由 `scripts/gen-provider-icons.mjs` 从 `@lobehub/icons-static-svg` 1.95.1（MIT，无依赖）只提取用到的 40 个服务生成，编译进网页、不联网下载）；自定义渠道和图标库未收录的品牌（Radius、TypeSafe、Mock）仍用「名称首字母 + 稳定配色」字母头像；`ProviderAvatar` 加 `data-provider-icon-kind`（brand / letter）。根 `devDependencies` 新增 `@lobehub/icons-static-svg`，许可记进 `THIRD_PARTY_NOTICES.md`。同一品牌的多个渠道共用一张 logo（OpenAI/OpenAI Codex、Moonshot AI/CN、Xiaomi 的 token plan、MiniMax/CN、Qwen 三个、ZAI/CN、Cloudflare 两个）。Onboarding 的 `ProviderList` 也带上同一图标。
- **合并来源**：`model-settings-preview` 的 `57b9ad6`（大分类 `Fold`）+ 图标卡片网格工作区改动；`fast-computer-model` / `fast-computer-model-review` 的 `055ed8a` → `2a287eb` → `93570c5`（默认关闭的快速操作模型；G1–G4 + G3 核验修正）。唯一冲突在 `apps/web/src/components/Settings.tsx` 的 `ModelsTab` 开头（`Fold` 与 `<FastComputerSection />` + 原 `<section>` 撞在一起），取「`<FastComputerSection />` 在前、`Fold` 包住原来那整段」。
- **原生 Jev 仍 BLOCKED**：G4 只是 fail-closed（移除全局 env key fallback、UI 移除 SystemOne 配置并注明接入待完成）；项目里没有已允许的 public auth 抽象，**不读/不绕过凭据、不从 env 发 host、不把 Key 明文存 settings**，所以原生 SystemOne 本轮只能 fail-closed，**不可宣称 Jev 已完成**；click 原型也**未做性能实测**。
- 验证（全 Mock，无真实 Key / 模型费用，未动用户 App / 浏览器；Node 用 `/opt/homebrew/opt/node@24/bin/node`）：`tsc --noEmit -p apps/web` exit 0；`npm run build -w @pi-assistant/web` exit 0；`node e2e/model-ui.mjs` 六组全过（第 5 组断言改为：每张卡都有图标、内置服务 ≥80% 有品牌图标（`data-provider-icon-kind=brand`）、图标不能全一样（同品牌多渠共用一张 logo，故不再要求 100% 唯一）、自定义渠道 6 个字母头像互不相同、390 单列不溢出）；截图 `evidence/model-ui/{06-settings-accordion,10-services-expanded,11-services-collapsed,12-services-collapsed-390,13-services-expanded-390,20-icons-0,20-icons-14,20-icons-28,20-icons-38}.png`（已逐张识图核对：OpenAI/Anthropic/Google/DeepSeek/AWS/GitHub Copilot/Meta/NVIDIA/Vercel/xAI/Xiaomi MiMo 等品牌 logo 正常，无空白/变形/缺图）。
- 未完成：`e2e/run.mjs` 全量与安装包真机未跑。进度见 `progress-snapshots/next-release-state.md`。

2026-10-22 **CUA 0.34.1 → 0.35.4 适配（beta.22 候选，同一整合树）**。背景：0.35.0 是 breaking change（`get_window_state` 默认不再回 `elements`），并新增批量动作 `run_steps` 与脚本 `run_script`；原实现的 `tool_call` 闸门只按外层工具名判权限，批量/脚本会绕过 guard。
- `third-party.json` 钉 `cua-driver 0.35.4` + 官方 `SHA256SUMS` 的五个平台哈希（darwin 资产已**实下校验一致**、解包后 `cua-driver --version` = 0.35.4、`list-tools` 列出 60 个工具）。
- `packages/ext-computer/src/index.ts`：新增 `expandComputerSteps`，把 `run_steps`/`run_actions` 展开成每一步（支持 `{tool,args}` 与官方简写 `{click:{…}}`；纯检查步骤算只读；认不出的步骤标 `__unknown__` 整批拦下），逐层套 `guardComputer` / `isSensitiveAction` / `browserFileViolation` / “只看”档位 / `host.before`；受保护操作在批量里同样单独弹审批、不提供“本任务内都允许”。`run_script` 列入 `HIDDEN_TOOLS`，并在 MCP 服务 env 设 `CUA_DRIVER_DISABLE_RUN_SCRIPT=1`（driver 侧也不列入 tools/list，双保险）。`INPUT_TOOLS` 按 0.35.4 **真实工具表**更新（补 `set_agent_cursor_*`、`run_steps`，去掉 0.35.4 已不存在的 `mouse_*`）。`hostDesktopPrompt` 按真实 schema 改写（`tree_format:"elements"` / `full_output:true` / `since:"latest"` / `run_steps` 批量 / `run_script` 已关）。
- 新增 `packages/server/test/computer-batch.test.ts`（4 项：展开逻辑、run_script 拦、批量藏受保护快捷键要单独批准、危险点击/只看/浏览器/完全权限）；`host-control.test.ts` 断言按 0.35.4 更新。**镜像已重建并核验**：`.github/workflows/desktop-image.yml` run [38683611869](https://github.com/MyMiMang/pi-assistant/actions/runs/38683611869)（workflow_dispatch，`--ref desktop-cua035`，version `0.1.4`）conclusion **success**——`build`（docker buildx `linux/amd64,linux/arm64` 推 GHCR + amd64 noVNC / cua-driver 冒烟）与 `nerdctl-smoke (ubuntu-24.04-arm)`、`nerdctl-smoke (ubuntu-latest)` 三个 job 全部成功，各 job 引用真实 manifest digest `sha256:6cc5c119…d54a42`；匿名 GHCR manifest（tag `0.1.4`）交叉核验 digest 一致，新 digest 已写回 `desktop-image.json`（version `0.1.4`）。**未做的验证**：需 Docker 的 `computer.smoke.ts`（本轮不跑）、安装包真机、在用户 Mac 上安装后开机（镜像仅经托管 CI 冒烟）。

2026-10-22 **合入 token 去重与主动能力（`bf26b0e`）并修对话隔离**（beta.22 候选，同一整合树）。
- 子代理终态跨机制去重：`task-waits.subagentWakeOwner` 按持久投递状态判 owner，`subagents.deliverSubagentEvents` 让位 / 收尾 / 补位；notify 文案只带短标题（任务 60 字）+ 结果摘要（300 字）+ 产出文件，完整内容用 `subagent_list` 查。主动巡检改变化驱动（`proactive_signals` + `recordSignal`，无变化不唤醒、兜底 ≥4h），支持 `proactive_advance` 在相关对话里推进（对话归属校验、忙时同一件事合并 / 不同事每对话排队 ≤3、队满进收件箱）。
- **修复（独立复核发现）**：`subagentWakeOwner` 原来只按 `target_ref + agent_id` 判 owner，别的对话（或无对话）登记的同目标等待会被当 owner，**吞掉子代理所属对话的 notify**。已把 signature 改为 `(subagentId, agentId, conversationId)`，SQL 两边 `COALESCE(conversation_id,'')` 比较，调用传 `r.conversation_id`；新增跨对话隔离回归（别的对话/无对话的等待不算 owner → notify 照常补位；同对话才让位；等待送达后只收尾）。`subagents.test.ts` 23/23、`task-waits`+`proactive`+`proactive-signal`+`task-wait-yield` 38/38、服务端 tsc exit 0。
- **已知限制（不掩盖）**：① 跨机制去重是 check-then-act（无跨机制锁），若 `task_wait` 在 owner 判定之后才登记/触发，notify 与等待可能各唤醒一次 → **不承诺 exactly-once**；② 识图 `describeImages` / 图片生成用量**未补齐**（`models.complete` 公开返回的 `usage` 只有 `{input,output}`，本轮报告未做，不虚构）；③ 记忆块缓存抖动、工具截图累积**未实测未改**（依赖 SDK 行为）。

2026-10-21 设置 › 模型：把「模型服务 / 渠道」改成一个大分类折叠（**未发布，beta.22 候选**；预览树 `model-settings-preview`，分支 `model-settings-preview`，基线 `origin/main` = `5b6cf11`，**未 push / 未 tag / 未打包**）。用户纠正：『之前那个图标的…搞一个大的分类折叠…模型添加它是一个大的分类，可以直接关上…现在没有那种直接全部关上的…改回之前那样子…一个大的分类，做完先我看一下』。改动：`apps/web/src/components/ui.tsx` 新增通用 `Fold`（展开箭头 + 图标 + 标题 + 数量徽标 + 可选提示/「?」说明；收起时 children 完全不渲染）；`apps/web/src/components/Settings.tsx` 的 `ModelsTab` 用 `Fold` 包住原来那整段 `模型服务 / 渠道`（添加渠道按钮 + 搜索 + 内置服务 + 我的渠道 + 每个服务的折叠行），标题行显示 `48` 个服务与「已配置 6」；`ProviderAccordion` 与每个 provider 的折叠行为原样保留。顶部「默认使用」「识图模型」两张卡仍在 `Fold` 外、始终可见；子代理仍是每个助理的候选池（本树未动），未恢复旧全局子代理模型设置。**默认展开**（不改变现有可见性，只增加“一键全部关上”）；要默认收起改 `servicesOpen` 初值一行。实际验证（全 Mock，无真实 Key / 模型费用，未动用户 App / 浏览器）：两端 `npm run typecheck` exit 0；`npm run build -w @pi-assistant/web`（tsc + vite）exit 0；`node e2e/model-ui.mjs` 六组全过（新增第 5 组内的父级折叠断言：收起后 `provider-accordion` / `provider-row` / `provider-group-builtin` / `provider-group-mine` 计数均为 0，默认使用 / 识图模型计数仍为 1；390 收起不横向溢出），截图 `evidence/model-ui/10-services-expanded.png`、`11-services-collapsed.png`、`12-services-collapsed-390.png`、`13-services-expanded-390.png`。未跑：服务端全量单测（未改服务端）、安装包真机。

2026-10-21 设置 › 模型：服务列表改为带图标的卡片网格（**未发布，beta.22 候选**；同一预览树 `model-settings-preview`，基线 `5b6cf11`，**未 push / 未 tag / 未打包**）。用户看上面预览截图后纠正：『之前这个我记得是图标的』。核实 git 历史：`ProviderAccordion`（一行行折叠）是 beta.20（`07b3723`）引入的；beta.19 及之前 `设置 › 模型 › 模型服务` 用的是 `ProviderList`——**两列卡片网格**，但卡片只有名称 + ✓ + 徽章 + 模型数，**从未有过每个服务专属的品牌图标**，仓库里也没有任何 provider logo 资源。所以「改回之前」按卡片网格恢复，图标用「名称首字母 + 稳定配色」字母头像 fallback（不联网下载、不伪造品牌图）。改动 `apps/web/src/components/Models.tsx`：新增 `providerName` / `providerInitials` / `AVATAR_TONES` / `ProviderAvatar`（testid `provider-icon`、`data-provider-icon`）；`ProviderAccordion` 每组改用 `grid grid-cols-1 gap-2 sm:grid-cols-2`（testid `provider-grid-{builtin,mine}`）；`ProviderRow` 改成卡片（图标 + 名称 + 状态徽章 + 模型数，展开时 `sm:col-span-2` 显示模型列表 + 登录 / 编辑配置），徽章不在展开区重复。`provider-accordion` / `provider-row` / `provider-toggle-*` / `provider-models-*` / `provider-edit-*` / `provider-group-*` 等 testid 与添加/编辑/应用/确认删除、默认使用、识图模型、子代理每助理候选池全部不变。图标区分度：多词取首尾词首字母、单 ASCII 词取前两字母、中文名取首字 + 末尾字母数字；实测内置 42 个服务 38 种图标（仅 MiniMax/Mistral、MiniMax CN/Moonshot AI CN、OpenAI/OpenRouter、xAI/Xiaomi Token Plan AMS 同字母，再用颜色区分），`渠道1…6` → `渠1…渠6` 全不同。验证（全 Mock，无真实 Key / 模型费用，未动用户 App / 浏览器；本机 Homebrew Node 缺 dylib，改用 `Pi Assistant.app` 内置 Node v22.23.3）：`tsc --noEmit -p apps/web` exit 0；vite build exit 0；`node e2e/model-ui.mjs` 六组全过（新增第 5 组断言：桌面 `provider-grid-builtin` 多列、每张卡都有图标、我的渠道 6 个图标互不相同、内置服务图标 ≥80% 互不相同、390 单列且不横向溢出）；`node e2e/custom-provider-delete.mjs` 通过（卡片展开 → 编辑 → 取消/失败/重试删除链路不变）。截图 `evidence/model-ui/{06-settings-accordion,10-services-expanded,11-services-collapsed,12-services-collapsed-390,13-services-expanded-390}.png`（已逐张识图核对）。未跑：`e2e/run.mjs` 全量（该脚本「首次运行向导」仍在等 beta.20 已下线的「设为默认模型」按钮，属本树既有陈旧断点，与本改动无关；模型卡片/能力/删除链路已由 `model-ui.mjs` 覆盖）、服务端全量单测（未改服务端）、安装包真机。

2026-10-15 beta.20 已公开 Latest：https://github.com/MyMiMang/pi-assistant/releases/tag/v0.1.0-beta.20 。Actions https://github.com/MyMiMang/pi-assistant/actions/runs/38612956619 全部成功（arm64 build、mac-smoke、publish；Windows/Linux skipped，Intel 未入矩阵）。tag 固定 `07b3723`；公开四项资产 DMG、更新包、签名、latest.json，独立核验版本/中文 notes/正式下载地址，仅 darwin-aarch64 与 darwin-aarch64-app。未安装用户 App。

beta.20 整合内容：模型菜单合并思考强度、按渠道折叠/搜索、常用五项持久化；任务展示共用短标题与状态，移除顶部子代理 tabs 和聊天大指令卡，完整指令在详情保留；附件 72px 缩略图复用全屏查看器，步骤汇总正确区分失败与仍在运行；定时任务新增每天时分/工作日/每周/均匀分钟或小时间隔/高级 cron，保留特殊旧 cron 与自定义免打扰；macOS 透明标题栏与交通灯留白。`subagent-routes.ts` 返回 reasoning 供统一模型菜单判断思考能力。底层 background/subagent/followup 未合并，等待不常驻模型，不按耗时估算 token。
2026-10-21 任务等待 `task_wait`（未打包，beta.21 候选，整合树 `integration-beta21`）：新增 `packages/server/src/task-waits.ts`（表 `task_waits`、事件快速通道、20s 兜底 tick、去重 `fireWait`、重启 `resumeWaits`、取消、手动刷新、结构化增量唤醒词）与单测 12 项；`ext-delivery` 加 `task_wait` / `task_wait_list` / `task_wait_check` / `task_wait_cancel`；`runtime.ts` 接线（import、主会话 host.waits、abort 取消等待、`setWaitWaker` 走 nudge、bootstrap `startWaitScheduler`）；`http.ts` 加查询/刷新/取消路由；`tasks.cancel` 连带取消该任务的等待。设计 §28。外部 provider 只走固定 GitHub REST 端点（不执行任意 shell；仅用进程已有的 `GITHUB_TOKEN`/`GH_TOKEN`，不读凭据文件、不输出 token；限流/授权失败按错误记录并到期兜底）。实际验证：`task-waits.test.ts` 12/12、`proactive`+`subagents` 回归 26/26、服务端 typecheck 通过。未跑：完整 e2e、安装包真机、真实 GitHub run 全链路（出口 IP 被匿名限流；有 token 时可用）。
2026-10-21 任务等待唤醒投递可靠性 + README 措辞纠正（未打包，beta.21 候选，整合树 `integration-beta21`，接上一条）：修复 `fireWait` 先把 `status` 写成 `fired`、waker 失败仅 log 导致通知永久丢失（崩溃窗口同样丢失）。把 `fired`（已判定有结果）与 `delivered`（已交给 runtime）分开持久化：新增 `delivery_status / delivery_attempts / delivered_at / last_delivery_error / next_delivery_at`（含升级回填：旧 fired 行保守视为已送达，避免升级瞬间重发）。waker 失败按退避重试（最多 5 次），`tickWaits` 开头补投，`resumeWaits` 重启后重置 pending 的补投时间；超过上限记 `failed` 并保留错误不再无限重试。**不承诺 exactly-once**：唤醒词加等待 id 作幂等线索，重复送达由模型按 id 去重。`runtime.ts` 的 `nudge` 不再 `catch` 吞错，返回 `false` 表示未送达，`setWaitWaker` 据此抛错触发重试（否则 waker 永远“成功”）。措辞纠正：`task_wait` 是**合作式结束**（工具只返回提示、不阻塞不中断，模型照做才会话才 settle），不是强制 yield；`wakePrompt` 的「不重载历史」改为「通知本身不叠加重复历史，会话历史照常存在」。实际验证：`task-waits.test.ts` 19/19（新增投递成功幂等、失败重试、超限 failed、重启补投、fired 后取消竞态）；`task-wait-yield.test.ts` 1/1（真实 Pi 会话 + mock 模型：`task_wait` 后 `isSessionBusy===false`、含 `settled`、等待期 mock 步骤计数不增长）；回归 `proactive`+`subagents`+`pi-compat`+`custom-providers`+`thinking-levels` 43/43；两端 `npm run typecheck` 通过。未跑：完整 e2e、安装包真机、真实 GitHub run。


实际验证：主会话已独立跑通 `e2e/model-ui.mjs` 六组与 `e2e/task-ui.mjs` 全断言（不沿用代理旧 25 项计数）；更新后的子代理入口专项已通过。最终整合树两端 typecheck、web build、model-picks/subagents/approval/proactive 共 37 项、定时解析 3 项及 `e2e/routines-ui.mjs` 全通过。Rust 未再修改，复用标题栏代理 cargo check 与六组布局通过结果。原生交通灯位置、拖动、双击缩放、全屏进出待安装包真机验证；缺 Developer ID 证书的系统授权保留问题仍阻塞。全程 Mock，无真实模型费用，未替换用户 App。发布范围固定 mac-arm64；Homebrew 默认 Node 缺动态库，最终检查用已有 Node 24.20.0，未改系统 Node。

2026-10-21 子代理思考强度 + 会话 header 调整（未打包，beta.22 候选，分支 `subagent-thinking-fix`，基线 `5b6cf11`，待集成负责人合入 `next-release-integration`）：新增子代理**自己的思考强度**入口，取值三层「单个子代理覆盖 > 助理默认（跟随/固定）> 跟随主会话」，最后一律按子代理实际模型 `clampThinking`（不支持推理的得到 off，不会出现 xhigh/max）。改动：`subagents.ts` 加 `thinking` 列 + `agentSubagentThinking/saveAgentSubagentThinking/resolveSubagentThinking/setSubagentThinkingOverride/applyLiveSubagentThinking`，`spawnSubagent` 增可选 `thinking` 并校验；`subagent-routes.ts` 加 `GET/PUT /api/agents/:id/subagent-thinking`、`PATCH /api/subagents/:id`，`/api/subagents/:id` 与详情返回 `resolvedThinking`；`runtime.ts` 子代理 `agentThinking` 改用 `resolveSubagentThinking`，运行中切换走 `applyModelSettings`（不重建会话、不动主会话）；`models.ts` 导出 `THINKING_LEVELS/isThinkingLevel`；`ext-delivery` 的 `spawn_subagent` 加 `thinking` 参数；web `ModelPicker.tsx` 抽出可复用的 `ThinkingButton`，`Subagents.tsx` 助理池与详情各接一个入口。UI 调整：`SubagentTasks` 去掉「主会话」chip，子代理详情保留左上角「返回主会话」、去掉 header 停止按钮（停止统一由输入栏按钮承担）。实际验证：`packages/server/test/subagents.test.ts` **20/20**（含新增「每助理默认跟随/指定、单个覆盖优先、按模型 clamp、spawn 校验」与「运行中改覆盖即落库并走 driver.apply」两项）；服务端 `tsc --noEmit` 与网页 `tsc --noEmit` 均通过；`vite build` 因本 worktree 借用其他树 node_modules 导致 config 临时目录解析异常未跑通（已在状态文件记录绕过方式），未跑完整 e2e、未跑安装包真机。全程 Mock，无真实模型费用、未动用户桌面与凭据。

2026-10-15 文档维护：本轮共享文档（AGENTS / HANDOFF / ROADMAP / DESIGN）由文档代理在独立 worktree（分支 `docs-beta20`，基线 `347bbdf`）统一撰写，只产出 diff、不自行 commit/push；模型 UI 子代理只写自己的私有状态文件（`progress-snapshots/model-ui-beta20-state.md`），不改共享文档，避免和代码混进同一提交。已按 beta.16–19 实际 git history / release notes 核对并修正陈旧状态（子代理 / 用量 / 组队选模型 / 思考强度 / 图片模型列表标成已随 beta.15 发布，子代理并发默认 10 / 排队 / 重启续跑标成已随 beta.19 发布），新增 beta.20 候选（模型 UI 合并 / 渠道折叠 / 常用 5，开发中）与「统一任务」（已批准方向、计划中、待实现）。见 AGENTS.md「文档维护（交付标准）」。

2026-10-15/21 子代理模型改版（已 `cherry-pick 6656d0f` 入整合树 `integration-beta21`，beta.21 候选、未打包）：全局设置移除子代理模型指定/挑选，只保留并发 + 最长运行；子代理模型改成**每个助理的候选池**（助理设置 › 子代理模型：可搜索、按服务分组、checkbox 多选、勾选不关菜单），默认跟随主会话。派活时在池内按能力挑，模型故障（限流 / 服务不可用 / 模型不存在 / 鉴权不通 / 超时，`model-errors.ts`）只在池内有限 fallback，从已保存会话续跑，每个候选最多一次，用尽 / 单项失败明确停；工具失败、权限拒绝、未知错误、用户停止都不换模型，也不使用池外模型、不无限重试；切换原因写用户可见系统消息，用量归同一子代理。迁移：旧全局 `subagentModels` 只留 `maxMinutes`/`maxConcurrent`（旧全局模型指定废弃为跟随主会话），旧全局允许清单迁给无显式配置的助理，旧单模型 → 单项池、旧跟随 → 空池；`migrateSubagentModelSettings()` 幂等。**边界**：初始化 `createPiSession` 失败的候选也并入本轮 `tried`（不会被请求阶段绕回）；`tried` 不落库，跨服务重启会按新顺序各再试一次，仍有界。改动文件：`packages/server/src/{subagents,model-errors,subagent-routes,models,runtime,pi-adapter/mock-provider}.ts`、`apps/web/src/components/{ModelPicker,Subagents,Settings,CustomProvider}.tsx`、`e2e/{subagents,model-ui}.mjs`、`docs/{DESIGN,ROADMAP}.md`、测试 `test/{model-errors.test,subagents.test,custom-providers.test,subagent-fallback.smoke}.ts`。整合树实际验证：两端 typecheck 通过；定向单测 `task-waits + task-wait-yield + thinking-levels + model-errors + subagents + custom-providers + pi-compat + model-picks` **62/62**；web/rendezvous `npm run build` 通过；真实 Mock 进程 fallback 冒烟通过；e2e `model-ui.mjs` 六组全过、`subagents.mjs` 全过。全程 Mock，无真实模型费用。

2026-10-21 beta.21 整合（整合树 `integration-beta21`，分支 `integration-beta21`，基线 `a48e27f`，未 push/tag）：把 `agent-model-pool` `6656d0f` cherry-pick 入本树，与 task_wait、推理档位合并；唯一代码冲突在 `runtime.ts` 顶部 import（取两边），docs 取两边。**修复主会话复核发现**：`runtime.ts` 初始化循环的 `tried` 集合原先在循环之后才建，候选 A `createPiSession` 失败换到 B 后，B 请求失败时 `planFallback` 可能绕回 A；已把 `tried` 提到循环前并把初始化失败候选记入，新增单测守住。测试环境修复（非代码）：本树 `apps/web/node_modules` 缺失导致 web build 在 closeBundle 读不到 `dist/manifest.webmanifest`，`npm ci --ignore-scripts` 补齐后构建通过。发布范围仍 `mac-arm64`（`.github/release-scope.json`）；beta.18「完全权限应用层免审批」未动。

beta.19 已公开：https://github.com/MyMiMang/pi-assistant/releases/tag/v0.1.0-beta.19 。正式 Actions https://github.com/MyMiMang/pi-assistant/actions/runs/38584256097 最终成功；首次 publish 替换 latest.json 遇 GitHub HTTP 500，仅重试失败任务成功，未重构建、未移动 tag。arm64 构建与 Mac 安装冒烟成功，Windows/Linux skipped、Intel 未入矩阵。实际公开 4 资产：latest.json、aarch64.dmg、aarch64.app.tar.gz 与签名；清单仅 darwin-aarch64 / darwin-aarch64-app，版本/notes/正式下载地址已核验。系统授权保留仍缺 Developer ID 证书明确阻塞。未安装用户 App。


本轮续接：发布树 `3a44fc0` 保留 beta.18 权限免审批基线，原 beta.15 + WIP 树未 reset、未覆盖。已精选合入图片全屏、模型删除（原生 confirm 改现有确认框）、子代理默认 10 / 持久 FIFO / 重启会话续跑、Tauri 外链。图片桌面/手机专项全部通过；模型 8 项单测与添加/取消/失败/重试删除 UI 链路通过；子代理 14 项 + 渠道 5 项、真实进程重启冒烟通过。UI 入口精简与容器宽度适配已在发布树复核：8 组场景全过，子代理专项 e2e 全过，受影响 types/build 通过。原生 Tauri 外链待 Mac CI 编译和安装冒烟，不能以网页测试代替原生测试。

CI 已增加 `mac-arm64/all` 范围，tag 按 `.github/release-scope.json` 固定本轮仅 arm64；跳过 Windows/Linux/Intel，publish needs 明确容许计划内 skipped、要求 build 和 mac-smoke 成功；资产/latest.json 的平台、签名与包名校验失败保持草稿。静态 3 项测试与全部 shell 语法通过；CI 提交 8764c2a 已推 main，手动仅 Mac 演练 Actions 38581168432 进行中（https://github.com/MyMiMang/pi-assistant/actions/runs/38581168432）。发布前再次核对远端空闲号。macOS 系统授权保留因缺 Developer ID 证书明确阻塞，诊断报告保留，不宣称修复，不安装用户 App。


2026-10-15 发布流程**暂缓 Intel Mac**（用户：『intel每次打包很久，下次不要打包他，等后期完全开发再带上』）：`.github/workflows/release.yml` 的桌面构建矩阵改为由 `prepare` 按 `BUILD_INTEL` 动态组装，默认只含 mac arm64 + Windows（加 Linux x64/arm64 两个 job，共 **4 个构建任务**），Intel x64 默认跳过。恢复方式二选一：手动运行 workflow 勾选 `build_intel`，或设仓库变量 `BUILD_INTEL=true`（Settings › Secrets and variables › Actions › Variables）。联动改动：`mac-smoke` 的 Intel dmg 挂载检查、`publish` 的 `x64.dmg` 资产断言都加了 `BUILD_INTEL` 条件，Windows / Linux / latest.json 依赖不因 Intel 缺失而阻塞；`publish` 新增守护——未构建 Intel 时若 `latest.json` 仍含 `darwin-x86_64` 则报错停在草稿，避免 Intel 用户被错误引到 arm 包（跳过时该字段自然缺失，Intel 老用户只停更）。文档（INSTALL / README 平台表、AGENTS、DESIGN CI 说明、ROADMAP）同步改掉「5 个平台」表述。本次只动发布流程与相关文档，未改产品代码、不触发新构建；**进行中的 beta.18（tag `v0.1.0-beta.18`，run 38567460857）用的是改动前的 workflow，照旧 5 平台构建，不受影响**。验证：release.yml YAML 解析通过、矩阵组装脚本用 `BUILD_INTEL=false/true` 两种取值跑出预期 JSON、`bash -n` 无语法错误；未跑产品测试、未另行打包。

2026-10-15 用户纠正权限定义（**已随 beta.18 发布**）：『不是完全权限那就得全部都不用审批啊』——档位是“完全权限”（开启 + 允许该助理 + 未暂停，即 `hostFileAccess` 为真）时，**应用层不再创建任何审批请求**，包括硬性保护清单命中的动作（关机、删除、改系统设置等）。实现：`requests.ts` 的 `approval()` 是所有应用层审批的唯一入口（email / connectors / delivery / routines / skills / browser / ext-computer / ext-approval 都经它），在那里按 `hostFileAccess(agentId)` 直接放行、不写卡片（提问 `ask_user` 不受影响）；`ext-approval` 的 `evaluate()` 在 full 下对非 deny 一律 allow、`hardGuard` 命中时不再请求；`ext-computer` 的硬性保护在本机档位 full（`approvals = none`）下不再请求（助理电脑 / 只看 / 限定 / 信任仍照旧）；系统提示与设置页文案同步改掉“受保护操作仍会问你”。**保留的 deny / 阻断**：凭据 / 密钥路径直接 deny、暂停 / 降权 / 关闭（`hostFileAccess` 每次求值立刻变假）、`observe` 输入工具隐藏、宿主系统权限弹窗、网站登录 / 验证码（`request_handoff`）、心跳任务不能执行需批准的操作。注意：`hostPlan` 文字变了 → `approvedHash` 变，已开启“操作这台电脑”的用户需在设置页重新确认一次计划。验证：相关单测 65/65（approval / hard-guard / host-control / sandbox-access / pi-compat / channels / proactive / mirror），服务端全量 249 pass（1 个无关失败：`shared-computer.test.ts` 的合并脚本要 GNU tar，macOS BSD tar 不支持 `--skip-old-files`，在未改动的发布树上同样失败），服务端 + 网页 typecheck 通过；未跑 e2e（未改 e2e 断言）。DESIGN §23.2 / 23.5-23.8、ROADMAP、ARCHITECTURE 已同步。

2026-10-14 beta.17 权限误报热修：基于公开 beta.16（4bfd0f9）的独立发布树，只选择性带入 hard-guard、shell-lex 和 hard-guard 测试，其他 UI / 模型 WIP 留待后续。命令按引号、命令位置和实际写入目标判定；修复 grep 危险词、gh --repo 输出日志、git log 格式串、sed 工作区输出、export PATH、复制受保护源到 /tmp、字面 heredoc 正文的误报。未引号 heredoc 的命令替换、喂给 shell 的脚本、sh -c / 反引号 / $(...) 和真实系统写入继续保护。主会话复核补掉自身保护与 stress 文本的全文匹配残留。在发布树独立验证：hard-guard + approval + host-control + sandbox-access **37/37** 通过，服务端与网页 typecheck 通过；未跑全量。发布按五平台构建和安装冒烟通过后自动公开 Latest。


2026-10-14 发版：beta.13 的 Linux 两版、Mac arm64、Windows 已构建成功；Intel Mac 在 `bundle_dmg.sh` 运行约 16 分钟后失败，重试仍卡在此步骤，已取消（[run 38500745136](https://github.com/MyMiMang/pi-assistant/actions/runs/38500745136)）。上游 tauri-action 默认将 `TAURI_BUNDLER_DMG_IGNORE_CI` 设为 true，强制 Finder 排版；显式设为 false 恢复 bundler CI 模式，并给两次打包加 `--verbose`。参照 [上游问题 1091](https://github.com/tauri-apps/tauri-action/issues/1091)，这是对相同失败症状的兼容处理；beta.13 的简略日志不足以确认具体子命令。以 beta.14 重新构建验证，旧 tag 不移动、旧草稿不公开。YAML 解析和 CLI 参数检查通过，未重跑产品全量测试。

2026-10-14 Intel Mac 打包改法：beta.14（[run 38503909614](https://github.com/MyMiMang/pi-assistant/actions/runs/38503909614)）上面的兼容处理无效，Intel Mac 两次 `tauri build` 各约 20 分钟后失败，其余平台全部成功，草稿未公开。beta.9 起公开版就缺 x64.dmg / x64 更新包。现改为：macOS 只用 `--bundles app` 让 Tauri 出 .app + .app.tar.gz/.sig（Tauri CLI 2.12.2 源码确认：构建 app 目标即生成更新包，latest.json 的 darwin 项不受影响），dmg 由单独步骤用 `hdiutil create`（失败重试 3 次 + verify）打成 Tauri 同名 `Pi.Assistant_<版本>_<x64|aarch64>.dmg` 传进草稿；删掉 continue-on-error/重试/XProtect/`TAURI_BUNDLER_DMG_IGNORE_CI` 等旧补丁；mac-smoke 额外挂载检查 Intel dmg（含 x86_64 二进制和更新包）。先推 release-dryrun 演练验证，不打 tag。

2026-10-14 发 beta.15（用户说「打包」）：基于 94b78a6 + 本说明提交，内容同 beta.13/14（子代理、用量、组队选模型等）+ Intel Mac 打包修复。演练 [run 38508018735](https://github.com/MyMiMang/pi-assistant/actions/runs/38508018735) 全部通过。beta.13/14 的草稿不公开、tag 不动。

2026-10-15 权限需求实现（**已随 beta.16 发布**）：用户否掉“本地项目目录白名单”方案，要求把“完全权限”做成**用户主机上文件/命令/桌面的统一权限**，完全权限下日常命令自动放行、受保护系统动作仍明确批准，并要求可维护、权限判断集中、不新增框架。实现：`host-control.ts` 新增唯一判定 `hostFileAccess(agentId)`（full + 已开启 + 允许该助理 + 未暂停，每次调用求值）；`ext-sandbox` / `ext-approval` / `runtime`（系统提示、`deliver_file`、hostpc 浏览器上传下载、识图）统一调用；`initHostAccessWatch()` 在 `host.changed` 时中止正在跑的主会话/子代理/后台任务；Docker 偏好下 full 的 bash 改在主机跑（本机执行后端经 pi-adapter 注入，扩展不直接 import Pi）、非 full 仍进容器。普通 bash（npm/which/ls/git…）full 下自动放行，凭据路径仍拒绝，硬性保护清单仍每次明确批准。DESIGN §23 已由“设计稿”改为“已实现”并删掉过时的“docker 恒判否”。相关单测（host-control / approval / sandbox-access / hard-guard）全过。

2026-10-15 发 beta.16（用户说「打包」）：基于 50d64c3 + 权限实现 + 本说明，**只含权限相关文件**（ext-approval / ext-sandbox / ext-computer / shared hard-guard、server 的 host-control / runtime / pi-adapter / files / vision-ext / http / main、HostControl、相关测试与 DESIGN/ROADMAP/HANDOFF），未验收的图片查看（ImageViewer / App / Attachments / Markdown / InfoPane）、发送快捷键与子代理卡片改动**不带入**本次发布，留待后续。在独立 worktree（`release-permissions`，基于 origin/main）核验：服务端 + 网页 typecheck 通过、受影响单测 31/31 通过。


| 版本 | 主要内容 |
|---|---|
| ≤ beta.6 | Phase 1–3 基础：流式聊天、审批、后台任务、隧道 + 配对、记忆（basic / Hindsight）、技能、定时、MCP、助理电脑（Lima / WSL2 / Docker，共用电脑）、浏览器、操作这台电脑（权限档位）、飞书 / 钉钉 / 企业微信 / 邮箱 / 微信 ClawBot、主动性、Linux 服务器版 |
| beta.7 | 界面打磨、窄屏适配、多处修复 |
| beta.8 | 更新流程重做（进度、错误原因、设置 › 关于与更新）；操作记录从界面去掉、日志加上限；窄处文字收成图标；手机不再横向晃动 |
| beta.9 | 助理电脑镜像 0.1.3（修 Apple 芯片开机即退出）；模型列表重做并接入 models.dev；「操作你的电脑」提示只在真正操作时出现；README 重写，加第三方组件清单 |
| beta.10 | 助理群聊（管理者派活、一句话建群、群专属助理）；群附件和附件真正交给模型（看图 / 识图模型兜底 / 文档文字提取）；渠道原生图片和文件；群聊审批转发到渠道；思考内容可折叠；图片生成；cua 浏览器和桌面控制；桌宠；聊天居中等手机修复 |

| beta.11 | **修 Windows 打开就是「127.0.0.1 拒绝连接」**：托盘程序拿到的安装目录是 `\\?\C:\...` 原样路径，Node 解析入口时报 `EISDIR: lstat 'C:'` 立刻退出（beta.8 起所有 Windows 版本都有，CI 里用真实安装包复现），`main.rs` 的 `plain_path()` 转回普通路径；服务日志落盘（`startup.rs`）；就绪前主窗口显示自带启动页 `apps/tray/ui/startup.html`，失败时显示原因、日志尾部、重试 / 复制诊断信息 / 打开日志文件夹；8787 被占用自动换 8788…8796（记在配置目录 `port.txt`）；新增 `windows-smoke.yml`（静默装到中文 + 空格目录、启动托盘、查 `/api/system/public`），发版改成先草稿、Windows/mac 冒烟通过才公开（见 DESIGN「CI 构建」）；发版演练（release-dryrun 分支，run 38415435058）：5 个构建、mac-smoke、Windows 安装到中文路径后启动托盘都通过，草稿已自动删除；修 Windows 上 cua-driver 种子复制失败（Node `cpSync` 复制目录在 Windows 上报 `EIO, Access is denied`，用户电脑上实测复现，改为逐文件复制到临时目录再改名 + 重试，`config.ts` `copySeed`） |
| beta.12 | 工作途中插话（Pi steer，下一个工具边界送达，消息显示送达状态）；整条说「停」立即全部停下（含等待中的审批），单聊 / 群聊 / 渠道通用（DESIGN §20）；Mock 模型修正：插话只在打断多步任务时特殊回应，群聊只按最新【用户】发言匹配（修 e2e 里后续群聊步骤被误判成“慢慢数”） |

| beta.15（组队选模型 + 用量） | **组队选模型 + 用量系统**（DESIGN §22）：建群时服务端按角色需求从已配置模型里打分挑选并写理由，卡片下拉按适合程度排序、带价格档；设置 › 模型 › 模型擅长 可改标签；每次模型调用记一行用量（含读写缓存、推理），按当时价格算费用并存价格快照，自定义单价 / 官方价打折，未知价「—」，人民币显示（汇率可改）；设置 › 用量（今天 / 7 天 / 30 天、按模型 / 助理 / 群、每日柱状图、缓存命中率与省下）；每条回复用量、群聊近 30 天费用；明细 90 天后按天汇总。models.dev 快照加推理 / 工具调用 / 价格（约 490 KB） |
| ↳ 进度 | 2026-10-14 修复 e2e 对历史用量的错误假设：价格行按 `mock/echo` 定位；给 Mock 补价只重算其未知价格，其他服务（包括已删除服务）的历史调用保留。针对性回归「自定义模型服务 + 组队选模型」通过，用量单测 7/7、两边 typecheck 通过。按用户最新要求停止完整 e2e，不再重复全量。已启动的服务端单测最终 225 通过、10 跳过、1 失败：macOS BSD tar 不支持共用电脑合并测试的 `--skip-old-files`（与本次改动无关，未改）。桌宠 17/17、Rendezvous 2/2 通过。真实 Key 验证和 §22.5 缺口仍保留。 |
| beta.15（后台子代理） | DESIGN §21 第一版：主会话用 `spawn_subagent` 派独立 Pi 会话，立即继续聊天；`subagent_message` 转发补充、`subagent_stop` 停止；每助理并发 3、只一层；设置中跟随 / 自动清单 / 固定模型及助理覆盖。聊天卡片和只读过程面板，主会话统一处理审批；终态与通知事件落库、3 分钟停滞 / 恢复、60 分钟最长运行（可改）、重启标 lost / 重新派；用量带 subagent_id 归属原助理。相关单测 32/32、渠道单测 5/5（确认子代理步骤不外发），两边 typecheck 通过；专项 `node e2e/subagents.mjs` 通过（继续聊、详情、补充转发、审批、停止、模型错误、重启、模型设置、手机布局、群聊），截图 97–98。真实模型的派活 / 核验 / 路由质量和外部渠道真账号仍待实测。 |
| beta.15（子代理会话分页） | 按用户确认的 Paseo 交互：子代理图标 → 选择任务 → 独立聊天分页，默认不自动开页；主 / 子会话切换保留草稿和滚动，关闭分页不停止任务。消息展示抽到 `ChatMessages.tsx` 共用气泡、思考、工具步骤、文件与用量；保留纯思考消息。子窗口可直接发消息（运行中 steer、只停止当前子代理）；完成后用落库的 `session_file` 接着聊，续聊重新计时、仍受并发 3 限制、每轮完成仍通知主会话。子代理单测 6/6、渠道 5/5、两端 typecheck 与网页构建通过；专项 `node e2e/subagents.mjs` 通过（含完成后 / 重启后上下文续聊、群聊），分页追加验证 `E2E_UI_ONLY=1 node e2e/subagents.mjs` 通过（默认不开页、图标选择、分页切换 / 草稿 / 关闭、直接消息、手机布局）。截图 97、99。未跑全量，真实 API Key 事项仍待验证。 |
| beta.15（模型菜单修复） | 聊天模型旁的思考强度：补齐自定义模型推理能力、旧配置启动回填，模型列表随设置变化刷新；图片生成列表按接口输出模态 / models.dev 图片输出标记 / 已知生成模型系列识别，不把识图模型当生成模型，不再提供“显示全部”混杂列表。模型快照增加图片输出标记（8），缓存升 v4。19 项相关单测、两端 typecheck、专项 `node e2e/model-capabilities.mjs` 通过（不刷新新增中转、桌面 / 手机思考强度、图片模型过滤、手动别名）。 |
| beta.12（工作途中插话） | **工作途中插话**：助理干活时随时能发消息，在下一个工具边界用 Pi steer 送达（之前是排到整轮做完），消息下显示「已送达正在进行的任务」；整条说「停 / 别做了 / stop」立刻全部停下（含命令、电脑操作、等待中的审批）；1:1、群聊、渠道都适用（DESIGN §20） |

所有功能都有单测和 e2e（Mock 模型）。beta.10 发布前在 main 上全部通过：`npm test`、`npm run e2e`（114 步）、`node e2e/pet.mjs`。

## 3. 已验证 vs 需要真机验证

**只在 CI / 模拟环境里验证过的，需要真机或真实账号：**
- **用户电脑的 cua 浏览器和桌面控制**：Mac（Chrome、信任 / 完全权限）和 Windows（Chrome / Edge）。详细检查项见第 8 节「用户电脑：完全接管与 CDP 浏览器」。
- **助理电脑**：Mac 上的 Lima 虚拟机、Windows 上的 WSL2（托管 CI 没有嵌套虚拟化），还有共用电脑和第二块屏幕。步骤见第 8 节。Apple 芯片开机已在用户的 Mac 上验证过（镜像 0.1.3）。
- **渠道真实账号**：飞书、钉钉、企业微信自建应用和智能机器人、微信 ClawBot 扫码。要看原生图片 / 文件收发，以及群聊审批卡片在渠道里点按钮和文字回复是否都能用。测试时用的是模拟平台。
- **图片生成**：要用真实 Key 测（OpenAI 兼容、百炼、方舟、Gemini、xAI）。测试时用的是模拟服务。
- **识图模型兜底、真实视觉模型收图**：Mock 模型只确认了收到几张图片。
- **思考内容的流式显示**：真实推理模型（DeepSeek、Qwen 等）的 `<think>` 流式拆分，以及半截标签的情况。
- **桌宠**：Mac 和 Windows 上要确认窗口透明（没有白底或黑底，也没有阴影框）、点击穿透、拖动、记住位置、全屏和切换桌面时还在、孵化效果（§19）。
- **HEIC 图片**：只有 macOS 能用 `sips` 转换；Windows 和 Linux 上助理只会收到一句说明，需要真机确认 iPhone 照片的体验。
- **应用更新**：Mac 和 Windows 上从 beta.8 / 9 更新到 beta.10，看进度显示和失败提示。从 beta.7 或更早升级时，旧的更新逻辑可能看起来没反应。
- **用量与费用**：真实服务返回的读 / 写缓存和推理 token 是否齐全（DeepSeek、百炼、火山、中转站经 Pi 返回的字段各不相同），算出来的费用和各家账单是否对得上；国内模型在 models.dev 里的价格是否齐全。
- **组队选模型**：真实模型会不会按要求填 `needs`，挑出来的模型是否合理（Mock 只按脚本）。
- **工作途中插话**：真实模型下的回应是否简短、换方向 / 停下判断是否准（Mock 模型只按脚本回复）；cua 电脑操作被中止时是否立即停（Mock 下只验证了 bash）。
- **其他**：Cloudflare 命名隧道公网连通、Web Push 真机推送、悬浮条透明（`macOSPrivateApi` / WebView2）。

## 4. 已知问题 / 限制
- **Windows 日志位置**：托盘和服务日志在 `%LOCALAPPDATA%\com.piassistant.app\logs\server.log`（超过 5MB 轮转为 `server.old.log`）；数据目录 `%APPDATA%\Pi Assistant`。macOS：`~/Library/Logs/com.piassistant.app/server.log`。
- 端口被占改用 8788… 时，网页的本地偏好（布局、语言，存在浏览器 localStorage，按端口区分）会回到默认；本机访问不需要登录，所以不会掉登录。端口记在配置目录 `port.txt`，之后一直用同一个。
- 安装包**没有签名**：macOS 第一次打开要右键选「打开」，Windows 会有 SmartScreen 提示（§5.2）。
- 群聊：复制群专属助理时不会复制它工作区里的文件。管理者派活做得好不好，取决于用的是什么模型。
- 附件：单个文件上限 100MB；文档摘录最多约 2 万 token；扫描版 PDF 不做 OCR。
- cua-driver 已升级到 0.35.4（host 侧 `third-party.json`；助理电脑镜像 `0.1.4`，digest `sha256:6cc5c119…d54a42`）。0.35.0 是 breaking change，适配点见本文 2026-10-22「CUA 0.34.1 → 0.35.4 适配」一条。以后再升级要重新核对 BROWSER.md、WORKFLOW.md 和工具参数格式。
- macOS 系统沙箱档没做。MCP 服务器经 npx 第一次下载时没有字节进度。
- Hindsight 运行环境 / 向量模型的下载百分比是估算的。远程 Hindsight 换不同维度的向量模型时，要对方实例自己迁移。
- 共用中转远程访问（Paseo 式）用户决定暂缓（§15.1）。

## 5. 待用户决定 / 下一步
需求、计划和待决定事项的完整清单见 [ROADMAP.md](ROADMAP.md)。
- **后台子代理已随 beta.19 发布**（默认 10 并发 / 排队 / 重启续跑）：主会话聊天、子代理后台干活、可查看过程、复用能力画像选模型。设计与实现见 DESIGN §21；真实模型与渠道真账号仍待验证。
- **许可证**：建议用 MIT，等用户确认（现在 README 写的是「保留所有权利」，仓库里没有 LICENSE 文件）。
- **代码签名**：Apple Developer ID 公证、Windows 代码签名证书，都要用户提供账号或证书。
- 下一步：beta.20 仅 macOS arm64 已公开，构建、Mac 安装冒烟与四项公开资产核验完成；等待用户实际使用反馈。模型/任务/缩略图/定时 UI 已验收；标题栏原生交互待用户安装后真机验证。任务底层调度未合并，见 DESIGN §25。其他候选：cua-driver 升级、群聊复制工作区、Windows HEIC、扫描 PDF OCR。

## 6. 构建 / 测试 / 发版

```bash
# Node 22.19+
npm ci --ignore-scripts
npm run dev              # Mock 模型启动 http://127.0.0.1:8787（不花钱）
npm run typecheck        # 服务端 + 网页
npm test                 # 服务端单测（200+ 个，约 3 分钟）
npm run e2e              # Playwright 端到端（需要 Chrome：CHROME=/path/to/chrome），约 25 分钟（110+ 步），截图写到 docs/screenshots，结果写 RESULTS.md
E2E_ONLY='正则' npm run e2e   # 只跑匹配的步骤（调试）
node e2e/pet.mjs         # 桌宠 e2e
npm run check:pi         # Pi 升级兼容检查
```

桌面程序（需要 Rust ≥ 1.90；Linux 另需 `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`）：见 `apps/tray/README.md`。

**发版**：改好后在 main 上打 tag `v0.1.0-beta.N` 并 push → `.github/workflows/release.yml` **默认构建 4 个任务**（mac arm64 / Windows / Linux x64 / Linux arm64；macOS 只让 Tauri 出 .app + 更新包，dmg 由 hdiutil 单独打——别再改回 Tauri 的 dmg 目标，Intel runner 上 bundle_dmg.sh 会失败）。**Intel Mac（x86_64）默认跳过**：耗时很久且长期失败（见 ROADMAP「暂缓」），需要时手动运行 workflow 勾选 `build_intel` 或设仓库变量 `BUILD_INTEL=true` 恢复第 5 个任务；跳过时 `latest.json` 不含 `darwin-x86_64`，Intel 老用户只停更不会被分到 arm 包（publish 有守护）。同时写 `docs/release-notes/v0.1.0-beta.N.md`（中文，给用户看）；构建结果并上传到 GitHub Release（自动更新签名用仓库 secrets `TAURI_SIGNING_PRIVATE_KEY`）。测试版 tag 也发布为**正式 latest 版本**（不是 pre-release），否则 `releases/latest/download/latest.json` 404，自动更新失效；`wsl-rootfs-v*` 例外（pre-release、不设 latest）。**只有用户要求时才打 tag。**

**提交习惯**：中文提交信息，一行写清楚做了什么和为什么（参考 `git log`）；截图单独一个提交（“截图：…（编号）+ 全量 e2e 结果”）。不要 force-push 共享分支。

## 7. 代码地图（最常改的地方）

- 服务端入口 `packages/server/src/main.ts`，HTTP 路由全部在 `http.ts`（`localOnly` = 只允许本机）。
- Pi 只通过 `packages/server/src/pi-adapter/` 使用（升级 Pi 时只看这里）。
- 统一下载：`packages/server/src/downloads.ts` + `apps/web/src/components/Downloads.tsx`。
- 助理电脑：`desktop.ts`（开关机、端口、截图、共用电脑 / 屏幕 / 合并）、`desktop/computers.ts`（哪个助理用哪台电脑、主屏幕争用，纯逻辑）、`packages/sandbox-desktop/pia-screen`（容器里的屏幕管理）、`pia-cua-mcp`（cua 中继）、`desktop/backend.ts`（后端选择）、`desktop/lima.ts`（macOS 虚拟机：下载 / 配置 / 开关机 / 保护）、`desktop/names.ts`（容器名硬性保护）、`downloads.ts` 的 `downloadFile`（大文件断点续传 + 摘要校验）。
- Hindsight：`packages/server/src/memory/hindsight/`（sidecar 安装/启动、provider 账本+同步队列、settings 三模型）。
- 操作这台电脑：`host-control.ts`（服务端）、`HostControl.tsx`（设置 + 输入框旁档位按钮）、`HostFloatBar.tsx`（悬浮条页面）、`apps/tray/src-tauri/src/main.rs`（悬浮条窗口）。
- 通用 UI 组件：`apps/web/src/components/ui.tsx`（Button / Modal / Badge / Input / **Help**「?」气泡 / **useConfirm** 确认框）；主题 `apps/web/src/themes/*.css`（勾选框、开关 `.pa-switch`、帮助气泡、下载条样式在 `app.css` 末尾）。
- 助理群聊：`packages/server/src/rooms/logic.ts`（@ 解析、发言规则、上限、增量注入，纯逻辑）、`rooms/index.ts`（建群/成员/调度/停止/继续/重启恢复、群规则与 `room_assign` / `room_propose_member` / `propose_room` 工具）、`rooms/copy.ts`（复制到我的助理）；界面 `RoomChat.tsx`（群聊页、@ 补全、新建群、群设置、删群）、`RoomCards.tsx`（提议卡片、群专属助理操作）。Mock 模型里 `roomReply` 是 e2e 用的脚本（“派给X”“循环”“慢慢”“加个成员”“组个团队”）。设计见 DESIGN §17。
- 桌宠：`packages/server/src/pet/`（状态、宠物包、孵化接口）、`apps/web/src/pet/`（`PetWindow.tsx` 是 /pet 页面，`hatch.ts` 负责去背景和拼图，`zip.ts`）、`components/PetSettings.tsx`、`apps/tray/src-tauri/src/pet.rs`（透明窗口、点击穿透、拖动、记住位置）。内置宠物改动后跑 `python3 scripts/pets/gen-presets.py --preview /tmp/pet-previews` 重新生成，自带格子校验。设计见 DESIGN §19。
- 输入框工具栏：`Chat.tsx`（`ContextRing` 上下文圆环、模型与思考合一的 `ModelPicker`、`HostTierPill`）。
- 附件：`files.ts`（上传、群附件 `saveRoomUpload` / `materializeFor`）、`attachments.ts`（图片 / 文档 → 模型输入）、`vision.ts` + `vision-ext.ts`（识图模型兜底、`look_at_image`）；界面 `Attachments.tsx`（`useAttachUploader` / `AttachTray` / `AttachButton`，单聊和群聊共用）。
- 渠道：`channels/index.ts`（入站、镜像、审批卡片、群聊卡片转发 `forwardRoomCard`）、`channels/media.ts` / `caps.ts`（各渠道能力与原生图片 / 文件）、`thinking.ts`（拆出思考内容）。
- 图片生成：`image-gen/`（providers / routes / extension），界面 `ImageModels.tsx`。
- 后台子代理：`subagents.ts`（状态、模型选择、事件、看门狗）、`subagent-routes.ts`（接口及子窗口直聊）、`runtime.ts`（独立 Pi 会话 / 续聊与主会话通知）、`ext-delivery`（派活 / 补充 / 停止工具）；界面 `Subagents.tsx`、`App.tsx` / `store.ts`（会话分页）、`ChatMessages.tsx`（共用消息展示）；专项测试 `e2e/subagents.mjs`。
- 用量与组队选模型：`usage/`（`prices.ts` 价格解析与费用计算、`index.ts` 记录 / 汇总 / 90 天滚动、`routes.ts` 接口）、`model-profile.ts`（擅长标签与打分，纯函数）、`rooms/model-pick.ts`；界面 `Usage.tsx`、`ModelStrengths.tsx`、`usage-fmt.ts`。改价格格式要同时改 `model-db.ts` 和 `scripts/gen-model-db.mjs`。

## 8. 真机测试步骤

### macOS 助理电脑真机测试（第 2 步）
1. 装 main 打出来的安装包（或源码 `npm run dev`），macOS 13+，Apple 芯片或 Intel 都要测；**不需要装 Docker**。
2. 设置 › 助理电脑：打开「给助理安装电脑」，运行方式保持“自带运行时（推荐）”→ 应显示“macOS 自带虚拟机（Lima）”。观察进度：先下载虚拟机组件（≈650 MB，0–40%）→ 第一次开机安装容器引擎（1–3 分钟）→ 下载桌面镜像。中途断网 / 退出 App 再开，应接着下而不是从头下。
3. 打开某个助理的「电脑」标签 → 自动开机 → 看到桌面画面；让助理打开浏览器访问一个网站。
4. 再开第二个助理的电脑：几秒内开机（共用同一台虚拟机）。
5. 两个都点关机 → 设置里虚拟机显示“已关机”，活动监视器里 `com.apple.Virtualization.VirtualMachine` 进程消失、内存回收。
6. 再开机：之前登录过的网站仍是登录状态。
7. 合上盖子睡眠几分钟再打开，继续用电脑标签（应能自动恢复，必要时自动重启虚拟机）。
8. 退出 App 后再打开：之前的虚拟机能继续用；退出后约半分钟虚拟机应自己关掉。
9. 关闭开关 → “删除虚拟机和镜像” → `~/.pia-vm` 和 数据目录/vm 都被删掉；用户自己的 `~/.lima`、Docker Desktop 完全没被碰。
有问题时请带上：`~/.pia-vm/pia-desktop/ha.stderr.log`、`serial*.log`，以及 设置 › 助理电脑 里显示的错误。

### Windows 助理电脑真机测试（第 3 步）
需要：Windows 10 2004+ 或 Windows 11（**家庭版、专业版各测一次**），x64；最好一台**还没装过 WSL** 的电脑和一台已经装了 WSL + Docker Desktop + 自己的 Ubuntu 发行版的电脑。
1. 装 main 打出来的安装包（或源码 `npm run dev`）。
2. 设置 › 助理电脑：打开「给助理安装电脑」，运行方式“自带运行时（推荐）”→ 应显示 Windows 的 WSL2。
3. 没装 WSL 的电脑：应显示「安装 WSL」按钮 → 点击 → 弹一次 UAC → 同意 → 等完成 → 显示“需要重启电脑”。再测一次点「否」：应提示“已取消管理员授权”。重启后回到设置，状态应变成可用。
4. 下载 rootfs（≈94 MB）：「下载与组件」页能看到进度；中途断网 / 退出 App 再开，应接着下。（仓库已公开，Release 是主下载源，GHCR 公开包是备用源）
5. 打开某个助理的「电脑」标签 → 自动 `wsl --import` + 开机 → 看到桌面；`wsl -l -v` 里出现 `PiAssistant-Desktop`（VERSION 2），**用户自己的发行版状态不变**。
6. 再开第二个助理：两个桌面同时可用（host 网络，各自端口）。让助理用浏览器访问网站。
7. 两个都关机 → `wsl -l -v` 里 PiAssistant-Desktop 变成 Stopped（Docker Desktop、自己的 Ubuntu 不受影响，没有被 `--shutdown`）；`vmmem` 内存回收（所有发行版都停了时）。
8. 再开机：之前的登录状态还在。退出 App：约半分钟内发行版停掉。
9. 发行版里看不到 Windows 文件：`wsl -d PiAssistant-Desktop -u root --exec ls /mnt` 为空。
10. 关闭开关 → 「删除虚拟机和镜像」→ `wsl -l` 里没有 PiAssistant-Desktop，`%LOCALAPPDATA%\Pi Assistant\wsl` 被删除。
11. BIOS 关闭虚拟化的电脑（如果有）：应显示中文原因“没有开启硬件虚拟化”。
有问题时请带上：设置 › 助理电脑 显示的错误、`wsl --status`、`wsl -l -v` 的输出、`%APPDATA%\Pi Assistant` 下的日志。

### 共用助理电脑真机测试（§15.4，任何平台）
1. 从旧版升级：之前每个助理各有电脑、登录过网站的，升级后这些助理应自动是“单独的电脑”，登录状态还在；设置 › 助理电脑 的「共用电脑」列表里能看到它们，可以「合并进共用电脑」。
2. 新建两个助理：「电脑」标签都显示“共用电脑（N 个助理）”，同一个画面。
3. 在助理甲里登录一个网站（例如让它打开网页并接管扫码登录），再让助理乙打开同一个网站：应该已经是登录状态。
4. 同时让两个助理做需要操作桌面的事：第二个应自动换到自己的屏幕并告诉你；「电脑」标签上方的屏幕按钮可以切换去看另一块屏幕。
5. 给某个助理打开「使用单独的电脑」（助理设置里）：下一条消息起它用自己的电脑，看不到共用的登录状态；关掉后数据保留，可以合并。
6. 合并：单独电脑里的文件出现在共用电脑里；共用电脑原来的登录状态不变，单独电脑的浏览器数据放在 `~/旧电脑-<助理名>/`。
7. 都不用时共用电脑按“空闲自动关机”关掉；再开机登录状态还在。
8. Windows（WSL host 网络）和 Mac（Lima）上重复 2–4，确认第二块屏幕能看到画面。

### Linux 服务器版
- 打包：`npm run build && node scripts/package-linux.mjs` → `dist-linux/pi-assistant-<版本>-linux-<arch>.tar.gz`（+ .sha256）。
- 本地测安装脚本（干净 systemd 容器）：`docker run -d --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw -v $PWD/dist-linux:/pkg:ro <装了 systemd 和 libpam-systemd 的 debian:12 镜像> /sbin/init`，然后 `sh deploy/linux/install.sh --file /pkg/….tar.gz`。
- Docker：`docker compose -f deploy/compose.yaml up -d --build`。
- 服务器模式开关：`PIA_HOST`、`PIA_HEADLESS`、`PIA_TRUST_LOOPBACK`、`PIA_SETUP_CHECK_MS`（设置码检查间隔）、`PIA_CLI_HINT`（日志里提示的命令）。命令行实现 `packages/server/src/cli.ts`，设置码 `setup-code.ts`，主人设备 `auth.ts`（`isOwnerDevice` / `setOwner` / `resetOwners`）。

### 用户电脑：完全接管与 CDP 浏览器（DESIGN §14.6.0 / §14.6.1）：需要真机验证
- **Mac（Chrome，信任 / 完全权限）**：
  - 用户的 Chrome 开着、已经登录 → 让助理搜一张图。
  - 我们这层不弹卡片，但可能出现 Chrome 自己的“允许远程调试”提示。
  - 之后 browser_navigate / semantic_v2 / browser_type / dom_event 点击都能用，登录状态还在，Chrome 没有重启。
  - 任务结束后，chrome://inspect/#remote-debugging 的开关应该已经关回去。
  - 同时检查 Chrome 144 以上的自动连接（auto-connect）路径。
- **Mac 完全权限的桌面操作**：微信 / 访达 / 备忘录等任意应用都能 launch_app → get_window_state → click / type_text / hotkey / drag，全程没有卡片；背景送达失败时只对那一个动作切到 foreground；get_desktop_state 能看全屏。
- **Windows（Chrome / Edge）**：trusted 点击应该能在后台送达；守护进程要在交互式桌面里（不是 Session 0）。
- **限定档位**：看不到 browser_* 工具，提示里会让用户调到“信任”。限定档位的清单里本来就没有 drag 和剪贴板，这次没改。
- 测试机的 Docker 不支持 user namespace，所以 isolated_new（cua 自己另开 Chromium）跑不起来；不影响用户电脑上的用法。
- cua-driver 已经出了 0.35.x，这次没升级，还固定在 0.34.1。以后升级时要重新核对 BROWSER.md、WORKFLOW.md 和工具的参数格式。


### 助理电脑镜像 0.1.3（修 Apple 芯片 Mac 开机即退出）
- 现象：Mac（Apple 芯片）点开机报「助理电脑开机后又退出了」，容器 pia-desk-shared 约 150ms 后以 126 退出（日志里的 `_XSERVTransmkdir … euid != 0` 只是无害警告）。
- 根因：Dockerfile 写了 `ARG TARGETARCH=amd64`，默认值盖掉了 buildx 注入的平台值，0.1.2 的 arm64 镜像里装的是 x86-64 的 cua-driver → `Exec format error`；start.sh 的 `wait -n` 把 126 带成容器退出码。Docker e2e 只跑 amd64 所以没发现。
- 修复：`ARG TARGETARCH` 不写默认值；构建时执行 `cua-driver --version` 校验；start.sh 开机前自检并给出中文原因；开机退出的错误带退出码含义。
- 防回归：`scripts/smoke-desktop-nerdctl.sh`（nerdctl-full + 独立 rootful containerd，同 Lima）在 ci.yml（固定 digest）和 desktop-image.yml（新构建）里于 ubuntu-latest + ubuntu-24.04-arm 原生运行器上真实开机。
