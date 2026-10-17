# beta.30 候选整合：一次有限 UI 验收（本树，未 push）

时间：2026-10-17（上海 00:03–00:12 左右）。树：worktree `beta30-followup-integration`，起点 HEAD `5ab653f`（clean，与来源树 `f7ef9b1` 的 ModelPicker / ThinkingSlider / e2e helper、`3462f8e` 的 fast-computer / 原生 TS 逐字一致，本轮只读不重跑那 270 项纯检查）。

> 本轮只做**一次**受限 UI 验收：本树 web build + `fast-mode-ui` + 一节 `thinking-slider-ui`(`ONLY='^A'`)。不跑全量 e2e / visual77 / model-ui / composer / subagent 大套餐，不碰真实模型 / 中转 / 下载 / 安装 / 系统权限 / 凭据 / 真实库 / 日常 Chrome。

## 1. 执行前检查（已做）

| 项 | 结果 |
|---|---|
| 起点状态 | HEAD `5ab653f`，`git status --porcelain` 为空 |
| Node / PATH | `/Users/dengdeng/.local/node-v24.19.0/bin` 前置（`node -v` = `v24.19.0`），未改系统 Node，未 `npm ci` / 未装依赖 |
| 依赖指向 | `node_modules/@pi-assistant/{shared,ext-computer,server}` 的 `realpath` 落在**本树** `packages/*`；Pi SDK 仍指 `release-candidate-validation/node_modules/@earendil-works/pi-coding-agent`（本地未跟踪软链，1.3.0） |
| vite 输出目录 | `apps/web/vite.config.ts` 的 `build.outDir` = `"dist"`（相对本树）→ 产物写本树 `apps/web/dist`；构建前该目录不存在（不是旧树残留），不写用户 App |
| 新鲜进程检查（白名单命令，不读 raw env） | `ps` 过滤 `fast-mode-ui|thinking-slider-ui|pia-e2e-*|launch-memory|vite preview` 无本次相关进程；`/tmp/pia-e2e-fast-mode-*`、`/tmp/pia-e2e-thinking-slider-*` 均不存在 |
| 浏览器选择 | 用脚本自带的**自有 headless Playwright（本机 Chrome 可执行文件 + 本树 `e2e/fixtures/native-launch-env.mjs` 给的 OS HOME / 真实 TMPDIR）**，属开发隔离测试，不碰用户 profile / 日常 Chrome |
| 服务隔离 | `e2e/fixtures/temp-server.mjs` 每次 mkdtemp 的 RUN_DIR（HOME / TMPDIR / `PIA_DATA_DIR` / `PIA_WORKSPACE`）+ `test/launch-memory.ts` 公开注入的内存凭据 + `PIA_MOCK=1` / `PIA_OFFLINE=1`，模型渠道指 `127.0.0.1:1`（无付费、无真实 key、无钥匙串、无真实 DB） |

## 2. 构建（一次）

`npm run build -w @pi-assistant/web` → **exit 0**，wall ≈ 5.9 s（`tsc --noEmit && vite build`）。

- 产物：`dist/index.html` 0.99 kB、`dist/assets/index-D95ZjCZV.css` 175.54 kB、`dist/assets/rfb-CtGtw_KV.js` 187.38 kB、`dist/assets/index-BvpMWekM.js` 1 368.47 kB。
- SHA256：`index-BvpMWekM.js` = `e86dd76450b7ae385f44ca5be4dca48a30d0c297f4c4d381f8041af9307a0036`；`index.html` = `a42626ecdd6dd20f373acb7a64bb81668bfbc7f3a84296b7f13bdbe8924ac1bc`。
- 日志：`logs/build-beta30-ui.log`（`*.log` 本地忽略）。

## 3. `fast-mode-ui`（一次，8 min 有界，实际 23.2 s）

命令：`SHOT_DIR=<本树>/evidence/beta30-ui/shots node e2e/fast-mode-ui.mjs`（外层自有进程组有界运行器，超时整组 SIGTERM → SIGKILL）。

**结果：64/64 通过，exit 0，0 失败**（`✅ 全部通过`）。覆盖并能证明整合未回归的真实 DOM 行为：

- 紧凑层 = 强度 + 可点击模型名 + Fast 闪电真按钮（`aria-pressed`）+ 滑块；`00-fast-off` 里七档粗轨 + **白色实心圆钮**、顶部当前档与模型名；
- 悬停 ~450 ms 出 Fast 说明（非 native title），**说明开着时 Esc 只关说明、菜单还在**；
- 真 PATCH `{fast:true}` 保存 + 刷新后持久化（服务端真值）；保存失败只回滚 fast + 给原因；
- 失败回滚重读 `GET /api/agents` 被延迟时，切走再回来点新值，旧回滚不覆盖最新点击（每助理 `LatestWrite` 代次）；
- 键盘：Enter 打开焦点落模型名、Shift+Tab 到 Fast、Esc 后焦点不留在已移除弹层；
- 390 宽不横向溢出、不半透明叠字；
- 两层：点模型名进目录（搜索 / 返回不改值 / 选完回紧凑层并更新头部），**目录层不再重复滑块与 Fast**；
- 子代理对话面板：Fast 跟随所属助理 / 独立开关 / 失败回滚 / 1 s 轮询不覆盖保存中 / `fast:null` 恢复跟随、档位按子代理实际注册模型（七档 vs 子集 5 档）；
- 协议不支持：灯仍显示但 `aria-disabled`（可聚焦看原因），点击不发 PATCH。

日志：`logs/fast-mode-ui-beta30.log`（`*.log` 本地忽略）。截图 11 张在 `evidence/beta30-ui/shots/`（**独立于 `docs/screenshots/` 的既有 raw，不覆盖来源树图**）。

