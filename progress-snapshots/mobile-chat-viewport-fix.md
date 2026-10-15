# mobile-chat-viewport-fix（手机浏览器：顶栏 / 输入栏不随整页移动 + 输入框不再触发自动放大）

分支 `mobile-chat-viewport-fix`，独立 tree，基线 = `hotfix-integration` 的 `b7d33d3` + 合入 `native-dialog-ui-fix` 的 `9554628`（弹窗栈保留，本地 merge commit `26fd3e5`）。未 push / 未 tag / 未打包。
工作树：`/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/mobile-chat-viewport-fix`。
与统一模型管理 UI（`model-settings-unified` 树）无文件重叠：没碰 `ModelServices.tsx` / `Settings` 等 owner 文件。

## 用户报的 bug
1. 手机浏览器里用 Pi，最上面的顶栏和底部的输入框会随整页上下移动，不固定。
2. 点输入框页面自动放大，打完字看聊天还要手动缩回去。

## 根因（真实源码定位）
| 现象 | 根因 | 位置 |
|---|---|---|
| 顶栏 / 输入栏随整页移动 | ① 手机媒体查询里 `body { overflow: auto }` 让**整页**成了滚动容器；② 整页高度用的是 `html, body, #root { height: 100% }`，iOS Safari 的 `100%` 取的是「地址栏收起后」的布局视口高，比可见区域高 → 页面本身可上下拖（`window.scrollTo(0, 400)` 真的生效）。整页一动，`position: absolute` 的输入栏（相对聊天列）和最外层顶栏就都跟着走。 | `themes/base.css` 的 `@media (max-width:820px){ body{overflow:auto} }`；`themes/app.css` 的 `html, body, #root { height: 100% }` |
| 点输入框整页自动放大 | iOS Safari 对 `font-size < 16px` 的输入控件聚焦时会自动放大整页。默认皮肤 `[data-skin=linear] .pa-app{font-size:13.5px}` 继承到 `textarea/input`（`.pa-composer textarea { font: inherit }`），实测 computed = **13.5px**。 | `themes/linear.css` + `themes/base.css` 的 `.pa-composer textarea` |
| 键盘弹起挡住输入栏 | iOS Safari 的键盘是**覆盖式**的，不缩布局视口，`100dvh` 也不跟着变（Chromium 有 `interactive-widget=resizes-content` 兜底，Safari 没有）。 | 无（此前完全没有 visualViewport 处理） |

## 本次改动（视口 CSS + 一个入口级 install，最小）
| 文件 | 改动 |
|---|---|
| `apps/web/src/themes/app.css` | ① `html { --pa-vvh: 100vh }` + `@supports (height:100dvh)` 覆盖为 `100dvh`；② `html, body { overflow: hidden; overscroll-behavior: none }`（页面本身不再滚）；③ `#root { height: var(--pa-vvh); overflow-y: auto }`（shell = 可视高度；`#root` 自己留滚动给配对页等整页内容，主界面用不到）；④ `@media (max-width:820px),(pointer:coarse)` 下 `html:not(.pa-pet-root) :where(input,textarea,select){ font-size:16px }`（只放大**控件**，不动版面字号；桌宠小窗排除）；⑤ `html.pa-kb-open .pa-composer-wrap{ padding-bottom:10px }`（键盘弹起时收起底部安全区留白）。 |
| `apps/web/src/viewport.ts`（新） | `installViewportHeight()`：监听 `visualViewport` 的 `resize` + window `resize` / `orientationchange`，把可视高度写成 `--pa-vvh`（px），并切 `pa-kb-open`；视口变矮后把**原本贴着底部**的聊天区重新贴住最后一条消息（视口矮多少就补多少松弛量，否则缩小后已经「不在底部」判不出来）。**`scale != 1`（双指缩放）时不写高度**，把页面完全交还浏览器，保住 pinch zoom 与文字缩放。 |
| `apps/web/src/main.tsx` | 加一行 `installViewportHeight()`（和 `installMacWindowChrome()` / `installExternalLinkHandling()` 同一处入口级 install）。**不动 App.tsx 的 active agent 逻辑**。 |
| `e2e/mobile-viewport-ui.mjs`（新） | 见下。 |

**共享而不是三份复制**：主会话 / 群聊 / 子代理本来就共用 `.pa-chat` + `.pa-scroll` + `.pa-composer-wrap`，本次修复全部落在 `html` / `#root` / 控件选择器这一层，所以三处一次性覆盖，没有给 `Chat.tsx` / `RoomChat.tsx` / `Subagents.tsx` 各加一份逻辑（这三个文件本次**没有改动**）。

