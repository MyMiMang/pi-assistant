# 默认本地语音（开箱即用）设计

> 状态：**设计（beta.30 候选，未实施）**。选型与事实证据见 `progress-snapshots/default-local-voice-decision.md`。
> 用户目标（原话大意）：**装好应用就能用语音**——不让人手动找模型 / 点下载 / 配路径；设置里可以切换别的；已有的「云 / 本地」选择**不能被默认覆盖或删除**；不需要用户提供云 key，不加付费云隐藏调用。优先**真正本地流式**听写，中文 / 英文都要能实际用；模型不限现目录，学优秀成品实现但**不照搬 GPL 代码**。尽量**随安装包带合法小模型 + runtime** 满足 offline-first，体积 / 许可合理，不先随意下载 GB。**若首次必须联网，必须明示；不能把后台自动下载说成首次断网可用。**

## 1. 范围

**做**
- 新增**原生流式**本地识别（sherpa-onnx `OnlineRecognizer`），作为「默认本地语音」。
- 默认语义：全新安装（`settings.voiceSource == null`）时提供开箱即用的本地流式默认；**已显式选择过的一律不动**。
- 复用现有：统一「下载与组件」进度 / 取消 / 失败重试、租约 / idle 卸载、权重 SHA256 校验、许可披露、`/api/audio/asr/source` CAS。

**不做（本轮）**
- 不改 Pi SDK / node_modules / 不 fork 引擎。
- 不删、不隐藏、不迁移现有 SenseVoice / Paraformer / Whisper（beta.28 的分段增量继续可用）。
- 不引入云端隐藏调用、不要用户 key。
- 不做 GGUF / 新引擎（Handy 的 moonshine / nemotron / Voxtral 路线）。
- 不加标点模型（默认流式模型输出无标点，如实标注）。

## 2. 现状（本树基线 `b20ec81`）

| 环节 | 现状 | 缺口 |
|---|---|---|
| 引擎 | `sherpa-onnx==1.13.8`，managed Python（uv + venv + `--require-hashes`） | 无流式端点 |
| 运行族 | `sensevoice` / `paraformer` / `whisper`，全部 `OfflineRecognizer`，未注册族 fail-closed（`runner.ts`） | 缺 `online-zipformer` |
| sidecar | `serve-script.ts`：一次性 `POST /transcribe`（16k mono WAV）→ JSON | 无「分块喂 + 增量回」 |
| 生命周期 | `manager.ts`：lease / idle 卸载 / cancel / install generation / 录制中不卸载 | 无流会话 |
| 权重 | `catalog.ts` + `manifest.ts` 固定 sha256，HF `resolve` 直链 | 新模型条目 |
| 来源 | `voice/source.ts`：`settings.voiceSource = {location,provider,model} | null`；`null` = 未配置；CAS `expectedVersion`；不静默挑源 | `null` 时的默认语义 |
| 下载 | `local-asr/download.ts` 登记 `asr:<modelId>` 到统一下载面板（事件驱动） | 默认模型的自动准备入口 |

## 3. 模型与运行族

### 3.1 catalog 条目（新增，数据驱动）
```
id:        streaming-zipformer-bilingual-zh-en-int8
provider:  local-online-zipformer
family:    online-zipformer
streaming: true                // 新字段：原生流式（前端据此走 committed/tentative）
defaultVoice: true             // 新字段：唯一「默认本地语音」标记（不硬编码 modelId）
manifest:  { repo, revision, files[encoder,decoder,joiner,tokens], bytes, sampleRate:16000, channels:1,
             punctuation:false, languages:["zh","en"], runner:"online-zipformer",
             fileRoles:{encoder,decoder,joiner,tokens} }
license:   decision="unresolved-bundle" / selfServe=true / redistribution=false / requiresExplicitAgreement=false
           （**本地按需下载放行；随包分发等主口径**，见决策文档 §三.1）
platforms: SHERPA_PLATFORMS（6 项）
```
`defaultVoice` 是**数据**：默认是哪个模型只由 catalog 决定，实现里不出现 modelId 字面量（`resolveDefaultVoiceModel(specs)` 纯函数）。

### 3.2 运行族 `online-zipformer`
- `runner.ts` 注册：`requiredRoles = ["encoder","decoder","joiner","tokens"]`，`assertWeights` 要求 3 个 `.onnx` + `tokens.txt`，沿用 `assertNoExecutableWeights`。
- `serve-script.ts` 新增 `onlineZipformerServeScript`：
  ```python
  recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
      encoder=..., decoder=..., joiner=..., tokens=...,
      num_threads=THREADS, sample_rate=16000, feature_dim=80,
      decoding_method="greedy_search",
      enable_endpoint_detection=True,
      rule1_min_trailing_silence=2.4, rule2_min_trailing_silence=1.2, rule3_min_utterance_length=20.0)
  ```
  端点规则取 sherpa 官方默认量级；**具体数值以真实 smoke 调**（不是拍脑袋当已验）。

