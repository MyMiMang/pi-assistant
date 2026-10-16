# 本地 SenseVoice ASR：后端 API 契约（v1，后端先行稿）

> 状态：**后端先行契约**（分支 `local-asr-sensevoice`，基 `unified-integration` = `ad3526f`）。UI 与语音输入主任务（voice agent）按此对接；
> **UI → Server 的上传契约（字段名 / 返回结构）由语音输入主任务最终确定**，本文件里标 ⚠️ 的部分可随主契约调整。
> 依据：`research/sensevoice-local-asr-feasibility.md`、`research/sensevoice-weight-license-review.md`、`research/voice-input-project-comparison.md`。
> **不声称任何性能数字**：本机未实测冷启动 / RTF / 峰值内存；**不把「已安装」当「能用」**。

## 0. 定位与红线

- 这是**可选**的本地 ASR provider：CPU、离线、单句转写（**不是流式、不是通话**）。
- **不随 App bundle 权重、不 mirror 再分发**：许可复核结论 `unresolved`（见下），所以安装入口**默认关闭**，只开放「用户自行导入合法取得的权重」。
- **不伪造成 chat / classifier**：本地 ASR 在统一注册表里是 `type:"asr"`，带 `asrAdapter` 元数据；**不定义一整套 ChatProvider 鉴权**。
- 引擎 = **sherpa-onnx 1.13.8（Apache-2.0，无 torch）**；权重 = SenseVoiceSmall int8 ONNX。
- **只绑 `127.0.0.1`**；token 每次启动新生成，**只在进程内**（`/status`、日志、前端一律看不到）。
- **未实测**：真实下载 / 安装 / 启动 / 转写质量与速度、Intel Mac / Windows / Linux 真机、GPU（本实现只用 CPU，未启用 MPS / CoreML）。

## 1. 许可门槛（最重要，先读）

| 项 | 值 |
|---|---|
| 权重许可 | **FunASR Model Open Source License Agreement v1.1**（**不是 Apache-2.0**） |
| 判定 | `decision: "unresolved"`（issue #334 仍 open；2026-09-22 标注「not final license-owner confirmation」） |
| 再分发 | `redistribution: false` → **不打包、不镜像** |
| 安装入口 | **默认关闭**（`unresolved`） |
| 自行导入 | **开放**（用户自己合法取得的权重） |

行为规则（`license.ts` 纯函数）：

- `installGate`：`prohibited` → 拒绝；`unresolved` → 拒绝（除非调用方显式 `allowUnresolved`，产品默认不传）；`cleared` → 允许，但**必须** `acceptLicense === termsVersion`。
- `importGate`：只有 `prohibited` 才拒绝。
- 任何情况 `bundleAllowed()` 在 `redistribution !== true` 时为 false。

**条款可见性（UI 必须遵守）**：`GET /source` 返回完整 `links` + `restrictions`（署名要求、§3 用途声明、§4.2、§6 单方改版、issue 未闭环）。
这些**必须默认可见**，不能用一次「我已阅读并同意」把法律文本折叠遮盖；勾选只是确认动作。署名（§2.2 硬要求）：`SenseVoiceSmall by FunASR / FunAudioLLM`。

## 2. 路由总览

