# local-laya-download-tracking：Laya 下载/校验统一链路（beta.26 候选，未发布）

更新时间：2026-10-16（Asia/Shanghai）
树：`local-laya-download-tracking`（独立 worktree，基 `release-candidate-validation` 干净 HEAD `dcce520`，即当前公开 beta.25 `8afc3aa` 的后续文档提交；Pi 1.3.0）
状态：**本地提交，未 push / 未 tag / 未打包**；供主合本地 ASR 方案后统一发布（用户长期授权、无需重复确认，但本阶段不发半成品）。下一个未用 tag 是 `v0.1.0-beta.26`（未创建）。
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
- 定向单测全过：`local-laya-verify-hf` 5 + `local-laya-verify` 6 + `local-laya` 17（含「并发第二个 install 被拒」）+ `local-laya-deps` 3 + `local-laya-routes` + `local-laya-register` + `downloads` 9（投影 / 取消 / followStatus）+ `local-laya-download` 2（投影映射 + 登记存在）+ `desktop-image-download` + `mcp-install` 共 **31 + 25 + 9 = 65 项全过**（分两批跑）。
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
