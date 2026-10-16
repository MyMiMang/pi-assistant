# beta.26 最终整合验证 + 发布准备

主会话最终复核（2026-10-16）：独立重跑两端类型检查通过，主题/ASR 前端逻辑 **17/17**；具体 ASR deps、多模型生命周期、Laya HF 布局、来源 CAS 与测试隔离子进程 **43/43**。全部显式使用临时 DATA/WORKSPACE/HOME，未读用户数据、未重新下载大权重。已核两份真实 ASR report JSON，发布说明修正缓存复用事实，并明确 small/turbo/large-v3 未做真实安装推理验证、真实 Safari/iPhone 输入法仍未验。按本轮既有发布授权准备普通推送及新 beta.26 tag，不再要求重复确认；公开状态在 Actions 与实际资产核验后记录。

树：`release-candidate-validation`（worktree `/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/release-candidate-validation`）。
起点：第一轮整合后 HEAD `6075b3e`（stage1 已合 Laya `10317d0` / 语音多模型 `55a09e7` 含后端 `18478d4` / 主题选模型 `0781b9c`）。
本轮 HEAD：`fb31539`（功能定稿；其后仅本快照 / 文档微调，最终 HEAD 以 `git rev-parse HEAD` 为准）。合并 1 `42f9613`、合并 2 `17a3da7`、收口文档 `f905c4d`、截图 `fb31539`；首父链干净、`git status` 干净。
**本任务不是发布动作：未 push / 未 tag / 未建 Release / 未更新用户 App / 未改 `.github/release-scope.json`（仍 `mac-arm64`）。** push / tag 由主会话在复核后做。

## 1. 本轮合并（均 `--no-ff`，保留各自祖先）

| 顺序 | 合并提交 | 父 2（合入分支 tip） | 内容 |
|---|---|---|---|
| 1 | `42f9613` | `8f8d458` `local-asr-multi-model` | 本地语音多模型生产修复：deps 按所选模型 repo/revision 直连 HF、Whisper `*-tokens` 自检、sidecar `ASR_WEIGHTS`、健康检查 90s + `modelId`、事件驱动进度、真实 smoke 证据与 fail-closed 回归 |
| 2 | `17a3da7` | `8e9a223` `local-laya-download-tracking` | Laya 测试隔离收口：`package.json` 测试入口预加载 `./test/setup.ts`、`local-laya-deps` 第一条静态导入、`isTempDataDir` realpath + 分隔符边界；`LAYA_EXTRA_MODELS` 公开支持核对 |

- 冲突只有两份文档：`docs/ROADMAP.md`（合并 1）、`docs/HANDOFF.md`（合并 2）。**手工收口**：ASR 保留「前端」行 + 取后端最新行（含真实 smoke），Laya 测试隔离段插到 Laya 段之后、ASR 段之前；不是 ours/theirs 一把覆盖。`git diff --check` 干净，无冲突标记残留。
- 合并 2 的分支历史基于 `10317d0`（不含 ASR 后端）——三方合并以 `10317d0` 为基，ASR 新增文件（`catalog.ts` / `service.ts` / `runner.ts` / `download.ts` 等）在本侧保留，**未被删**（`ls packages/server/src/local-asr/` 18 个文件齐全）。
- 未合：任何 owner 的 WIP / dirty 树；未碰 `next-release-integration` / `stash` / `wip/*`。

## 2. 本轮实跑（Node v24.20.0；全部隔离）

隔离：所有命令 `PIA_DATA_DIR` / `PIA_WORKSPACE` / `HOME` 指向本次新建的临时根（`mktemp -d /tmp/pia-b26-final-*`），`PIA_OFFLINE=1`；UI 夹具用静态 `apps/web/dist` + `page.route` / 内存 launcher；**未读真实 data / config DB / cache / credentials / `secrets.ts` / SDK 凭据源码；未下权重、未起真实 Laya / 语音 sidecar、未开麦、未付费、未连真实云、未碰钥匙串。**