全部挂 `localOnly`（仅本机回环），前缀 `/api/local-models/asr/sensevoice`：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/status` | 平台 / 许可 / 安装 / 运行 / health / 注册 / idle 策略 |
| GET | `/platform` | 平台预检 + 可用加速器（**只有 cpu**） |
| GET | `/source` | 来源元数据 + 许可披露 + 模型文件（路径 / 大小 / SHA256） |
| GET | `/logs?lines=200` | 最近日志（已脱敏，不含 token） |
| POST | `/install` | `{ acceptLicense?, source?: "download"\|"import", importDir? }`；异步跑，用 status 轮询 |
| POST | `/cancel` | 取消进行中的安装 / 下载（随后自动回滚 staging） |
| POST | `/start` | 启动 sidecar（按需） |
| POST | `/stop` | 停止 sidecar（只释放进程与 CPU/RAM，**保留磁盘权重**） |
| POST | `/pause` | 暂停：停止 + 不再自动重启 |
| POST | `/resume` | 恢复：清退避与失败计数 |
| POST | `/idle` | `{ seconds }` 设置空闲 TTL（0 = 每次推理后立即释放） |
| POST | `/update` | 重跑安装到 staging 并原子切换（失败回滚旧环境） |
| DELETE | `/` | 卸载（body `{ "confirm": true }`；只删 own 目录） |
| POST | `/transcribe` | ⚠️ 后端先行：raw body = 16k mono 16bit WAV → `{ ok, result }` |

约定：写操作成功 `{ ok: true, status }`；失败 `400` + `{ ok: false, error, status }`；`transcribe` 未运行 `409`、音频非法 `400`。

## 3. status 结构（要点）

```ts
interface AsrStatus {
  platform: { key; os; arch; support: "supported"|"conditional"|"unsupported"; accelerator: "cpu"; wheelTag; reason };
  license: { licenseName; termsVersion; decision; redistribution; attribution; links; restrictions; reason; acceptValue };
  install: { state: "not_installed"|"installing"|"installed"|"failed"; phase; received; total; error; installedAt; source: "download"|"import"|null };
  runtime: { state: "stopped"|"starting"|"running"|"stopping"|"crashed"|"paused"; pid; port; host: "127.0.0.1"; restarts; lastError };
  health: { ok; device; loaded } | null;
  configured: boolean;                    // 已安装（≠ 能用）
  registered: { provider; modelId; protocol } | null;   // 无 token
  idle: { seconds; lastActiveAt; active; leases; unloads; paused };
  source: {...}; model: { id; bytes; sampleRate; channels; languages; punctuation; threadCap };
  notes: string[];                        // 明确的边界声明（未实测 / CPU / 释放语义）
}
```

## 4. 生命周期与资源策略

- **安装**：许可门槛（同步 `precheck`，决定 HTTP 状态码）→ uv → staging venv → `sherpa-onnx==1.13.8` → 权重（下载 / 导入）→ 清单校验（大小 + SHA256 + 路径安全）→ **原子 activate**。
  失败 / 取消 → 回滚 staging，`state=failed`（取消则 `not_installed`），**绝不产生半安装 ready**。
- **按需加载**：进程只在需要时启动；**不录音时默认短 idle TTL = 90s**（可配 `0..3600`，`0` = 每次推理后立即释放）。
- **idle 截止时间**从「最后一次推理结束 / 录音租约释放」起算；**正在推理或有排队请求、或持有录音租约时绝不 kill**；新请求重置截止时间。
- **释放语义**：只释放**进程与 CPU/RAM**，磁盘权重保留。**不把「卸载模型」宣传成「RSS 一定回落」**——本模块不提供任何内存承诺。
- **停止 = 明确的 stop-active-abort**：停止 / 释放会 `abort()` 进行中的推理请求，调用方会收到「已中止」而不是挂住。
- **只 kill 自己 spawn 的 pid**；启动失败按**有界指数退避**（1s → 2s → … 封顶 30s），连续 5 次失败进入 `paused`，需 `resume`。
- **麦克风并行**：进程启动与录音并行（冷加载时 UI 单独显示「准备中」，录音不丢）——由 voice agent 在 UI 侧编排；后端只保证「启动中也能接收请求后转写」与「未安装时 `transcribe` 明确 409」。

## 5. 权重来源与导入

- 下载（仅 `cleared` 许可时开放）：只按固定清单 `allow_patterns` 取文件，落到**我们自己的** staging 目录（真实文件，不用共享 HF 缓存符号链接）。
  - 模型 `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`，revision `2365baeacb507f821a0c8120fcee3d484dba7a07`；
  - `model.int8.onnx` 239 233 841 B / SHA256 = HF LFS oid `c71f0ce0…a2cd51`；`tokens.txt` 315 894 B / `f449eb28…a29a1dc`。
- 导入（`source: "import"`，`unresolved` 下唯一可用路径）：`importDir` 必须**绝对路径、真实目录、非符号链接**，不得在本地 ASR 自己的目录内，也不得在敏感位置（`~/.ssh`、`~/.gnupg`、`~/Library/Keychains`、`~/.aws`、`/etc`、`/System` 等）。
  **只复制清单内文件**（不列举、不读取其它文件），源文件不得是符号链接、大小必须与清单一致，复制后同样走清单校验。
- **升级清单（换 revision / 版本）必须同步 `research/sensevoice-weight-license-review.md` 与测试**（测试会校验清单形状与 ONNX 摘要）。

## 6. 转写协议（⚠️ 待 voice agent 确认）

后端先行实现（`transcribe.ts`）：

1. **先校验 WAV**（`checkWav`，无 ffmpeg 依赖）：RIFF/WAVE、PCM、16-bit、16000 Hz、单声道、data 长度是完整帧、字节 ≤ 8 MB、时长 ≤ 120 s。不合格 → `400` + `problems`，**不占用租约**（不重置 idle）。
2. 取**推理租约**（`beginInference()`）→ `POST {baseUrl}audio/transcriptions`（`baseUrl = http://127.0.0.1:<port>/v1/`），头 `authorization: Bearer <进程内 token>`、`content-type: audio/wav`，body = WAV 字节。
3. 默认超时 60s；**租约 signal 与超时任一触发即中止**；`finally` 一定释放租约。
4. 返回 `{ text, language, segments[], usage: { audioSeconds, cost: null } }`——**成本未知一律 `null`，绝不填 0**。

