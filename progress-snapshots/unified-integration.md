# 统一整合树 unified-integration（本轮总体收尾 owner 进度）

更新时间：2026-10-15（Asia/Shanghai）
树：`unified-integration`（worktree，基 `hotfix-integration` `b7d33d3`）
状态：**本地提交，未 push / 未 tag / 未打包**（等主会话把 mobile 之后统一发布，仅 mac-arm64）。

## 阶段一：合并既有分支（已完成，全部 `--no-ff` 保留祖先）

按顺序合入，每次先 `git log` 安全 review 依赖再合：

| 顺序 | 来源 | 提交 | 结果 |
|---|---|---|---|
| 1 | `native-dialog-ui-fix` | `9554628` | 干净（docs 自动合并，`beta.24.md` / progress 保留） |
| 2 | `unified-model-registry` | `98415a8`+`54b1ef1`+`48ffa95`+`d48a7d5`+`b55e83a` | 干净 |
| 3 | `local-laya-runtime` | `9578eee` 整分支（10 commits，基 `b7d33d3`） | 干净 |
| 4 | `fast-model-benchmark` | `12fa47d`+`c98a299` | `http.ts` 冲突：`mountFastComputerRoutes` 既要注入 `createRuntimeBenchmarkHost` 又要挂 `mountLocalLayaRoutes` → 两个都保留 |
| 5 | `model-settings-unified` | `f5a7428`+`140b0cc`+`778c7d9`+`98ab36b`+`7b5e5d6`（含 merge `9554628`） | `docs/ROADMAP.md` 冲突：两条需求行都保留 |
| 6 | `conversation-loading-restore-fix` | `d8d38fe`+`a940cfe`+`54f1956` | 仅 docs 冲突（HANDOFF/ROADMAP 两段都保留）；`Chat.tsx`/`store.ts`/新增 `selection.ts` 自动合并 |
| 7 | `mobile-chat-viewport-fix` | merge `9554628` + `1c565ab` | 仅 `docs/HANDOFF.md` 冲突（两段都保留）；`main.tsx` 自动合并，确认三个 installer 都在：`installMacWindowChrome` / `installViewportHeight` / `installExternalLinkHandling` |

冲突都按「保留全部、不整文件覆盖」处理。

## 阶段一验证（实际跑过）

- 依赖：worktree 用 `npm ci --ignore-scripts` 真装（5s）；先前符号链接拼 `node_modules` 会让 Vite `closeBundle` 读不到 `dist/manifest.webmanifest`，已弃用该方式。
- 两端 tsc：`packages/server` 与 `apps/web` `tsc --noEmit` **exit 0**。
- web 构建：`vite build` **通过**。
- 专项服务端单测（内存 `CredentialStore` + 临时数据目录，全程 Mock，未碰系统钥匙串）：
  `vision` / `image-gen` / `custom-providers` / `model-registry` / `local-models` / `local-laya{,-routes,-deps,-register}` /
  `fast-computer-benchmark{,-host}` / `fast-computer-guard` / `test-data-isolation` / `isolation` / `classifier{,-persistence}`
  **97/97 通过**。为此把 `vision.test.ts` / `isolation.test.ts` 的无参 `initModels()` 改为注入 `memoryCredentialStore()`（否则会构造走 OS 钥匙串的后端）。
- 纯前端 e2e（静态 dist + 拦 `/api`，不起 `main.ts`）：
  `native-dialog-ui` ✅ · `model-services-ui` ✅ · `channel-delete` ✅ · `model-ui` ✅ · `conversation-restore` **10/10** ✅ · `mobile-viewport-ui` ✅。
- `web-selection.test.ts`（mobile 选择恢复纯逻辑）**10/10** ✅。

### 修过的集成问题

- `e2e/model-ui.mjs` 矮视口翻转断言：两树页面布局一致，集成树因数据量导致滚动位置为 47（msu 为 0），按钮 y=231、菜单在下方仍放得下 → 产品行为正确、测试假设脆弱。改为先把触发器 `scrollIntoView({block:"end"})` 确定性制造「下方放不下」。
- `vision.test.ts` / `isolation.test.ts` 强制公开内存凭据（见上）。

## 阶段二：UI S5/S6（部分；剩余有明确阻塞）

### 本轮已完成

- **本地 Laya 「已安装未启动也出现」**：`GET /api/local-models/laya/status` 现在顺带 `rememberLocalModelStatus(st, LAYA_PROVIDER_ID, LAYA_MODEL_ID)`，用已知默认模型 id 补齐；重启后从未启动的实例也进 registry hints，不再只靠 bus 内存缓存。`rememberLocalModelStatus` 增加可选 `fallbackModelId`。新增路由测试断言；`local-laya-routes`+`local-models`+`custom-providers` **19/19** 通过。
- 统一面板（`ModelServices.tsx`）在 `/api/models/registry` 就绪时**已经默认渲染**（不是仅 `?unified=1`）；`?unified=1` 只是接口失败时的原型预览开关。
- 服务端契约已齐：`GET /api/models/registry`、`PUT /api/models/registry/:p/models/:m/capabilities`（内置/生图/本地拒绝手改、`MODEL_CAPABILITIES` 白名单、slash 走 `:model` 参数原样传）、`imageAdapter`、`kind:"local"`、生图 legacy key 幂等迁移。

### 未做 + 阻塞（下一位继续前先读这段）

1. **删旧区**（`VisionModelPicker` / `ImageModelsSection` / 快速操作区从「模型」页移走）目前**不能安全删**：
   - `e2e/model-ui.mjs` 用 `vision-model-picker`（18 处）、`e2e/run.mjs` 用 `image-models`/`default-image-model`、`e2e/fast-computer-ui.mjs` 用 `fast-computer-section`。删除必须同步迁移这三个 e2e（本轮明确不跑全量 e2e）。
   - 统一面板的 **AddServiceDialog 还是原型**（只往本地 state 塞 `demo-*`，未调 `/api/models/custom` 与 `/api/image-models/providers` 的真实 CRUD，也没有按能力决定写入哪个 store）。**在它接真实写接口之前删旧「模型服务 / 渠道」折叠区，会让用户失去添加/编辑/删除渠道的唯一入口。**
   - 结论：S6 的删旧依赖「AddServiceDialog 接真实 CRUD + e2e 迁移」两件事，建议作为下一步单独小任务，先写测试再接。
2. 快速操作开关迁到「电脑设置」并明确 host/assistant scope：涉及 server schema（后端目前只有 global）+ `fast-computer-ui.mjs` 迁移，同上单独做。
3. 生图 `imageKeyMigrated` marker 的语义（「标已迁但实际两套 key」的判定）需 registry owner 复核，未在本轮改动。
4. benchmark 真实 CUA 运行条件仍 blocked（hostpc 未开 / VM 未就绪），本轮只验证了契约/单测/e2e fixture，未在真实桌面开窗跑 CUA。

## 边界

- 未 push / 未 tag / 未打包；仅 mac-arm64 预发布由主会话统一做。
- 未跑全量单测 / 全量 e2e（按任务要求只跑专项 + 列出的纯前端 e2e）。
- 全程 Mock、内存凭据、临时数据目录；未碰系统钥匙串、未下载 Laya、未操作真实桌面、未安装 App、未产生真实模型费用。
- 未动 `secrets.ts` / SDK 凭据实现 / 真实 keys / config 历史；未 pop stash。
