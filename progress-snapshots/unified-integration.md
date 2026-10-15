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

- `e2e/model-ui.mjs` 矮视口翻转断言：原来把触发器 `scrollIntoView({block:"end"})` 到容器底部制造「下方放不下」；统一面板接手后触发器（默认使用）在页面顶部、无法滚到下半屏，改为用 200px 高的矮视口确定性地制造「下方放不下」（菜单起点在按钮上方即算翻转）。
- `vision.test.ts` / `isolation.test.ts` 强制公开内存凭据（见上）。
- **registry `kind` 误判（真实服务才会触发）**：自定义服务的 chat 模型也会出现在 Pi 的 chat 目录里，`buildRegistry` 的 builtin 循环先建了同 id provider，导致自定义/中转站被标成 `kind:"builtin"`，界面显示「登录」而不是「编辑渠道」。修复：自定义循环强制 `p.kind="custom"`，并加回归单测（`chatModels` 含自定义 provider 时仍为 custom）。

## 阶段二：UI S5/S6（已完成）

### 本轮已完成

- **本地 Laya 「已安装未启动也出现」**：`GET /api/local-models/laya/status` 现在顺带 `rememberLocalModelStatus(st, LAYA_PROVIDER_ID, LAYA_MODEL_ID)`，用已知默认模型 id 补齐；重启后从未启动的实例也进 registry hints，不再只靠 bus 内存缓存。`rememberLocalModelStatus` 增加可选 `fallbackModelId`。新增路由测试断言；`local-laya-routes`+`local-models`+`custom-providers` **19/19** 通过。
- 统一面板（`ModelServices.tsx`）在 `/api/models/registry` 就绪时**已经默认渲染**；去掉了 `?unified=1` 原型预览与 `DEMO_LAYA` 假数据 fallback（接口失败显示错误 + 重试，不渲染 demo）。
- 服务端契约已齐：`GET /api/models/registry`、`PUT /api/models/registry/:p/models/:m/capabilities`、`imageAdapter`、`kind:"local"`、生图 legacy key 幂等迁移。
- **AddServiceDialog 接真实 CRUD**：官方完整目录（`/api/models/providers`，未接入的官方服务也能点开走公开登录 API `POST /api/models/login`）；自定义 / 中转走 `CustomProviderForm`（`POST/PUT /api/models/custom`，地址 + Key 一次保存，`fetch-models` 自动发现元数据）；新增「生图服务」类型复用 `ImageProviderForm`（OpenAI / 百炼 / 方舟 / Gemini / xAI）。
- **服务卡真实操作**：能力纠正（`PUT .../capabilities`）、测试连接（`POST /api/models/test`，loading / 失败重试）、编辑（内嵌表单）、删除（应用内确认 + `DELETE`）；生图适配按 `keyFrom=provider.id` 绑定同一个 provider（不新建第二套 imageKey）；面板加「默认图片模型」共享 Select。
- **删旧区**：删除 `VisionModel.tsx`（独立识图选择器，图片跟当前 chat）、`ImageModelsSection` 独立生图区块（保留 `ImageProviderForm` / `AgentImageModel` / `generate_image` 工具）、旧「模型服务 / 渠道」折叠区与快速操作独立凭据区；模型擅长标签改到统一面板模型行内编辑。
- **快速操作按电脑 scope**：`fastComputerSettings(scope)` 支持 `hostpc` / `computer`（缺省回落旧全局设置，向后兼容）；迁到「设置 › 操作这台电脑」与「设置 › 助理电脑」各自一份，只从**已配置**的原生 System One 分类器里选（去掉 chat 替代类型）；`CustomStorage` 的快速操作引用按 storage key 读写，悬空引用逐份清理。
- **benchmark provenance**：`FastBenchmarkResult` 新增 `provenance`（`cua` / `fixture` / `unknown`），由 driver 提供（真实 MCP driver = cua）；UI 按每次结果标明来源，去掉永久硬编码的「真实执行未验证」文案。真实 CUA 运行路径仍是 `createRuntimeBenchmarkHost`（hostpc 授权 + cua daemon / 助理电脑就绪才 available，不假装 ready）。
- **本地 Laya 卡**：WS `local-laya.changed` 驱动刷新（store `localLayaVersion`）+ 过渡期 1s 轮询；未安装有「一键安装」；停止后模型显示未就绪、不删配置。
- 两端 `tsc --noEmit` exit 0；`vite build` 通过。

### 未做 / 边界

- benchmark 真实 CUA 运行条件仍 blocked（hostpc 未开 / VM 未就绪），本轮只验证契约 / 单测 / e2e fixture，**未在真实桌面开窗跑 CUA**；`provenance` 让界面如实标明来源，不冒充真实。
- 生图 `imageKeyMigrated` marker 的语义（「标已迁但实际两套 key」的判定）仍未在本轮改动，留 registry owner 复核。

## 验证（本轮实际跑过）

- 两端 `tsc --noEmit` exit 0；`npm run build -w @pi-assistant/web`（tsc + vite）通过。
- 专项服务端单测（内存凭据 + 临时数据目录，全程 Mock）：`model-registry` / `classifier{,-persistence}` / `custom-providers` / `fast-computer{,-benchmark,-benchmark-host,-guard,-tool}` / `test-data-isolation` **95/95 通过**。
- e2e（纯前端 fixture 或本地 Mock 服务）：`model-services-ui`（真实 CRUD fixture）、`model-ui`、`fast-computer-ui`、`custom-provider-delete`、`model-capabilities` **全部通过**。
- 未跑：全量单测 / 全量 `e2e/run.mjs`（25 分钟，按任务要求只跑专项）。

## 边界

- 未 push / 未 tag / 未打包；仅 mac-arm64 预发布由主会话统一做。
- 未跑全量单测 / 全量 e2e（按任务要求只跑专项 + 列出的纯前端 e2e）。
- 全程 Mock、内存凭据、临时数据目录；未碰系统钥匙串、未下载 Laya、未操作真实桌面、未安装 App、未产生真实模型费用。
- 未动 `secrets.ts` / SDK 凭据实现 / 真实 keys / config 历史；未 pop stash。
