# release-candidate-validation 集成收尾报告（memory + voice + queue dedup + ASR 供应链）

- worktree：`release-candidate-validation`，起点 `362ccaf`，**当前 HEAD 见 `git log`**（本轮已在 `5fa4c1e` 之上追加：合并 thinking `de4491e`、合并 memory UI `3c3fdd4`、修统一 `Select` 可访问性、新增 thinking 前端 e2e；工作区 clean）
- 全程未 push / 未 tag / 未打包；只构建 Apple 芯片 macOS 的约束未触发（本阶段没打包）
- 全程 Mock / 内存 CredentialStore / 临时 `PIA_DATA_DIR`+`PIA_WORKSPACE`；**未读用户 key / 凭据 / 真实 db / Hindsight bank**，未碰系统钥匙串、未真下载权重、未真录音、未起 sidecar、未调付费模型
- Node 用 `/Users/dengdeng/.local/node-v24.19.0/bin`（Homebrew 的 node 25.8.2 因 simdjson 动态库缺失不可用，未做系统升级）

## 1. 本轮合入（`--no-ff` 保祖先）
| commit | 内容 |
|---|---|
| `b4474b6` | 合并 `memory-scope-safety`（HEAD `31fb220`，含 `dcb491c`/`065be28` 等**全部祖先**）：provenance + task 草稿分层、reflect 源端隔离、晋升去重、超时真中止。冲突只在 `runtime.ts`（子代理 extensions 行）与 `docs/HANDOFF.md`——**双方功能都保留**（memory 的 actor 注入 + 技能作用域 `skillFilter`/`skillPaths` 都在），未整文件覆盖。`http.ts` 自动合并后核对：记忆端点 actor 与技能/引用端点均在。 |
| `1ab56f9` | 合并 `voice-input-implementation`（HEAD `2c673f9`，含 local-asr-sensevoice `88a6909` + 引用 UI `dc83728` 祖先）：无冲突。 |
| `80bce16` | 合并 `message-replies-queue-dedup`（`771e3f0`）：群聊入队按可信来源消息幂等。 |
| `566ffce` | queue 收尾小修：多收件人组**整体事务化**（`BEGIN/COMMIT`，避免「部分入队后 crash」半组被 source 守卫整组跳过）+ 取消语义显式化（已有任何回合含 cancelled 即不再路由；仅显式 `retry` 且全部 cancelled 才重新唤醒；**不承诺 exactly-once**）。 |
| `f3b27dd` | 语音收尾：云 ASR 设置 + 本地 SenseVoice 许可卡 + 麦克风设置入口（见下）。 |
| `607ecbe` | 本地 ASR 引擎供应链：按平台固定 sherpa wheel SHA256 + `--require-hashes`。 |
| `bbf7bac` | 修回归：SenseVoice 卡状态响应不完整不崩面板；补 `model-services-ui` fixture 缺失的 `/api/models` 与 ASR 路由。 |

## 2. 实际跑过的检查（真实输出）
| 检查 | 结果 |
|---|---|
| 服务端 `tsc --noEmit -p packages/server` | exit 0 |
| 网页 `tsc --noEmit -p apps/web` | exit 0 |
| web `vite build`（2506 模块） | 通过 |
| 记忆相关单测（memory-scope-safety + retain-dedup + hindsight-scope + hindsight + hindsight-switch） | **19/19**（注：memory 报告写的 20 是把一个含子用例的用例按 2 计；实际断言 19 条，0 fail / 0 skip） |
| 群聊入队 + 引用 + rooms（queue-dedup + message-replies + message-replies-http + rooms） | **42/42** |
| 技能 + 语音/ASR（skill-assignments + skill-import + skill-intel + voice-asr + voice-input + local-asr-license/manager/transcribe/wav + asr-providers-http） | **103/103** |
| `e2e/voice-input-ui.mjs`（新写，纯前端 fixture + Chromium 假麦克风） | **全部通过**（25 项）：麦克风可见 / 未配置给「去设置」且 0 转写 / 录音→停止→转写插入锚点且保留草稿、不自动发送 / 取消 0 次转写且不动草稿与引用 / 切后台取消不发送 / 390 不溢出 / 云 ASR 声明区块 / SenseVoice 许可卡（限制默认可见、未确认时接受勾选禁用、下载安装禁用、导入可用） |
| `e2e/model-services-ui.mjs` | 通过（含**修的回归**：见 §4） |
| `e2e/model-ui.mjs` | 通过 |
| `e2e/custom-provider-delete.mjs` | 通过 |

