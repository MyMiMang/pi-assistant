# 请求级 Fast（OpenAI `service_tier`）· 实现合同

> 状态：**候选实现，未发布 / 未 push / 未 tag / 未打包**。工作树 `fast-inference-mode-implementation`，基 `thinking-slider-visual-refinement` HEAD `8b8d836`（保留用户已批准的粗渐变轨 / 实心无字白圆 / 居中 strength / 模型名次行）。Pi 依赖 **1.3.0**；不改 SDK / `node_modules` / 私有接口。
> 相关研究：`research/fast-inference-mode-review.md`、`research/fast-mode-source-check/`（OpenAI 官方文档原文）、`research/sub2api-fast-mode-review.md`（公开中转源码审计，只代表 pinned commit 0.2.17，不代表用户实际站点）。
> 本文是实现事实与边界的唯一契约；界面文案、测试口径、消息 meta 都以这里为准。

## 1. 这是什么 / 不是什么

- **是什么**：用户点输入栏模型弹层左上角的闪电，就为这个助理（或单个子代理覆盖）的**下一次 provider 请求**附加 `service_tier: "priority"`。这是 OpenAI Responses / Chat Completions / Codex 的公开参数，官方 `fast` 也映射到 `priority`，所以固定发 `priority`（不新增第二层「每个模型声明参数名/值」的配置）。
- **不是什么**：不是把思考强度降到 `low/minimal`；不改思考档位；不换模型 / 不换候选池；和「电脑快速操作模型（Jev / Laya）」完全无关、不共用设置或状态。
- **作用范围**：正常对话回合（含工具循环、自动重试）。上下文压缩 / 摘要请求不带（Pi 的 `compact()` 不经过 `onPayload`，也更省钱）。
- **作用对象**：按**本次 hook 实际拿到的 model.api** 判断，不用「最初选择的模型」；所以换模型 / 池内 fallback 到不支持的协议时不会误发。主题设计、自动总结等使用独立会话的路径不挂 Fast。

## 2. 接入方式（只用公开能力）

- `session.agent.onPayload`（Pi 公开字段，`ProviderRequestOptions.onPayload`）：在每次 provider 请求前读当前开关与本次 model，必要时返回替换后的 payload；**组合**已有 `onPayload`（先跑原 hook，再在它的结果上判断；我们不改时必须把原 hook 的替换结果继续返回，不能吞掉别的 instrumentation）。
- `session.agent.onProviderStreamEvent`（公开）：只读地观察实际 tier；同样组合已有 hook。
- 不打印 / 不落库 raw payload、stream body、headers、密钥；不拦 abort；不接管 Pi 的重试机制。
- 关掉 = **不附加** `service_tier`；绝不补 `auto` / `default` 去覆盖服务 / 项目原设置。

## 3. 能力口径（不冒充真支持）

后台三态：

| 口径 | 含义 | 当前判定 |
| --- | --- | --- |
| `supported` | 有**服务级明确声明**（文档 + 模型范围） | 目前没有，保留给以后；**不按 provider 名或模型名猜** |
| `requestable-unverified` | 协议能带该字段，但服务 / 模型不一定支持、可能降级或额外收费 | 所有 OpenAI 兼容协议（含官方 OpenAI）；用户仍可显式请求，界面写明未知 |
| `unsupported` | 协议没有这个字段 / 本地托管 | `anthropic-messages`、Azure Responses、Google、Bedrock、Mistral、本地 llama.cpp / Laya 等，显示「当前接口暂未接入 Fast」并说明本次不发送 |

- 官方 OpenAI 文档只证明参数存在；具体模型 / 账号仍可能拒绝或降级（ChatGPT 登录、自定义 endpoint 更未实测），所以 `provider === "openai"` **不**等于 `supported`。
- 不宣称 Anthropic「没有 Fast」：Anthropic 有独立的 `speed: "fast"`；本轮只实现 OpenAI / Codex 语义，文案统一写「当前接口暂未接入 Fast」。

## 4. 状态与落库

