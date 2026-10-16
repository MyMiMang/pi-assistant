# beta.27 候选验证快照（Laya 真实安装 + 操作条去浮层）

2026-10-16/17，候选树 `release-candidate-validation`，该轮起点公开 beta.26 `476e73a`；**未 push / 未 tag / 未打包，beta.27 候选。**
本快照的「实跑」都是主会话在同一棵树上亲自跑出来的；未跑的写「未验」。

## 一、合并（保留各自祖先，可回滚）

起点 `476e73a`（clean，= 公开 beta.26 文档 HEAD）。两个分支都以它为 merge-base，改动范围不重叠（仅 HANDOFF/ROADMAP 邻近行，git 自动合并，人工确认两 scope 都在）：

- `989d211` 合并 `laya-beta26-install-fix`（`0630693`）：Laya 权重校验承认自有 HF 缓存共享 blob 形态（多受信根 + `trustRootBase`，断链与越界分开报）。
- `f61e8d7` 合并 `beta26-settings-feedback-fix`（`7ec7169`）：操作这台电脑底部操作条去 sticky 浮层，回普通文档流。

## 二、合并后有限回归（no 全量 757 / 全量 e2e）

- server `tsc --noEmit -p .` exit 0；web `tsc --noEmit` exit 0；`npm run build -w apps/web`（vite build）通过。
- 定向单测（`node --import tsx --import ./test/setup.ts --test --test-concurrency=1`）：local-laya（7 文件）+ local-asr（6）+ downloads / local-models / desktop-image-download + voice-asr / voice-source-http / asr-providers-http / voice-input = **190/190 过**；另 mcp-install 4/4（需 npm 在 PATH）。
- `e2e/settings-usability-ui.mjs`（静态 dist + `page.route` 夹具）**全部通过**，含本合并新增 F 段：真实 DOM 滚动桌面 1440×900 / 390×844 断言操作条随内容位移≈滚动量、不覆盖下方「macOS 权限」提示、开启后提示不被遮挡、无原生弹窗、390 不横向溢出。

## 三、Laya 真实安装 / 启动 / 分类（Apple Silicon macOS arm64，Node v24.20.0）

脚本 `scripts/laya-real-smoke.mjs`（手动，`npm run smoke:local-laya`，**不进默认 npm test**），复用 `local-asr-real-smoke.mjs` 的隔离结构：
- owner 标记的 scratch 根（`PIA_SMOKE_DIR` 未标记拒绝、`PIA_SMOKE_FRESH` 只重建 root 下受控子目录）；
- 进程内显式覆盖 `PIA_DATA_DIR / PIA_WORKSPACE / HOME / UV_CACHE_DIR / UV_PYTHON_INSTALL_DIR / PIP_CONFIG_FILE=/dev/null`，注入**内存** `CredentialStore`（不构造安全凭据后端、不碰钥匙串）；
- 不碰用户真实数据 / 真实 HF 缓存 / 系统 Python / 全局 pip；所有 scratch 删除都在 owner guard 内；
- 走生产实现本身：`createLayaDeps()` → `LocalLayaManager.install()` → `start()` → 经 Pi 公开 classifier 链路 `models.classify()`（官方 `typesafe-system-one` → `/v1/systemone`）发一次**无害**选择题（两个普通标签）；自起 worker 在 `finally` 里 stop。

### 预算（先 HEAD / HF 元数据估，超预算即停）
- 固定清单：7 文件 **678,212,540 B**；HF 元数据逐条大小 / LFS sha 与 pin 一致（只读元数据，不下权重）。
- 估算：权重 678.2MB + torch macos-arm64 80.6MB + laya wheel 0.4MB + 运行时常量 = **1097.6MB** < 预算 3072MB。
- 首跑真实新增下载落盘（`du`，缓存保留至今）：HF 权重 **647MB**（含 643,835,514B `model.safetensors`）+ uv archive **711MB**（torch/transformers 等解包）+ CPython **71MB** + uv **28MB** ≈ **1.44GB**。后续重跑命中缓存，网络≈0（只几次元数据）。**总网络在 3GB 预算内。**

