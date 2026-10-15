# 需求与计划（ROADMAP）

用户提出的需求、计划和待定事项都记在这里，**用户一说就记**，状态有变化随时更新。
状态：`设计中` / `开发中` / `已完成（版本）` / `待用户决定` / `暂缓`。

## 功能需求

2026-10-15 用户报告 beta.22 启动退出（`openJson → makeAdapter → restartChannel`，AES-GCM authentication failed），随后授权「打包」。代码已修复，准备发布 beta.23（仅 mac-arm64）：渠道解密错误不再退出后台，设置可打开、停用保留原密文、微信可重新扫码恢复；渠道相关单测 16/16、两端 typecheck 通过。待构建与安装冒烟通过后公开；真实密钥失配原因与用户安装恢复待验证，详见 HANDOFF「beta.22 启动崩溃」。

当前公开版为 v0.1.0-beta.21（仅 Apple Silicon Mac，Actions 38621370349 构建/安装冒烟/publish 成功；四项公开资产和 arm64 更新清单独立核验，beta.18 完全权限行为保留）。上一版 v0.1.0-beta.20。用户授权剩余功能验收后直接提交、推送、打包；本轮仅 macOS arm64，跳过 Intel、Windows、Linux。发布范围由 `.github/release-scope.json` 的 `mac-arm64` 固定，手动 `scope=all` 可恢复多平台，安装冒烟与平台清单校验成功后才公开。

