# local-laya-download-tracking：Laya 下载/校验统一链路（beta.26 候选，未发布）

更新时间：2026-10-16（Asia/Shanghai，第二轮补缺口）
树：`local-laya-download-tracking`（独立 worktree，基 `release-candidate-validation` 干净 HEAD `dcce520`，即当前公开 beta.25 `8afc3aa` 的后续文档提交；Pi 1.3.0）
状态：**本地提交，未 push / 未 tag / 未打包**；HEAD `ff1d25e`（主审补缺口 d66016d + 夹具 89f0a4c + 截图 ff1d25e，见第八节）；供主合本地 ASR 方案后统一发布（用户长期授权、无需重复确认，但本阶段不发半成品）。下一个未用 tag 是 `v0.1.0-beta.26`（未创建）。
边界：全程临时目录 / 假文件 / 本地小 HTTP fixture；**未真下载 GB 权重、未建 uv venv、未起真实 Laya、未碰 GPU / 麦克风 / 真实用户数据 / 钥匙串 / `secrets.ts` / Pi SDK / node_modules**。

## 一、用户实报（beta.25 安装真实失败）

1. 「我在下载 Laya，为什么下载和组件里没有」——Laya 没登记进统一「下载与组件」面板。
2. 红字「权重校验未通过：符号链接越界：.gitattributes；符号链接越界：README.md；符号链接越界：encoder/config.json」且**无进度条**。

## 二、根因

1. **符号链接越界（核心 bug）**：`managed-weights/verify.ts` 把「受信根」设成 **snapshot 目录本身**（`HF_HOME/hub/models--org--repo/snapshots/<rev>`）。而 HuggingFace 缓存里快照文件是指向同 cache 根下 `../../blobs/<sha>` 的 symlink，`realpathSync` 必然落在 snapshot 目录之外 → 每个文件都被误判「符号链接越界」。旧注释写的「symlink 必须仍指向该目录内」本身就是错的受信根定义。
2. **下载面板看不到**：`local-laya/index.ts` 旧注释以「本模块有自己的分阶段状态、统一下载面板只能显示 trackDownload 进度、容易误报未下载」为由**明确不登记** `registerDownload`。用户因此看不到安装/下载。
3. **假进度**：`LocalLayaCard` 进度条 `width: ${percent ?? 8}%` —— 总量未知时写死 8%，像在下载却无真实依据。

## 三、改动（两个本地提交）

### commit 1 `fa2feb1`：修 HF 缓存合法 symlink 被误判越界

- `packages/server/src/managed-weights/verify.ts`
  - `verifyPinnedFiles` 新增 `trustRoot`：清单文件的 **realpath 必须落在受信根内**。Laya 传同 cache 根的 `models--org--repo/`，合法 blob 链接通过；逃到任意用户目录 / 绝对路径跳出 cache **仍拒绝**（`pathInsideRoot`）。
  - `PinnedFile.optional`：辅助元数据（README / .gitattributes）**缺失不算失败**；存在仍校验大小 / SHA256；`encoder/config.json` 与 `model.safetensors`、`tokenizer/*` **逐个严格校验**，不是「跳过 symlink 放弃校验」。
  - 新增 `materializePinnedFiles(srcDir, destDir, files, { trustRoot })`：把已校验的必需文件**物化成 staging 里的普通文件**（优先硬链接真实 blob，跨设备退回复制），物化后再核大小 / SHA256；只处理必需文件。
- `local-laya/verify.ts` 透传 `trustRoot`；`local-laya/hf-metadata.ts` 新增 `hfRepoDir()`（blobs/snapshots 的父目录 = 受信根）。
- `local-laya/checkpoint-files.ts`：两个 checkpoint 的 `.gitattributes` / `README.md` 标 `optional: true`。
- `local-laya/deps.ts`：`verifyCheckpoint` 用 `trustRoot = hfRepoDir(...)`；校验通过后 `materializePinnedFiles` 写 `runtime/weights.new`（staging），`activate()` 原子 rename 到 `runtime/weights`，`rollback()` 清 staging。**不动 HF 缓存**，断点续传 partial 保留。
- 新测试 `test/local-laya-verify-hf.test.ts`（5 例）：真实 HF 两级布局（`snapshots/<rev>/<file>` → `../../blobs/<sha>`）——旧行为全部误报越界（复现）、修复后合法通过、逃出 cache 根拒绝、篡改大小 / SHA256 拒绝、辅助文件缺失不失败且必需文件仍逐个校验、物化为普通文件并复核。

