# 默认本地语音：自动准备 + 原生流式会话 —— 后端 API 契约 v1（冻结给前端）

> 状态：**契约冻结（前端按此对接，勿另造第二套）**。实现分支 `default-local-voice`，基线 `b20ec81`，本文件提交于 HEAD `607519d` 之后。
> 决策来源：主决策 **P2 首次自动准备**（无需用户手动点下载 / 找文件；**首次需联网并透明显示**；准备完成后可离线；**不随包分发许可未充分确认的权重**；**不假称首次断网可用**）。选型见 `progress-snapshots/default-local-voice-decision.md`；设计见 `docs/design/default-local-voice.md`。
> **本文件覆盖设计文档 §3.4 / §4 的旧措辞**：① committed/tentative 前缀由**服务端**给出（前端不自己算最长公共前缀）；② 新鲜用户（来源从未设置）准备完成且期间未被改选时，后端**自动把来源写为默认本地模型**（`自动 selected & ready`），仍严格 CAS，绝不覆盖用户中途的选择。
> 日期：本轮真实日期以工具 `date` 为准（见文末核验记录）。

---

## 0. 传输选型（先定，避免两套协议）

- **不用** `browser streaming request` / `duplex: "half"`（Safari 不支持）→ **不使用浏览器原生流式上传**。
- **用**：既有 **authenticated HTTP**（沿用现 host server 会话鉴权 + loopback sidecar Bearer）。浏览器 → host server（鉴权）→ loopback sidecar（每次启动新 Bearer token）。
- **鉴权范围（重要）**：**只有 sidecar 绑 `127.0.0.1`**。host server 的 `/api/audio/asr/stream/*` 走**现 safe API 路径**（本机或已配对设备），**不加 `localOnly`**——手机 / 远程浏览器连到 host server 后照常可用，延续用户原本「手机用语音」的 scope。未配对请求由现全局鉴权中间件 401，不由本模块另造鉴权。
- 会话模型：`start / append / end / cancel` 四步**有界会话**。`append` 为**帧批**（建议 **200–400 ms** 一帧，即 6 400–12 800 B），每次返回**本批产生的 JSON 事件**。
- 这是**模型原生增量**（`accept_waveform → is_ready → decode → get_result`），**不是**「攒完整段再批量转写」。
- 只绑 `127.0.0.1` 的是 sidecar；host server 的 token 只在进程内，`/status`、日志、前端一律看不到。

---

## 1. 自动准备（auto-prep）：默认模型状态

### 1.1 主入口：`GET /api/audio/asr/source`（前端已有的那次 GET 直接带出）

在现有 `AsrSourceView` 上**加一个可选块** `defaultVoice`（旧客户端忽略即可，向后兼容）：

```ts
interface AsrSourceView {
  source: AsrSource | null;        // 现有：{ location, provider, model } | null
  options: AsrSourceOption[];      // 现有
  version: number;                 // 现有：CAS 版本（每次写入递增）
  defaultVoice?: DefaultVoicePrepView;   // 新增
}

interface DefaultVoicePrepView {
  defaultModelId: string | null;   // catalog 里唯一 defaultVoice 标记解析结果；目录没标记 → null（fail closed，不猜）
  kind: "user-chosen" | "default" | "unconfigured";  // 与 default-voice.ts 的 defaultVoiceView().kind 一致
  label: string;                   // 可直接显示的中文一句话

  prep: {
    state: "not_applicable" | "not_prepared" | "preparing" | "ready" | "failed" | "cancelled";
    jobId: string | null;          // 统一下载注册表稳定 id = `asr:<modelId>`（与组件页同一个 job）
    phase: "preflight" | "uv" | "venv" | "engine" | "weights" | "verify" | "activate" | null;
    phaseLabel: string;            // 中文阶段名，直接可显示
    received: number | null;       // 字节；未知则 null（不编 0）
    total: number | null;          // 字节；null → 前端画不定进度条，不编百分比
    percent: number | null;        // 仅 total 非 null 时给；否则 null
    attempt: number;               // 第几次安装尝试（generation）
    startedAt: string | null;      // ISO
    finishedAt: string | null;     // ISO
    error: string | null;          // 失败原因（中文，脱敏）
    errorCode: string | null;      // 见 §4 错误码
    retryable: boolean;            // 失败是否可重试（走统一下载组件）
  };

  firstRunNeedsNetwork: boolean;   // P2 口径 = true（首次需联网准备）；若将来随包内置 = false
  approxBytes: number | null;      // 首次准备估算总字节（权重 198 270 793 B + 共享 runtime 估算）；未知 null
  offlineAfterReady: boolean;      // 准备完成后可离线使用 = true
  requiresUserAction: false;       // 自动准备**不需要**用户手动点下载 / 找文件
  micPermissionRequested: false;   // 准备 / 预热**不申请麦克风权限**
  notes: string[];                 // 诚实边界（首次联网、无标点、未实测质量等）
}
```