| 本轮剩余需求 | 当前状态 | 验收与限制 |
|---|---|---|
| 设置 › 模型：「模型服务 / 渠道」要是一个大分类、能一键全部关上；里面的服务要「改回之前那样子」=带图标的卡片网格（『之前那个图标的…搞一个大的分类折叠…模型添加它是一个大的分类，可以直接关上…现在没有那种直接全部关上的…改回之前那样子』） | 已完成（未发布，beta.22 候选） | 父级折叠行 = 展开箭头 + 图标 + 「模型服务 / 渠道」+ 服务数量 + 已配置数；收起后整块（添加渠道按钮 + 搜索 + 内置服务 + 我的渠道）完全不渲染；顶部「默认使用」「识图模型」固定可见、不受父级折叠影响。里面每个服务是**带服务图标的卡片网格**（内置/我的两组各自两列、390 单列），点卡片展开该服务的模型 + 登录 / 编辑配置；图标：内置服务用真实品牌 logo（`provider-icons.ts`，由 `scripts/gen-provider-icons.mjs` 从 `@lobehub/icons-static-svg`（MIT）提取，不联网），自定义渠道 / 未收录品牌（Radius、TypeSafe、Mock）用「名称首字母 + 稳定配色」字母头像兜底（新增 `provider-grid-*` / `provider-icon` testid 与断言）。整合树 `next-release-integration`，基线 `5b6cf11` |
| 快速操作模型（原生 SystemOne / Jev）：默认关闭的本地快速决策模型，chat 替代 adapter + 有界候选选择闭环 | 已完成代码（未发布，beta.22 候选） | 已合入 `055ed8a`+`2a287eb`+`93570c5`（G1–G4 + G3 核验修正）与 `1fbbddb`+`d3432a8`+`78f3d24`+`a487ea5`（原生 Jev 接入）。**原生 Jev 已实现**（早期「G4 只 fail-closed、原生 Jev 阻塞」作废）：从 Pi 公开 `ModelRuntime` 的 classifier 目录选模型（TypeSafe / OpenRouter / 自定义渠道），经公开 `ModelRuntime.classify` 只发受限离散 choice（答案必须是候选 id、置信度缺失不合成、成本缺失记未知不记 0）；鉴权由 Pi 按所选服务在请求时解析，**不读全局 env Key、不把 Key 明文存 settings**；自定义渠道的 SystemOne 分类器（协议 + 模型 id）持久化，启动 / reload 按元数据重新注册。默认关闭、关闭时零额外调用。**未做 / 未验**：真实 Jev 调用（无真实 Key）、chat click 原型性能实测、专项 e2e 全量 |
| 助理电脑：用户自定义虚拟机 CPU / 内存 / 磁盘；空闲自动关机时间改应用内下拉 | 已完成代码（未发布，beta.22 候选） | 设置 › 助理电脑 的空闲时间与 CPU / 内存 / 磁盘都用应用内下拉（`ui.tsx` 的 `Select`，非原生 select；Esc 关菜单、390 不溢出）。资源仅 macOS Lima 可调，Docker / WSL2 明示不可调。`desktop/resources.ts` 纯函数：建议值、可调范围（内核 1–16，内存 2–总内存 75%（≤32），磁盘 20–256）、整数校验（API 拒非法 / 字符串注入）；`mergeInstanceResources` 关机后写配置：用户选择 > 现有实例值（不强行升降配）> 建议值，磁盘只扩不缩（API 也拒绝缩小）。空闲判定 watcher 依赖可注入，假时钟 + 假后端证明 10 分钟边界、busy / 看画面阻关、重启重计时、虚拟机空转（`test/desktop-idle-watcher.test.ts`）。整合树 `next-release-integration`（cherry-pick `236572e`）。**未做**：真实 VM 资源调整、安装包真机 |
| CUA 0.34.1 → 0.35.4 适配升级：批量动作 / 增量观察，逐层权限检查、脚本不绕 guard | 已完成代码与镜像（未发布，beta.22 候选） | `third-party.json` 钉 0.35.4 + 官方 SHA256SUMS 哈希（darwin 资产实下校验一致、二进制可运行）；`run_steps` 展开成每一步逐层套 guard/敏感动作/文件限制（含官方简写 `{click:{…}}`、纯检查、认不出即整批拦）；`run_script` 隐藏 + `CUA_DRIVER_DISABLE_RUN_SCRIPT=1`；提示按真实 schema 改 `tree_format:"elements"`/`full_output:true`/`since:"latest"`。**镜像已重建并核验**：`desktop-image.json` 改 `0.1.4` / `sha256:6cc5c119…d54a42`，GH Actions run [38683611869](https://github.com/MyMiMang/pi-assistant/actions/runs/38683611869) success（build 多架构推 GHCR + amd64 冒烟、nerdctl-smoke arm64/ubuntu-latest；匿名 manifest 交叉核验 tag `0.1.4` digest 一致）。**未做**：`computer.smoke.ts`（需 Docker）、安装包真机、用户 Mac 安装后开机 |
| 子代理默认并发 10、可配置、满额持久 FIFO 排队 | 已完成（beta.19） | 1–100 按助理；释放自动派发；模型设置保存不会重置并发；14 项单测、渠道 5 项通过 |
| 服务重启子代理续跑 | 已完成（beta.19） | 有 session 从断点续跑并核验不明副作用；无 session 标 lost 要求核验；停止/取消不恢复；真实 Mock 进程强杀与重启通过 |
| 图片全屏、缩放、拖动、手机双指、重置、下载 | 已完成（beta.19） | Portal 到 body；聊天与信息面板统一；定向桌面/390px Playwright 全通过 |
| 自定义模型服务删除报不支持 | 已完成（beta.19） | 原生 confirm 换现有 useConfirm；显示当前引用影响；失败保留配置并显示原因；取消/失败/重试/删除链路通过，8 项模型单测通过 |
| Shift+Enter 发送、Enter 换行、IME 防误发、长子代理卡片 | 已完成（beta.19） | 发布树子代理专项与容器宽度专项通过；Enter/Shift+Enter/IME、长路径卡片桌面/390px通过 |
| 移除顶部和输入栏重复电脑入口、按聊天容器隐藏按钮文字、删除审批页脚 | 已完成（beta.19） | 发布树专项8组全过；保留右侧 InfoPane 电脑页；628px容器隐藏文字，宽屏显示，tooltip/aria保留 |
| 聊天外链交给系统浏览器 | 已完成（beta.19），原生点击待用户实测 | Tauri 禁用吞掉点击的 JS opener 拦截，由原生 navigation/new-window 打开；Mac CI 编译与安装冒烟通过，网页外链属性已验证；系统浏览器实际点击未自动操作用户账号 |
| macOS 更新后重复系统授权 | 明确阻塞（不阻塞其他交付） | 本机无 Developer ID 签名证书；adhoc cdhash 随构建变化，不能承诺保留 TCC。诊断见 beta18-macos-signing-tcc-report.md；不自行签证书或安装用户 App |


2026-10-15 用户要求暂缓 Intel 打包：『intel每次打包很久，下次不要打包他，等后期完全开发再带上』——开发版默认跳过 Intel Mac（x86_64）构建，保留 mac arm64 / Windows / Linux x64 / arm64；后期需要时手动运行 release workflow 勾选 `build_intel` 或设仓库变量 `BUILD_INTEL=true` 即可恢复（不改代码）。

2026-10-14 用户要求最高优先修复完全权限下普通操作的审批误报，并明确「修完直接提交打包」。beta.17 热修已完成独立发布树验证（相关单测 37/37、两端 typecheck），待五平台构建与安装冒烟后公开；只发布权限词法 / 规则与回归测试，其他 WIP 留待后续。


2026-10-14 用户确认打包：发布 `v0.1.0-beta.14`（进行中；beta.13 Intel Mac 的 DMG 失败，已修 CI 兼容配置后重发），包含后台子代理与按需聊天分页、用量和组队选模型、聊天思考强度及图片模型筛选修复；沿用多平台构建和 Windows / Mac 安装冒烟后自动公开的流程。

2026-10-14 接手续作：先修复组队选模型 / 用量在完整 e2e 中的失败，跑通整套测试后合入 main；随后按 DESIGN §21 实现后台子代理。真实 Key 的缓存 / 推理 token、账单对账和选模型效果仍待实测；旁路调用计量及群聊每条消息用量尚未完成。

2026-10-15 用户提出权限需求：不要单独做“本地项目目录白名单 / 逐目录授权”，而是把“完全权限”定义为**用户主机上的文件、命令、桌面统一权限**（消除“桌面能操作、文件读写被工作区拦住”的割裂）；同时要求权限判断集中、可维护，不新增框架、不过度防御。已停止独立项目目录授权方案，设计写入 [DESIGN.md](DESIGN.md) §23 并实现完毕（未打包）。

2026-10-15 用户纠正权限定义：『不是完全权限那就得全部都不用审批啊』——只要档位是“完全权限”（开启 + 允许该助理 + 未暂停），**应用层就完全不弹审批**，包括硬性保护清单里的动作（关机、删除、改系统设置等），也包括发送邮件 / 提交表单 / 建定时任务 / 改技能等有后果的动作。不等于删掉认证或安全 deny：凭据 / 密钥路径仍然直接拒绝，暂停 / 降权 / 关闭仍然拦，宿主系统权限弹窗和网站验证码仍然要用户本人处理。实现（DESIGN §23.8）：所有应用层审批的唯一入口 `requests.approval()` 按 `hostFileAccess()` 放行；`ext-approval` 与 `ext-computer` 的硬性保护在 full 下不再创建请求。

| 需求（用户原话大意） | 状态 | 说明 |
|---|---|---|
| Intel Mac（x86_64）构建 | 暂缓（默认不构建） | 用户要求等后期开发完善再带上。release.yml 默认只建 mac arm64 / Windows / Linux x64 / arm64（4 个任务）；恢复：`workflow_dispatch.build_intel` 勾选，或仓库变量 `BUILD_INTEL=true`。跳过时 latest.json 不含 darwin-x86_64，Intel 老用户只停更、不会被分到 arm 包 |
| 完全权限 = 应用层全部不弹审批（含硬性保护动作） | 已完成（beta.18 已发布） | DESIGN §23.8。`requests.approval()` 是唯一入口，按 `hostFileAccess()` 直接放行，email / connectors / delivery / routines / skills / browser / computer / ext-approval 全覆盖；full 下硬性保护不再请求；凭据 deny、暂停/降权/关闭、系统权限弹窗、验证码仍拦；主/子/后台都用父助理当前档位。相关单测 + 两端 typecheck 通过 |
| 普通命令审批误报热修（grep / 日志 / PATH / heredoc / cp 源方向） | 已完成（beta.17 已发布） | 命令位置与实际写入目标集中判定；真实危险嵌套执行仍保护；37 项相关测试与 typecheck 通过 |
| 完全权限 = 用户主机文件/命令/桌面统一权限（不做逐目录白名单） | 已完成（beta.16） | DESIGN §23。一处判定 `hostFileAccess()` 供 sandbox/approval/runtime 统一调用；full 普通命令自动放行（受保护动作的审批行为后由 2026-10-15 纠正改为“也不问”，见上一行）；docker 偏好下 full 走主机（本机执行后端经 pi-adapter 注入）；降权/暂停即中止在跑任务。相关单测通过 |
| 聊天界面模型旁要能选思考强度，修复设置里能选、聊天里却没有的情况 | 已完成（beta.15） | 修复自定义模型推理能力识别和工具栏模型列表刷新；只验证相关流程 |
| 图片模型列表只显示真正能生成图片的模型，复用已有模型参数库识别，避免语言模型混入 | 已完成（beta.15） | 区分图片输入（识图）与图片输出（生成）；去掉“显示全部语言模型”入口，保留手动输入别名 |
| 组建团队（建群）时，按用户已经配好的模型各自擅长什么，自动给成员分配合适的模型；分配结果可以改 | 已完成（beta.15） | DESIGN §22：擅长标签（设置 › 模型 可改）+ 打分；卡片下拉按适合程度排序、显示理由和价格档 |
| 用量系统：每个模型的 token 用量和花费，包括缓存命中，参考 Codex 的用量页 | 已完成（beta.15） | DESIGN §22：按次记录、按当时价格算费用、自定义价 / 折扣、未知显示「—」、人民币显示、设置 › 用量、每条回复用量、群聊费用、90 天后按天汇总 |
| 用量预算与提醒 | 计划中 | 用户说以后再做 |
| 后台子代理：主会话陪用户聊天，自己判断要不要派子代理去后台干活，派完马上接着聊；中途的话由主会话分辨（补充→转给子代理、改方向→调整或重派、无关→直接回、「停」→全停）；子代理做完通知主会话，核验后汇报；1:1 / 群聊 / 微信等渠道一致 | 已完成（beta.19） | DESIGN §21。已定：只一层不嵌套；默认 10 个并发、可配置（见下一行）；沿用现有审批卡经主会话转给用户 |
| 子代理并发上限可配置（默认 10）：满额时新任务自动排队并持久化，有空位自动派发，不拒绝、不要用户再派；重启后队列恢复、FIFO、不重复派发，停止 / 取消的排队任务不偷偷续跑 | 已完成（beta.19） | 2026-10-15 用户要求。DESIGN §21.3 / §21.6：`queued` 状态 + `pumpSubagents` FIFO 派发 + `maxConcurrent`（1–100，默认 10，按助理）；设置 › 模型 › 子代理并发上限；针对性单测 14/14、两端 typecheck 通过 |
| 子代理服务重启后从中断处恢复（并入队列调度）：持久会话 resume，保留任务 / 已完成工具结果，以「先检查进度」提示续跑避免从头重做，取消 / 停止不恢复，幂等调度；不承诺任意副作用 exactly once，未完成工具状态不明要标注并核验 | 已完成（beta.19） | 2026-10-15 用户同意。DESIGN §21.7：`running/stalled` 且已落库 `session_file` 的重入队 `resume=1` 续跑，无 session 的标 `lost` 要求核验不重跑；已取消 / 停止不动；针对性单测 14/14 + 真实进程重启续跑冒烟 `test/subagent-restart.smoke.ts` 通过 |
| 子代理绝不默默结束或卡住：做完、出错、没进展、崩溃、程序重启，主会话都一定知道并告诉用户（原因 + 下一步）；卡片不会一直转圈 | 已完成（beta.19） | DESIGN §21.7：唯一终态 + 事件落库 + 心跳看门狗（3 分钟）+ 最长 60 分钟（已定，可改） + 有 session 重启续跑，无 session 标 lost |
| 子代理也要像主会话一样的独立会话分页，能看回复、思考和工具操作，也能直接发消息；平时在主会话聊，想看时点进任一子代理 | 已完成（beta.19） | DESIGN §21.4；子代理图标 → 选择任务 → 打开分页，默认不自动开页；切换保留草稿，关闭分页不停止任务；运行时插话，结束后续聊 |
| 子代理用哪个模型：设置里勾选允许子代理用的模型；没配置→用主会话助理自己的模型；配了允许清单→主会话按任务和能力在清单内自动挑（复用组队能力画像）；指定了→用指定的 | 已完成（beta.19） | DESIGN §21.5；依赖组队自动选模型的能力画像 |
| 子代理模型改成「每个助理的候选池」（多选）：全局设置移除子代理模型指定/挑选（只保留并发 + 最长运行）；助理设置里可搜索、按服务分组、checkbox 多选候选池，默认跟随主会话；主会话派活时在池内按任务挑；模型不可用（限流 / 服务不可用 / 模型不存在 / 鉴权不通等可恢复故障）只在池内有限 fallback，1 个选项失败 / 池内用尽就明确停，不用池外模型、不无限重试；切换原因 / 使用模型对用户可见，用量归同一任务不重复卡片 | 已发布（beta.21） | 2026-10-15 用户要求。DESIGN §21.5：`subagents.ts`（候选池 + `planFallback` + 迁移 `migrateSubagentModelSettings`）、`model-errors.ts`（故障分类）、`runtime.ts`（会话内换模型续跑）、`Subagents.tsx`/`ModelPicker.tsx`（池多选菜单）；单测（选择 / 迁移 / fallback 决策 / 切换记录，含初始化失败候选不绕回）+ 真实 Mock 进程 fallback 冒烟 `test/subagent-fallback.smoke.ts` + e2e `subagents.mjs` / `model-ui.mjs` 通过；旧单模型 → 单项池、旧全局允许清单迁给无显式配置的助理 |
| 工作中随时发消息、说停就停 | 已完成（beta.12） | DESIGN §20 |
| Windows 装上就能用（中文用户名、端口被占、杀毒软件等），出错时有友好页面 | 已完成（beta.11） | 启动页 + 日志 + 发版前 Windows/Mac 安装冒烟 |
| 桌宠：多款预设 + 用户一句话自己做 | 已完成（beta.10，第一版） | 第二版：每个助理一只、新消息冒泡 |
| jev（TypeSafe）快速决策模型 | 已升级为「快速操作模型」，**已实现（未发布，beta.22 候选）** | 见下方 2026-10-21 新增需求 |
| 快速操作模型（可选，默认关闭）：开启后主模型仍规划 / 授权 / 异常决策，快速模型只在程序给出的有界候选里挑一个控件；关闭时完全沿用主模型、零额外调用 | **已完成代码（未发布，beta.22 候选；已合入整合树 `next-release-integration`）** | 2026-10-21 用户批准（原话大意『用 jev 这种快速模型代替操作，主模型还是思考，没开就主模型来』）。协议调研见 `research/jev-multichannel-evaluation.md`；**原生 Jev（System One）经 Pi 公开 `ModelRuntime.classify` 接入**：从 Pi classifier 目录选模型，鉴权由 Pi 请求时解析（不读全局 env Key、不把 Key 明文存 settings）；另有 chat 替代 adapter（**非 Jev、不合成校准概率**）；`fast-computer/{types,choosers,index,tool,routes}.ts` + `fast_pick_action` 工具（`ctx.executeTool` 走既有 ext-computer 钩子）。单测（`fast-computer*` 共 3 文件）+ 两端 typecheck + web build 通过。**未 push / 未 tag / 未打包 / 未替换用户 App**；未跑真实 Jev 调用、未跑专项 e2e 全量 |

## beta.20 已发布需求

2026-10-15 基于 beta.19（`347bbdf`）整合；主会话模型 UI 六组、任务 UI 全部断言通过。定时任务专项合入后再次验证。已随 beta.20 公开为 Latest，发布结果见 HANDOFF。

| 需求（用户原话大意） | 状态 | 说明 |
|---|---|---|
| 输入栏「模型」和「思考强度」合并成一个按钮：下拉里选模型 + 设思考强度，按钮显示「模型 + 档位」，窄容器只留图标；上下文用量独立显示 | 已完成（beta.20） | 单聊 / 群聊 / 子代理复用同一组件；方案与验收项见 DESIGN §24 |
| 设置 › 模型：自定义渠道（provider）多，按渠道可折叠、不要全摊，能展开看该服务支持的模型；编辑 / 保存 / 删除沿用现有确认框 | 已完成（beta.20） | 不回归原生 `window.confirm` |
| 模型多时：常用 5 个（按实际选择频次 / 最近选择持久化）置顶，其余按渠道分组可搜索折叠；分组与常用不重复 | 已完成（beta.20） | 需要服务端最小统计 |
| 单聊 / 群聊 / 子代理统一模型入口，复用同一组件 | 已完成（beta.20） | — |
| 「任务」概念统一：把后台任务 / 子代理 / 定时跟进等归为同一种「任务」 | 展示层已完成（beta.20） | 共用短标题、状态与列表行；保留后台/子代理各自入口和底层调度，未合并为一个总调度器。DESIGN §25 |
| 任务概览、附件缩略图、步骤成功/失败汇总 | 已完成（beta.20） | 主会话独立 task-ui 全断言通过；移除顶部子代理 tabs 与聊天大指令卡，完整指令在详情折叠保留 |
| 定时任务直接调时分、工作日、每周、间隔、高级 cron | 已完成（beta.20） | 特殊旧 cron、自定义免打扰保留；间隔至少 5 分钟且均匀；解析与专项 UI 通过。DESIGN §26 |
| macOS 透明标题栏与交通灯留白 | 已发布（beta.20，真机交互待测） | cargo check、六组布局通过；原生交通灯、拖动、双击与全屏待安装包真机验证 |

## beta.21 已发布需求

2026-10-21 整合树 `integration-beta21`，cherry-pick `agent-model-pool 6656d0f` 合入 task_wait、推理档位；提交/tag `9215c83`，Actions 38621370349 成功并公开 Latest（仅 macOS arm64）。

| 需求（用户原话大意） | 状态 | 说明 |
|---|---|---|
| 任务等待 `task_wait`：等内部任务 / 子代理 / GitHub Actions run / 到点时由**程序等待**，不 sleep 轮询 | 已发布（beta.21） | 持久 `task_waits` + 事件快速通道 + 兜底 tick；去重唤醒、重启恢复、取消（含任务取消连带）、手动刷新、最后检查时间可查询；provider 只走固定 GitHub REST 端点，用进程已有 token、不读凭据文件。唤醒投递与 `fired` 分离持久化、失败有限重试、重启补投（不承诺 exactly-once，带等待 id 幂等线索）。19 项单测 + 1 项 mock 集成（合作式结束、等待期零模型调用）通过。DESIGN §28 |
| 自定义服务的推理档位：认得出的模型补回 xhigh / max，认不出的保持 Pi 默认，不凭空造 | 已发布（beta.21） | 按 Pi 内置目录同一模型的 `thinkingLevelMap` 补；多托管商映射不一致且无同协议/唯一官方来源时保守不补（启发式，不当中转支持的事实）；请求参数 mock 断言发出 xhigh。DESIGN §24 |
| 子代理模型改为每个助理的候选池（多选）+ 池内有限 fallback | 已发布（beta.21） | 见上方 beta.21 条 |

**beta.21 整合验证**：定向 typecheck、单测 62/62、web/rendezvous 构建、Mock fallback 冒烟、`e2e/model-ui.mjs` 六组、`e2e/subagents.mjs` 全过。仅 macOS arm64。

## beta.22 候选需求

| 需求（用户原话大意） | 状态 | 说明 |
|---|---|---|
| 子代理要能设自己的思考强度（不是一直跟着主会话），每助理可设默认、单个子代理可临时改，运行中也能改 | 已实现待验证（beta.22 候选） | 三层取值「单个覆盖 > 助理默认（跟随/固定）> 跟随主会话」，一律按子代理实际模型 clamp；运行中走 `applyModelSettings`，不动主会话。`subagents.thinking` 列 + `PATCH /api/subagents/:id` + `GET/PUT /api/agents/:id/subagent-thinking` + `spawn_subagent.thinking`。`subagents.test.ts` 20/20，两端 typecheck、web tsc 通过。DESIGN §21.8 |
| 会话 header 上「主会话」chip 去掉；子代理详情保留左上角「返回主会话」；子代理详情 header 的「停止」去掉，停止统一由输入栏按钮承担 | 已实现待验证（beta.22 候选） | `SubagentTasks` 移除 `withMain`；`SubagentChat` header 去停止、保留返回；停止按钮在 composer。`e2e/task-ui.mjs`、`e2e/composer-compact.mjs` 断言已同步 |
| 设置 › 模型 › 子代理 的「子代理并发上限」「子代理最长运行」输入框空白（只有 spinner） | 已修（未发布，beta.22 候选） | 根因：`GET /api/subagents/settings` 返回 `{settings,models}`，组件把整个响应当设置对象 → `d.maxConcurrent/d.maxMinutes` 为 `undefined` → `defaultValue={undefined}` 空白；**后端默认一直是好的**（未配置时 `maxMinutes 60` / `maxConcurrent clampConcurrent()=10`，实测接口原样返回）。改为读 `r.settings` + 受控草稿 + 失焦提交：加载中/失败不渲染可编辑空框、失败显示原因、空/0/越界恢复生效值不静默存 0。新增 `e2e/settings-subagent.mjs`（25 项，含预置旧记录缺字段） |
| 设置弹窗里模型菜单跑偏到整行右边（识图模型实测偏 438px） | 已修（未发布，beta.22 候选） | 根因不是 transform：设置在块级容器里时 wrapper 被拉成整行宽，菜单 `absolute right-0` 相对整行右对齐。改为共享 `usePopover` 统一 portal 到 body + `position:fixed` 按 `getBoundingClientRect` 锚定触发器（上下翻转 + 按可用空间限高 + resize/scroll 重定位）。`e2e/model-ui.mjs` 新增 [5b]（锚定 / 滚动 / 缩放 / 翻转 / 390） |
| 助理电脑：用户自定义虚拟机 CPU / 内存 / 磁盘；空闲自动关机改应用内下拉 | 已实现待验证（beta.22 候选） | 合 `236572e`；review 后又修：共享 `Select` 向上翻转限高（否则 top 可能为负）、菜单内部滚动不再被 window 的 capture scroll 监听关掉、`z-[60]` 高于设置弹窗；`validateResourceChoice` 放行「保留超范围现值」（换到更小的机器时不因内存超 75% 上限而拒绝改其它字段），UI 选项带上现值不空白。新增 `e2e/settings-desktop-resources.mjs`（39 项）。Lima 主盘扩容已核实：`limactl start` 会 `prepareDisk` 对账并扩到配置值，缩小被 Lima 拒绝（`disk shrinking is not supported`），启动失败不吞（转中文错误） |

**统一任务展示**：本轮共用展示组件，短标题由前端截取、不调用模型；完整指令保留。子代理、后台长任务、定时跟进的底层机制保持独立，统一总列表与服务端可选标题接口仍属后续。

**任务等待（task_wait，已实现未打包）**：模型不再 sleep 轮询，而是登记一次持久等待，然后**由模型结束当前回合**（合作式结束，不是强制 yield；工具只写记录并返回提示，模型照做会话才 settle）；内部任务/子代理结束走 bus 事件快速通道，外部 GitHub Actions 走固定 REST 端点按间隔检查，另有到点兜底。等待期间由程序检查、不调用模型；只有结果变化才做一次结构化增量唤醒，唤醒投递失败可重试/重启补投。见 DESIGN §28。

**节省 token 是硬验收点**（不与运行时长挂钩）：
- 等待期间**不调用模型**；优先「事件完成通知」或「定时一次检查」，**不要**用监督代理 `sleep` + 循环问模型的方式盯任务。
- 运行机制已符合：`runtime.ts` 的 `tasks.run` 是独立 Pi session，`promptSession` 跑完工具循环、settle 即 `done` 并释放 session，**不是常驻模型循环**；`proactive.ts` 的跟进落 `proactive_followups` 表，本地 timer（`tickProactive`）到点才 `runHeartbeat`（一次模型调用）。
- 常用任务可展示**累计用量**（按真实模型调用累加）；**文档和界面不能按运行时长估算 / 计算 token**。

**token 效率与主动能力（2026-10-22，`proactive-efficiency` 树，待负责人 cherry-pick）**：
- 子代理终态「双唤醒」修复：同一子代理终态只唤醒一次（`task_wait` 与自动 `notify` 跨机制去重，复用持久投递状态；等待取消 / 投递彻底失败时 notify 补位，不丢不重）。`resumed` 只更新卡片不再唤醒；notify 只带短标题 + 结果摘要，全文用 `subagent_list` 按需查。DESIGN §21.7。
- 主动巡检改为**变化驱动**：复用 bus 信号（后台任务失败等尚无专用唤醒的卡点）+ 已有跟进 / 定时；无变化不空巡（零模型）；有未闭环事项时保留低频有界兜底（最低 4 小时）；提示只带信号差量。`proactive_surface` 可指定相关对话；新增心跳专用 `proactive_advance`，通过相关对话的主会话按用户统一定义走正常权限（完全权限免审批、其他档位审批），忙时同事件合并、异任务排队（每对话 ≤3）。DESIGN §14.12 / §23.8。
- 未做：识图 / 图片生成用量补齐（公开接口未暴露真实 usage，见状态报告）；记忆块缓存与截图累积未实测，不盲改。

## 待用户决定

| 事项 | 状态 | 说明 |
|---|---|---|
| 开源许可证（LICENSE）：用 MIT，还是暂不加 | 待用户决定 | 仓库现在没有 LICENSE 文件；第三方清单见 THIRD_PARTY_NOTICES.md |
| 安装包签名：Apple 公证、Windows 代码签名 | 待用户决定 | 未签名时 macOS 首次要右键打开，Windows 有 SmartScreen 提示；签名需要付费证书 |

## 工作规则（用户定的）

- **每个需求、计划、改动都要马上同步到文档**：新需求写进本页（**原话大意 + 状态 + 验收点**），做完改状态、把进度写进 [HANDOFF.md](HANDOFF.md)（**改了哪些文件 / 什么行为 + 实际跑了什么测试 + 剩余限制或待办**），设计写进 [DESIGN.md](DESIGN.md)；发布说明与「已发布 vs 未发布」的区别、不采信子代理自报当验收等，详见 [AGENTS.md](../AGENTS.md)「文档维护（交付标准）」。
- **只有用户说「打包」才发版**（打 tag）。平时改动只推到 `main`。
- **用户随时可能说「停」**：tag 还没推就不推。tag 推上去以后，发版流程会先建草稿，Windows/Mac 安装冒烟都通过才公开成 Latest。要中途取消运行或者把已经公开的版本改回草稿，需要 GitHub 登录（Actions 页面点 Cancel，或者用已登录的 `gh run cancel` / `gh release edit --draft=true`）。**box 上的 `gh` 没有登录**，只能 git push，所以取消要请用户或有权限的人在网页上操作。

- 2026-10-14 用户补充工作要求：避免过度设计和过度防御；验证只跑失败用例与受影响部分，不随意扩展或重复全量测试。
