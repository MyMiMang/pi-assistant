# 需求与计划（ROADMAP）

用户提出的需求、计划和待定事项都记在这里，**用户一说就记**，状态有变化随时更新。
状态：`设计中` / `开发中` / `已完成（版本）` / `待用户决定` / `暂缓`。

## 功能需求

2026-10-15 用户报告 beta.22 启动退出（`openJson → makeAdapter → restartChannel`，AES-GCM authentication failed），随后授权「打包」。已完成并发布 beta.23（仅 mac-arm64）：渠道解密错误不再退出后台，设置可打开、停用保留原密文、微信可重新扫码恢复；渠道相关单测 16/16、两端 typecheck、构建、Mac 安装包启动及公开更新清单核验通过。真实密钥失配原因与用户原数据恢复待验证，详见 HANDOFF「beta.22 启动崩溃」。

当前公开版为 v0.1.0-beta.23（仅 Apple Silicon Mac，Actions 38710953760 构建 / 安装包启动 / publish 成功；四项公开资产和 arm64 更新清单独立核验）。上一版 v0.1.0-beta.22。发布范围由 `.github/release-scope.json` 的 `mac-arm64` 固定，跳过 Intel、Windows、Linux；手动 `scope=all` 可恢复多平台，安装冒烟与平台清单校验成功后才公开。下表保留 beta.22 等前序功能的交付记录。