## 3. 云 ASR 设置（补「上游 API 有、用户不可配置」的缺口）
- 服务端新增 `GET/POST /api/audio/asr/providers`、`DELETE /api/audio/asr/providers/:provider/:model`：**复用既有 provider 的 baseUrl / Key**，只声明「这个模型走语音转写」；不新建第二套 Key。未知服务 / 不支持协议 / 缺参数一律 400 且不写设置（`asr-providers-http.test.ts` 真实 HTTP 3/3 验证：声明后 `GET /api/models/registry` 出现 `type:"asr"`，删除后消失）。
- UI：`ModelServices` 每个非本地服务展开后有「语音识别（ASR）」区块（选模型 + 协议，复用该服务凭据），本地 SenseVoice 独立许可卡（限制默认可见、`decision=unresolved` 时接受勾选禁用、下载安装禁用、`导入已下载权重` 可用）。
- 麦克风：未配置 ASR 时按钮提示「未配置语音识别模型」并给「去设置」入口；`pickAsrModel` 只在注册表里选**已声明**的 ASR（本地优先），**没有未选自动云 fallback**。

## 4. 供应链（sherpa wheels）
- 从 PyPI 公开元数据（2026-10-15 复核）取 `sherpa-onnx==1.13.8`（依赖仅 `sherpa-onnx-core==1.13.8`，后者无依赖）两个包的官方 wheel SHA256，按 6 个支持平台（darwin arm64/x64、win x64/arm64、linux x64/arm64，Python 固定 3.12）固定；macOS 同时列 arch 专用与 universal2 摘要。
- 安装改为写 requirements + `uv pip install --require-hashes -r`；**无固定摘要的平台 fail closed，不回退未校验安装**。许可 `unresolved` 时安装入口本就默认关闭（勾选不能绕过），本轮只做固定与校验，**没有真下载 / 真安装**。

## 5. 修的回归（重要）
- 我新增的 `LocalSenseVoiceCard` 用 `st?.install.state` 作为 `useEffect` 依赖，状态响应为 `{}` 时会在**依赖数组求值阶段**崩掉整个模型服务面板（`model-services-ui` 从 2 张卡变 0）。已改为可选链 + 缺字段降级为「不可用」，不再崩。
- `model-services-ui` fixture 一直没 mock `/api/models`（`useConfiguredModels` 要求数组），已补 `[]` 与 ASR 两条路由；该用例现已通过。

## 6. 记忆 REST 安全（代码核对，未端到端）
- 用户侧记忆端点（GET/POST/PATCH/DELETE/reflect）一律在**服务端**显式传 `actor:"user"`，请求体类型不含 actor，**客户端无法伪造成 main**；工具路径 actor 由 runtime 按会话上下文注入（子代理/后台/群/主）。`promote/rejectDraft` 只给主会话。
- `canMutate` 缺省 actor 视为主会话，仅影响内部/旧调用；外部入口均已显式传 actor。属「代码审阅确认」，未跑真实 Hindsight 端到端。

## 7. 未验 / 限制（如实）
- **未 push / 未 tag / 未打包**（等 subagent-thinking-options-fix 交付后整体最小合，再走最后的 arm64 preflight）。
- 真实 Hindsight **HTTP retain/reflect（LLM）未验**：未配大模型凭据、无 Docker、未碰用户正在跑的 Hindsight 服务；只做了官方 0.10.3 查询层（`ReflectRequest` 校验器 + tag SQL helpers）实物验证。
- 本地 SenseVoice：**未真下载权重 / 未起 sidecar / 未真机录音**；sherpa 安装只到「生成带 SHA256 的 requirements」层，未跑真 `uv pip install`。许可 `unresolved`（FunASR MODEL_LICENSE v1.1，issue #334 未终局）→ 默认不自动安装、不随包分发、不镜像；只保留用户自行导入合法权重。
- 云 ASR：未用真实云 key 打通转写（无付费调用）。
- **webhook / 外部渠道引用未接**：不声称支持外部渠道的 reply。
- 全量 e2e / 安装包真机 / VM / 用户电脑未跑。
- `model-services-ui` 的 fixture 补 `/api/models` 是测试夹具修正，不代表生产 `/api/models` 行为变化。

## 8. 边界
未 push / 未 tag；未读 `secrets.ts` / 真实 keys / db / Hindsight bank / SDK 凭据历史；未改系统设置 / mic / 付费 / 大模型下载 / VM / App；未动 `voice-input-implementation` 与 `subagent-thinking-options-fix` 的源 tree。