⚠️ 待确认：UI → Pi Server 的上传方式（multipart 字段名 / 是否复用 WS）、语言参数、分段与草稿合并的时机；由语音输入主任务定，后端按主契约调整 `transcribe` 路由签名即可。

## 7. 统一注册表（`type:"asr"`）

- `ModelType` / `ModelCapability` 新增 `"asr"`；`RegistryModel.asrAdapter` = `{ protocol, sampleRate, maxSeconds, languages, punctuation, requiresApiKey: false }`。
- 本地服务卡片 `kind:"local"`，`source:"local"`；已安装但停止时**保留卡片**，只标暂不可用。
- **不含凭据**：注册表与 `/status` 都没有 token；运行中的端点只在 `local-asr/adapter-registry.ts`（server 内部）。
- 安全元数据经 `local-asr.changed` 事件 → `local-models.ts` 缓存（provider / modelId / protocol / 状态 / device / asr 元数据），不 import 实现、不读凭据。

## 8. 安全不变量（实现已写死，测试覆盖）

1. 只绑 `127.0.0.1`；**不接受任意 URL**（转写只打注册表里的 loopback 端点，`install` 只透传已知字段——无 SSRF 入口）。
2. token 只在进程内 + 子进程环境；日志与状态脱敏（`Bearer ***` / 长十六进制串）。
3. 原始音频只在内存里：不落盘、不写日志、不进记忆；无 TTL 临时文件（本实现不留音频文件）。
4. 卸载只删 own 目录（canonical 校验），且需显式 `confirm`。
5. 导入不读敏感目录 / 只复制清单内文件。
6. 不装系统 Python、不装硬件驱动、不动用户文件。

## 9. 未验证清单（诚实边界）

- 真实 uv / venv / `pip install sherpa-onnx` / 权重下载 / 启动 / 转写：**全部未在真机跑过**（本轮只用 fake deps + 假识别器）。
- 冷启动、RTF、峰值 RSS、与 Laya / VM 并存的资源表现：**未测**，不给承诺。
- Intel Mac / Windows x64 / Windows ARM64 / Linux x64 / ARM64 真机：**未测**（平台支持只按官方轮子声明）。
- CoreML / MPS：**未启用、未验证**（上游未证 SenseVoice 的加速声明）。
- sherpa-onnx 轮子 SHA256：**未 pin**（按平台/CPython 分片，v1 只 pin 版本号，依赖 uv/PyPI 索引完整性）。
- 许可：issue #334 仍 open，**不是法律意见**。

---

# 本地 ASR 多模型目录（v2，分支 `local-asr-multi-model`，基 `release-candidate-validation` = `dcce520`）

> 状态：**后端已实现**（未 push / 未打包）。用户要求：本地语音提供**多个可选择模型**，按性能档位推荐，
> 一键下载安装配置后可用，不是解禁单一 SenseVoice 按钮。UI 由 `local-asr-model-choice-ui` 树消费。
> 事实来源：`local-asr-model-catalog-2026-10-16.json`（HF LFS oid + 实测 tokens SHA256 + sherpa-onnx 1.13.8 sdist 工厂签名）。

## A. 目录里有哪些模型（正式 6 项）