| 本轮剩余需求 | 当前状态 | 验收与限制 |
|---|---|---|
| 外观：默认换成「暗夜」、删掉「极简」、新增一套可爱像素风、外观开放给用户 DIY（AI 造主题）——『默认的这个外观替换成暗夜这个外观变成默认；极简删掉；再设计一套可爱一点像素风；外观开放给用户 DIY 让他们 AI 创造，你看怎么弄』 | 已完成（`appearance-theme-ai-workflow` 树，基 `appearance-theme-implementation` `5992517`，未 push / 未 tag / 未打包）：默认 `noir` + 删 `linear` + 迁移 + 首屏不闪白；`pixel` 像素风浅深双版；DIY typed ThemeManifest v1 + 引擎/库存/预览事务 + 设置→外观「用 AI 设计主题」面板与「我的主题」管理；**AI 后端已接通**（`POST /api/themes/draft` + 临时专用 Pi 会话只挂 `theme_draft`，复用当前助理模型，参考图走附件 opaque id，取消/超时真 abort，并发去重）。 | 用户已定：主动选择过的其他主题保留、不 reset；入口只留设置→外观（**已取消 `/主题设计` slash**）；DIY 保存后可编辑/另存新 UUID/导出/删除，预览未保存不覆盖原主题、取消完整恢复；图片默认仅作参考。设计见 [docs/design/appearance-themes.md](design/appearance-themes.md)。验收：`theme-manifest` 22/22 + `appearance-theme` 8/8 + **`theme-ai` 13/13**、前端纯逻辑 `theme-ai-frontend.test.mjs` 4/4、真实 server UI `e2e/theme-ai-ui.mjs` 5/5、`e2e/run.mjs`「外观 DIY」步骤实跑通过（AI 生成/继续改/保存/另存/取消/390）；两端 `tsc` exit 0、`npm run build -w apps/web` 通过。**未验**：真实云模型上的生成质量与参考图实际效果、全量 `e2e/run.mjs`（向导步骤为基线失败）、真机、打包。 |
| 聊天消息引用（reply / quote）：单聊 + 群聊都能引用某条消息再回复；群里「引用谁只叫谁」，引用 A 不叫管理者 / 其它成员，引用 A 但 @B 只叫 B，@all 仍叫全部；引用只是上下文不是授权 | 后端 + UI 已完成，整合验收中（`message-replies-backend` `8d9af27`/`5a9a65f`/`341f0fa` + `message-replies-ui` `f225a85`/`859809a`/`0885369`/`dc83728`，均基 ad3526f，已 --no-ff 合入验收树，未发布） | 设计契约 `docs/design/message-replies.md`（冻结 `ReplySnapshot` / Message DTO、`replyToId` / `clientId`、`GET /api/messages/:mid(/context)`）。实现：`rooms/logic.ts` `planForUserWithQuote`（@ > 引用作者 > 既有管理者；已删除 / 停用成员不误唤 manager，明确提示改用 @；引用 manager 默认不自动扩派）、`messages.ts` + `db.ts` 迁移列（`reply_to_id`/`reply_snapshot`/`client_id`、`room_turns.source_message_id` 去重）、`replies.ts`（可信解析 / 有界快照 / 模型上下文 wrapper）、`http.ts` 路由与 fail closed、`runtime.ts` 单聊注入。删除被引消息时快照 scrub 成不可用不泄露正文；编辑保留原摘录 + `edited`。验证：`test/message-replies.test.ts` 14/14、`rooms.test.ts` 12/12、服务端 tsc 通过、全量 550 项 538 过（2 项改前基线同样失败的既有环境问题）。**限制**：只有用户本人引用会唤醒；跨会话引用未支持 |
| 技能作用域：技能库统一库存（内置 / 用户 / 外部），**默认所有助理不启用任何技能（内置也不启用）**，每个助理一份显式启用清单；外部技能先入库再仅启用目标助理；群成员 / 子代理 / 后台按所属助理同一选集 | 代码完成，整合验收中（`skill-scope-assignment` `96a4c8d`，基 ad3526f，已 --no-ff 合入验收树，未发布） | 约束：不改 Pi SDK / node_modules / 私有 API，只用公开 `skillsOverride` + Agent Skills 规范；运行时经 `pi-adapter`。已落：`skill-assignments.ts`（`settings.skillAssignments`，缺失/`[]` 都是 none，无全局默认无内置例外）、canonical id `来源/名称`、`skills.ts` 三根目录与来源、`pi-adapter` 可选 `skillFilter`、runtime 主/后台/子三处共用 `skillFilterFor(agentId)` + 分配版本入会话 key。验证：新增 `test/skill-assignments.test.ts` 8/8、`test/skill-import.test.ts` 9/9、`test/pi-sdk-boundary.test.ts` 1/1，`rooms` 14/14、`pi-packages`+`isolation`+`test-data-isolation` 6/6，`skill-intel` 6/6，server/web tsc exit 0，web vite build 通过，**e2e `e2e/skills-scope.mjs` 全通过（真实 server+临时数据+Mock）**。**已做**：HTTP/UI（库存启用数 + 按 agent 配置 + 导入弹窗）、外部导入（本地目录 / zip 安全解压、同名冲突不静默覆盖）、`skill_search` 限定可用集、room `members.skills` 落真实 enabledIDs；顺带修 `deleteSkill` 不删 external 目录的 bug。**未做 / 未验证**：网络 git / URL 导入、全量 e2e、真机安装包、真实升级路径端到端。设计见 `docs/design/skill-scope-assignment.md` |
| 真实操控基准「一键真实测试」：不能靠手填枢纽 / 安全无效开关，点开始才开专用窗口 | 代码完成（`benchmark-environment-bootstrap` 树，基 `benchmark-production-fix`，未发布） | 新增 `benchmark-window.ts`（只凭 tools/list 推断「可准备」，hostpc 要驱动自有隔离浏览器，**GET availability 只报元数据不开窗**）；POST start 才「先建窗口→pin 精确身份→再跑」；`benchmark-driver` 真实现 `browser_prepare isolated_new` + `browser_navigate`（随机 nonce）+ `get_browser_state` exact 绑定 + `list_windows`/`get_window_state` pin 原生 pid/window_id，结束只 kill 自有 pid；`benchmark-guard` 受限权限桥（暂停 / 只看档位 / run_script 拒绝）；`benchmark-gateway` 按桌面运行时推 guest 可达别名（拿不到 fail-closed，绝不 0.0.0.0）+ fixture 窄网关（非白名单 403 + 同源）。实跑：两端 tsc exit 0；`fast-computer*`+`host-control` 89/89；新增 window 专件 9/9（含真实本地 HTTP 窄网关 403）。**未真机**：真实 cua 返回字段 / 别名可达性未验证，实现按官方说明 fail-closed。见 `docs/design/benchmark-environment-bootstrap.md` |
| 快速操作模型「加性能测试按钮测速度，慢不建议但不强制」：用户纠正为**真实受控 CUA 操控基准**（不是模型 API 时延 / 固定 choice 题） | 契约 + 后端 + fixture/宿主接线已实现（`fast-model-benchmark` 树，未发布） | 专用隔离 fixture 窗口真实走「观察→候选→快速模型选→执行前精确窗口身份 fail-closed→派发 click→机器状态+独立 UI 观测双证据判分」；快速模型只 click，type 由程序固定输入不计模型能力；共享结果 DTO `FastBenchmarkResult`（p50/p95/timeouts/successRatio/cancel + advisory 不 hard-disable，冷启动单列，p95 样本不足标粗略）；API `GET/POST /api/fast-computer/benchmark`、`GET /:id`、`POST /:id/cancel`，未就绪返回 409 blocked；本轮补齐本地 sandbox fixture（多按钮/下拉/滚动后目标/动态两步）+ 机器状态 reporter（arm + nonce 防串扰）+ `benchmark-host.ts`（availability/并发互斥/只关自有窗口/owner 过滤）+ `benchmark-driver.ts`（真实 MCP 路径，capable 拿不到独立窗口证明即 fail-closed）+ `http.ts` 实际注入 `createRuntimeBenchmarkHost`；单测 20/20（含真 driver 调用序列模拟、token 变化 0 执行、取消清理、nonce 串扰、平台不支持）、服务端 typecheck 通过。**未实测**：真实 CUA 运行（hostpc 未开 / VM 未就绪）、真实桌面上打开 fixture 窗口、UI、全量 e2e。设计见 `docs/design/fast-model-benchmark.md` |
| 统一模型管理：一个服务（baseURL+Key）可同时含 chat / vision / image / classifier；能力按可靠元数据 / Pi 官方目录识别（不靠名字含 Jev、不隐式付费 probe），推断的标「未确认」可用户纠正；生图与快速操作不再单独配凭据；移除独立识图选择器；本地 Laya 一键下载 + health；「实际操作测试」（真实受控 CUA，不是 API 时延） | 已完成代码（统一整合树 `unified-integration`，未发布） | 已合入 registry / Laya / benchmark / 原生弹窗 / 两项手机修复；**S5/S6 已完成**：AddServiceDialog 接 `/api/models/custom` 与 `/api/image-models` 真实 CRUD（官方完整目录未接入也能登录、自定义地址+Key 一次保存、生图服务复用 `ImageProviderForm`、生图适配按 `keyFrom` 复用同一 provider）；删除旧 `VisionModelPicker` / `ImageModelsSection` / 「模型服务 / 渠道」折叠区；快速操作按 `hostpc` / `computer` 各一份 scope，只从已配置的 System One 分类器选；benchmark 结果加 `provenance`（cua/fixture/unknown）按每次结果标明。验证：两端 tsc + vite build 通过；专项单测 95/95（model-registry / classifier / custom-providers / fast-computer / test-data-isolation）；e2e `model-services-ui`（真实 CRUD fixture）/ `model-ui` / `fast-computer-ui` / `custom-provider-delete` / `model-capabilities` 通过。**未真机**：真实 CUA 桌面运行（hostpc 未开 / VM 未就绪）、真实 Laya 下载安装。设计与契约 `docs/design/model-settings-unified.md`；进度 `progress-snapshots/unified-integration.md`；未 push/未打包 |
| 手机每次打开都是第一个助理（不是上次用的那个）+ 点会话窗口聊天记录白加载很久、无 loading 像坏了 | 已修代码（`conversation-loading-restore-fix`，beta.24 候选，待真机） | 根因：`current` 只在内存、`loadAgents` 用 `agents[0]` 兜底且无持久化；切对话清空消息后无 loading / 错误 / 空态，且无并发保护。修法：新增 `selection.ts`（账号隔离 key、恢复优先级：有效 current > `?agent=` > 上次明确打开 > 第一个仅一次；只存公开 id），`store.ts` 加 `msgState` + 请求代号 / `AbortController`（晚返回旧请求不覆盖新目标、乐观消息不被迟到 history 覆盖、失败可重试）、`Chat.tsx` 加骨架 / 错误重试 / 空对话 / 加载更早。已跑：纯逻辑单测 10/10、手机 390 + 桌面纯前端 fixture 10/10、两端 typecheck；**未真机**、未跑全量 e2e。未改 `App.tsx` / 向导 / 模型设置 UI |
| 设置 › 模型：「模型服务 / 渠道」要是一个大分类、能一键全部关上；里面的服务要「改回之前那样子」=带图标的卡片网格（『之前那个图标的…搞一个大的分类折叠…模型添加它是一个大的分类，可以直接关上…现在没有那种直接全部关上的…改回之前那样子』） | 已完成（未发布，beta.22 候选） | 父级折叠行 = 展开箭头 + 图标 + 「模型服务 / 渠道」+ 服务数量 + 已配置数；收起后整块（添加渠道按钮 + 搜索 + 内置服务 + 我的渠道）完全不渲染；顶部「默认使用」「识图模型」固定可见、不受父级折叠影响。里面每个服务是**带服务图标的卡片网格**（内置/我的两组各自两列、390 单列），点卡片展开该服务的模型 + 登录 / 编辑配置；图标：内置服务用真实品牌 logo（`provider-icons.ts`，由 `scripts/gen-provider-icons.mjs` 从 `@lobehub/icons-static-svg`（MIT）提取，不联网），自定义渠道 / 未收录品牌（Radius、TypeSafe、Mock）用「名称首字母 + 稳定配色」字母头像兜底（新增 `provider-grid-*` / `provider-icon` testid 与断言）。整合树 `next-release-integration`，基线 `5b6cf11` |
| 快速操作模型（原生 SystemOne / Jev）：默认关闭的本地快速决策模型，chat 替代 adapter + 有界候选选择闭环 | 已完成代码（未发布，beta.22 候选） | 已合入 `055ed8a`+`2a287eb`+`93570c5`（G1–G4 + G3 核验修正）与 `1fbbddb`+`d3432a8`+`78f3d24`+`a487ea5`（原生 Jev 接入）。**原生 Jev 已实现**（早期「G4 只 fail-closed、原生 Jev 阻塞」作废）：从 Pi 公开 `ModelRuntime` 的 classifier 目录选模型（TypeSafe / OpenRouter / 自定义渠道），经公开 `ModelRuntime.classify` 只发受限离散 choice（答案必须是候选 id、置信度缺失不合成、成本缺失记未知不记 0）；鉴权由 Pi 按所选服务在请求时解析，**不读全局 env Key、不把 Key 明文存 settings**；自定义渠道的 SystemOne 分类器（协议 + 模型 id）持久化，启动 / reload 按元数据重新注册。默认关闭、关闭时零额外调用。**未做 / 未验**：真实 Jev 调用（无真实 Key）、chat click 原型性能实测、专项 e2e 全量 |
| 本地 Laya 一键安装（后端 local-laya manager）：模型服务页一键装 → 自动起 loopback classifier 供「快速操作模型」选用 | 开发中（分支 `local-laya-runtime`，未 push） | 调研见 `research/laya-one-click-cross-platform-feasibility.md`。已做：独立 uv/venv + 平台 pin（Apple Silicon MPS；Intel Mac 条件 pin `numpy<2 torch==2.2.2 transformers==4.57.6`；Win/Linux x64 CPU 基线 + 可选 CUDA/XPU；Win ARM64 明确 unsupported）；staging 原子 activate / 失败回滚 / 取消；随机 token 仅进程内 + 子进程环境，注册 loopback classifier（`/v1/systemone`），**token 不进 status / 日志 / 前端**；仅本机回环不默认暴露局域网；卸载只删 own 目录需确认。**未做 / 未真机**：真实下载与安装、真实 Laya 启动、GPU/CPU 实测、UI 对接（契约 `docs/design/local-laya-api.md`）、性能测试（单独任务） |
| 语音输入本地优先：本地 SenseVoice ASR（sherpa-onnx int8 CPU + managed runtime） | 开发中（分支 `local-asr-sensevoice`，基 `unified-integration`=`ad3526f`，未 push） | 用户原话大意：本地优先、不打包权重、许可不明确就挡安装入口、按需加载短 idle 释放、限物理核线程、不虚构 GPU。已做：权重许可复核（`MODEL_LICENSE v1.1`，issue #334 仍 open → `unresolved`，**不 bundle/不镜像**）；`/api/local-models/asr/sensevoice` 的 status/platform/source/logs/install/cancel/start/stop/pause/resume/idle/update/DELETE/transcribe（全部 localOnly）；`install` 需 `acceptLicense===1.1` 且 `unresolved` 默认关闭，`source:"import"` 走 canonical 校验 + 只复制清单内文件；idle TTL 默认 90s（0=立即释放），从最后一次推理/录音租约释放起算，忙时不 kill，只释放进程保留磁盘；有界退避 + 连续失败暂停；只 kill own pid；统一注册表新增 `type:"asr"` + `asrAdapter`（不伪 chat/classifier、无 token）。验证：server tsc exit 0；`local-asr-*` + local-laya + model-registry + local-models + downloads **86/86**。**未真机**：真实安装/下载/启动/转写、RTF/RSS、Intel/Windows/Linux、CoreML 均未测；sherpa-onnx 轮子未 pin 哈希。契约 `docs/design/local-asr-api.md`；许可 `research/sensevoice-weight-license-review.md` |
| 助理电脑：用户自定义虚拟机 CPU / 内存 / 磁盘；空闲自动关机时间改应用内下拉 | 已完成代码（未发布，beta.22 候选） | 设置 › 助理电脑 的空闲时间与 CPU / 内存 / 磁盘都用应用内下拉（`ui.tsx` 的 `Select`，非原生 select；Esc 关菜单、390 不溢出）。资源仅 macOS Lima 可调，Docker / WSL2 明示不可调。`desktop/resources.ts` 纯函数：建议值、可调范围（内核 1–16，内存 2–总内存 75%（≤32），磁盘 20–256）、整数校验（API 拒非法 / 字符串注入）；`mergeInstanceResources` 关机后写配置：用户选择 > 现有实例值（不强行升降配）> 建议值，磁盘只扩不缩（API 也拒绝缩小）。空闲判定 watcher 依赖可注入，假时钟 + 假后端证明 10 分钟边界、busy / 看画面阻关、重启重计时、虚拟机空转（`test/desktop-idle-watcher.test.ts`）。整合树 `next-release-integration`（cherry-pick `236572e`）。**未做**：真实 VM 资源调整、安装包真机 |
| CUA 0.34.1 → 0.35.4 适配升级：批量动作 / 增量观察，逐层权限检查、脚本不绕 guard | 已完成代码与镜像（未发布，beta.22 候选） | `third-party.json` 钉 0.35.4 + 官方 SHA256SUMS 哈希（darwin 资产实下校验一致、二进制可运行）；`run_steps` 展开成每一步逐层套 guard/敏感动作/文件限制（含官方简写 `{click:{…}}`、纯检查、认不出即整批拦）；`run_script` 隐藏 + `CUA_DRIVER_DISABLE_RUN_SCRIPT=1`；提示按真实 schema 改 `tree_format:"elements"`/`full_output:true`/`since:"latest"`。**镜像已重建并核验**：`desktop-image.json` 改 `0.1.4` / `sha256:6cc5c119…d54a42`，GH Actions run [38683611869](https://github.com/MyMiMang/pi-assistant/actions/runs/38683611869) success（build 多架构推 GHCR + amd64 冒烟、nerdctl-smoke arm64/ubuntu-latest；匿名 manifest 交叉核验 tag `0.1.4` digest 一致）。**未做**：`computer.smoke.ts`（需 Docker）、安装包真机、用户 Mac 安装后开机 |
| 子代理默认并发 10、可配置、满额持久 FIFO 排队 | 已完成（beta.19） | 1–100 按助理；释放自动派发；模型设置保存不会重置并发；14 项单测、渠道 5 项通过 |
| 服务重启子代理续跑 | 已完成（beta.19） | 有 session 从断点续跑并核验不明副作用；无 session 标 lost 要求核验；停止/取消不恢复；真实 Mock 进程强杀与重启通过 |
| 图片全屏、缩放、拖动、手机双指、重置、下载 | 已完成（beta.19） | Portal 到 body；聊天与信息面板统一；定向桌面/390px Playwright 全通过 |
| 自定义模型服务删除报不支持 | 已完成（beta.19） | 原生 confirm 换现有 useConfirm；显示当前引用影响；失败保留配置并显示原因；取消/失败/重试/删除链路通过，8 项模型单测通过 |
| Shift+Enter 发送、Enter 换行、IME 防误发、长子代理卡片 | 已完成（beta.19） | 发布树子代理专项与容器宽度专项通过；Enter/Shift+Enter/IME、长路径卡片桌面/390px通过 |
| 移除顶部和输入栏重复电脑入口、按聊天容器隐藏按钮文字、删除审批页脚 | 已完成（beta.19） | 发布树专项8组全过；保留右侧 InfoPane 电脑页；628px容器隐藏文字，宽屏显示，tooltip/aria保留 |
| 聊天外链交给系统浏览器 | 已修（`hotfix-integration`，beta.24 候选，待安装冒烟） | 根因：主窗口是远程页面，opener 插件默认 JS 拦截会 `preventDefault` 再 invoke `plugin:opener|open_url`，但 `remote-ui` capability 未放行该命令（`opener:default` 的 `windows: []` 不覆盖任何窗口）→ 点击被吞；beta.19 只关掉 JS 拦截、改走原生 `on_new_window`/`on_navigation`，安装版实测仍无反应且原回调 `let _ =` 吞错误。修法：`apps/web/src/externalLinks.ts` 页面侧显式接管（只认 `__TAURI_INTERNALS__`、只放行 http/https/mailto、preventDefault→invoke→退回 window.open→失败弹可见提示），`remote-ui` 放行 `opener:allow-open-url`+`opener:allow-default-urls`，Rust 加 `is_external_link` 白名单并不再吞错误。已跑：13/13 单测、两端 typecheck、web build；**未跑**：cargo build、安装包真机点击 |
| 升级后已配置仍被强行重设首次向导 | 已修（`hotfix-integration`，beta.24 候选，待真机） | 根因：`/api/system.onboarded` 依赖 `defaultModel()` 实时解析，配置读取暂时失败 / 模型不可解析返回 null → 已配置误判未配置。改为只看持久信号（向导标志 / `defaultModel` 设置 / 助理数量）+ 启动幂等恢复丢失标志，新增 `modelReady` 单列模型可用性；界面提示可恢复错误而不重走。onboarding 7 项 + HTTP 级 1 项通过 |
| 渠道删除按钮点不动（微信 ClawBot） | 已修（`hotfix-integration`，beta.24 候选，待真机） | 根因：原生 `window.confirm` 在 Tauri remote webview 不弹窗且返回 false → DELETE 不执行。换应用内 `useConfirm`（ConfirmDialog）+ aria-label/data-testid，删除中 disabled + ref 防双击，失败显示原因，坏凭据连接不解密也能删。`e2e/channel-delete.mjs` 纯前端 fixture 通过（取消零请求 / 失败留存 / 慢删除防双击 / 390 宽 / 无原生 confirm） |
| 侧边栏凭空多出助理「小微」（单测污染真实库） | 已修根因（`hotfix-integration`，beta.24 候选） | `test/setup.ts` 的 `PIA_DATA_DIR ??=` 在外部已有该变量（或 WIP 删过该行）时，`clawbot.test.ts` 把测试助理与渠道行写进用户真实数据目录 → 下次启动「微信凭据无法解密」。改 `=` 强制覆盖 + 新增 `test-data-isolation.test.ts` + `seed-copy.test.ts` 补 setup 前置。**未删除**用户库里已有的「小微」与测试渠道行（等用户确认）；未碰用户真实微信连接 |
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
| 子代理要能设自己的思考强度（不是一直跟着主会话），每助理可设默认、单个子代理可临时改，运行中也能改 | 已实现待验证（beta.22 候选；2026-10-22 修「选项不全」） | 三层取值「单个覆盖 > 助理默认（跟随/固定）> 跟随主会话」，一律按子代理实际模型 clamp；运行中走 `applyModelSettings`，不动主会话。`subagents.thinking` 列 + `PATCH /api/subagents/:id` + `GET/PUT /api/agents/:id/subagent-thinking` + `spawn_subagent.thinking`。`subagents.test.ts` 20/20，两端 typecheck、web tsc 通过。**2026-10-22 修**：助理设置默认档位原来取候选池交集（任一模型不支持就裁掉 xhigh/max），改为共享 `thinkingLevelsFor` 取并集（空池 = 主会话模型，与主会话一致），详情在 clamp 时给 tooltip；`subagent-thinking-options.test.ts` 2/2 + `subagents`/`custom-providers`/`subagent-resume-safety` 51/51，两端 tsc 通过（浏览器 e2e 未跑，本树 vite build 环境错）。DESIGN §21.8 |
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

## 记忆作用域安全（2026-10-15，`memory-scope-safety` 树，基 `unified-integration` `66ae16b`，**未 push / 未 tag / 未打包**）

| 需求（用户原话大意） | 状态 | 说明 |
|---|---|---|
| Hindsight 记忆按主建议改：完整可用 + 分层，不禁子代理 | 已改，待核验 | 依据 `docs/research/hindsight-integration-audit.md`。新增 `MemoryOrigin{actor/status/…}` provenance（服务端注入，工具不可伪造 actor）；子代理/后台/群来源写 fact 默认降为 task 草稿（不落共享 user 库），主会话/用户写 verified；新增 `scope=task` 短期草稿（默认 7 天 TTL，`memoryTaskDraftTtlDays` 可配）。设计见 `docs/design/memory-scope-safety.md`。 |
| 主会话核验后晋升，去重/幂等，不盲覆盖 | 已改，待核验 | `memory.promote`（幂等；只与已确认条目按规范化文本去重、不新增不覆盖正文、证据累积到 `evidenceRefs`；agent 级晋升原地转正、不因账本同文本去重而消失）+ `memory.rejectDraft`；新增仅主会话注入的 `memory_review` 工具。 |
| 删除/更新只能 own 任务/own writer；共享需主/用户 | 已改，待核验 | `canMutate`：子代理删共享 user / 他人条目服务端拒绝（含完全权限档位，语义非审批）。 |
| 旧记忆不降级/不删、legacy 可读；不批量 rewrite | 已改，待核验 | 无 origin 的旧条目读取标 `legacy`、保持原 scope 可见；`meta` 增量字段。reflect 源端也用官方 untagged/global 范围（`{tags:[],match:'exact'}`）保留无 tag 旧忆。 |
| readOnlyHint 修正；别一刀每条记忆都弹审批 | 已改，待核验 | `remember` 真实写入但 `destructive:false/openWorld:false`（非完全权限也不弹）；`forget` `destructive:true`（按档位审批）；`recall/reflect` 保持只读。完全权限仍应用层免审批。 |
| 测试（fake Hindsight + 临时目录 + 内存凭据） | 已跑 20/20 | `memory-scope-safety`(12) + `memory-retain-dedup`(1) + `hindsight-scope`(1) + `hindsight`(4) + `hindsight-switch`(2)，全通过；服务端 `tsc --noEmit` exit 0。旧 `hindsight.test`/`hindsight-switch` 已注入内存凭据首次真跑。真实 HTTP retain/reflect（需 LLM 凭据）未验，只做官方 0.10.3 过滤层实物验证。 |
| 同文本不同 task 草稿不互吞 | 已改，待核验 | `RememberInput.dedupe`（默认 true）；草稿写入不去重，不同任务/子代理的同文本草稿是两条账本条目；已确认写入仍去重。 |
| reflect 源端隔离：子代理反思不能看到兄弟 task 草稿 | 已改，待核验 | 服务端 retain 打 provenance tag（`scope:`/`status:`/`actor:`/`task:`/`conv:`）；`memory.reflect` 按 actor/task/conversation 在**请求里**限定允许集合（`tag_groups`），provider 未拿到显式作用域直接拒绝（fail closed）；子代理请求不把兄弟草稿送进模型。官方 0.10.3 `engine/search/tags.py` 实物核实 tag 语义；本任务只取 `status=draft`，已驳回/已晋升不再进证据；user 库非核验视角也显式限定。 |


| 需求（用户原话大意） | 状态 | 说明 |
|---|---|---|
| 更新后已配置还强制走 setup 环节 | 已改，待核验 | 根因：`/api/system.onboarded` 依赖 `defaultModel()` 解析，配置读取暂时失败 / 模型暂不可解析时返回 null → 已配置被误判为未配置。改为只看持久信号（向导标志 / `defaultModel` 设置 / 助理数量）并新增 `modelReady` 单列模型可用性；启动时幂等恢复丢失的向导标志；界面提示可恢复错误而不重走向导。新装仍引导，只助理或只模型都不算完成。新增 `onboarding.test.ts`（7 项）+ `onboarding-recovery.test.ts`（HTTP 级），连同 `custom-providers`/`channels`/`clawbot` 共 32/32 通过。 |
| beta.23 渠道修复复核 | 已复核，无需再改 | `6cf31fe` 把 `makeAdapter` 纳入启动 try、解密失败转中文恢复提示、未重填保留密文；覆盖现场崩溃路径，未触碰 `secrets.ts` 与用户数据。本轮不重复改，也未把未解的钥匙串根因宣称已解决。 |

## 手机端 App shell / 输入框 viewport 修复（2026-10-15，`mobile-chat-viewport-fix` 树，基 `hotfix-integration` `b7d33d3` + `9554628`，**未 push / 未 tag**）

| 需求（用户原话大意） | 状态 | 说明 |
|---|---|---|
| 手机浏览器用 Pi，最顶栏和底部输入框会随整页上下移动、不固定 | 已修，待真机确认 | 根因：① 手机媒体查询里 `body{overflow:auto}` 让**整页**成了滚动容器；② `html,body,#root{height:100%}` 在 iOS Safari 取的是「地址栏收起后」的高度（比可见区域高）→ 页面本身可上下拖，`position:absolute` 的输入栏和外层顶栏就跟着走。修复：`html,body{overflow:hidden}` + `#root{height:var(--pa-vvh)}`（由 `visualViewport` 写 px，无 JS 时退回 `100dvh`/`100vh`），只有聊天内容区 `.pa-scroll` 滚动。新增 `e2e/mobile-viewport-ui.mjs`（纯前端 fixture，390/375/430 三档 + 群聊 + 横竖屏 + 桌面回归，123 项全通过）。 |
| 点输入框页面自动放大，打完看聊天要手动缩回 | 已修，待真机确认 | 根因：默认皮肤 `.pa-app` 13.5px 继承进 `textarea/input`（`.pa-composer textarea{font:inherit}`，实测 computed 13.5px < iOS 的 16px 阈值）。修复：`@media (max-width:820px),(pointer:coarse)` 下只把 `input/textarea/select` 提到 16px，**不动版面字号**（整页仍 13.5px），桌宠小窗排除。**不加** `user-scalable=no`/`maximum-scale=1`，保留双指缩放与文字缩放。 |
| 键盘弹起 / 收回、横竖切换、地址栏折叠后输入与末消息仍可见 | 已实现，待真机确认 | iOS Safari 键盘是覆盖式、不缩布局视口，`100dvh` 也不变，所以用 `visualViewport` 写 `--pa-vvh`（Chromium 另有 `interactive-widget=resizes-content` 兜底）；视口变矮后把原本贴底的聊天区重新贴住最后一条（按塌缩高度补松弛量）。`scale != 1` 时不介入，保住 pinch zoom。主会话 / 群聊 / 子代理共用同一套 `html`/`#root` 规则，**没有三份复制**。真机 iOS 键盘未验证（Playwright 无真 iOS 键盘，e2e 用缩小视口近似）。详见 `progress-snapshots/mobile-chat-viewport-fix.md` |

## 聊天附件应用内预览（2026-10-22，`file-preview` 树，基 `unified-integration` `3bf2c01`，**未 push / 未 tag**）

| 需求（用户原话大意） | 状态 | 说明 |
|---|---|---|
| 聊天里的文件卡片（如 `voice-input-feasibility.md`）只有下载图标，点卡片没有任何预览；要求点卡片主体 / 文件名在应用内打开预览，下载图标保持独立（不误触预览） | 已实现代码，待主 review 合入（未打包） | 新增共享 `apps/web/src/components/FilePreview.tsx` + 纯逻辑 `apps/web/src/preview.ts`，聊天上传 / 交付 / 信息面板「文件」共用；非图片卡片改为「主体按钮（预览）+ 独立下载按钮」，避免嵌套按钮。支持 Markdown（默认渲染 + 可切源码，复用现有 react-markdown）/ 纯文本 / log / json / 代码（行号 + 复制）/ CSV（引号内换行、有界表格）/ PDF（`<object>` 内嵌 + fallback 提示 + 下载）；xlsx / docx / pptx / HTML / SVG / 压缩包明确标「暂不支持预览」，只下载、不执行。安全：只走授权资源地址 `/api/files/:id` 带登录凭证拉取，不读本机任意路径 / URL、不绕权限；类型判定扩展名 + MIME + 实际字节嗅探（二进制不当文本解码）；文本上限 1MB、CSV 500×50、代码 5000 行；Markdown 外链图片默认不自动加载、链接只放行 http/https/mailto（javascript: / data: / 相对文件引用不渲染成链接）；PDF 只用本会话 blob，不外源、不服务端 exec / 云上传。 |
| 验证 | 已跑（纯前端 fixture，未碰钥匙串 / 真实数据） | `e2e/file-preview.mjs` 桌面 + 390 共 37 项全通过（点主体预览、Markdown 渲染/源码切换 / 下载不误触 / 39KB Markdown 表格代码 / 外链图不自动加载 / 危险与相对链接不成链 / CSV 引号换行 / 代码行号复制 / 不支持类型 / 超限不下载 / 404 重试 / PDF object+fallback / 图片仍走 ImageViewer / Esc + 焦点返回 / 390 工具栏）；web `tsc --noEmit` + `vite build` 通过；`e2e/mobile-viewport-ui.mjs` 回归全通过。**未做 / 未真机**：xlsx 等 Office 预览（无安全库，明确暂不支持）、真机 iOS 手势、真实 PDF 内嵌（headless 无 PDF 插件，只验 fallback）。 |

## 语音输入（输入栏语音→文字草稿）（2026-10-15，`voice-input-implementation` 树，基 `unified-integration` `ad3526f`，**未 push / 未 tag**）

| 需求（用户原话大意） | 状态 | 说明 |
|---|---|---|
| 输入栏加语音输入：点麦克风录音、再点停止，转成文字**插入开始录制时的光标锚点**，**保留用户后续编辑**，**不自动发送** | 已实现代码，待主 review 合入（未打包） | 独立 `VoiceInput.tsx` + `useVoiceInput` hook + 纯逻辑 `voice-input.ts`；发送键旁可发现麦克风按钮；状态 `idle/preparing/recording/transcribing/error/finish`；最长 60 s；取消只丢语音、不清 draft/replyTo；切对话/页面隐藏立即 stop tracks + 取消不发送；16 kHz PCM16 WAV 链路（真实重采样，不假 16000，不引 FFmpeg 全依赖）。设计见 [design/voice-input.md](design/voice-input.md)。 |
| 麦克风位置修正（用户原话：「这个麦克风放在发送键旁边」）——之前渲染在**左侧附件工具列**（回形针旁边），与最初「发送键旁」不符 | 已实现代码，本树未发布（用户调整） | 麦克风 / 停止 / 取消固定贴在发送键**左侧紧邻**：`.pa-voice-ctl`（`flex:none`、`align-self:flex-end`）与发送键同属 `.pa-composer-bar`，单聊 / 群聊一致；390 / 矮窗不换行、不挤权限 / 模型选择器。提示与未配置的「去设置」移到**独立 status 行**（`.pa-voice-status`，`order:1;flex-basis:100%`），不拖动发送键、错误信息仍可见（`voice-hint`）。子代理输入栏没有麦克风（语音只做主 / 群），共享 composer CSS 已回归。 |
| 服务端统一 ASR 模型类型 + 薄 adapter（不另起 key 孤岛） | 已实现代码，待主合 | 注册表 `ModelType` 加 `asr`、`ModelCapability` 加 `asr`；`POST /api/audio/transcriptions`（multipart，WAV 头/采样率/声道/时长/字节校验、abort+超时、幂等只在 completed 返回、错误 redact、音频只在内存、不远程 fetch/不 ffmpeg 任意路径/不 SSRF）；复用 provider 的 baseUrl+key（**不读 secret.ts**）；未知能力不靠名猜、chat 多模态不自动算 ASR、云 fallback 不偷偷变收费。 |
| 本地 SenseVoice provider 的接口契约（安装/生命周期由另一子代理做） | 契约已定，另一子代理实现 | `source: "local"`、`kind: "local"`、`protocol: "openai-audio-transcriptions"`、`baseUrl` 本机回环、`local{installed,running,state,device}`、本地不需 key。见 design §4.1。 |
| 双向语音通话 | **不做**（用户已取消） | 本设计明确排除，不实现。 |

验证：服务端假 PCM / 假 provider / 内存凭据 / 强制 tmp 数据目录（不联网、不开麦、不产生费用）；前端纯逻辑（取消 0 请求、开始 1 次 getUserMedia、权限拒绝、页面隐藏、真实 16k WAV、真重采样、锚点插入、stale 对话不插入、IME、replyTo 共存、390）。真机（iOS 录音/键盘、真实音质、真实云 ASR、本地模型速度）**未验证**，不 claim。

麦克风位置修正（2026-10-16，本树本地未发布，用户调整）：`e2e/voice-input-ui.mjs` 加几何断言——`voice-mic` 与 `.pa-composer-bar .pa-send` 必须同一 composer-bar、DOM 在发送键之前、同一行（中心 y 差 ≤6px）、紧贴其左（间隙 ≤14px），且不在 `.pa-composer-tools` 里；单聊 / 群聊 / 390 / 1440×560 矮窗各验一遍，并断言录音时发送键 x 不位移（提示走独立 status 行）。实跑：该脚本全通过；`e2e/composer-compact.mjs`（单 / 群 / 子三入口 390 / 1280 / 1440）回归全通过；web `tsc --noEmit` + `vite build` 通过。未跑全量 e2e。

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
