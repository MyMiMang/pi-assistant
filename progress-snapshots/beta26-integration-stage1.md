# beta.26 候选 · 第一阶段整合与有限交叉复核

树：`release-candidate-validation`（本快照所在 worktree，`/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/release-candidate-validation`）。
起点：`dcce520`（beta.25 已公开状态）。**不是发布任务：未 push / 未 tag / 未更新用户 App / 未改 `.github/release-scope.json`。**
本阶段只把三个已 review 的固定 SHA 候选 `--no-ff` 合入候选树，做有限交叉复核；不碰任何 owner 的 WIP/dirty 树、不做大改。

## 1. 合并记录（均 `--no-ff`，保留各自祖先，可回滚）

| 顺序 | 合并提交 | 父 1（我们的树） | 父 2（合入分支 tip） | 内容 |
|---|---|---|---|---|
| 1 | `1dbb652` | `dcce520` | `10317d0` `local-laya-download-tracking` | Laya 下载统一链路修复（= `08ecbd9` 基 + `d66016d` 源码 + `89f0a4c` UI 夹具 + `ff1d25e` 截图） |
| 2 | `277ddfb` | `1dbb652` | `55a09e7` `local-asr-model-choice-ui` | 本地语音多模型（前端 `55a09e7` + 后端 `18478d4` + 旧 Laya `08ecbd9` 并入 + 真实 catalog server smoke） |
| 3 | `12370a5` | `277ddfb` | `0781b9c` `theme-designer-model-choice` | 主题设计可选本次草稿模型（`89f9a23`/`142f682`/`216945e`/`71e1e65` + `6da0f01` 主审修 + 截图 `0781b9c`） |

- 第一个合并（Laya）与第二个合并（ASR）**三方合并自动完成无冲突**：`local-laya/*`、`managed-weights/verify.ts`、`downloads.ts`、`docs/design/local-laya-api.md` 在 ASR 分支里的版本等同其并入的 `08ecbd9`（是 Laya 分支 `10317d0` 的祖先），git 取到 Laya 最新版。已逐文件核对 HEAD 与 `10317d0` 一致（见 §3）。
- 第三个合并（Theme）仅 `docs/HANDOFF.md`、`docs/ROADMAP.md` 冲突。**按「不能 ours/theirs 一把覆盖」手工收口**：保留 beta.25 已公开状态段与既有 beta.25 功能分节；三块功能各自一段 / 一行；顶部 beta.26 blockquote 两条都保留（语音 UI + 主题设计）。无冲突标记残留（`git diff --check` 干净）。
- 未合：`local-asr-multi-model` 的 `8beea59`（ASR 生产 deps/HTTP 下载修复）及其 dirty 后续、`local-laya-download-tracking` 的测试隔离 P0 / 公开 Laya 路径 resolver WIP（`sa_mvapng018t7nr6`）、`next-release-integration` / `stash` / `wip/*` 等秘密 WIP 树。

## 2. 已合入内容（三块，含各自限制，细节以各分支文档为准）

- **Laya 下载统一链路**（`docs/design/local-laya-api.md` §6/§8）：`managed-weights/verify.ts` 受信根改 cache 根（修 HF 合法 symlink 被误判越界），校验后物化普通文件 staging 再原子 activate；`local-laya/download.ts` 把 Laya 登记进既有 `downloads.ts`（新增 `DownloadDef.cancel` + `status` 投影 + 通用 `followStatus` + `POST /api/downloads/:id/cancel`，**未另造 registry**）；`Downloads.tsx` 补取消 / 可见错误 / 重试 / 读失败保留旧行；进度改事件驱动（`notifyDownload` 转发 `downloads.changed`，去全局每秒轮询）；权重进度只算本 checkpoint 必需文件。
- **本地语音多模型**（`docs/design/local-asr-model-catalog.md`、`docs/design/local-asr-api.md` 多模型目录）：`GET /api/local-models/asr/catalog`（硬件档位 / 推荐 / 每模型状态 + 许可 + 来源）、`/models/:id/{install,cancel,select,start,stop,pause,resume,idle,update,status}` + `DELETE`；运行族 sensevoice/paraformer/whisper；`intent:"install_and_use"` + 来源 `version`/`expectedVersion` CAS（`409 asr_source_conflict`）；许可分级 `agreementRequired`（MIT/Apache 一键装不伪同意，SenseVoice `unresolved` 仍只允许自行导入）；正式 6 项：Paraformer 中文、Whisper base/small/turbo/large-v3、SenseVoice。前端 `LocalAsrModels.tsx` 等按真实 catalog DTO 渲染，安装并使用由后端写来源、前端不再自己 PUT。
- **主题设计可选模型**（`docs/design/appearance-themes.md` §5.7/§8）：面板顶部「使用模型」显示并可选本次草稿模型（canonical `provider/id` 快照进本次请求），不改助理主模型 / 模型池 / 全局默认；服务端 `resolveThemeModel` 对显式引用 **fail-closed**（空对象 / null / 非对象 / 不存在 / 缺凭据一律报错、0 请求、不 fallback 到别的收费模型）；带参考图只列支持视觉的模型。

## 3. 本阶段实跑（Node v24.20.0；全部隔离）

隔离：所有命令 `PIA_DATA_DIR` / `PIA_WORKSPACE` / `HOME` 指向本阶段新建的临时根，`PIA_OFFLINE=1`；未读真实 data / config DB / cache / credentials / `secrets.ts` / SDK 凭据源码；未下权重、未启动真实 Laya / 语音 sidecar、未开麦、未付费、未连真实云、未碰钥匙串。