> 前端只需在现有 `GET /api/audio/asr/source` 的返回里读 `defaultVoice`，**不需要**另开轮询：准备进度复用现有「下载与组件」的进度推送（`local-asr.changed` 事件 → 现有 status 视图），前端订阅既有事件即可。
> 兼容别名：`GET /api/local-models/asr/default-voice` 返回同一 `DefaultVoicePrepView`（headless / Linux server 与网站用，逻辑同一份数据）。

### 1.2 自动准备语义（**不覆盖任何已有选择**）

后端新增两个 settings 标记（纯数据 key，不引入状态框架）：

```ts
const VOICE_DEFAULT_INIT_KEY   = "voiceDefaultInit";   // { at: ISO, modelId, sourceVersionAtStart: number }
const VOICE_DEFAULT_OPTOUT_KEY = "voiceDefaultOptOut"; // { at: ISO, reason: "cancelled" | "user_cleared" | "user_chose_other" }
```

区分「从未设置（unset）」与「显式清空（explicit null）」：`settings.voiceSource` **key 不存在** = unset；key 存在且值为 `null` = 用户显式清空（写 optout）。

**自动准备资格**（全部满足才启动，否则不动）：

| 条件 | 说明 |
|---|---|
| `readVoiceSource() === null` 且 `voiceSource` key **不存在**（unset） | 显式清空（explicit null）**不**自动准备 |
| `voiceDefaultOptOut` 不存在 | 用户取消 / 清空过 → 记 intent，**不 restart** |
| `voiceDefaultInit` 不存在 | 自动 job **全局只启动一次**，不反复重试、不「每次启动就下」 |
| catalog 解析出唯一 `defaultModelId` | `resolveDefaultVoiceId()` fail closed，无标记则 `state:"not_applicable"` |

**启动时机**：host server 启动后（后台）检查一次资格 → 满足则登记统一下载 job `asr:<modelId>` 并跑 `manager.install`，同时写 `voiceDefaultInit = { at, modelId, sourceVersionAtStart }`（**安装开始时捕获 sourceVersion**）。

**完成时（关键）**：安装 `activate` 成功后，用**安装开始时捕获的 `sourceVersionAtStart` 做 CAS**：

- 若期间 `voiceSource` 版本未变、且来源仍为 unset → **自动写** `source = { location:"local", provider:<catalog provider>, model: defaultModelId }`（`自动 selected & ready`），`kind` 变 `default`；
- 若期间用户改选了云端 / 别的本地 / 显式清空（版本变了）→ **CAS 失败，不写**（`asr_source_conflict` 静默不覆盖），仅在 `defaultVoice.notes` 记「已装但未切来源」。

**失败 / 取消**：

- 失败 → `prep.state:"failed"`，**可见**（`error` + `errorCode` + `retryable`），重试**只能**通过统一下载组件 / 现有 status 视图的显式「重试」按钮；**不自动重试**、**不独立 registry / poller**。
- 用户取消 → `prep.state:"cancelled"`，写 `voiceDefaultOptOut = { reason:"cancelled" }`，**不 restart**。
- 用户清空来源（`PUT source:null`）→ 写 `voiceDefaultOptOut = { reason:"user_cleared" }`，**不 restart**。

