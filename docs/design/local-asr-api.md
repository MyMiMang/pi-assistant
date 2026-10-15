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