- 助理级：`agents.fast`（`INTEGER NOT NULL DEFAULT 0`，轻量迁移）。主会话 / 群成员 / 后台任务 / 定时任务都用所属助理这一列。
- 子代理覆盖：`subagents.fast`（`INTEGER NULL`）；`null` = 跟随所属助理，`1/0` = 独立开 / 关。与 `thinking` 完全独立的两列，互不修改。
- 不新增「助理级子代理 Fast 默认」设置页：子代理默认就是跟随。
- 路由：`PATCH /api/agents/:id { fast }` 只 `UPDATE agents.fast`；`PATCH /api/subagents/:id { fast }` 只 `UPDATE subagents.fast`；`GET /api/models` 每个模型附 `fast: { capability, reason? }`。`SUBAGENTS` 详情附 `resolvedFast`。
- 前端各 context 用各自的值（助理 / 子代理），不共用全局 localStorage；保存中 `pending` 禁重复，失败只回滚 fast 字段并给原因（不覆盖同时修改的 thinking / 模型 / 消息）。同一助理的多入口共用一份「最后一次为准」写入（`LatestWrite`，确认值来自服务端响应），迟到成功 / 失败不落地。**同端顺序**：同一个助理的 Fast PATCH 走 `SerialWriteQueue` 串行发出（服务端 `PATCH /api/agents/:id` 是读 body → 同步原子 `UPDATE` → 返回，没有 await 到写库，所以客户端串行就保住本端点击顺序），界面仍在点击时立即乐观更新，可随时表达新意图。**边界**：这是**本端**顺序，不是服务端事务——不同设备 / 另一个客户端并发写仍以服务端最后处理的那次为准；没有新增版本号 / CAS，也不假装有。失败回滚取**服务端当前真值**（`GET /api/agents` 重读；外部设备的 WS 刷新可能已让本地确认值过时），只有读不到时才退回本端上一次确认值。`patchAgent`（thinking / 模型）只合并本次请求改的字段，避免它的迟到响应把并发的 fast 写回旧值。

## 5. requested ≠ accepted ≠ observed（关键）

| 层 | 证据 | 能说什么 |
| --- | --- | --- |
| requested | 最终 HTTP 请求体里实际有 `service_tier` | 「已请求 priority」 |
| 200 / 字段被接受 | HTTP 状态 | 不能单独证明加速 |
| 非终止回显 | Responses `response.created`、Chat Completions 流式 chunk | 只是「服务回显 X」，来源可能是 requested，**不能证明实际档位** |
| 终止回显 | Responses / Codex 的 `response.completed` / `done` / `incomplete` / `failed` | 才可能是实际档位；`priority/fast` 才标 observed Fast |

- **`default` 不等于标准计费、也不等于没走 Fast**：Codex OAuth 常见 default 回显但按 priority 计费（sub2api `service_tier_billing.go`）。UI 只写「服务回显 default（实际加速未确认）」，禁止写「被降级为标准档 / 已降费」。
- 终止回显 `priority` 也只写「服务回显 Fast」，不保证 wall-clock 更快。
- 没有回显 → 「已请求，服务未回显实际档位」；不把 200 当成功。
- 回显状态每次请求重置，不把上一条回复的 tier 套到换模型后的下一次请求。
- 消息 `meta.fast` 只存短对象：`enabled / requested / status / capability / api / observed / observedKind / reported / reportedKind / reason`，不存 raw body / header。**开着但因协议不支持 / 请求体异常没发出去时也写 meta**，错误消息同样带上，避免「灯亮着但用户不知道没发」。

## 6. 错误与费用

- 400 / 403 原样报错；**不自动删参数重发**（会重复推理 / 重复计费）。中转策略 `block` 常见 403 `permission_error`，与 400 一样只发一次。
- 不主动关闭 Fast，不自动降档、不自动换模型。
- 费用：不承诺通用倍率；文案「可能增加用量 / 费用（部分站点约 2 倍或更高），以服务商账单为准」。Pi 若从终止事件观测到 priority 会按自身价格规则计算；但中转可能配置 `free_openai_fast` 或自定义倍率，**不把 2x 当所有站承诺**。
- 关闭时若请求里本来就有服务 / 模型配置的 tier（`samplingParams` 或别的 hook），如实标 `externally-configured`，不宣称「本次标准档」。

## 7. 界面