### commit 2 `211bcb5`：Laya 接入统一下载登记 + 进度条去假百分比

- `packages/server/src/downloads.ts`（**小扩展，非新框架**）：
  - `DownloadDef.cancel?`（取消走组件自己的 AbortController，不另建 controller）、`DownloadDef.status?`（组件投影自己的 phase/received/total/error，比内部计数权威）。
  - `DownloadInfo.canCancel`；新增 `cancelDownload(id)` / `POST /api/downloads/:id/cancel`。
  - 新增通用 `followStatus(id, read)`：轮询组件阶段状态 → `Progress`（**已知总字节 → 字节进度；未知 → 不定进度 + 阶段文字，不编假百分比**）；同一 id 只一个循环，结束自动停。**Laya / 本地 ASR 共用，勿另写一套。**
- 新增 `packages/server/src/local-laya/download.ts`：`projectLayaInstall()` 把 manager install 状态投影成下载 DTO（`installed→ready / installing→downloading / failed→error / 未装→missing`；**只有权重阶段带真实 total**）；`start` 复用 `manager.install`、`cancel` 复用 `manager.cancel`；`followStatus` 观察进度。只观察，不复制安装逻辑。`http.ts` 引入即登记。
- `LocalLayaCard` 进度条：权重阶段用真实字节百分比；其余阶段改 `pa-dl-bar indet` 不定进度 + 阶段中文 + 已下载字节，去掉 `?? 8` 假数。
- 两个入口同一 job：电脑页 Laya 卡与「下载与组件」页（group `本地模型`）读同一个 manager 状态；`manager.install` 并发第二次直接拒绝（新增单测）。

## 四、验证（本树实跑，Node v24.20.0，tsx，临时数据目录）

- server `tsc --noEmit -p .` exit 0；web `tsc --noEmit -p apps/web` exit 0。
- 定向单测全过：`local-laya-verify-hf` 5 + `local-laya-verify` 6 + `local-laya` 12 + `local-laya-deps` 3 + `local-laya-routes` 8 + `local-laya-register` 3 + `downloads` 7 + `local-laya-download` 2 + `desktop-image-download` 1 + `mcp-install` 4 = **51 项**（一次运行 51/51，`--test-concurrency=1`）。
  - 注：本快照初稿曾写「31 + 25 + 9 = 65」，2026-10-16 第二轮按上述命令在 Node v24.20.0 实跑复现不到 65（`local-laya` 实为 12、`downloads` 实为 7），以本节与第八节的实数与命令为准。
- **未跑全量 `npm test`（757）/ 全量 e2e（25min）**：本树只跑受影响项与必要邻居。

## 五、剩余限制 / 未验（如实）

- **没在真机下载 GB 权重端到端跑过**：符号链接根治已用**真实 HF 形状 fixture（snapshots+blobs 两级 symlink）**证明；仍不等于真实网络下载 / 真实 Laya 启动已成功。
- `materializePinnedFiles` 的 staging 镜像已落在 own `runtime/weights`，但**真实 Laya sidecar 仍从 HF 缓存读取**（未改 runtime env，避免猜 sidecar 契约）；镜像用于校验 / 审计与后续接入，不构成「运行已实测」。
- 未 push / 未 tag / 未打包；原始用户级 App 缓存 / 真实 partial 未读未改（只按 manager 既有 rollback 清自己新建的 staging）。

## 六、给 ASR owner 的统一下载契约（勿另建一套）

```ts
// packages/server/src/downloads.ts（已实现并提交）
interface DownloadDef {
  id: string; name: string; group: string; size?: number;
  installed: () => boolean;                 // 首屏「已下载/未安装」
  start?: () => Promise<unknown>;           // 下载/重试
  cancel?: () => Promise<unknown> | unknown;// 取消（走各自 manager 的同一个 AbortController）
  status?: () => {                          // 组件自己的阶段状态投影（比内部计数权威）
    state: "missing" | "downloading" | "ready" | "error";
    received?: number; total?: number | null; detail?: string | null; error?: string | null;
  };
  hidden?: () => boolean;
}
followStatus(id: string, read: () => { active: boolean; detail?: string | null;
  received?: number; total?: number | null; error?: string | null }, intervalMs?: number): void;
```

