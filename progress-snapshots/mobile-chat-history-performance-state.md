# 手机聊天历史性能 — WIP checkpoint（暂停，未 push / 未 commit）

> 2026-10-17 01:2x。因用户机器严重卡顿（16GB 内存用 15GB、swap 13.7GB、load 233）按主指示**暂停一切新 build / browser / perf 重测**，
> 只保留本文件记录断点。HEAD 仍 `8025387`（未 commit / 未 push）。工作树有未提交改动（见下）。
> 我自己起的测试进程/端口已全部回收（无残留监听；唯一残留 `launch-memory` pid 66395 已 kill）。

## 0. 恢复后本轮（2026-10-17 01:5x，独占重测试槽）

**进程 / 端口台账（本轮自建，均已回收）**
- 手工复核用服务：`test/launch-memory.ts`，pid 82447，端口 **28471**，`PIA_DATA_DIR=/tmp/pia-cmp.*`（自有临时目录），已 kill + `pgrep -f test/launch-memory` 为空；`lsof` 无 27xxx–29xxx 监听。
- 测试运行：`/Applications/Pi Assistant.app/Contents/MacOS/node`（v22.23.3）跑 `node --test`，硬超时兜底；子服务随测试进程退出（`after` SIGKILL），无残留。
- 未动他人 worktree 的进程（观察到 `.hermes/node ... pat.test.mjs` pid 14988/37310、`local-asr-multi-model` 的 `main.ts` pid 98025，非本任务）。
- 机器：load 23.7 → 12.5，swap used 9.8G → 9.6G（未继续增长）。

**本轮修正 1：`static-compression-http.test.ts` 从 1/7 修到 7/7（根因不是压缩实现）**
- 根因：环境变量前缀。`config.ts` 的 `env()` 会拼 `BRAND.envPrefix`（`PIA_`），测试里传的是 `WEB_DIST` → **被静默忽略**，服务用了真实 `apps/web/dist`。于是 `/assets/app-abc123.js`、`/icon.png` 都落到 SPA 兜底 `index.html`（996B，正是真实 dist 的 index.html 大小），7 个断言里 6 个失败。压缩实现本身没坏。
- 改：`PIA_WEB_DIST`（另：`/api/system` 的压缩体要用 `gunzipSync` 后再断言，`node:http` 客户端不像 fetch 自动解压）。
- 结果：7/7 通过（App 内置 node v22.23.3，真实 HTTP + 自有 mini webDist）：JS gzip 发 `.gz`（Content-Encoding/Length/Vary/`immutable` 都对）、identity 发原始件、HEAD 无 body 且 Length 正确、`/` gzip+`no-cache`、API JSON gzip 且 identity 明文、PNG 不二次压缩。
- 语义记录（保留，非缺陷）：Range 命中压缩表示 —— `serveStatic({precompressed})` 先选 `.gz`，再对**压缩字节**做 range（206 + `Content-Range` 基于压缩后大小）。

**⚠️ 风险报告（需主决策，本轮未自封完工）：「引用跳到很久以前的消息」**
- 现状：`useMessageJump` → `ensure` = `store.loadUntilMessage` / RoomChat 自带 `ensureLoaded`，从当前窗口**连续**向更早分页，上限 20 页（≈1000 条）；超过上限 → 状态 `far`「原消息较早，请先上滑加载更早的消息」。
- 正面：**不打洞**（旧实现把 `/api/messages/:mid/context` 的孤立窗口 merge 进列表，当前窗口与目标窗口之间那段历史永久不可达，`loadMore` 也补不上）——这是真缺陷，已修。
- 负面：**违反「上限后拒绝本可跳功能」**。旧实现能直接跳到任意旧消息（但有洞）；现在超过 ~1000 条就只给提示。另：一次远跳会把沿途上千条塞进 DOM（手机正是要避免的场景）。
- 选项（请主选，C 属新架构不在本轮）：
  - **A（本轮现状）**保留有界连续分页 + `far` 提示：诚实、无洞、可重试、可手动上滑；代价是超远引用跳不了。
  - **B** 提高单次跳转页大小（`limit=200` × N 而不是 50 × 20）：触及更远，但单跳 DOM 成本更高，手机更慢。
  - **C** 服务端补前向游标（`after`/`afterSeq`）+ 前端「虚拟 gap 标记」：真正无洞且能跳任意距离，需要新接口 + 新 UI 结构 → **要新增大架构，回主排期**。
- 建议：本轮按 **A** 收口（不再改行为），C 列入下一阶段；A 已保证「完整历史访问」（连续上滑可达任意早）+ 不跳动 + search/jump/群聊 scope 判定照旧。