- **左上角闪电是真按钮**（开 / 关），彻底替换原四角星；44px 透明命中区、20–22px 图标；`aria-pressed` 表示开关，不可用用 `aria-disabled`（仍可聚焦看原因，不用 native `disabled` 把 tooltip 也禁掉）；等待保存 `aria-busy` 且不响应重复点击；开启高亮、关闭低强调；颜色 / 圆角 / 动效走主题 token，覆盖 glass / warm / noir / pixel 与 DIY，reduced-motion 下无额外动画。
- 悬停约 450ms 出短介绍（复用 `Help` 的气泡定位 / 样式 / 外部点击规则，新增极小的 `useHoverTip`）；focus 立即显示、触摸点按同时聚焦显示说明并切换；不使用 native `title` 作为唯一说明。
- **Esc 按叠加顺序关**：菜单和气泡都监听 `document` 捕获阶段，同一节点上的监听器按注册顺序执行、`stopPropagation` 挡不住彼此，所以按「打开顺序」维护一个小栈（`apps/web/src/esc-layer.ts`）：只有最上层（例如菜单里悬停出的 Fast 说明）处理这一下 Esc，关掉后这一下不再往下传 —— 效果是「关说明不关菜单」，再按一次才关菜单，不把底层设置弹窗一起关。
- 非推理 / 单档模型仍显示闪电（Fast 独立），不把 Fast 绑在「>1 档」上；协议不支持时显示原因，点击不产生请求。
- **两层紧凑弹层**（聊天 / 输入栏入口）：默认只显示当前强度标题、可点击的当前模型名（带箭头）、Fast、滑块 / 必要重置；点模型名才进完整目录（搜索 / 服务分组 / 常用全部保留）；选完模型回紧凑层并更新头部；「返回」只退一层，不改模型 / 思考 / Fast；Esc 在目录里退一层、紧凑层才关闭；焦点回触发器 / 模型名（键盘 Enter 打开时直接落在模型名）；390 宽走底部弹层不溢出。**目录层只选模型**：强度滑块 / Fast 已在紧凑层，不在目录里重复一整套（管理型入口没有紧凑层，仍保留菜单里的强度块）。
- 模型目录加载中 / 加载失败：紧凑层不冒充「不支持思考强度」，失败给「模型目录没加载出来 + 重试」（`error` + `onRetry` 复用 `useConfiguredModels().reload`），成功但无档位才是真不支持。
- 管理型入口（默认模型设置页、组队成员编辑）仍直接打开完整目录，不砍模型管理功能。
- **群聊没有输入栏模型层**（既有产品设计：群成员各自是一个助理，模型 / 思考 / Fast 都在该助理自己的输入栏设置）。所以群聊不做第二套紧凑弹层，Fast 取**每个成员助理自己的 `agents.fast`**（不是群级全局值），群消息的 `Fast · …` 状态用同一份 `meta.fast`；后台任务 / 定时任务同样用所属助理的值。不把「主会话有」写成「群聊也完成」。
- 子代理会话复用同一 `ThinkingSlider` / 紧凑语义；其模型由候选池决定，头部只显示当前模型（不可从弹层换模型，不新增后端路由）。
- 消息下方短状态（`Fast · …`）按第 5 节口径显示；回显 default / 冲突用可读提示，不隐藏；错误消息也显示（开着但因协议不支持 / 请求体异常没发出去时，用户要能看到「本次未请求」而不是只看到灯亮着）。

## 8. 测试与边界

已跑（轻量；临时数据目录 + 内存凭据 + loopback 假 HTTP，不连真实云、不发真实付费请求）：