### 1.3 required adapter capability（前端据此决定是否走流式）

统一注册表 `RegistryModel.asrAdapter` 增字段（不新增一套鉴权）：

```ts
interface AsrAdapterCapability {
  protocol: "asr-stream-v1" | null;   // 流式协议；非流式模型为 null
  streaming: boolean;                 // 是否原生流式（只有 online-zipformer 族为 true）
  sampleRate: 16000;
  channels: 1;
  format: "s16le";
  partialIntervalHintMs: [200, 400];  // append 建议间隔
  maxChunkBytes: number;              // 单帧硬上限
  maxSessionMs: number;               // 单会话硬上限（默认 60000）
  idleTimeoutMs: number;              // append 间隔超时（默认 10000）
  punctuation: false;                 // 默认流式模型无标点（如实标注）
  languages: ["zh", "en"];
  requiresApiKey: false;
}
```

前端**只在 `streaming === true && protocol === "asr-stream-v1"` 时**启用流式 UI；否则回落现有 batch（SenseVoice / Paraformer / Whisper）路径 —— 现有模型**不删、不改**。

**这个能力必须从 `GET /api/audio/asr/source` 的 `options[]` 就能读到**（不能只在 RegistryModel 里），否则前端会错误 fallback：

```ts
// AsrSourceOption 新增两个字段（与 adapter capability 一致）：
{
  location: "local",
  provider: "local-online-zipformer",
  model: "streaming-zipformer-bilingual-zh-en-int8",
  protocol: "asr-stream-v1",   // 流式模型就是流式协议；其余本地模型仍是 "local-asr-http"
  streaming: true,             // 原生流式
  streamProtocol: "asr-stream-v1",
  availability: "ready" | "not_installed" | "not_running",
  ...
}
```

云端选项固定 `streaming: false`、`streamProtocol: null`。前端判断：`option.streaming === true && option.protocol === option.streamProtocol`。

---

## 2. 流式会话：start / append / end / cancel

### 2.1 `POST /api/audio/asr/stream`（创建会话）

鉴权：沿用现 host server 会话；只绑 `127.0.0.1`。

请求体（JSON）：

```ts
{
  modelId?: string;      // 省略 = 用当前来源 / 默认本地流式；必须解析为 online-zipformer 族
  sampleRate: 16000;     // 唯一允许
  channels: 1;           // 唯一允许
  format: "s16le";       // 唯一允许
  clientId?: string;     // 可选，仅日志（不含凭据）
}
```

响应 `200`：

```ts
{
  sessionId: string;             // 服务端生成（不透明）
  modelId: string;
  provider: string;              // 本地流式 provider
  sourceVersion: number;         // 创建时捕获的 voiceSource 版本（lease 绑定；变更见 §3）
  leaseId: string;               // 会话租约（录制中不卸载 worker）
  protocol: "asr-stream-v1";
  sampleRate: 16000; channels: 1; format: "s16le";
  maxChunkBytes: number;         // 单 append 硬上限（默认 32000 B = 1 s）
  partialIntervalHintMs: [200, 400];
  maxSessionMs: number;          // 默认 60000
  idleTimeoutMs: number;         // 默认 10000
  nextSeq: 0;                    // 下一个期望 seq（会话内单调，从 0 开始）
  state: "ready";
}
```

错误：`409 asr_not_ready`（模型未准备 / 未安装 → body 带 `defaultVoice.prep` 结构化状态，**不是**让前端先攒无限音频）、`409 asr_stream_busy`（**单流 busy**：同模型已有活跃会话）、`400 asr_bad_format`、`503 asr_engine_error`。

### 2.2 `POST /api/audio/asr/stream/:sessionId/append`（追加一帧）