**本轮修正 2（真实缺陷，HEAD 就有）：一次滚到顶会把整段历史自动拉完**
- 现象（现构建上稳定复现）：手机单聊把滚动条拉到顶部 → **3 次** `/messages` 请求，120 条 fixture 全部进 DOM（`request=3, ids=m1..m120`）。
- 原因：`Chat.tsx` 的 `onScroll` 只看 `scrollTop < 200` 就 `loadEarlier()`；内容插入上方后浏览器**滚动锚定**会再次派发 scroll（`scrollTop` 仍在顶部附近），于是每插完一页又触发下一页 → 几十万条的会话会把整段历史一页页拉完（内存 / DOM 爆炸），正是本任务要避免的场景。
- 修法（小改，`apps/web/src/components/Chat.tsx`）：`lastAutoTop` ref——`scrollTop >= 200` 时重新武装，否则同一个滚动位置（±8px）只自动加载一页。用户离开顶部再滑回来照旧按页加载（每个上滑手势一页），「加载更早的消息」按钮不受影响。`RoomChat` 的 onScroll 只更新 `stick`，没有这个自动加载，无需改。
- 回归：`e2e/mobile-chat-pagination-ui.mjs` 测试 2 的第二个手势改成真实手势（先离开顶部 ≥200px 再滑回顶部），并新增断言「停在顶部 `request` 必须=2（首次+一页）」。

**本轮独立复跑（均通过，证据在 `evidence/mobile-chat-history-performance/`）**
- `packages/server/test/static-compression-http.test.ts` → **7/7**（`static-compression-http-7of7.log`）。
- `e2e/mobile-chat-pagination-ui.mjs`（先 `npm run build -w @pi-assistant/web`）→ **5/5**（`pagination-ui-5of5.log`）。
- `npx tsc --noEmit -p apps/web` → 通过（exit 0）。
- 最终性能**一次**重测（合成 1000 条，CDP 200ms / 1.5Mbps / 4x CPU / 390×844，**模拟不是真机**；`final-perf-2026-10-17.json`）：

| 指标 | 改前 HEAD 8025387（300/200，无压缩） | 中间构建（50/50+gzip，有重复请求） | **本轮最终**（含 §1.4 去重 + 修正 2） |
|---|---|---|---|
| firstRowMs | 23,566 | 5,947 | **2,037** |
| settledMs | 23,997 | 6,439 | **2,156** |
| 历史请求次数 | 2 | 2 | **1** |
| 聊天 JSON 线缆字节 | ≈2.75MB（未压） | 6,534 | **6,546**（解压 471,445） |
| 主 JS 线缆字节 | 1,293,406 | 389,894 | **389,668** |
| DOM 节点 | 13,072 | 2,343 | **2,343** |
| 渲染行数 / 滚动高度 | — | — | 45 / 38,972px |

（时钟：`firstRowMs`/`settledMs` 相对 domcontentloaded；`messageResponses[].atMs` 相对页面开始。资源计时确认只有 **1** 次 `/api/agents/*/messages?limit=50`。）

**仍未验 / 未做（本轮）**：生产隧道（Cloudflare）压缩 / CDN 缓存未验；真实手机 / 真机网络 / PWA 命中未验；v24 下 `launch-memory` 静默挂起仍未查（服务端测试统一用 App 内置 v22.23.3）；全量 `npm test` / `e2e/run.mjs` 未跑（本任务只跑受影响的定向测试）。

**进程 / 端口归还（重测试槽）**：本轮自建的服务（pid 82447/28471、90200/28572）已全部 `kill -9`；`pgrep -f launch-memory` 为空、无 27xxx–29xxx 监听、临时目录已删；无残留浏览器（只有他人 2 天前起的 Chrome）；load 7.3 / swap used 9.28G（未增长）。**重测试槽已归还。**

## 1. 已做完（可运行，已过测试）

在原三条 commit（`6d7849a` 复合游标 / `f7cb543` 50/50 首批 / `8025387` 设计与脚手架）之上，本轮续做：

### 1.1 静态资源预压缩 + 缓存（新增，最大首屏杠杆）
- `apps/web/vite.config.ts`：新增 `precompress()` 构建插件，`writeBundle` 给文本资源生成 `.gz` 旁路（只在压缩后更小时写；图片/字体不压）。
- `packages/server/src/http.ts`：`serveStatic({ root, precompressed: true, onFound })`；
  - `onFound` 设 `Cache-Control`：`/assets/*` → `public, max-age=31536000, immutable`；`/`、`/index.html`、`/sw.js` → `no-cache`；其余静态 → `public, max-age=86400`；
  - 可压缩文本始终补 `Vary: Accept-Encoding`（仅有 `.gz` 旁路的类型）；
  - SPA 回退 `app.get("*")` 的 index.html 补 `no-cache`。
  - Accept-Encoding 协商、Content-Length、HEAD、Range、304（本服务端本就无 ETag/304，未被破坏）均已按 serveStatic 语义保持。