**明确没做**：没有加 `user-scalable=no` / `maximum-scale=1`（保留双指缩放和文字缩放，不破无障碍）；没有用 `position: fixed` 做 shell（避免 iOS 键盘下 fixed 抖动）；没有引新依赖。

## 已验证（实际跑过，Node 24.20.0，全 Mock）
- `npm run typecheck`：服务端 + 网页 `tsc --noEmit` exit 0。
- `npm run build -w @pi-assistant/web`：通过（2493 模块）。
- `node e2e/mobile-viewport-ui.mjs`：**123 项全通过**。纯前端 fixture（静态 dist + `page.route` 拦 `/api`，**不起 main.ts、不碰钥匙串、不碰真实数据目录**）。
  - 390 / 375 / 430 × 800 三档：顶栏贴顶（top=0）、输入栏贴底（bottom = 视口高）、`html/body overflow=hidden`、`window.scrollTo(0,600)` 后 `scrollY` 仍 0、shell 高 = 可视高、无横向溢出、`--pa-vvh` 已写入、App 整体字号仍 13.5px（没把整页放大）、**所有输入类控件 computed ≥ 16px**。
  - 多行输入：输入框变高（37px → 111px）后输入栏仍贴底、整页仍不可滚。
  - 键盘模拟（先聚焦输入框，再把视口缩到 390×420）：顶栏仍在 0、输入栏在可视区底部、整天不可滚、**聊天区自动贴底（gap=0）**、最后一条消息在可视区内。
  - 横竖屏切换（800×430）：顶栏 / 输入栏 / 整页滚动行为都对。
  - 群聊：打开手机抽屉进入群聊，上面每一项重跑一遍（证明主会话 / 群聊共用同一套 shell）。
  - viewport meta：不含 `user-scalable=no` / `maximum-scale=1`，保留 `viewport-fit=cover`。
  - 桌面 1280×900 回归：输入框字号仍是 13.5px（手机规则不泄漏）、顶栏贴顶、输入栏贴底。
- 回归（另外三条已有 e2e 都实际重跑通过）：`e2e/composer-compact.mjs`（含 **IME 组合期间 Shift+Enter 不发送**、390 三档、主群子三处输入栏）、`e2e/task-ui.mjs`（子代理详情 + 390）、`e2e/native-dialog-ui.mjs`（本次 merge 进来的弹窗栈，确认没被破坏）。
- 截图：`/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/mobile-viewport/`（main/room × 390/375/430 + desktop-1280）。

## 未验证 / 边界（不宣称）
- **没有真机 iOS 键盘验证**。Playwright 的 Chromium 移动模拟没有真 iOS 键盘（Safari 键盘是覆盖式的），e2e 里的「键盘弹起」是 `setViewportSize` 缩小视口的**近似**；真机上这一步由 `viewport.ts` 的 `visualViewport` 完成，**需要真机确认**。同理，iOS 的「聚焦自动放大」在 Chromium 里复现不出来，本脚本只能证明「控件字号已 ≥ 16px 这个阈值条件成立」。
- 没有安装 App、没有操作真实手机的 Safari / Chrome 远程调试（按要求不动用户手机浏览器 / 不装 App / 不碰系统操作 / 不碰钥匙串 / 不碰真实数据）。
- 没有跑全量 e2e 和单测（本次只改前端 CSS + 一个 install + 新增 e2e，按规则只跑受影响的检查）。
- 地址栏折叠时的精确高度依赖浏览器什么时候派发 `visualViewport.resize`；真机上若发现「折叠后有一小段留白」，属于待真机确认的细节。

## 合入说明（给主会话）
- 基线 `b7d33d3` 之上只多一个 merge commit `26fd3e5`（合 `9554628` 原生 dialog 根治，保留弹窗栈）和本修复的提交。
- 改动文件只有 4 个：`themes/app.css`、`viewport.ts`（新）、`main.tsx`（1 行 + 1 import）、`e2e/mobile-viewport-ui.mjs`（新），外加本文档与 ROADMAP / HANDOFF。**不碰** `Chat.tsx` / `RoomChat.tsx` / `Subagents.tsx` / `App.tsx` / `Settings.tsx` / `ModelServices.tsx`，与「App / hook 白屏 loading」另一个任务的预计改动面（App.tsx / hook）和统一模型 UI 都不冲突。
- 本地环境注意：这个 tree 的 `node_modules` 是从 `hotfix-integration` 用 APFS clone 复制的，并补了 `apps/web/node_modules/{highlight.js@11.12,typescript}`（share 的 `hotfix-integration/node_modules` 里缺这两个嵌套依赖，直接用会构建失败）；`node_modules` 已被 gitignore，不在提交里。