## 4. `thinking-slider-ui` A 节（一次，`ONLY='^A'` + `FAILFAST=1`，实际 18.7 s）

命令：`ONLY='^A' FAILFAST=1 node e2e/thinking-slider-ui.mjs`（脚本内先起临时 HOME/TMPDIR/DATA/WORKSPACE + 独立进程组服务）。

**结果：A 组 10/10 步通过，exit 0，0 失败**（`[thinking-slider-ui] 10/10 通过`）。A 节实际覆盖（对应本轮整合改动）：

| 步 | 覆盖 | 与整合改动的关系 |
|---|---|---|
| A1 | 七档全量：7 个刻度、顺序 = Pi 顺序、aria 正确 | 档位语义未被视觉重做改动 |
| A1b | 视觉：粗胶囊轨 + 实心圆钮（钮内无文字）、min/max 不越出轨道 | 滑块最终视觉 |
| A2 | 键盘逐档（End / ArrowLeft / Home）每次只写一次、提交后按原行为关闭、Esc 后焦点回芯片 | 提交时机 / 键盘未回归 |
| A3 | 点同一档不关弹层、不多发请求 | Fast 改动后的 D 语义 |
| A4 | 拖动中不写、`pointerup` 才写一次（snap 最近档） | 提交时机 |
| **A5** | **拖动后窗口失焦 / Esc 都不写、回到已提交档（拖动取消）** | 取消不写库 |
| A6 | 子集模型只剩支持的档（不补不吞） | 档位来源 |
| A7 | 非推理模型（只有 off）紧凑层不画滑块、如实说明；目录层不重复强度块 | 两层弹层 |
| A8 | 「跟随」只出现在子代理（助理级），主会话无「跟随」reset | Fast / 滑块共用组件语义 |
| **A9** | **390 宽 × 四主题（noir / glass / warm / pixel）不横向溢出；pixel 走 steps 分支** | 主题 token + 动效分支 |

未跑：B 组（DIY 动效 → 滑块）、C 组（默认强度保存代次）、`thinking-slider-visual.mjs`(77)、`model-ui` / `model-picker-favorites-ui` / `composer-compact` / `subagent-*` / `model-menu-flow` / 全量 e2e —— 按授权只覆盖实际改动的整合面。

日志：`logs/thinking-slider-ui-A-beta30.log`。

## 5. 截图核对（`look_at_image`，6 张）

逐张实际看过（不是只看文件名），确认真实可见、非透明、非空白：

| 图 | 核对结论 |
|---|---|
| `00-fast-off.png` | 紧凑弹层：左闪电、居中「中」accent、次行 `anthropic.claude-sonnet-5 ›`、七档粗轨 + **白色实心圆钮**、底部「较高强度可能更慢，并可能增加用量 ?」 |
| `01-fast-tip.png` | Fast 费用说明气泡真实存在：不改思考 / 不换模型、服务不确定支持、「可能增加用量 / 费用（部分站点约 2 倍或更高），以服务商账单为准」 |
| `04-fast-390.png` | 390 窄屏：弹层在输入栏上方、文字清晰可读、无横向溢出、完全不透明（不是半透明叠字） |
| `08-subagent-fast-follow.png` | 子代理面板：头部「跟随·中」+ 模型名 + 右上重置、滑块白圆钮、闪电点亮、底部「思考·跟随·中」芯片 |
| `02-fast-on.png` | Fast 开态闪电点亮、滑块与头部同时可见 |
| `05-model-directory.png` | 第二层目录：`← 返回` + 搜索框（输入 `sol`）+ 服务分组「本地假中转 1」+ `gpt-6.1-sol`，**无重复滑块 / Fast** |

截图走 `e2e/fixtures/stable-shot.mjs`（等弹层可见 + 有限动画播完 + computed opacity ≥ 0.999 / visibility + 连续 4 帧几何稳定），**未禁用动画、未强制 reduced-motion**。

## 6. 收尾（无本次残留）

- 运行后白名单 `ps` 过滤：无 `fast-mode-ui` / `thinking-slider-ui` / 本次 `pia-e2e-*` / `launch-memory` / vite 进程（本树脚本 `finally` 内已按进程组 SIGTERM → 限时 → SIGKILL 收尾）。
- `/tmp/pia-e2e-fast-mode-*`、`/tmp/pia-e2e-thinking-slider-*` 均不存在（本次 mkdtemp 目录已删，未 `KEEP=1`）。
- 未对历史/别树进程做任何 kill；生产 CuaDriver / 已安装 App / Laya 模型未启动、未停止、未改动。
- 全程未出现钥匙串 / OS 人机验证 / 权限弹窗（服务用内存凭据，浏览器用 helper 给的 OS HOME），因此没有需要停止 native 的情形。
- 本轮**未改产品代码**（零代码 fix），因此没有「小 fix 后只跑失败影响」的追跑；tree 除新增 `evidence/beta30-ui/`（截图）外无改动。

## 7. 结论与口径

- **能说的**：整合后的 web 构建成功；Fast 两层紧凑弹层 / 闪电 / 保存与回滚 / 两层目录 / 子代理跟随与子集档位 / 390 / 非透明截图在本树真实 DOM 与真实服务端（内存凭据 + mock）上验证通过（64/64）；滑块 A 节 10/10 步（含拖动取消、390×四主题）通过 —— **整合未在这些面上回归**。
- **不能说的**：不宣称 Fast 真实优先 / 真实加速 / 真实计费或回显（本轮无真实中转、无付费请求）；不宣称已安装 App / 真机 / 手机真机；不宣称 Laya 质量；不把本轮的 mock 模型当真实模型行为；未跑 B/C 组与 visual77，故不称「滑块视觉全量验收通过」。
