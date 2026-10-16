# 语音输入（输入栏语音→文字草稿）设计

- 状态：设计 + 契约（本树 `voice-input-implementation`，基 `unified-integration` `ad3526f`，**未 push / 未 tag**）。2026-10-16 用户 UI 修正：麦克风从附件工具列移到**发送键左侧紧邻**，提示 / 「去设置」走独立 status 行。**2026-10-16 二次用户修正（入口克制）**：idle（含未配置 ASR）**不再常驻** status 行 / 「去设置」，只有用户点麦克风且 hook 回 `asr_not_configured` 时才短暂出现；**beta.24 已发布的是旧常驻行为，本修正未发布（候选树 `0069d36`）。**
- 依据：`research/voice-input-feasibility.md`、`research/sensevoice-local-asr-feasibility.md`、`research/voice-input-project-comparison.md`。
- 范围：**只做「输入栏语音→文字草稿」**。用户已明确取消双向语音通话，**绝不实现**。本地 SenseVoice provider（安装/生命周期）由另一子代理负责，本设计只给出它要实现的接口契约。

## 1. 用户已确认的交互（验收基线）

| 项 | 决定 |
|---|---|
| 入口 | 发送键**左侧紧邻**一个可发现的麦克风按钮（`pa-icon-btn ghost` + `Mic` 图标，带 `aria-label`/`title`）。麦克风 / 停止 / 取消包在 `.pa-voice-ctl`（`flex:none`）里，与发送键同属 `.pa-composer-bar`，同一行不换行。**idle 不常驻任何状态行 / 入口**（未配置 ASR 的说明只在按钮 `title` 里）；只有在用户**点了麦克风**且 hook 回 `asr_not_configured` 时，才短暂浮现短说明 + 「去设置」——放在独立 status 行 `.pa-voice-status`（`order:1;flex:0 0 100%`），不挤附件 / 权限 / 模型选择器、不拖动发送键；取消 / 切会话 / 点「去设置」后清掉临时提示。 |
| 操作 | **点击开始录音，再点停止**（toggle，默认）；**长按作为可选增强，首期不做**。 |
| 结果 | 转写文本**插入开始录制时的光标锚点**；**保留**用户在转写期间对草稿的后续编辑；**不自动发送**。 |
| 草稿 | 只改输入框文本，**不清 draft、不清 replyTo（引用）**。 |
| 取消 | 只丢弃语音，**不动 draft / replyTo**；取消 = 不发起转写请求。 |
| 权限 | 麦克风权限走**系统弹窗**，由用户自己点；应用不代点、不重复弹。 |
| 时长 | 最长 **60 秒**（可解释：一次说一段，超时自动停止并转写）。 |
| 不做 | 不静默上传、不静默降级到云端、不在用户不知情时切换付费 provider、不做全局热键（避免修饰键卡住）。 |

## 2. 状态机

```
idle ──start──▶ preparing ──(getUserMedia ok)──▶ recording ──stop──▶ transcribing ──ok──▶ finish ──▶ idle
  ▲                 │                                │                     │
  │                 └──(权限拒绝 / 非安全上下文)──▶ error ◀──(上传失败 / 超时 / 未配置 ASR)──┘
  └────────── cancel / 切对话 / 页面隐藏（丢弃，不发送） ◀──────────────────────────────┘
```

- `preparing`：已按下、正在拿麦克风 / 打开 AudioContext。
- `recording`：可先开始采集缓冲，**本地模型启动/预热在后台并行**（另一代理的本地 runtime 负责），但**麦克风权限必须由用户自己点**。
- `transcribing`：已停止采集、正在上传+转写。
- `error`：权限拒绝 / 非安全上下文（`navigator.mediaDevices` 不存在）/ 未配置 ASR / 网络超时。文案可解释、给恢复指引，**不 silent**。
- `finish`：文本已插入锚点，短暂提示后回 `idle`。
- **不自动重试**：失败保留本地草稿与音频（内存 blob），只给用户手动「重试」，避免重复付费。
- **切 agent / conversation / detach / 页面 hidden / 后台**：立即 `stop tracks` + 取消（**不发送**）。
- **短按 toggle 默认；长按 optional 不需要首期**。
- **IME / 发送快捷键不被打断**：转写结果插入前若 `isComposing`，**推迟到 compositionend** 再插入，绝不打断候选；发送 / 换行键按用户偏好（默认 `Enter` 发送、`Shift+Enter` 换行，见 [chat-send-shortcut.md](chat-send-shortcut.md)），输入法确认回车不会发送。

## 3. 音频链路（前端）

