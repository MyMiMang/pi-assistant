# laya-download-verification：本地 Laya 权重下载校验 / 供应链收尾

更新时间：2026-10-15（Asia/Shanghai）
树：`laya-download-verification`（独立 worktree，基 `unified-final-review` 干净 HEAD `8d68f1e`）
状态：**本地提交，未 push / 未 tag / 未打包**；供主会话合入后统一发布。
边界：全程 Mock / 临时目录 / 小 HTTP；**未真下载 GB 权重、未建 uv venv、未起真实 Laya、未碰 GPU / 钥匙串 / 真实 keys / config 历史 / `secrets.ts`**；未动其它 agent 的 benchmark 树。

## 一、问题

`8d68f1e` 的 Laya 一键安装「校验」阶段只跑 `python -c "import laya"`，权重完整性只依赖 HF `revision`（commit SHA）由 HF 端强制，**本地没有独立摘要校验**。这与用户「一键下载安装」的安全验收不符：下载被中间人替换 / 断点缓存被污染时，仍可能被当成「已装好」并 activate。

## 二、改动

### 1. 固定文件清单（新）— `packages/server/src/local-laya/checkpoint-files.ts`
- 每个 checkpoint 的**必需文件 + 大小 + SHA256**：
  - `laya-multilingual@e4e9ddf2…` 7 个文件（含 `model.safetensors` 643,835,514 B、`tokenizer/tokenizer.json` 34,363,188 B）；
  - `laya-typed-decisions@1a793eb5…` 7 个文件。
- 大文件 SHA256 取 HuggingFace **LFS oid**（`/api/models/<repo>/revision/<sha>?blobs=true` 的 `lfs.sha256`，公开、无需 Key、不下权重）；小文件在同一 revision 下取回后本地算 SHA256。**不用 main/latest 哈希套旧 revision**。
- `assertSafeManifest`：拒绝绝对 / `..` 路径、重复路径、`.py/.bin/.pt` 等非 safetensors 文件，要求含 safetensors + tokenizer 配置。

### 2. 下载后流式校验（新）— `packages/server/src/local-laya/verify.ts`
- 对清单每个文件**流式** SHA256 + 大小比对；缺文件 / 大小或哈希不符 → 问题列表，`ok=false`。
- 路径安全：只读该 snapshot 目录；symlink 必须仍指向目录内（HF 缓存快照本身是 symlink → blob），越界直接拒绝。
- 纯文件系统操作，不执行 checkpoint 内任何脚本。

### 3. HF 元数据读取（新）— `packages/server/src/local-laya/hf-metadata.ts`
- 只请求一条几 KB 的 JSON；`parseHfSiblings` / `fetchHfSiblings` / `hfSnapshotDir`，便于脚本复核与单测（本地 HTTP fixture）。

### 4. 接入安装状态机 — `manager.ts` / `deps.ts`
- `LayaDeps` 新增 `verifyCheckpoint(cp, signal)`；install 的 `verify` 阶段在 `import laya` 之后、`activate` 之前调用。
- 真实实现：解析 `HF_HOME/hub/models--…/snapshots/<revision>/` 目录并校验；失败抛错 → manager 回滚 staging、置 `failed`，**绝不 activate**。
- 下载改为按清单 `allow_patterns`（只取清单文件，不下 repo 里多余脚本），仍走 HF 缓存续传；**取消保留 partial 可恢复，但状态回 `not_installed`，不误判 ready**。
- `LayaStatus` 新增 `configured`（已安装配置，重启仍在）与既有 `registered`（进程内已注册 = 当前可用）分离：停止 / 崩溃不清 `configured`，也不删持久配置；运行时 token 仍只存进程内。

### 5. 复核脚本（新）— `scripts/laya-checkpoint-digests.ts`
- `npx tsx scripts/laya-checkpoint-digests.ts`：只读 HF 元数据 + 非 LFS 小文件，逐条比对固定清单；漂移则 exit 1。
- 实跑结果：`✅ laya-multilingual@e4e9ddf21a7b 文件 7（pin 7）`、`✅ laya-typed-decisions@1a793eb568e6 文件 7（pin 7）` → 与公开 HF 元数据**一致**。

### 6. 文档 / 元数据
- `docs/design/local-laya-api.md`：status 加 `configured`，新增「权重供应链完整性（下载后校验，通过才 activate）」章节。
- `third-party.json` / `THIRD_PARTY_NOTICES.md`：补文件清单 + SHA256 来源说明；核对无占位 sha（uv 等既有 pin 摘要真实）。
- 前端 `apps/web/src/types.ts` 加可选 `configured`（UI 原本就按 `registered` 区分「未就绪 / 不删配置」，无需改逻辑）。

## 三、验证（本树实跑）

- 环境：Node `v24.20.0`（`/opt/homebrew/opt/node@24`）、tsx、Mock、临时数据目录。
- 服务端 `tsc --noEmit -p .` → exit 0；网页 `tsc --noEmit -p apps/web` → exit 0。
- 定向单测（`local-laya` 13 + `local-laya-verify` 6 + `local-laya-deps` 3 + `local-laya-routes` 8 + `local-laya-register` 3 + `image-gen` 13 + `model-registry` 9）→ 合计 **53/53**。
- 新增断言：校验失败 → `failed` + 回滚 + 不 activate；`configured`/`registered` 分离且 stop 不删配置；bitflip / 缺文件 / 大小不符 / symlink 越界拒绝 / 目录内 symlink 允许 / 越界路径跳过；HF 元数据解析 + 非 200 抛错。
- `npx tsx scripts/laya-checkpoint-digests.ts` → 两个 checkpoint 与公开 HF 元数据一致（只读元数据 + 小文件，未下权重）。

## 四、剩余限制

- **未在真机上下载 GB 权重做端到端实测**；清单 SHA256 已与公开 HF 元数据逐条核对一致，但「下载 → 流式校验 → activate」全链路未在真实网络跑过。
- 未跑全量单测 / e2e；未在真实桌面 / GPU / 助理电脑验证 Laya 启动。
- 未 push / 未 tag / 未打包。