- 实测（真实 HTTP，macOS 回环）：`index-*.js` 带 gzip → `content-encoding: gzip`、`content-length` 389,432（原始 1,293,433）、`vary: accept-encoding`、`cache-control: ...immutable`；不带 gzip → 原始件；HEAD 长度正确；Range → 206；png 不二次压缩。

### 1.2 API JSON 压缩（新增，限定范围）
- `http.ts`：`app.use("*", compress({ encoding: "gzip", contentTypeFilter: /^application\/(?:json|[^;]*\+json)\b/i }))`。
- **只压 JSON**：静态 JS/CSS 走预压缩旁路，文件下载（octet-stream / 附件）、图片、SSE 不在范围内；LLM 流式走 `llm-proxy` 的原生 `res`（不进 Hono fetch），不缓冲不压坏。
- Hono compress 自动跳过已有 Content-Encoding / 206 / HEAD / no-transform，补 `Vary: Accept-Encoding`、去 `Content-Length`。
- 敏感响应评估：聊天 JSON 本身是本人数据、同源 + 鉴权，压缩不改变可读性；不全局盲压。

### 1.3 引用跳转的**分页空洞**缺陷修复（真实缺陷，小修）
- 现象：旧实现把 `/api/messages/:mid/context` 的孤立窗口直接 merge 进当前列表并 `hasMore=true`。当目标比当前窗口更早且不相邻时，当前窗口与该窗口**中间一段历史永远加载不到**（`loadMore` 只往 list[0] 更早翻，不会补中间），滚动也无法补上。
- 修法（不新增服务端接口、复用现有稳定游标）：
  - `MessageReply.tsx` `useMessageJump`：不再 `onInsert(context)`；改为 `locate`（确认存在/同容器）→ `ensure(mid)` **从当前窗口连续向更早分页直到目标进入列表** → 定位高亮。新增 `far` 状态（超过页数上限时明确提示先上滑，不打洞）。
  - `store.ts` 新增 `loadUntilMessage(agentId, mid)`：有界（≤20 页）循环 `loadMoreMessages`，带无进展/失败保护。
  - `Chat.tsx`：`ensureLoaded = store.loadUntilMessage`；`RoomChat.tsx`：自带连续向更早分页的 `ensureLoaded`（群聊 `before=seq`）。
  - `/api/messages/:mid/context` 接口**保留**（仅用于存在性/同容器快速判定），未删契约。
- 该修复是分页验收必需的（原设计文档承认“继续向上加载”，但未覆盖中间空洞）。

### 1.4 首屏串行请求：去掉 WS 首次连接导致的重复聊天拉取
- `App.tsx`：`connectWs` 的 `open` **首次**只置连接状态，不再 `loadAgents().then(selectAgent)`；断线重连才重新同步。此前首次连接会把首屏聊天 JSON 拉两次（perf 证据里 2 个相同 `limit=50` 响应）。

### 1.5 证据时钟口径修复
- `scripts/perf/measure-first-screen.mjs`：明确记录 `navMs`、`firstRowMs`（相对 `domcontentloaded`）、`settledMs`（相对 navAt）、`messageResponses[].atMs`（相对 t0），并新增 `firstRowFromStartMs`/`settledFromStartMs`、`clock` 说明；新增 CDP `encodedDataLength`（线缆字节）与 `resources`（资源计时）。
- 原证据只有 `atMs`（相对 t0）与 `firstRowMs`（相对 navAt），无法直接交叉核对——本轮补齐口径。

### 1.6 测试
- 新增 `e2e/mobile-chat-pagination-ui.mjs`（纯前端 fixture + 真实 WebSocket，静态托管 dist，不启服务端、不碰真实数据）：**5/5 通过**：
  1. 首屏只拉 `limit=50`、渲染 50 条（m71..m120），只发 1 次历史请求；
  2. 上滑加载更早：稳定复合游标 `before`/`beforeSeq`，插入上方后按高度差回填锚点（m71 仍贴视口顶）；
  3. 往上翻（stick=false）新消息不拉底；贴底时跟随到底；
  4. 引用跳未加载的 m1：连续分页到 m1，最终 DOM 连续覆盖 m1..m120**无空洞**，多发 `before` 分页请求（≥3）；
  5. 群聊上滑加载更早（`before=seq`），连续覆盖 r1..r80。