| modelId | family | 档位 | 权重体积 | 许可 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `paraformer-zh-2023-09-14-int8` | paraformer | 轻量 | 243,446,974 B | Apache-2.0（cleared） | 中文主力，中英混说；**无标点** |
| `whisper-base-int8` | whisper | 轻量 | 160,609,290 B | MIT（cleared） | 多语，中文弱于同体积 Paraformer |
| `whisper-small-int8` | whisper | 均衡 | 375,485,327 B | MIT（cleared） | 多语均衡（16GB 档推荐） |
| `whisper-turbo-int8` | whisper | 高质量 | 1,036,613,791 B | MIT（cleared） | 高质量里的速度优先版 |
| `whisper-large-v3-int8` | whisper | 高质量 | 1,775,753,918 B | MIT（cleared） | 最高精度档（32GB 档推荐） |
| `sensevoice-small-int8` | sensevoice | 均衡 | 239,549,735 B | **unresolved** | 存量兼容：**只保留自行导入**，不进下载面板 |

- **Whisper 输出为模型原生文本（含标点 / 大小写）**：研究 JSON 的 `punctuation:false` 字段不可靠，本实现按真实原生输出记为 `punctuation:true`，不做云端纠错。
- **Qwen3-ASR 0.6B 暂不上目录**：sherpa 1.13.8 真实支持 `from_qwen3_asr`，但公开 tar 缺 per-file / tar SHA256 pin → 未 pin 前不放「空可下载按钮」；运行族扩展点保留（`runner.ts`）。
- **许可准确**：正式项均为 MIT / Apache-2.0；SenseVoice 仍按 `unresolved`（issue #334 open），**不新增 accept 勾框把它洗成允许**，老 `provider=local-sensevoice` / modelId / 权重 pin 不变，历史 `voiceSource` 与已安装目录继续可读。

## B. 读：`GET /api/local-models/asr/catalog`

字段 = 现有 `AsrStatus` / `AsrSourceMeta` / `LicenseDisclosure` 的组合（**不重复定义几份 types**），实际类型见
`packages/server/src/local-asr/service.ts` 的 `LocalAsrCatalog` / `LocalAsrModelView`：

```ts
interface LocalAsrCatalog {
  hardware: { os; arch; cpuCores; memoryBytes; tier: "light"|"balanced"|"high"|"unknown"; tierNote };  // 按系统总 RAM 8/16/32 保守分档（估算，非跑分）
  runtime: { engine: "sherpa-onnx"; version; python; depsBytes: number|null; depsNote };                 // 共享引擎与权重分开
  recommendedId: string | null;
  models: LocalAsrModelView[];
  notes: string[];                                                                                        // 未实测边界
}
interface LocalAsrModelView {
  id; provider; family; variant; name; nameEn; languages; note;
  tier; tags: AsrTier[]; recommended: boolean; recommendationReason;
  available; unavailableReason;
  weightsBytes; depsBytes: number|null; depsNote; suggestedMemoryBytes; memoryNote;   // 内存=模型进程估算，非整机门槛
  capabilities; multilingual;
  license: LicenseDisclosure;                                                          // 同 /source
  source: { source: AsrSourceMeta; model: { id; repo; revision; files[] } };           // 同 /source 的 model.files
  installed; selected; running;
  install: { state; phase; phaseLabel; received; total; percent; error; installedAt; source; jobId; attempt };
  runtime: { state; pid; port; host; restarts; lastError; healthOk; loaded };
}
```

- 一次请求拿全（硬件档位 / 体积 / 依赖 / 内存估算 / 许可 / 来源 / 安装态 / 运行态），GET **不下载、不启动 worker**。
- **许可确认分级**：`license.agreementRequired` 为 `false` 时（MIT / Apache-2.0）**不强制每次点同意** —— 正常展示署名与许可证链接即可，`acceptLicense` 可不传（一键装）；为 `true` 时才要求 `acceptLicense === acceptValue`。SenseVoice（unresolved）仍**阻下载**、保留自行导入，不新增勾框将其洗成允许。
- `install.total === null` → 前端画不定进度条（`phaseLabel` 给中文阶段），不编假百分比。
- `jobId` = 统一下载注册表稳定 id `asr:<modelId>`（同一次安装 = 同一个 job）；`attempt` 是第几次安装尝试（generation 概念，不要求 jobId 唯一到 attempt）。
- 不含 token：catalog / status 只有 provider / model / protocol。