- 主会话独立复核（`8a6b18b`，Node 24.19，外层临时 HOME / DATA / WORKSPACE / TMPDIR + `PIA_OFFLINE`）：上面 server 14 + 前端 43 = **57/57**，5.62s，exit 0。
- 本轮 review 修复后（`8a6b18b` + 本次提交，Node 22.23.3 副本）：同样 14 + 44 = **58/58**（前端多出 1 条 Esc 归属测试）。两端 `tsc --noEmit` exit 0。
- **e2e 启动隔离 + 保存顺序收口**（`7dd7279` + 本次，Node 24.20.0）：前端 **47/47**（`fast-mode-frontend` 8：原 5 + 3 条保存顺序 / 迟到失败；`thinking-slider-frontend` + `model-menu-two-level` 39）；`e2e/native-launch-env-fixture.test.mjs` **4/4**；`node --check` 覆盖改过的 11 个 `.mjs` 全过；`tsc --noEmit -p apps/web` exit 0。**服务端 14/14 未在本次重跑**（本次没改 server），主会话已在本树 `7dd7279` 用独立临时 HOME / DATA / WORKSPACE / TMPDIR 复跑 14 + 44 = 58/58（exit 0），不再重复记账。
- **e2e 启动隔离**：统一「服务 = `test/launch-memory.ts` 内存凭据 + 临时 HOME / TMPDIR / DATA / WORKSPACE；浏览器 = `e2e/fixtures/native-launch-env.mjs` 真实 HOME / TMPDIR；finally 有界 SIGTERM→SIGKILL + 只删本次目录」。原 `fast-mode-ui` 直接起 `src/main.ts`（会构造走 OS 钥匙串的生产凭据后端）且 `PIA_WORKSPACE_DIR` 拼错（真实变量 `PIA_WORKSPACE`）已修；`model-ui` / `model-picker-favorites-ui` / `composer-compact` 同类问题一并改走 `e2e/fixtures/temp-server.mjs`；`thinking-slider-ui` / `thinking-slider-visual` 服务端本来就合规，只补浏览器 env（父进程是合成 HOME / TMPDIR 时也不漏）。
- **真实浏览器实跑（2026-10-17，本树 HEAD `5f7987f` + 本轮脚本修正；Node 22.23.3、web build 通过、本机 Chrome 155 headless）**：每次 mkdtemp 的 RUN_DIR + 内存凭据 + `PIA_MOCK` / `PIA_OFFLINE`，模型渠道只连 `127.0.0.1:1`，无真实付费。`e2e/fast-mode-ui.mjs` **43 项全过**（紧凑层闪电真按钮 / 悬停 450ms / Esc 只关说明 / 真实 PATCH + 刷新持久化 / 失败只回滚 fast 并给原因 / **延迟 GET + 切走回来再点的代次回归** / Enter 焦点 + Shift+Tab 到 Fast / 390 不溢出 / 两层目录搜索·返回·选完回紧凑 / 不支持协议 aria-disabled 可聚焦且不发 PATCH）；相关脚本 `model-ui` 6 组全过、`model-picker-favorites-ui` 7/7、`thinking-slider-ui` 18/18、`thinking-slider-visual` 77/77、`composer-compact` 45 项全过。延迟 GET 回归做过反向验证：临时去掉 `if (!w.isCurrent(gen)) return;` 时该项失败（界面停在旧值 true），恢复后通过。**本轮只改 e2e 脚本与文档，未改产品代码**；失败均为夹具时序 / 旧断言（等目录加载、Shift+Tab 方向、Playwright 把 `aria-disabled` 也算不可点、选完模型后紧凑层仍打开、非推理模型实际是 `fixed` 而非 `unsupported`、目录层不再有 `model-thinking`），已按真实产品语义修正，没有删断言或放宽成功条件。截图 `docs/screenshots/fast-mode-ui/{00-fast-off,01-fast-tip-esc,02-fast-on,03-fast-save-failed,04-fast-390,05-model-directory,06-model-selected,07-fast-unsupported}.png`，逐张看过、无敏感信息（模型是测试用的 `fast-model` / `slow-model` / mock，本地假中转只连 loopback）。

- `packages/server/test/fast-mode.test.ts` **14/14**：真实 `createPiSession` + 本机 fake OpenAI 兼容端点抓**最终请求体**，证明关不附加、开只多 `service_tier=priority`、`reasoning_effort` 基线是具体 `medium` 且不变、再关恢复；组合已有 `onPayload` / `onProviderStreamEvent`；已有 tier 不被覆盖；400 与 403 各只发一次带参数请求；终止 / 非终止回显分类；换模型按实际 `api` 守卫；助理独立 / 子代理跟随与覆盖。
- `e2e/fast-mode-frontend.test.mjs` + `e2e/thinking-slider-frontend.test.mjs` + `e2e/model-menu-two-level.test.mjs` **44/44**：闪电真按钮 / aria / 不可用仍可聚焦、非推理模型仍有 Fast、模型名可点击入口与空态、加载 / 失败不误报、default 文案不称标准档、非终止回显来源未确认、两层状态（初次紧凑 / 点模型名进目录 / 返回 / 选完返回 / Esc / 非聊天入口保持原样）、Esc 归属（后打开的气泡先关、菜单不被顺手关）。**这些是纯逻辑 / 静态 DOM 断言，不冒充浏览器 DOM 行为**；真实浏览器里的 Esc / 焦点 / 悬停由 `e2e/fast-mode-ui.mjs` 覆盖（上条已实跑）。

**未跑 / 未验**：

- 真实中转站（含 sub2api 部署）与真实付费请求；不同站点策略（filter / block / force_priority / free_openai_fast）、倍率与计费账单。
- 真机 App、手机 390 真机；截图是 headless Chrome，不等于真机。
- 群聊**没有输入栏模型层**（既有设计），Fast 按每个成员助理自己的 `agents.fast` 继承；本轮没有群聊 UI 的 Fast 入口可验收，不称「群聊 UI 完成」。子代理 Fast（`subagents.fast` null 跟随 / 1/0 覆盖）只有服务端 14/14 逻辑与路由覆盖，**未跑子代理会话的真实浏览器 UI**；子代理设置卡的 `patchSubagentFast` 也没有浏览器回归。
- 消息 `meta.fast` 的真实 provider 回显（终止 / 非终止）只有 loopback 假 HTTP 与纯函数测试，**没有真实中转回显**；群里 / 后台 / 定时任务的 `Fast · …` 状态未在真实消息流里看过。
- 全量 `npm test` / 全量 e2e。
- `supported` 态目前没有服务级声明可用；不声称任何服务「真支持」具体模型。