- body = **裸二进制** 16 kHz mono s16le PCM（`Content-Type: application/octet-stream`）。
- 头 `X-Asr-Seq: <n>`（必填，= 服务端 `nextSeq`）。
- 建议每 **200–400 ms** 一次（6 400–12 800 B）；**单会话 append 串行**（上一帧未返回前不要并发发下一帧）。
- `maxChunkBytes`（默认 32000 B）是硬上限。

响应 `200`：

```ts
{
  seq: number;                   // 本次帧的 seq（回显）
  accepted: number;              // 接受的字节数
  nextSeq: number;               // = seq + 1
  state: "listening" | "endpoint" | "ended" | "error";
  events: AsrStreamEvent[];      // 本批产生的事件（可能为空数组）
  buffered: number;              // 服务端未消费字节（backpressure 指标，有界）
}
```

错误：`409 asr_stream_seq_gap`（seq > nextSeq，乱序 reject）、`409 asr_stream_seq_replay`（seq < nextSeq，重复帧 reject 且**不重复喂音频**）、`429 asr_stream_backpressure`（服务端积压达上限，body 带 `retryAfterMs`；**绝不无限排队**）、`409 asr_stream_expired`（超 `maxSessionMs`，须重开会话）、`413 asr_frame_too_large`、`404 asr_stream_unknown`。

### 2.3 事件类型（服务端给出 committed / tentative / final）

```ts
type AsrStreamEvent =
  | { type:"committed";  text:string; segmentId:string; seq:number }
  | { type:"tentative";  text:string; segmentId:string; seq:number }
  | { type:"final";      text:string; segmentId:string; seq:number }
  | { type:"endpoint";   segmentId:string; seq:number }
  | { type:"error";      code:string; message:string; retryable:boolean; seq:number };
```

**语义（server-authoritative per-segment，前端不得两边各算 LCP）**：

- `segmentId`：段号，`endpoint` 后 +1；新段的 partial 属于新 `segmentId`。
- **`committed` = 该段当前稳定前缀的「完整文本」（绝对量，不是 delta）**，只增不回退。
- **`tentative` = 该段剩余部分的「完整文本」（绝对量，整体替换）**，不是 suffix 拼接；同一 `segmentId` 内每次整段覆盖。
- 因此该段展示文本恒为 **`committed + tentative`**（前端只做一次拼接，**不做最长公共前缀**）。
- `final`：`endpoint` 或 `end` 时冻结该段**完整文本**（绝对量）；之后该 `segmentId` 不再有事件。
- `endpoint`：段边界通知（服务端已 `reset`，可继续听下一句）。
- `error`：致命错误；会话终止，`retryable` 决定前端是否提示重试。
- **前端职责**：只按 `segmentId` 维护「committed 文本 + tentative 文本 + 是否 final」，按事件顺序应用；用户已编辑区仍按现有 `VoiceDraftAssembler` 规则冻结、不被覆盖。原先多余的客户端 `StablePrefixTracker` **不作为 wire 算法**。

### 2.4 `POST /api/audio/asr/stream/:sessionId/end`（正常结束）

- body（可选）：`{ reason?: "stop" | "finish" }`。
- 服务端：喂尾部有效 silence / `finish input` → 产出该段 `final` → `close` 会话 → **释放 lease**（worker 可被 idle 回收）。
- 响应 `200`：`{ sessionId, state:"ended", modelId, sourceVersion, finals: AsrStreamEvent[] }`。
- **幂等**：重复 end → `200`，`state:"ended"`，不再产出事件。

### 2.5 `POST /api/audio/asr/stream/:sessionId/cancel`（取消）

- 立即中止、`close` 会话、**释放 lease**、不产 `final`（保留已 `final` 的段）。
- 响应 `200`：`{ sessionId, state:"cancelled" }`。**幂等**。
- **cancel 不重启任何 job**；不写 optout（那是「来源清空 / 取消自动准备」的语义，见 §1.2）。