| 检查 | 命令（在树根 / `packages/server`） | 结果 |
|---|---|---|
| 服务端类型 | `npm run typecheck -w @pi-assistant/server`（`tsc --noEmit`） | exit 0 |
| 网页类型 | `./node_modules/.bin/tsc --noEmit -p apps/web` | exit 0 |
| 网页构建 | `npm run build -w @pi-assistant/web` | 通过（`vite build`） |
| 服务端定向单测 | `node --import tsx --import ./test/setup.ts --test test/{theme-ai,local-asr-multimodel,local-asr-license,downloads,local-laya-verify-hf,local-laya-verify,local-laya-download,local-laya,local-laya-deps,local-laya-routes,local-laya-register,voice-source-http,local-models}.test.ts` | **109/109 通过，0 失败 / 0 跳过**（其中 `theme-ai` 单跑 **19/19**） |
| 主题前端纯逻辑 | `node --import tsx --test e2e/theme-ai-frontend.test.mjs` | **11/11** |
| ASR 前端纯逻辑 | `node --import tsx --test e2e/local-asr-models-frontend.test.mjs` | **6/6** |
| ASR 安全 UI 夹具 | `node e2e/local-asr-models-ui.mjs`（静态 dist + `page.route`，纯前端，未起真实服务） | **全过**（5 模型渲染 / 许可 / indeterminate 进度 / `intent=install_and_use` 不偷传 acceptLicense / selected 使用中 / stale 不 late 覆盖 / `/select` / 取消 / 失败重试 / 390） |
| 设置功能安全 UI 夹具 | `node e2e/settings-functional-ui.mjs`（同上，证据输出重定向到临时目录） | **全过**（17 项导航 / 模型页瘦身 / 语音配置 / 语音入口 / Help / 本地段旧断言不破） |
| Laya 下载 UI 夹具 | `LAYA_UI_OUT=<tmp> node e2e/local-laya-download-ui.mjs` | **20/20**（取消同一 job / 权重真实百分比 / 依赖不定进度不混字节 / GET 失败保留旧行 + 重试 / POST 行内错误 / 电脑页取消 / 390） |
| 真实后端 catalog smoke | `node --import tsx e2e/local-asr-catalog-real.mjs`（内存 launcher + tmp DATA/WORKSPACE 起真实 server） | **通过**（真实 `GET /api/local-models/asr/catalog` 200，6 模型，tier=balanced，recommendedId=whisper-small-int8；MIT/Apache `agreementRequired=false`、SenseVoice `true`；含真实权重 pin） |

交叉核对（共享契约以 Laya 最新为准）：HEAD 的 `packages/server/src/downloads.ts`、`local-laya/{deps,download,verify,hf-metadata,checkpoint-files,index}.ts`、`managed-weights/verify.ts`、`docs/design/local-laya-api.md` 与 `10317d0` **逐文件一致**；ASR 的旧 `notify/轮询` 写法未覆盖 Laya 的事件驱动/取消契约。

## 4. 核实过的合并图

- `git log --first-parent --oneline dcce520..HEAD` = 三条中文 merge commit（`1dbb652` / `277ddfb` / `12370a5`），无其它提交夹带。
- `10317d0`、`55a09e7`、`0781b9c` 均为 HEAD 祖先（`git merge-base --is-ancestor` = yes）。
- 结束后 `git status` 干净、无未跟踪文件；HEAD = `12370a5`。

## 5. 未验 / 不可宣称（如实）

- **ASR 多模型「可安装」仍不可宣称 ready**：候选树里的 deps 下载仍是老实现（`18478d4` 时代按固定来源），按所选模型 repo/revision 直连 HF 的生产修复在 `local-asr-multi-model` 的 `8beea59` 及其后续（另 owner 进行中，真实 <900MB 两 family 实测未完成），本阶段**未合**。等后端 productionfix + 真实 smoke 完成后由主会话再合。
- 主题的**真实云模型生成质量 / 计费**未验（本阶段只跑假模型 / 内存凭据 / mock server）。
- ASR 的**真实下载 / sha256 / 启动 sidecar / 转写 / RTF / 峰值内存**未验；SenseVoice 许可仍未决（`unresolved`，仅自行导入）。
- Laya 的**真实 GB 权重端到端 / 真实启动**未验（禁止真实 Torch / GB 权重）；只跑了假文件 / 环回 fixture。
- 三块都**未真机安装包 / 未跑全量 `npm test`（757 项）/ 未跑全量 `e2e/run.mjs`**（第 1 步向导是既有基线）。本阶段只做「受影响定向回归」，未全量。
- 已知基线 / 相邻风险（未在本阶段复跑或未定性，不遮掩）：`local-laya-download-tracking` owner 自述 `test/setup.ts` 静态 import 早于 `await import()` 的隐患与其自报的临时目录写入已自行清理，**主会话未独立确认**（本阶段未进入真实数据目录查看 / 恢复，也未据其改动树）；测试预加载 guard 由 Laya owner 另修。
- 本阶段无新版本号、无 release notes、无 tag；beta.25 仍为唯一公开版本，beta.25 已完成功能按各分支快照保留。

## 6. 主会话后续依赖（下一步）

1. 等 `local-asr-multi-model` 生产 deps / HTTP 下载修复完整 done 后，由主会话合入候选树，并对 ASR 做真实两 family（<900MB）安装 + 转写 smoke；在此之前不把「5 模型可一键安装」写成 ready。
2. 等 Laya owner 的测试隔离 P0 + 公开 Laya 路径 resolver 修复完成后由主会话合入（本阶段未拿 dirty 最新）。
3. 三块都通过后再统一决定是否纳入 beta.26 打包范围（由用户说「打包」后才定版本与范围；缺省仍只 Apple 芯片 macOS arm64）。