- **优先 16 kHz 单声道 PCM16 WAV**：`AudioContext({ sampleRate: 16000 })` + `AudioWorkletNode`（不可用时退回 `ScriptProcessorNode`）取原始 PCM，前端组 WAV。
- **不假 16000**：`AudioContext` 的 `sampleRate` 是**请求值**，浏览器可能不满足 → **必须校验 `ctx.sampleRate`**，不等于 16000 时用**真实线性重采样**（`resampleTo16k`）后再组 WAV。WAV 头里写实际采样率。
- **不引 FFmpeg 全依赖**：前端只产 PCM16 WAV；`MediaRecorder`（webm/mp4 容器）只作为「浏览器不支持 AudioWorklet」的兜底，且上传前用 `isTypeSupported` 探测、服务端按 `protocol` 校验支持格式，**不支持就明确报错，不崩**。
- **不偷录**：只有用户按下按钮才 `getUserMedia`；停止/取消/切页立即 `track.stop()`，麦克风指示灯熄灭。
- **iOS**：`MediaRecorder` 支持用 `isTypeSupported` + 服务端格式校验；优先 WAV 链路。
- **隐私**：录音不落消息附件、不落日志、不落记忆；只在内存里存在，取消即丢。

## 4. 服务端统一 ASR 契约

### 4.1 模型类型（统一注册表）

- `ModelType` 增加 `"asr"`；`ModelCapability` 增加 `"asr"`。
- 云 ASR：复用 provider registry 的**同一份 baseUrl + key**，`protocol: "openai-audio-transcriptions"`，`source: "custom"`，**只有用户显式声明才 `confirmed: true`**。
- 本地 ASR（另一代理）：`source: "local"`、`kind: "local"`、`protocol: "local-asr-http"`（本机 loopback sidecar），`baseUrl: "http://127.0.0.1:<port>/v1/"`，**不需要用户 key**；运行中端点（含进程内 token）只在 `local-asr/adapter-registry.ts`，**绝不进注册表**。
- **`asrAdapter` 只有一种形状**（云 / 本地共用，避免两套 RegistryAsr 类型）：
  ```ts
  interface RegistryAsrAdapter {
    protocol: string;               // openai-audio-transcriptions | local-asr-http
    location: "cloud" | "local";
    requiresApiKey: boolean;        // 本地 false
    sampleRate?: number; maxSeconds?: number; languages?: string[]; punctuation?: boolean;
    baseUrl?: string;               // 展示用，绝不含 token
  }
  ```
- 本地卡片经 `local-asr.changed` 事件 → `local-models.ts` 缓存（`type:"asr"` + `asr` 元数据）；**停止后保留卡片**只标暂不可用。
- **许可证**：SenseVoice 权重许可 `unresolved`（issue #334 仍 open）→ 本地安装入口**默认关闭**，**不 bundle / 不镜像**权重；只开放**用户自行合法导入**。**不允许**把 `unresolved` 强开成 allow；云端 ASR 作为可切换选项，**不强制云优先**。
- **不靠模型名猜能力**：`chat` 能通 ≠ 能转写；`/v1/models` 不含能力元数据。未知能力默认 `confirmed: false`，界面不给入口。
- **chat 多模态不自动算 ASR**：`vision` 不等于 `asr`。
- **免费/本地 fallback 不能偷偷变收费**：切换 provider 必须用户可见；默认只在用户已配置的 ASR 里选。

### 4.2 路由 `POST /api/audio/transcriptions`

- 鉴权：走**正常 safe API 路径**（`/api/*` 中间件：本机或已配对设备）；owner 上下文（`agentId`/`conversationId`）只用于归属与审计，**不把普通麦克风录音做成每秒审批**。
- 请求：`multipart/form-data`
  - `file`：音频（**PCM16 WAV**，或 provider 明确支持的格式）
  - `provider`、`model`：必填，必须解析到 registry 里 `capabilities` 含 `asr` 且 `confirmed` 的模型
  - `requestId`：必填，幂等键
  - `language`（可选）、`agentId`/`conversationId`（可选，归属）
- 校验（fail-closed）：
  - content-type 仅允许音频/八位流；**实际字节必须是合法 RIFF/WAVE 头**
  - 采样率必须 16000、声道 1、位深 16（WAV 链路）；否则 400
  - 时长 ≤ 60 s、字节 ≤ 5 MB；**流式上传带上限**，超限即中断
  - **只接受上传的音频字节**：**不**从远程 URL fetch、**不**读任意本地路径、**不**跑 ffmpeg 处理用户可控路径、**不**接受 SSRF 型 scheme