### 2.6 `GET /api/audio/asr/stream/:sessionId`（可选：状态 / 排障）

返回 `{ sessionId, modelId, sourceVersion, state, nextSeq, buffered, ageMs, leaseId }`。**不含 token**。

---

## 3. 鉴权范围、租约与来源变更

- **鉴权链**：浏览器 → host server（现会话鉴权）→ loopback sidecar（**每次启动新随机 Bearer**）。**不**给 sidecar 开口暴露 plaintext、**不**接受任意 URL（无 SSRF）。
- **会话绑定授权主体**：`create` 时记录调用者主体（本地 = `local`，远程 = 已配对设备 id，来自现全局鉴权中间件的 `caller`）+ `agentId` / `conversationId` + `sourceVersion`。
  - **别的会话 / 设备拿 `sessionId` 不能 `append` / `end` / `cancel`** → `403 asr_stream_forbidden`（**不只靠随机 id 防猜**）。
  - `agentId` / `conversationId` 在后续请求头（`x-asr-agent` / `x-asr-conversation`）与创建时不一致 → `409 asr_stream_scope_mismatch`。
- **租约**：会话持有 `leaseId`，捕获 `modelId + version + sessionId`。活跃会话期间 **worker 不卸载**（沿用现有「录制中不卸载」）；`end` / `cancel` / `idleTimeout` / `maxSessionMs` 到点即释放。
- **来源变更（跨 agent / conversation）**：会话绑定的 `sourceVersion` 与当前不一致时，下一次 `append` 返回 `409 asr_source_changed` 并**取消该会话**；**明确可取消、绝不 fallback 到别的模型**（不把进行中的音频送给别的模型）。前端提示「识别来源已变，请重新开始录音」。
- **不静默计费**：`source === null` 时**绝不**悄悄回落云端。

---

## 4. 错误码总表（统一，前端按 code 分支）

| code | HTTP | 含义 | 前端动作 |
|---|---|---|---|
| `asr_not_ready` | 409 | 默认模型未准备 / 未安装 | 显示 `defaultVoice.prep` 结构化状态（含进度 / 失败 / 重试） |
| `asr_stream_busy` | 409 | 同模型已有活跃会话（单流 busy） | 提示稍后 / 复用现有会话 |
| `asr_stream_seq_gap` | 409 | seq 乱序（> nextSeq） | 丢弃该帧，按 `nextSeq` 重发 |
| `asr_stream_seq_replay` | 409 | seq 重复（< nextSeq） | 忽略（不重发音频） |
| `asr_stream_backpressure` | 429 | 服务端积压达上限 | 按 `retryAfterMs` 退避重发 |
| `asr_stream_expired` | 409 | 超 `maxSessionMs` | 重开会话 |
| `asr_stream_unknown` | 404 | sessionId 未知 / 已回收 | 重开会话 |
| `asr_source_changed` | 409 | 会话期间来源被改选 | 取消并提示重开录音 |
| `asr_stream_forbidden` | 403 | 会话属于其它客户端 / 设备 | 不重试，重新创建会话 |
| `asr_stream_scope_mismatch` | 409 | agent / conversation 归属不一致 | 用创建时的归属重试 |
| `asr_bad_format` | 400 | 采样率 / 声道 / 格式非法 | 修参数 |
| `asr_frame_too_large` | 413 | 帧超 `maxChunkBytes` | 拆帧 |
| `asr_source_conflict` | 409 | 来源 CAS 冲突（自动切来源失败，**不覆盖**） | 提示「已装但未切来源」 |
| `asr_engine_error` | 503/500 | 引擎 / sidecar 异常 | `retryable:true` 时提示重试 |

**界限（bounded）**：`append` 串行、`buffered` 有界、`maxChunkBytes` 有界、`maxSessionMs`（60 s）有界、`idleTimeoutMs`（10 s）有界、单流 busy、全局自动准备 job **唯一且一次**；**无无限队列、无无限会话、无自动重试风暴**。

---

## 5. 资源与安全不变量（实现写死，测试覆盖）

