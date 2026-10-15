# 语音输入实现进度报告（voice-input-implementation）

- 树：`/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/voice-input-implementation`
- 分支 `voice-input-implementation`，基 `unified-integration` `ad3526f`，**未 push / 未 tag / 未打包**
- 已本地合入：`message-replies-ui` `dc83728`、`local-asr-sensevoice` `88a6909`
- 工作区：**clean**（无未提交改动，无冲突标记）

## 1. 实际 commit（最新在前）

| commit | 内容 |
|---|---|
| `a00ad00` | 录音租约（本地 ASR 录中不卸载）+ `local-asr-http` 转写路径 + 契约文档同步，单测 94/94 |
| `7a86422` | 合并本地 SenseVoice ASR（`88a6909`）：统一 `asrAdapter` 形状 / 单一 RegistryAsr 契约，语音路由支持 `local-asr-http` |
| `f90213e` | 合并引用 UI（`dc83728`）并接线：语音按钮保留 quote/draft，`replyTo` 透传 |
| `6521433` | 语音输入 UI：`VoiceInput` 组件 + `useVoiceInput` 管线 + api 转写客户端，主/群 composer 极小接入 |
| `bef5e4b` | 语音输入核心：ASR 统一类型 / 薄 adapter / 路由 + 前端纯逻辑（状态机/WAV/重采样/草稿锚点），假依赖单测 32 项 |
| `5802e9f` | 语音输入：设计文档与需求登记 |

## 2. 实际改了什么

- 服务端新增 `packages/server/src/voice/{contract,asr,routes,index}.ts`：
  - `POST /api/audio/transcriptions`（multipart；WAV 头 / 16k / 单声道 / 16bit / ≤60s / ≤5MB 校验；abort + 60s 超时；`requestId` 幂等**只复用已完成**、失败不缓存可手动重试；错误脱敏；音频只在内存）。
  - `POST/GET/DELETE /api/audio/asr/lease`（本地录音租约）。
  - 上游两协议：云 `openai-audio-transcriptions`（multipart）+ 本地 `local-asr-http`（loopback raw WAV + Bearer 进程内 token，端点来自 `local-asr/adapter-registry`）。**不读 `secret.ts`**。
- 统一注册表：`ModelType`/`ModelCapability` 加 `"asr"`；`RegistryAsrAdapter` 单一形状；`RegistryLocalProvider.type`；`local-models.ts` 加 `label/type/baseUrl/asr` + `local-asr.changed`。
- 前端：`voice-input.ts`（纯逻辑）、`hooks/useVoiceInput.ts`、`components/VoiceInput.tsx`、`api.ts`（`transcribeAudio`/`listAsrModels`/lease）；主/群 composer 极小接入。

## 3. 实际跑了的测试

- server `tsc --noEmit` exit 0；web `tsc --noEmit` exit 0。
- `voice-input`(16) + `voice-asr`(18) + `model-registry` + `local-models` + `local-asr-{wav,license,transcribe,manager}` + `local-laya-routes` = **94/94**。
- `e2e/replies-frontend.test.mjs` **11/11**（合并引用 UI 后回归）。

## 4. local-asr-api.md 五个未定点：结论

1. **上传方式**：`multipart/form-data` → `POST /api/audio/transcriptions`，字段 `file`(PCM16 WAV) / `provider` / `model` / `requestId` / 可选 `language`、`agentId`、`conversationId`。**不复用 WS**。返回 `{ text, provider, model, durationMs, usage? }`（usage 只含真实值）。Pi Server → 本地 sidecar 走你已实现的 raw WAV `local-asr-http`。
2. **语言参数**：可选 `language`（如 `zh`/`en`）；缺省不传 → provider 自动（SenseVoice 有 LID）。注册表 `asrAdapter.languages` 暴露候选，有值才透传。
3. **分段与草稿合并时机**：v1 **单段非流式**。录满 ≤60s → 16k mono WAV → 一次上传 → 结果插到**开始录制时的光标锚点**（保留用户后续编辑）；**不按 segments 分段插入、不自动发送**。`segments[]` 由本地返回，Pi Server 只回拼接后的 `text`（字段保留）。
4. **asrAdapter 字段收敛**（已合并）：单一 `RegistryAsrAdapter { protocol, location:"cloud"|"local", requiresApiKey, sampleRate?, maxSeconds?, languages?, punctuation?, baseUrl? }`；本地填 sampleRate/maxSeconds/languages/punctuation/requiresApiKey:false，云填 baseUrl/requiresApiKey:true。
5. **单一 RegistryAsr 类型 + runtime callback 字段**：`buildRegistry` 只有一条本地 asr 分支（你的 local source）+ 一条 `input.asr` 显式云声明分支；`RegistryAsrProvider` 只用于显式声明。事件统一 `local-asr.changed`，建议 payload 顶层带 `{ status, provider, modelId }`（停止后 `status.registered=null` 也能定位）；`local-models.ts` 已优先读顶层、缺省回退 `local-sensevoice`/`sensevoice-small-int8`。`LocalModelHint` = `{ provider, label, modelId, type, protocol, baseUrl?, installed, running, state, device, asr?, lastSeen }`。

## 5. 录音租约（避免录中 kill）

- `POST /api/audio/asr/lease { provider, model }` → `{ leaseId }`（本地：非阻塞 `asrManager().start()` 边录边加载 + `acquireRecording()`；未安装 → 409）。
- `DELETE /api/audio/asr/lease/:id` 释放。前端在录音开始时 acquire，stop/cancel/error/idle/页面隐藏/卸载时 release；云端不涉及。
- 许可：SenseVoice 权重 `unresolved`（issue #334 open）→ 安装入口默认关闭、不 bundle/不镜像；只开放用户自行合法导入；云 ASR 为可切换选项，**不强制云优先**。

## 6. 具体卡点 / 余缺

1. **真机与真链路未验**：真实麦克风、真实云 ASR、本地 sidecar 真跑（下载/启动/转写）、iOS 键盘、真机音质 —— 均**未验证**，不 claim。
2. **UI e2e 未跑**：vite 生产构建在本 worktree（node_modules 为 APFS 克隆）失败，未定位，与本改动无关；因此「mic 可见 / 权限拒绝 / 后台停 / 16k WAV / 390 键盘」纯前端 e2e 尚未跑（逻辑已由 34 项 Node 单测覆盖）。
3. **云 ASR 配置 UI 未做**：设置页 `selectASRsource`（写 `asrProviders` 设置）留给主会话按统一 registry 合。
4. **sherpa-onnx wheel SHA 未 pin**（local-asr 侧遗留，整合补）。
5. **主合依赖**：我的 registry thin adapter + 其 local source 已在 `7a86422` 收敛；`apps/web/src/types.ts` 无重叠（ASR 类型在 `api.ts`）。