- **每个模型一个 id**（例如 `asr:sensevoice`、`asr:<model>`）：两个官方权重可同时各占一行，不要用一条唯一 ASR 行藏真实选项。
- 取消统一走 `POST /api/downloads/:id/cancel`；服务端只调你登记的 `cancel()`，不另建 controller。
- 进度：**知道总量就给 `total`**（字节条 + 百分比）；不知道就 `total: null`（界面自动 `pa-dl-bar indet` 不定条 + 阶段文字）。复用 `downloadFile`（Range / sha 校验 / 原子改名）与 `watchDir`，不要新下载引擎。

## 八、主审补缺口（第二轮，2026-10-16）

主审核验后确认前两提交的核心（HF symlink 校验根治）保留，但还有 4 个真实缺口；本轮只补缺口，不回滚、不重写下载链路、不新框架。

### 提交
- `d66016d`：源码 + 服务端测试。
- `89f0a4c`：新增纯前端夹具 `e2e/local-laya-download-ui.mjs`（11→20 项断言）。
- `ff1d25e`：夹具截图 `evidence/local-laya-download/`（单独提交，按 AGENTS.md）。

### 缺口 1：下载行没有取消
- `apps/web/src/components/Downloads.tsx`：`DownloadInfo` 加 `canCancel`；`DownloadRow` 加 `onCancel` + `pending`（按钮转圈）；下载中且 `canCancel` 显示「取消」→ `POST /api/downloads/:id/cancel`（服务端 `cancelDownload` → Laya `manager.cancel`，**同一个 AbortController**，未新建）。
- GET 列表失败原来 `catch(() => setItems([]))`：会把「读取失败」显示成「没有需要下载的组件」。改为**保留已加载旧行** + 可见错误条（`downloads-error`）+ 重试（`downloads-retry`）；起 / 停失败的 `catch` 不再吞，行内短错误（`download-row-error`），不用原生 alert。
- 跨阶段混字节：下载中不再拿 `def.size` 当已下载分母（原来依赖阶段显示「0 B / 约 646 MB」）。

### 缺口 2：全局每秒 setInterval
- `packages/server/src/local-laya/download.ts` 删掉 `setInterval(…, 1000)` 全局 watcher（会强制构造 manager、每秒重复 FS 查询）。
- 新增 `downloads.ts` 的 `notifyDownload(id, force)`：组件在**自己的 bus 事件**里把投影转发给 `downloads.changed`。Laya 订阅既有 `local-laya.changed`，首 / 终事件 `force` 立即发；两个入口（电脑页 `/api/local-models/laya/install`、下载页 `/api/downloads/local-laya/start`）同一 job。只用事件里的 status，不在回调里懒构造 manager。`followStatus` 保留（ASR 等按需可用），不再被 Laya 全局用。
- 兼容：`DownloadDef.status` / `cancel` 与 `DownloadStatus` 契约**未改**（只新增 `notifyDownload`），ASR 侧 `download.ts` 的全局轮询不归本树。

### 缺口 3：权重进度真实来源 + 本地校验物化真正接进运行时
- 进度：原来 `watchDir([hfHome], …)` 会把整个 HF 缓存（含别的 repo / 历史）当本模型字节。改为 `checkpointProgressBytes(hfHome, cp, files)`：只统计**本 checkpoint 必需文件**对应的 `blobs/<sha256>`（含 `.incomplete` 增量）与已完成 snapshot；返回 ≤ 必需文件总量。已缓存部分立刻可见（不从 0 起，避免 0→100 假闪）。采样器在成功 / 失败 / 取消的 `finally` 里 `clearInterval`，不留永久 timer。
- 依赖阶段（pip，总量未知）：新增 `watchDirBytes(dirs, onBytes)` 用 uv 缓存 + staging venv 真实目录字节，`total` 保持 null → 不定进度；不跨阶段混 bytes/total。
- 运行时接入（主审给的两选一，选**真正 wire**，不是删物化）：Laya 公开配置 `LAYA_EXTRA_MODELS`（`{名字: repo 或本地 checkpoint 目录}`，见 `research/laya/docs/http-api.md` 与 `laya/serve.py`）支持本地目录。`manager.start()` 现在传 `LAYA_EXTRA_MODELS={"multilingual": <runtime/weights>}` + `LAYA_MODELS=multilingual`（默认会预加载全部三个，另两个会去下载）。`runtime/weights` 就是 `verifyCheckpoint` 里 `materializePinnedFiles` 校验后物化的普通文件目录 → 运行时读的确实是被校验的文件，而不是 HF 缓存 snapshot。目录不存在（如仅 `update()` 未换权重）则不设，避免指向空目录。`LayaPaths` 加 `weights` / `weightsStaging`；deps 加 `checkpointSource()`、`watchBytes()`（均可选）。