1. 只绑 `127.0.0.1`；sidecar token 每次启动新生成，只在进程内 + 子进程环境；日志 / 状态脱敏。
2. 原始音频只在内存：**不落盘、不写日志、不进记忆**。
3. **不改 Pi SDK / node_modules**；不 fork 引擎；不装系统 Python / pip。
4. **不碰真实用户 db / cache / 麦克风 / 云端 / 凭据密钥文件**；测试用假音频 + 内存鉴权 + 临时环境。
5. 下载复用统一 `downloadFile`（Range 续传 / `.part` / SHA256 / 原子改名）+ `manager.install` 阶段（`preflight>uv>venv>engine>weights>verify>activate`）；**不另造 registry / poller**。
6. 平台：`SHERPA_PLATFORMS` 6 项；无 Pi SDK 修改。

---

## 6. 前端对接要点（一页速查）

1. 现有 `GET /api/audio/asr/source` 多读一个 `defaultVoice` 块；**不要**另开轮询，订阅现有下载 / 状态事件。
2. 语音页默认项：`defaultModelId` 置顶 + 「默认」徽标；显示**实际**状态（未准备 / 准备中 x% / 可用 / 失败 + 重试）。
3. 首次联网必须**明示**：`firstRunNeedsNetwork === true` → 写「**首次使用需联网自动准备约 `approxBytes`，之后可离线使用**」；**绝不写「首次断网可用」**。
4. 流式能力从 `options[].streaming` / `options[].protocol` 读（见 §1.3），不要只看 RegistryModel；`streaming === true` 才走 `start/append/end/cancel`；否则走现有 batch。
5. 渲染：**`committed + tentative`**（都是绝对文本，直接拼接）；`tentative` 同 `segmentId` 整体替换；`final` 冻结；**前端不做 LCP**；用户编辑区不覆盖。
6. **麦克风权限只在用户点 mic 时申请**；准备 / 预热不碰麦克风。
7. 已选来源（云 / 本地 / 显式清空）**不覆盖、不删除**；只提供显式「换成默认本地」按钮。

---

## 7. 本轮边界（诚实）

- 真实权重下载 / 真机 smoke / 质量与 RTF：**本轮未跑**（资源槽未释放，`read/edit/git` 先行）。真实 smoke 计划：自有标记 scratch，预估新增 < 600 MB（模型 198 270 793 B + 共享 runtime wheels），threads ≤ 4，官方中英 wav 分 200 ms 喂，验证首 partial 早于 stop、endpoint 触发、final 文本 + 词命中**如实**记录，**不做 native 模型质量承诺**。
- 权重许可：**保持 `selfServe` 单独政策**，**不假 bundle 商用 clear**；元数据 `apache-2.0` 但权重仓无 LICENSE 文件 → **如实标注**（本地按需下载放行，随包分发等主口径）。**不影响 SenseVoice 原选项**。
- 原「未下权重」仅 tokens.txt 核过 SHA（本地实测），**不是**大文件实测 → manifest **不声称 hash 已全实测**。
- 平台 CI / 全链验收由主统一整合后进行（本树不 push / 不 tag）。

---

## 8. 实现与真实验收（2026-10-24，覆盖上文「本轮未跑」的口径）