- 新增 `packages/server/test/static-compression-http.test.ts`（真实 HTTP + 测试自造 webDist 含 .gz 旁路）——**尚未跑通**：本机 Node v24.19.0 起服务端会静默挂起（见 §4），v22 下待重跑；测试代码里 Range/png 两处断言也要按实际响应修正（png 那次返回的是 index.html，说明 WEB_DIST 是否被采纳需复核）。
- 既有 `e2e/conversation-restore.mjs` 已覆盖「切对话晚返回旧请求不覆盖新目标」，未重复。
- `apps/web` `tsc --noEmit` 通过；`packages/server` `tsc --noEmit`（v22 下）此前通过。

## 2. 性能实测（合成 1000 条，CDP 200ms / 1.5Mbps / 4x CPU / 390×844 — **不是真机**）

时钟：`firstRowMs` 相对 domcontentloaded；`atMs` 相对页面开始。

| 指标 | 改前 HEAD 8025387（300/200，无压缩） | 本轮工作树（50/50 + gzip） |
|---|---|---|
| firstRowMs（相对 domcontentloaded） | 23,566 | 5,947 |
| settledMs | 23,997 | 6,439 |
| 聊天 JSON 解压后字节 | 2,746,171 | 471,445 |
| 聊天 JSON 线缆字节（gzip） | 未压（≈2.75MB） | **6,534** |
| 主 JS 传输字节 | 1,293,406 | **389,894** |
| DOM 节点 | 13,072 | 2,343 |

**注意**：以上“本轮”数字取自中间构建（含压缩+分页，但**尚未含** §1.4 的首次连接去重），该次测量出现 2 个相同聊天响应；去重后预计更快，但**未重测**（暂停 perf）。合成/模拟网络，不代表真实手机；生产隧道/Cloudflare 是否已在上游压缩仍未验。

## 3. 未验 / 未做（如实）
- 生产隧道（Cloudflare named tunnel）链路是否压缩/CDN 缓存：未验（本地/直连不压缩；CF 边缘对文本类型通常自行压缩，但未实测域名）。
- 真实手机、真实网络、PWA 命中：未验。
- 全量 `npm test` / 全量 `e2e/run.mjs`：未跑（只跑受影响的 web e2e 与 typecheck）。
- `static-compression-http.test.ts` 未过（见 §1.6/§4）。
- App.tsx 首次连接去重后的最终性能未重测。

## 4. 环境发现（重要）
- 本机 Homebrew `/opt/homebrew/bin/node` 是 25.8.2，缺 `libsimdjson.31.dylib`，**不可用**。
- 主指定 `~/.local/node-v24.19.0/bin/node` v24.19.0：能跑 vite build 与 Playwright e2e（5/5）；但 `node --import tsx packages/server/test/launch-memory.ts` **静默挂起**（无任何输出、端口不监听），服务端测试起不来。
- 之前一套可用服务端运行时是 App 内置 `/Applications/Pi Assistant.app/Contents/MacOS/node` v22.23.3（engines >=22.19 的基线）。服务端测试/启服建议用 v22；v24 挂起原因待查（可能是 tsx + node:sqlite/依赖在 v24 下的兼容问题）。
- `node_modules/@pi-assistant/*` 都指向本 worktree 的 `packages/*`（相对 symlink），`node_modules/typescript` 是本 worktree 实体目录且 7.0.2 与 lock 一致；**无共享基树污染**。

## 5. 未提交改动清单（工作树，HEAD 8025387）
```
 M apps/web/src/App.tsx
 M apps/web/src/components/Chat.tsx
 M apps/web/src/components/MessageReply.tsx
 M apps/web/src/components/RoomChat.tsx
 M apps/web/src/store.ts
 M apps/web/vite.config.ts
 M packages/server/src/http.ts
 M scripts/perf/measure-first-screen.mjs
?? e2e/mobile-chat-pagination-ui.mjs
?? packages/server/test/static-compression-http.test.ts
```

## 6. 恢复后的下一步（按优先级）
1. 用 v22 跑通 `static-compression-http.test.ts`（修 Range/png 断言，复核 WEB_DIST）。
2. 用最终构建（含 §1.4）重跑 `measure-first-screen` 一次，确认聊天请求只剩 1 次、firstRow 进一步下降。
3. 定向回归：`messages-pagination.test.ts`、replies/rooms 相关单测、`e2e/conversation-restore.mjs`。
4. 补文档 `docs/design/chat-history-pagination.md` 的压缩/空洞修复与最终数据；标注**未发布**。
5. 全量 `npm test`（v22）与必要 e2e。