### 缺口 4：精确测试数
- 见第四节：本轮实跑 **59/59**（`--test-concurrency=1`，一次运行）：`local-laya-verify-hf` 5 + `local-laya-verify` 6 + `local-laya` 14 + `local-laya-deps` 6 + `local-laya-routes` 9 + `local-laya-register` 3 + `downloads` 7 + `local-laya-download` 4 + `desktop-image-download` 1 + `mcp-install` 4。
- 新增测试：`local-laya` 两条 start env 接线（有 / 无物化目录）；`local-laya-deps` 三条（blob 进度含 `.incomplete` / 别 repo 不计 / 封顶；已缓存计满；`checkpointSourcePath` + `watchDirBytes` 停止）；`local-laya-routes` 一条 POST cancel 转发；`local-laya-download` 事件驱动转发 + 取消链路。

### 真实 UI 夹具（首验）
`e2e/local-laya-download-ui.mjs`（静态托管 `apps/web/dist` + `page.route` 拦 `/api`，不启服务、不碰真实数据），20/20 全过：
- 权重阶段 308.0 MB / 616.1 MB · 50% + 实条 + 取消按钮；点取消 → `POST /api/downloads/local-laya/cancel`；取消后 `出错` + `重试`。
- 依赖阶段 12.0 MB · 阶段文字 + 不定条，**不含「约」**（不混字节）。
- GET 失败：红色错误条「下载列表读取失败…」+ 重试，**旧行仍在**；重试后错误条消失。
- POST start 失败：行内红字「启动失败」。
- 电脑页 `?settings=host` Laya 卡安装中 → 取消 → `POST /api/local-models/laya/cancel`。
- 390 窄屏不横向溢出。
截图已用 `look_at_image` 逐张确认，见 `evidence/local-laya-download/`。

### 本轮实跑
- server `tsc --noEmit -p .` exit 0；web `tsc --noEmit -p apps/web` exit 0；web `vite build` 通过。
- 定向单测 **59/59**（命令见第四节）；UI 夹具 20/20。
- **未跑全量 `npm test`（757）/ 全量 e2e（25min）**；**未真机下 GB 权重、未装 uv Python、未起真实 Laya、未碰 GPU / 麦克风 / 真实用户数据 / 钥匙串**。

### 本轮发现的既有隐患（如实，未修，待主定）
- `test/setup.ts` 用 `await import()` 设置 `PIA_DATA_DIR`，但 ESM 静态 import 先于模块体求值 → `config.dataDir` 在单测里**仍是真实数据目录**（实测：`config.dataDir=/Users/dengdeng/Library/Application Support/Pi Assistant`，而 `TEST_DATA_DIR` 是临时目录）。现有测试靠「显式注入 `paths(dir)` / 不用 `config.dataDir`」避开；本轮我的一条测试曾误用 `createLayaDeps()` 而写到一个真实路径，已立即删除还原（只删自己新建的 `local-laya/runtime`，未动 `hf/` / `python/` / `uv-cache/`）。建议后续单独修 `test/setup.ts` 的加载顺序并跑全量单测验证（本轮未动，避免超出定向范围）。

### 剩余限制 / 未验（更新）
- 仍未真机端到端下载 GB 权重；symlink 根治与 blob 进度已用真实 HF 形状 fixture 证明，不等于真实网络 / 真实 Laya 启动已成功。
- `LAYA_EXTRA_MODELS` 接线只做了**环境变量与路径**级别单测（断言 spawn env），未真实启动 sidecar 证明 Laya 从该目录加载（禁止装真实 Torch/Laya）。
- 未 push / 未 tag / 未打包；未读 / 未改用户真实 HF 缓存与 partial。