| 检查 | 命令 | 结果 |
|---|---|---|
| 服务端类型 | `npm run typecheck -w @pi-assistant/server` | exit 0 |
| 网页类型 | `./node_modules/.bin/tsc --noEmit -p apps/web` | exit 0 |
| 网页构建 | `npm run build -w @pi-assistant/web` | 通过（`vite build`） |
| 服务端定向单测（17 文件） | `node --import tsx --import ./test/setup.ts --test --test-concurrency=1 test/{theme-ai,local-asr-deps,local-asr-manager,local-asr-multimodel,local-asr-license,voice-source-http,downloads,local-laya-verify-hf,local-laya-verify,local-laya-download,local-laya,local-laya-deps,local-laya-routes,local-laya-register,local-models,test-data-isolation,asr-providers-http}.test.ts` | **147/147 通过，0 失败 / 0 跳过** |
| `theme-ai` 单跑 | 同上（单文件） | **19/19** |
| 主题前端纯逻辑 | `node --import tsx --test e2e/theme-ai-frontend.test.mjs` | **11/11** |
| ASR 前端纯逻辑 | `node --import tsx --test e2e/local-asr-models-frontend.test.mjs` | **6/6** |
| ASR 安全 UI 夹具 | `node e2e/local-asr-models-ui.mjs`（静态 dist + `page.route`，未起真实服务） | **全过（37 断言）** |
| 设置功能安全 UI 夹具 | `node e2e/settings-functional-ui.mjs` | **全过（53 断言）** |
| Laya 下载 UI 夹具 | `LAYA_UI_OUT=<tmp> node e2e/local-laya-download-ui.mjs` | **20/20** |
| 主题 AI 真实 UI | `node e2e/theme-ai-ui.mjs`（安全 launcher `test/launch-memory.ts` + 临时 DATA/WORKSPACE） | **6/6** |
| 真实后端 catalog smoke | `node --import tsx e2e/local-asr-catalog-real.mjs`（内存 launcher + tmp DATA/WORKSPACE 起真实 server） | **通过**（6 模型；5 个 cleared + SenseVoice unresolved；`recommendedId` 在清单；含真实权重 pin） |

- 真实 ASR smoke **未重跑**（不重复下 400MB）：只核 `evidence/local-asr-real-smoke/report-2026-10-16T08-{50-13,52-10}.json` 存在 + 内容与目录一致（Whisper base 160,609,290B / Paraformer 243,446,974B，逐文件 SHA256），并跑 `test/local-asr-deps.test.ts`（真跑生产 `createAsrDeps`，只注入本地 Range fixture，不 mock 下载）。
- **排除项（说明）**：`test/mcp-install.test.ts` 的真实 `npx` / `uvx` 用例在假 HOME 冷缓存下会超时，**不属于本次改动**（相邻外网 / npx·uvx 冷缓存），本轮**未跑**，也不把它的结果算进来。未跑全量 `npm test`（757 项 / ~25min）、未跑全量 `e2e/run.mjs`。

## 3. 重点复核结论

- **服务 `select` 吞掉 start 异常是否使 UI「使用中却已崩」**：**结论是当前设计可接受，但已如实记录为可读性小隐患，未改 owner 语义。** `service.select()` 先写「用本地」来源、再 `await target.start().catch(()=>{})`；start 抛错（spawn 失败 → `runtime.state="crashed"`；或 paused / 退避）被吞，路由仍返回 `ok:true` + `status`。
  - 但**失败是可见的**：前端 `StatusBadge` 对 `runtime.state==="crashed"` 显示红色「已崩溃」，详情区 `local-asr-runtime` 显示 `运行态 + 重启次数 + lastError`。所以不是「静默崩溃」。
  - **且有兜底设计**：`voice/index.ts::acquireAsrLease` 在开始录音时**懒启动**（`void manager.start().catch(()=>{})`，注释写明「启动失败由随后的转写返回 409，UI 再提示」）；`transcribe` 在 worker 未运行时返回 409。即换来源与起进程解耦，换来源后可在用的时候再起。
  - 唯一可读性瑕疵：详情头部绿色「已设为语音来源」与红色「已崩溃」可同屏，语义分别是「来源已切」与「进程没起」——两者都真实，不构成误导，但**若要更清晰可在 select 响应里带上 `runtime.state!=="running"` 的提示**，属小改，交主会话决定，本轮不擅动。