### 真实缓存形态（证据）
首跑后自有 HF 缓存确实出现**两层共享 blob**：`snapshots/<rev>/model.safetensors` → `models--convaiinnovations--laya-multilingual/blobs/9d62…`（= LFS oid）→ `hub/blobs/53/5349…` 普通文件（另有 `.huggingface-shared-blobs` 标记）。**这正好是 `laya-beta26-install-fix` 针对的形态**；beta.26「只把 repo 目录当受信根」在此会判大文件「符号链接越界」、装不上。

### 首跑中发现并修复的 4 个真实产品 bug（都在真机链路暴露，不是 smoke 绕过）
1. **`uv venv` 未 `--relocatable` → 启动 ENOENT**：staging venv 被原子 rename 成生效 `env` 后，`laya-serve` 的 shebang 仍写死 `env.new/bin/python`（已消失）→ `spawn` ENOENT。修：`manager.install` 的 `uv venv` 加 `--relocatable`（脚本按相对位置解析 venv，改名后仍可用）。回归：`test/local-laya.test.ts` 断言 venv 命令含 `--relocatable`。
2. **health 重试窗只有 10×500ms≈5s，把慢加载误判不健康**：multilingual 644MB 冷加载实测约 **35s**。修：改**截止时间**轮询（180s）+ 子进程退出提前返回（同 local-asr 既有模式），加可注入 `setTimer`。回归：`test/local-laya.test.ts` 慢加载（前 4 次未就绪）最终等到就绪。
3. **`spawnServe` 未处理子进程 `error` 事件 → 进程被打挂**：spawn 失败（ENOENT 等）只触发 `error`，未捕获会 crash 整个服务。修：`error` 转成一次 `onExit`，manager 置 `crashed`。回归：`test/local-laya-deps.test.ts` 用不存在路径断言经 `onExit` 报退出。
4. **sidecar 首条输出写日志时 `statSync` 打在还不存在的 `serve.log` 上 → 未捕获 ENOENT crash**：`spawnServe` 的 `out()` 在 `stdout/stderr` 的 data 回调里 `statSync(logFile)`，文件尚未创建即抛。修：先 `existsSync` 再 `statSync`，并 try/catch。回归：`local-laya-deps.test.ts` 用 `node -e console.log` 假 sidecar 断言输出入日志且不抛。

### 最终一次完整跑（命中缓存，**安装 5s 是复用 scratch 缓存，不是首次从零**）
- install phases：`preflight>uv>venv>torch>laya>weights>verify>activate`，state `installed`；
- 物化生效目录 `runtime/weights` 5 个必需文件大小 / SHA256 与固定清单**逐条一致**（`model.safetensors` = `9d628f…`）；
- `start()`：真实 `laya-serve`（loopback）起来，`/health` `loaded=["multilingual"]`、`device=mps`、`checkpointDevices.multilingual=mps`（revision 为 null 属正常：本地目录来源无上游 revision）；
- **官方协议分类**（Pi 公开链路，非 mock 非直接拼 HTTP）：`stopReason=stop`、`type=choice`、`choice=alpha`、`probabilities={alpha:0.5361,beta:0.4639}`、`confidence=0.0038`、`usage.input_tokens=51`。**只证明官方协议真实推理链路打通，不声称智能 / 准确率**（confidence 0.0038 只是这次自检问题的真实输出，不作质量结论）；
- finally stop：`state=stopped`，旧 pid 已退出（无泄漏）。
- 证据：`evidence/local-laya-real-smoke/`（`report-*.json` / `smoke-*.log` + 4 个首跑失败日志 `first-attempt-0{1..4}-*.log`）。**logs / report 无 token / 无凭据**（runtime token 只存在进程内，仅经 Pi 公开链路使用）。

## 四、未验（如实）
- **仅 Apple 芯片 macOS arm64** 实测；Windows / Linux / Intel Mac **未实机**（路径 / 平台规则只有离线单测，不宣称跨平台实机过）。
- 只测了 `laya-multilingual` 一个 checkpoint；`laya` / `laya-typed-decisions` 与真实 GPU（CUDA/XPU）未测。
- 未做真实速度 / 内存 / RTF 基准；`confidence=0.0038` 不作质量 / 准确率结论。
- 未跑全量 `npm test`（757）/ 全量 `e2e/run.mjs`；未打包 / 未装用户 App。
- **SenseVoice 一键安装仍由另一 owner（`sa_mvaux4yhqtzegm`，新树 `sensevoice-oneclick-fix`）进行中，本树未动其源码、未合并，本快照不声称 SenseVoice 已完成。**