### 3.3 流式协议（已实现，契约以 `progress-snapshots/default-stream-contract.md` 为准）

**本小节为早期设计草稿，已被契约取代**：实现采用 `start / append / end / cancel` 四步**有界 HTTP 会话**（而非单个 chunked POST），以便手机 / 远程浏览器经 host server 既有鉴权使用、并支持取消 / 幂等 / 主体绑定。

- `POST /api/audio/asr/stream`（create）→ `{ sessionId, modelId, provider, sourceVersion, leaseId, protocol:"asr-stream-v1", sampleRate, channels, format:"s16le", maxChunkBytes, partialIntervalHintMs, maxSessionMs, idleTimeoutMs, nextSeq:0, state:"ready" }`；
- `POST /api/audio/asr/stream/:id/append`（body = 裸 16k mono s16le PCM，头 `X-Asr-Seq`）→ `{ seq, accepted, nextSeq, state, events[], buffered }`；
- `POST /api/audio/asr/stream/:id/end` → `{ state:"ended", finals[] }`（幂等）；`POST .../cancel` → `{ state:"cancelled" }`（幂等）。
- 鉴权：**只有 sidecar 绑 `127.0.0.1`**；host server 路由走现 safe API 鉴权（**非 localOnly，手机可用**）；会话绑定**授权主体 + agent/conversation + sourceVersion**，别的会话拿 sessionId 不能操作。
- 事件：`committed`（段稳定前缀，绝对文本）/ `tentative`（该段剩余整体文本）/ `final` / `endpoint` / `error`，**server-authoritative per-segment**（前端不做 LCP）。

### 3.4 稳定前缀（前端）
- 服务端在 sidecar 内计算并直接给出 `committed`（段稳定前缀）与 `tentative`（该段剩余整体），**前端只做 `committed + tentative` 拼接，不做最长公共前缀**（详见契约 §2.3；早期「客户端算 LCP」的草稿已废弃）。
- `final` 到达即冻结该段，并 `reset` 后的新 partial 进入下一句（新 `segmentId`）。
- 复用现有 `VoiceDraftAssembler` 的「用户已编辑区不覆盖」规则：只改 tentative 区，用户动过的段一律冻结。

## 4. 默认语义（关键：不覆盖用户选择）

| `settings.voiceSource` | 行为 |
|---|---|
| `null`（全新 / 从未选） | 语音设置页显示「**默认：本地流式听写**」+ 实际状态（未准备 / 准备中 x% / 可用）；**只有用户按下麦克风或点「使用默认」时才写入 source**，且写入前用 CAS（`expectedVersion`） |
| 已是 `local` / `cloud`（任何值） | **一律不写**，只显示「当前使用：…」，另给「换成默认本地」按钮（显式动作） |
| 指向已删除的模型 | 沿用现有 `withSelected` → `deleted` 条目 + 原因，**不改写存的值** |

- 已安装数据 / `asrProviders` 声明一律不删不改（`source.ts` 现有约定）。
- 不静默计费：`null` 时绝不悄悄回落到云端。

## 5. 准备 / 预热 / 权限

- **准备（install）**：默认模型登记进统一下载面板（`asr:<modelId>`），复用 `downloadFile`（Range 续传 / `.part` / 摘要校验 / 原子改名）+ `manager.install` 阶段（`preflight>uv>venv>engine>weights>verify>activate`）。
- **首次是否联网**：取决于是否随包内置（见 §7）。**界面必须写清**：内置 → 「已内置，可离线使用」；未内置 → 「**首次使用需联网自动准备约 XXX MB，之后可离线使用**」。**绝不写「首次断网可用」**。
- **预热（warmup）**：只在「用户打开语音面板 / 按下麦克风」时启动 worker 并加载模型；线程数沿用 `capThreads`（物理核封顶，**不霸全 CPU**）；idle TTL 沿用 `ASR_DEFAULT_IDLE_SECONDS`；**录制中绝不卸载**。
- **麦克风权限**：**未开始录音前不申请**。准备 / 预热不碰麦克风。
- **手机 / Web**：识别一律在 **host server** 上跑；手机只上传音频流，**不在手机上重下权重**（现有架构已经如此，默认模型沿用）。

## 6. 设置与状态（沿用现有信息架构）

- 位置：设置 → 语音（`VoiceSettings.tsx`）本地段，现有 `LocalAsrModels.tsx` 列表里默认项置顶并带「默认」徽标。
- 显示**实际使用的模型**（catalog `selected` 为准）与**实际状态**：未安装 / 准备中（复用统一下载组件，真实阶段 + 真实百分比）/ 可用 / 失败（原因 + 重试）。
- 说明性文字（首次联网、无标点、体积、许可）放现有 `<?>` Help，不占主界面。
- Linux 服务器版（无 UI）：同一套 HTTP API 可用（`/api/local-models/asr/*` + `/api/audio/asr/source`），默认语义同样只在 `null` 时生效。