- **来源 CAS 不回归**：`voice-source-http` 用例覆盖 `expectedVersion` 过期 → 409 不覆盖、带当前版本成功且版本递增、旧客户端不带字段仍兼容 —— 在 147/147 内通过。
- **录音租约 guard 不回归**：`local-asr-multimodel.test.ts`「有录音租约时 select 明确拒绝，不把进行中音频送给别的模型」通过；`local-asr-manager.test.ts` 的「录音中绝不释放 / TTL 不 kill / stop-active-abort」通过。
- **catalog 只有 5 个 cleared 下载项 + SenseVoice 仅导入默认折叠**：真实 catalog smoke 输出 5 个 `cleared`（Paraformer + 4 Whisper）+ 1 个 SenseVoice `unresolved`；ASR UI 夹具断言「旧版 SenseVoice 导入默认收起，主流程没有第二套来源按钮」通过。
- **未发现需要大改才能整合的问题**；两处小文档冲突按上文手工收口即可。

## 4. 发布准备（停在 push 前）

- **版本 / 范围**：`v0.1.0-beta.26` **未被占用** → 已写 `docs/release-notes/v0.1.0-beta.26.md`（中文、短、面向用户；覆盖三需求 + 「不再硬编码」+ Enter 沿用 beta.25 + 高档 ASR / Laya 实机 / 真麦·云未验；范围仍仅 Apple 芯片 macOS arm64）。版本号取自 tag，未改任何版本字段。
- **remote 现状（只读，用 `workspace/tools/gh_2.65.0_macOS_arm64/bin/gh` + `GH_CONFIG_DIR=workspace/github-auth`，只调 `gh`、未读 `hosts.yml`）**：`main` = `dcce520`（beta.25 文档提交，2026-10-16T06:11:54Z）；`Latest` release = `v0.1.0-beta.25`；tags 最新 `v0.1.0-beta.25`。**没有 beta.26 的 tag / release，未 force / rebase 任何人。**
- **THIRD_PARTY_NOTICES 补全**：原「本地语音识别」只列 `sherpa-onnx`（Apache-2.0）与 SenseVoice（unresolved），本轮补上新增**随产品按需下载**的两族权重——Paraformer 中文（Apache-2.0，`csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14` revision `def02708…`）与 OpenAI Whisper base/small/turbo/large-v3（MIT，`csukuangfj/sherpa-onnx-whisper-*`，各 revision pin SHA，逐文件大小 + SHA256）；标题由「用户自行导入 / 许可未闭环」改为「按需下载 / 自行导入」。模型权重 pin 的单一事实仍在 `packages/server/src/local-asr/catalog.ts`（及 `local-asr-model-catalog-2026-10-16.json`），未复制到 `third-party.json`。
- **`.github/release-scope.json`** 保持 `mac-arm64`，未改。

## 5. 未验 / 不可宣称（如实）

- **ASR**：跨平台（Windows / Linux / Intel Mac）未实机，仅 PyPI 元数据证明 wheel 矩阵合法；Whisper turbo / large-v3（1~2GB）**未真实下载**；RTF / 峰值内存只单样本一次值，**不作性能结论或机器推荐**；真机麦克风 / App 内端到端未验。
- **Laya**：未真机装 Torch / 下 GB 权重 / 起真实 Laya；`LAYA_EXTRA_MODELS` 本地目录加载用 pinned wheel 的纯 Python resolver 验证，**未在真实 0.4.8 运行时实机跑**；Laya 可能改写 `tokenizer_config.json`，「物化字节永远等于清单 SHA256」不成立。
- **主题**：真实云模型生成质量 / 计费未验。
- **全局**：真机 App / 全量 `npm test`（757）/ 全量 `e2e/run.mjs`（第 1 步向导为既有基线）本轮未跑；系统钥匙串根因未确诊；SenseVoice 许可仍未决（仅自行导入）。
- **测试隔离事故恢复**：2026-10-15/16 自报把测试助理 / Laya runtime 写进真实数据目录的那次恢复，**主会话仍未独立确认**；本轮只证明「未来测试不再落真实目录」，未对用户真实数据做审计 / 恢复。

## 6. 下一步（交主会话）

1. 主会话复核本整合树（HEAD `fb31539`）→ `git push`（不 force）。
2. 按本轮已有「完成验证后直接推送打包」授权打新 tag `v0.1.0-beta.26`（不移动旧 tag），走 `release.yml`（scope `mac-arm64`），Mac 安装启动冒烟通过再公开为 Latest。
3. 如需，就 §3 的 `select` 提示做小增补（可选，不阻塞）。