- 上游：`POST {baseUrl}/v1/audio/transcriptions`，multipart（`file` + `model` + `language` + `response_format=json`），带该 provider 解析出的凭据（由 Pi/registry 提供，**本模块不读 `secret.ts`、不实现 key 解析**）；`AbortController` + 超时（默认 60 s）。
- 取消：客户端断开 / 用户取消 → abort 上游。**明确：abort 不保证 provider 不计费**（文档写清），不计为成功。
- 幂等：`requestId` → 仅当**已 completed** 时直接返回缓存结果，**不重复调上游**；`unknown` 状态**不**当成功返回。
- 错误：**redact**（不回显 key / 上游 URL / 原始 body）；错误码稳定（`asr_not_configured` / `asr_invalid_audio` / `asr_too_large` / `asr_timeout` / `asr_upstream_error` / `asr_aborted`）。
- 用量：只记**真实 API 返回值**；未知**不填 0**。
- 隐私：音频**只在内存 buffer 中处理**，不落盘、不进消息、不进日志/记忆；若临时文件必要，canonical 路径 + TTL + 启动清理。
- **ASR 预览不进主模型**：转写结果只是文本草稿，不自动触发模型回复、不绕过任何工具权限。

### 4.3 云端 provider 的显式同意

- **第一次用云 ASR 前**必须有一次明确说明：**音频会上传到该 provider、可能产生费用**；用户同意后才发请求。
- 本地 provider：明确「音频只留在你的电脑」，只在必要时经**自有 Pi Server** 传到本机（手机经 HTTPS 隧道）。

### 4.4 录音租约（避免录中 kill）

本地 ASR 的 idle TTL 默认 **90 s**，从「最后一次推理结束 / **录音租约释放**」起算；**正在推理或有录音租约时绝不卸载**。
因此前端在开始录音时 `POST /api/audio/asr/lease { provider, model }` 拿租约（同时**非阻塞**触发本地 sidecar 启动，边录边加载），
停止 / 取消 / 出错 / 回到 idle 时 `DELETE /api/audio/asr/lease/:id` 释放。云端 ASR 不涉及租约。
本地未安装时租约接口明确 `409`（不静默）；转写时端点未运行也明确 `409`。

## 5. 前端模块边界（便于主合并）

- `apps/web/src/voice-input.ts`：**纯逻辑**（状态机、WAV 组包、真实重采样、锚点插入、能力/错误映射），依赖注入，可单测。
- `apps/web/src/hooks/useVoiceInput.ts`：React hook，真实浏览器管线（getUserMedia / AudioContext / AudioWorklet），薄封装。
- `apps/web/src/components/VoiceInput.tsx`：独立组件（按钮 + 状态 + 可访问性），**不改整个 composer**。
- `apps/web/src/api.ts`：`transcribeAudio(...)`（multipart 上传 + abort）。
- 主会话/群聊 composer：只加**极小 hunk**（import + 发送键前一行 `<VoiceInput ... />`），与「消息引用」子任务改动**不重叠**。子代理 composer 不加麦克风（语音只做主 / 群）；共享 `.pa-composer-bar` / `.pa-voice-*` 样式已适配（2026-10-16 用户 UI 修正：麦克风从附件列移到发送键左侧，提示走独立 status 行）。

## 6. 安全红线（写死）

1. 语音识别结果**永远是文本草稿**，用户确认才发送；不自动执行工具、不绕权限。
2. 不后台录音、不上送音频，除非用户明确按下按钮。
3. 原始音频不落日志 / 记忆 / 消息附件 / 临时文件（除非 TTL 清理）。
4. 长期 API key 绝不下发前端；前端只与自有 Pi Server 通信。
5. 不因「能 chat」推断「能 ASR」；未确认能力不给入口。
6. 不自动重试付费请求；不把 abort 当免费。
7. 不做双向语音通话。

## 7. 测试计划

- 服务端（假数据，强制 tmp data/workspace，内存凭据，不联网、不开麦）：
  - `voice-asr.test.ts`：非法 payload / 非 WAV 头 / 采样率错 / 超限 / 超时 / 幂等（completed 命中、unknown 不命中）/ 未配置 ASR / 错误 redact / 不读 key。
  - `voice-contract.test.ts`：`ModelType` 含 `asr`、`modelsWithCapability("asr")`、本地 asr provider 合并、未确认不 confirmed。
- 前端纯逻辑（server 测试目录 import `apps/web/src/voice-input.ts`，与 `web-selection.test.ts` 同风格）：
  - 取消 0 次请求、开始 1 次 getUserMedia、权限拒绝→error、页面隐藏→stop+cancel、
  - 16 kHz WAV 头**真实**、非 16k 输入**真重采样**、锚点插入保留用户编辑、stale conversation 不插入、
  - IME 组合中不插入、与 replyTo/draft 共存、390 键盘布局（组件契约）。
- 真机未验证项（不 claim）：iOS Safari 键盘/录音、真实麦克风音质、真实云 ASR 效果、本地模型实际速度。

## 8. 待办 / 不在本轮

- 云 ASR provider 的 UI 配置页（主会话按统一 registry 合）。
- 本地 SenseVoice 的安装/生命周期（另一子代理，按 §4.1 契约实现）。
- 语音通话（用户已取消，不做）。