## 7. 打包（三种口径，按主拍板切换）

| 口径 | 内容 | 每平台增量 | 开箱是否离线 |
|---|---|---|---|
| **P0 全内置** | 权重 198 MB + CPython（新增 `bin-seed` 项，~71 MB）+ 两个 wheel（~12–25 MB） | ≈ +285–295 MB | ✅ 真 offline-first |
| **P1 只内置权重** | 权重 198 MB | +198 MB | ❌ 首次联网准备运行时 ~85–95 MB（**明示**） |
| **P2 全不内置**（本轮默认落地口径，受许可阻塞） | — | 0 | ❌ 首次联网准备 ~285–295 MB（**明示**） |

- 复用 `scripts/stage-app.mjs` / `scripts/fetch-bins.ts` / `third-party.json`：新增内置物一律走 `third-party.json` 固定版本 + SHA256，**不新造清单**。
- 安装包内资源**只读**：运行时物化到**自有数据目录**（`数据目录/local-asr/...`），**绝不往只读 `.app` 里写**（沿用现有 `asrPaths()` 约定）。
- 内置物校验：`bin-seed` 首次启动复制时校验 SHA256（沿用现有 `config.ts` 的 `bin-seed` 流程）。

## 8. 最小实现清单（主发槽后执行）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/server/src/local-asr/manifest.ts` | 新增 `AsrModelManifest.streaming?`；新增默认模型常量与 pin |
| 2 | `packages/server/src/local-asr/catalog.ts` | 新增条目 + `streaming` / `defaultVoice` 字段；`resolveDefaultVoiceModel()` 纯函数 |
| 3 | `packages/server/src/local-asr/runner.ts` | 注册 `online-zipformer` 族（roles / assertWeights） |
| 4 | `packages/server/src/local-asr/serve-script.ts` | 新增 `onlineZipformerServeScript` + `/stream` chunked 端点 |
| 5 | `packages/server/src/local-asr/manager.ts` | 流会话：`openStream()`、`finally` 释放、录制中不卸载；复用 lease |
| 6 | `packages/server/src/local-asr/{download,service,routes}.ts` | 登记默认模型；`install_and_use` 仅在 `source==null` 且用户显式动作时写 |
| 7 | `packages/server/src/voice/*` | 默认语义：`null` → 「默认本地流式」视图；不覆盖已有值 |
| 8 | `apps/web/src/{voice-input.ts,hooks/useVoiceInput.ts,components/VoiceInput.tsx}` | committed/tentative 稳定前缀；复用 `VoiceDraftAssembler` |
| 9 | `apps/web/src/components/{LocalAsrModels,VoiceSettings}.tsx` | 「默认」徽标 + 首次联网明示 + 实际状态 |
| 10 | `docs/*` | 本设计 + HANDOFF + ROADMAP + THIRD_PARTY_NOTICES（新权重与引擎署名） |

## 9. 验收方案（本树不许跑，留给测试槽）

**单测（合成信号 + 假 provider，不碰真麦）**
- catalog / manifest：`defaultVoice` 唯一、pin 齐全、`resolveDefaultVoiceModel` 数据驱动；
- runner：`online-zipformer` roles 齐全 / 缺一 fail-closed；脚本里出现 `from_transducer` 且**不出现** `OfflineRecognizer`；
- 流协议：partial/final 事件解析、endpoint→reset、断连释放、非法帧拒绝；
- 默认语义：`source==null` 才写；`source!=null` 时安装完成 / 自动准备**不写**；CAS 冲突返回 409；
- 前端：最长公共前缀（中文不空格 / 英文空格）、用户编辑区不被覆盖、取消保留已冻结段。

**真实 smoke（有测试槽后）**
- 真下 198.3 MB → 逐文件 SHA256 与 pin 一致 → 起真实 sidecar；
- 喂官方 `test_wavs/0.wav`（中文）与 `1.wav`（英文）**按 100 ms 分块**；
- 断言：partial 在流结束前就出字；endpoint 触发 reset 后能连续出第二句；final 文本如实记录（**命中/漏字都如实写，不夸质量**）；本机 RTF 与首字延迟**实测**（不引用官方指标）；
- 断网复测：内置口径下断网可录音识别；未内置口径下界面明确提示需联网；
- 录制中不卸载、取消后 worker 释放、idle 回收、切模型与 lease 冲突。

**明确不做的验收**：不跑全量 `npm test` / 全量 e2e（按用户「只跑受影响部分」要求）。

## 10. 未决 / 阻塞（见决策文档 §三）

1. 权重**再分发**许可（bundle）口径未定 → 本轮按「本地按需下载 + 明示首次联网」落地。
2. 流式协议 + manager 流生命周期是新增件，**未实现**。
3. 真 offline-first 需新增「内置 CPython」打包机制（未做）。
4. 中英文真实质量 / RTF / 首字延迟**未实测**。
5. 默认流式模型**无标点**（如实标注，不假装有）。