## C. 写：按模型 id 路由（旧 `/asr/sensevoice/*` 保留兼容，语义不变）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/local-models/asr/models/:id/install` | body `{ acceptLicense?, source?: "download"\|"import", importDir?, intent?: "install"\|"install_and_use" }`；许可门槛同步 precheck 定状态码 |
| POST | `/api/local-models/asr/models/:id/cancel` | 取消进行中的安装 / 下载，回滚 staging |
| POST | `/api/local-models/asr/models/:id/select` | 切到该模型并停旧 worker；有录音租约 / 活跃推理时 400（忙时明确拒绝） |
| POST | `/api/local-models/asr/models/:id/start` / `stop` / `pause` / `resume` / `idle` / `update` | 生命周期（lazy，idle TTL 沿用 90s） |
| GET | `/api/local-models/asr/models/:id/status` | 单模型 status（catalog 子集，轮询用） |
| DELETE | `/api/local-models/asr/models/:id` | body `{ confirm: true }`；只删**该模型**权重 / 元数据，不卸共享 runtime 与其它模型 |

## D. 装 ≠ 用；stale intent 防覆盖

- `install` 只负责**装**，不改当前 ASR 来源。
- `intent:"install_and_use"`：安装成功后，**仅当**当前 `voiceSource` 与安装开始时完全一致才写「用本地该模型」；
  期间用户改选云端 / 别的模型 → 迟到的安装完成**不得覆盖**新选择（`LocalAsrService.install` 的 `selectionAtStart` 比对）。
- 来源真相仍是 `PUT /api/audio/asr/source`（UI 也可在安装成功后自己 PUT，二者幂等）。
- **跨客户端 stale（CAS）**：`GET /api/audio/asr/source` 额外返回 `version`（每次写入递增）；`PUT` 可带可选 `expectedVersion`（非负整数），与当前版本不一致时返回 `409` + `error:"asr_source_conflict"` 且**不写入**（旧客户端不带该字段照旧可用）。后端 `install_and_use` 在安装完成时用**安装开始捕获的版本**做 CAS：期间别的页面 / 客户端改选 cloud 或别的模型 → 写入失败则**不覆盖**（UI 提示「已装但未切来源」）。

## E. 统一下载（复用 `downloads.ts`，不另造 registry）

- 每个 cleared 且平台支持的模型登记稳定 downloadId `asr:<modelId>`（`local-asr/download.ts`）：
  `status()` 把 manager 的 install 状态投影成统一下载状态；`cancel()` 走同一个 manager AbortController；
  `hidden()` 对 SenseVoice（unresolved）与不支持平台返回 true。
- 「组件页下载」与「语音页安装并使用」是**同一个 job**：任何入口触发的安装经 `local-asr.changed` 事件（**事件驱动，不装永久定时 loop**）同步进下载面板。

## F. 运行族（有界扩展点）

`runner.ts` 注册 `sensevoice` / `paraformer` / `whisper`（sherpa 同一 `OfflineRecognizer`，按族构造）：
- SenseVoice：`from_sense_voice(model, tokens, use_itn=True, language)`；
- Paraformer：`from_paraformer(paraformer, tokens, num_threads, feature_dim=80)`（无标点）；
- Whisper：`from_whisper(encoder, decoder, tokens, language="", task="transcribe")` —— **`language=""` 自动检测，绝不回落引擎默认 `en`**；large-v3 的 128 mel 由引擎内部处理，不手造参数。
- 未注册 family → `precheck` fail closed（不假 runner 冒充）；Qwen3-ASR 待 pin。

## G. 隔离与资源

- **共享 runtime**（venv / uv / python / logs），**per-model 权重目录与 metadata**（老 SenseVoice 用历史布局）；全局**串行安装**避免并发 `uv pip` 污染同一 env。
- 一次只运行一个 worker；`select` 先停旧 worker；有录音租约 / 活跃推理时明确拒绝，不把进行中的音频送给别的模型。
- 卸载一个模型不卸共享 runtime / 其它模型权重；不删正在用（有租约）的模型。

## H. 未实测边界（诚实）

- 真实下载 / 安装 / 启动 / 转写、RTF、峰值内存：**全部未在本机跑过**（本轮只跑 fake deps + 统计测试）。
- 硬件档位与模型内存是**保守估算**，未跑 benchmark；`suggestedMemoryBytes` 是模型进程估算，不是整机门槛。
- 许可为公开来源核对，**不是法律意见**；Whisper 原生标点仍待真机确认。