## 9. 最终最小整合（thinking + 记忆后端 Select，2026-10-22 续做）
- 合并 `subagent-thinking-options-fix`（`de4491e`）到本树：候选池档位改**并集**、`packages/shared/src/thinking-levels.ts` 统一规则、服务端 `PiModels.supportedThinking`、档位菜单内部滚动、clamp 说明；`--no-ff` 无冲突。候选池原有的 memory / voice / queue 改动未被覆盖。
- 合并 `memory-backend-select-ui-fix`（`3c3fdd4`）到本树：助理页 + 设置全局记忆后端改应用内统一 `Select`。同样 `--no-ff` 无冲突；`ui.tsx` 的 `Select` 是唯一共享改动点，thinking 的菜单在 `ModelPicker.tsx`（另一处），两者不冲突，内部滚动保留。
- 修统一 `Select` 可访问性（上游自报的 `aria-activedescendant` 挂在 `button` 上属于非法 ARIA）：把 `aria-activedescendant` 移到**获得焦点的 `listbox`**（打开时聚焦菜单、选项 `tabIndex=-1`），触发按钮保留 button 语义并加 `aria-controls`。键盘语义不变（方向键只移高亮、`Esc` 不保存并还焦点、`Enter` 提交）。
- 前端真实 fixture e2e 新增 `e2e/subagent-thinking-levels.mjs`（真实服务端 + 真实 React 构建 + Chromium）：候选池为空=跟随主会话（档位=主会话模型、sol 无 off 则菜单无 off）；mixed 候选池取并集（含 xhigh/max/off，并集是旧交集严格超集）；非推理只有 off；固定档位被候选池不支持时黄字说明 + 按钮 tooltip；390 窄矮窗菜单限高 + 内部滚动，底部 max 可达可点。
- 实跑（Node 24.19.0，全 Mock / 临时数据，未碰钥匙串 / 真实 key / db）：thinking 6/6、queue/replies/rooms/subagents/custom-providers/model-registry 99/99、memory 19/19、voice/ASR 67/67、两端 `tsc --noEmit` exit 0、web `vite build` 通过；`e2e/subagent-thinking-levels`（新增）、`e2e/memory-provider-select`、`e2e/model-ui`、`e2e/model-services-ui` 全通过（`e2e/run.mjs` 的 `selectOption` 已由 memory UI 分支改为按钮点击，`node --check` 语法通过；未跑全量 run.mjs）。
- 远端只读核对（`gh` 已登录 MyMiMang，只读、未 push）：remote `main` = `8d7a7d8`（= 本地 main，是候选 HEAD 的祖先），最新公开 `v0.1.0-beta.23`，**`v0.1.0-beta.24` 未占用**。发布范围 `mac-arm64`。
- 资源核对：本地 ASR `serve-script.ts` 为代码内字符串、安装时写盘（无外部打包资源 / 无 `dirname` 运行时路径问题）；语音 `AudioWorklet` 用内联 `Blob` 注入（无 static / Tauri 资源依赖）；`git diff main..HEAD -- node_modules` 为空（未改 Pi SDK）。
- 日志：`evidence/final-arm64-preflight/`（tests-thinking / tests-queue-replies / tests-memory / tests-voice-asr / typecheck-build / e2e-subagent-thinking-levels / summary）。
- 未验（如实）：真实 Hindsight LLM retain/reflect、真下载 / 起 SenseVoice、真实云 ASR、手机真机、安装包真机、全量 `e2e/run.mjs`。

## 10. Pi SDK 1.1.0 → 1.2.0 合入候选（本轮）
- `deps/pi-1.2.0` 的四个提交（`1db53e7` 依赖升级 + union 适配 / `811062b` union 回归测试 / `e0462c2` 升级脚本 / `2948a05` 文档）以 `--no-ff` 合入本候选，合并提交 `bfd621a`，保祖先；候选自有 `node_modules` 官方装 1.2.0（无源码 patch / 无 fork），未系统升级 Node。
- 语义修正：`scripts/pi-update.mjs` 拆成 bump（升三包 + 同步依赖记录，compat 只写 `target`）与 `finalize`（**测试通过后**才写 `compat.json` 的 `testedWith`）；`pi-latest.yml` 把 `finalize` 放在测试成功之后，失败开 issue 且基线不前进。`check-pi.mjs` 对 `target != testedWith` 给提示。
- 新增本地验收：`test/pi-mcp-1.2.test.ts` 3/3、`test/pi-1.2-custom-provider.test.ts` 3/3、`test/pi-1.2-boot-context.test.ts` 5/5（都是真实 Pi 会话 + 本地 fake MCP / loopback 假服务 + 假 Key + 临时目录）。受影响定向测试 57 通过 / 1 失败（既有 macOS bsdtar 基线）/ 2 跳过；两端 typecheck exit 0；web `vite build` 2507 模块通过。
- 设计与验收自包含入库：`docs/design/pi-1.2-upgrade.md`；未验边界见 HANDOFF 本轮条目。
- 本候选此阶段**未合入**（各自独立树进行中，由主统一合并，勿提前标完成）：从消息 fork、上下文/技能整理与按需启用、tool discovery / codemode 受控验证、主题 UI 与 AI 主题。真实云 / 真实 Key / 真实定时 / 安装包真机仍未验。