- **实现状态**：后端 `faa2c2f`（自动准备 + 原生流式会话 + 流式 sidecar）与前端 `c4c9317`（真实 wire + server-authoritative 句段模型 + 准备状态 UI）已 `--no-ff` 合入候选树；随后补齐 §1.2 / §2 中此前只写在契约里的部分：
  - 取消 / 清空 / 改选别的模型 → 写 `voiceDefaultOptOut`（`cancelled` / `user_cleared` / `user_chose_other`），**不自动 restart**；显式重试才清。
  - `install_and_use` 自动采用默认：安装开始与结束**都必须是 unset**（`voiceSource` key 不存在）+ 版本未变（CAS），显式 null 绝不覆盖。
  - 新增窄接口 `POST /api/local-models/asr/default-voice/cancel|retry`：只动目录里唯一的默认模型、复用同一 `asr:<modelId>` job、走正常 safe API（手机已配对可用）；**不放开**通用 `localOnly` 的 `/api/downloads/:id/*`。
  - `POST /api/audio/asr/stream` 严格 body（未知字段 400 `asr_bad_format`）；`agentId` / `conversationId` 在创建时绑定，append / end / cancel 用同名头校验，不一致 409 `asr_stream_scope_mismatch`；别的主体拿 sessionId 403。
  - `asr_not_ready` 的 409 body 带 `defaultVoice.prep`；创建时若当前来源是**别的**模型（云 / 本地批量），明确拒绝而不是偷用默认流式模型。
  - 来源被改选 → **立即**释放租约 + 取消会话（`asr_source_changed`），不回退云；sidecar 卡住时有界超时（10 s）按 `asr_engine_error`，避免挂死会话留租约。
  - sidecar `committed` 必须是真的段稳定前缀；文本不再以 committed 开头时 `tentative` 给空，**不给假尾句**。
- **真实模型验收（本机 Apple 芯片 macOS；scratch `pia-asr-smoke-amv7oy7ejb00`，threads 4，预算 600 MB）**：198,270,793 B / 4 文件 SHA256 与 pin 一致 → activate → 真 sidecar 健康（`modelId` / `loaded` 均对）→ 官方 `test_wavs/0.wav`（**中英混说**）与 `1.wav`（**中文夹 ALWAYS**）按 200 ms 分帧、**未做实时 pacing**（decode 完就喂下一帧）：调用 `end()` **之前**就收到非空 tentative（= 协议分帧增量返回）、endpoint 3 次、单次 append 往返 25–30 ms、RTF≈0.06（**仅 decode 吞吐，不是交互端到端延迟**）、`seq` 重放拒绝、cancel 释放租约且 worker 不杀、stop 后 pid 回收、**离线请求拦截条件下**复跑成功（只拦本进程 `fetch`，外部请求 0）。证据 `evidence/local-asr-real-smoke/`。
- **对照口径已修正（旧写法作废）**：「CER 0 / 0」和「首字 3–6 ms」都不成立：`1.wav` 只是与**上游文档该模型的示例输出**逐字一致（固定 URL 见脚本 `STREAM_EXPECT_SOURCE`；上游示例是**模型自动识别示例、非人工真值**），`0.wav` 的旧对照串**无可公开核对来源**（该模型官方文档页面没有 0.wav 示例输出；同页「昨天是 MONDAY TODAY IS THEY…」属于另一个模型且是 `THEY`），故不给一致度结论；「首字 3–6 ms」取的是**空 tentative** 且喂音频是 unpaced，**不是实时（嘴到字）延迟**，实时节奏下的首非空文本时延**未测**。旧 json / log 不重写，限制见 `evidence/local-asr-real-smoke/REPORT-CAVEATS.md`（本轮同步修了 smoke 的证据结构：非空首字 + `pacing` 标识、append 期间的 final 也入 `finalBySegment`、真 p50 / p95、`referenceKind` / `agreementScore` 入 report、离线边界字段，**修了但未重跑**）。
- **真实 smoke 修掉的 3 个生产 bug**：① `baseUrl` 已含 `/v1/` 却再拼 `/v1/stream/*` → 404；② sherpa-onnx 1.13.8 `OnlineRecognizer.get_result()` 返回 `str`（脚本按 `.text` 取）→ AttributeError；③ `start` 未消费请求体 → keep-alive 残留字节被解析成下一个请求方法（append 501）。
- **仍然如实不声称**：默认流式模型**输出无标点**；首次需联网自动准备（198 MB + 共享运行时），不随包内置；只在 Apple 芯片 macOS 本机验过；**未跑独立英文 / 中文语料、真麦克风、弱网 / 实时节奏、物理断网**，也不做质量 / 准确率结论。
