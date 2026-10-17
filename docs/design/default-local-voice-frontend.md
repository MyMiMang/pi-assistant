# 默认本地语音（前端）：原生流式会话层 + 默认准备状态（**已按冻结契约接线**）

> 状态：**已按冻结契约生产接线并合入候选树；DOM 生产贯通 e2e 11/11、后端真实模型验收通过（2026-10-24，未发布）**（worktree `default-local-voice-ui`，分支同名，基 `release-candidate-validation` `b20ec81`；**未 push / 未 tag / 未打包 / 未装用户 App**）。
> 后端契约（冻结，唯一事实来源）：`default-local-voice/progress-snapshots/default-stream-contract.md`（HEAD `faa2c2f`，含 CORS 允许自定义流式头）；后端实现见该树 `packages/server/src/local-asr/{stream,stream-hub,serve-script,default-voice-prep,service}.ts`、`voice/{routes,index,contract,source}.ts`。
> 设计边界（用户要求）：装好就能用语音、**不让人手动找模型 / 点下载 / 配路径**；已有云 / 本地选择**不被默认覆盖或删除**；只做前端，不改 Pi SDK / node_modules / 后端。

## 1. 范围与边界

**已完成（本树）**
- `apps/web/src/api.ts`：**实现真实 wire 的 `openAsrStream`**（`POST /api/audio/asr/stream` → `append` 裸 s16le + `X-Asr-Seq` → `end` / `cancel`；复用 `api()` 的同一鉴权，`response.json()` 后交 `normalizeStreamEvents` 归一化；带 `x-asr-agent` / `x-asr-conversation`，每次请求独立 deadline `AbortController`）。
- `apps/web/src/voice-stream.ts`：线协议事件归一化（committed / tentative / final / endpoint）、**server-authoritative 句段模型**（按 `segmentId` + `seq`，无客户端 LCP）、`StreamPacer`（200–400 ms）、`splitInt16`（按 `maxChunkBytes` 切帧）、`StreamResampler`（48 k → 16 k 跨片连续）、`NativeVoiceController`（会话先就绪、串行 ack、有界积压、stop 只 flush 尾、cancel / hidden abort、失败保已确认文本、60 s 上限、错误码中文映射）。
- `apps/web/src/voice-pref.ts`：**按契约形状精确解析** `defaultVoice` 块（`prep.state` 必须是契约枚举，否则 `ok:false`）+ 合并统一下载进度 + 标签 / 色调 / 取消重试条件 / 首次联网文案。
- `apps/web/src/hooks/useVoiceInput.ts`：两条路径共用来源 / 租约 / 采集；`openStream` 接线后**只有 `streaming + protocol + streamProtocol` 三项一致**才走流式；未配置来源时按准备状态给可解释提示（不逼手动配置）；暴露 `prep` / `cancelPrepare` / `retryPrepare`。
- `apps/web/src/hooks/useDefaultVoicePrep.ts` + `components/DefaultVoicePrep.tsx`：准备状态 + 取消 / 重试（走统一下载组件 `asr:<modelId>` 同一 job）。
- `apps/web/src/components/VoiceInput.tsx`：tentative 就地预览 + **输入附近一行准备状态 / 操作**。
- `apps/web/src/components/VoiceSettings.tsx` / `LocalAsrModels.tsx`：默认本地语音准备状态 + 取消 / 重试；默认模型贴「默认」徽标。

**未做（等测试槽 / 主放行）**
- 未跑真实后端联测（真 sidecar + 真权重 + 分片喂 PCM）、未跑浏览器 e2e（假麦 + 假 provider）、未 build、未 `npm ci`。
- 未改 `VoiceInputController`（整段批量 + 分段增量）一行逻辑，**不回归**。
- 不加「我同意」勾选、不新增默认开关、不自动切来源。

## 2. 线协议与前端实现（对齐契约）

```ts
// 归一化事件（api.ts 解析 wire JSON 后喂给模型；与契约语义一一对应）
type VoiceStreamUpdate =
  | { kind:"committed"; segmentId:string; text:string; seq?:number }  // 该段**完整**稳定前缀（绝对量，只增不回退）
  | { kind:"tentative"; segmentId:string; text:string; seq?:number }  // 该段**剩余部分完整文本**（绝对量整体替换）
  | { kind:"final";     segmentId:string; text:string; seq?:number }  // 该段**完整文本**（绝对量）
  | { kind:"endpoint";  segmentId:string; seq?:number };              // 段边界（不带文本）
```

- 展示文本恒为 `committed + tentative`（前端只做一次拼接）；**不做最长公共前缀**（`longestCommonPrefix` 仅留作纯 helper，不参与 wire）。
- `VoiceStreamModel` 按 `segmentId` 维护 `{committed, tentative, finalized, lastSeq}`：committed 只把**新增前缀**作为 `commits` 交给 `VoiceDraftAssembler`（不重复追加），`tentative` 整体替换，`final` 只提交未进草稿的剩余部分，重复 final / 晚到 partial / 旧 seq 一律忽略；「你好你好」不做 substring 去重。
- 会话层接口（唯一接线缝，已被 `api.ts` 的 `openAsrStream` 实现）：

```ts
interface VoiceStreamTransport {
  append(pcm: Int16Array, seq: number): Promise<void>;  // 串行；resolve = 后端已 ack
  finish(): Promise<void>;                              // end，等 final
  abort(reason?: string): void;                         // 断开 + best-effort cancel（独立短 signal）
  readonly limits?: VoiceStreamLimits;                  // 服务端 maxChunkBytes / maxSessionMs / idleTimeoutMs / 采样率
}
```

- **不用** 浏览器原生流式上传（`duplex:"half"` Safari 不支持）；是普通有界 HTTP 会话，Safari 可用。
- 鉴权：与其它请求同一 `api()`（带 `authorization` / 同源 Cookie），不另存 Bearer、不直连 sidecar；跨源时后端 CORS 已允许 `x-asr-seq` / `x-asr-agent` / `x-asr-conversation`。
- 错误码按契约分支：`asr_stream_seq_replay` → 当作 ack（不重发音频）；`asr_stream_backpressure` → 按 `retryAfterMs` 有界退避（≤3 次）；`asr_source_changed` / `asr_stream_expired` / `asr_stream_unknown` / `asr_stream_forbidden` → 标记会话终结；中文文案见 `streamFailureInfo` / `streamOpenError`。

## 3. 状态与生命周期

- 状态机与既有控制器一致：`idle → preparing → recording → transcribing → finish/idle`（失败 `error`）。
- **会话先就绪（`STREAM_OPEN_TIMEOUT_MS = 8 s`）再开采集**：ready 失败尽早失败、不占麦克风（拿权限期间被取消 / 隐藏 / 切来源 → 立刻 `track.stop()` 并 abort 迟到就绪的会话）。
- **停止只 flush 尾片 + `finish`**：先冲 `StreamResampler` 尾、再冲 `StreamPacer` 尾（按 `maxChunkBytes` 切帧），不整段重识别；`stop` 等 `finish`（含在途 append），可被 `cancel` abort。
- **有界并发**：append 串行（`maxInflight = 1`），慢后端只让缓冲增长（受 60 s 录音上限约束），**不无限排队**；`progress().backlog` 反映积压。
- **重采样**：`AudioContext({sampleRate:16000})` 失败退到原生采样率时，用 `StreamResampler` 真重采样 16 k（跨片按全局位置插值，无 gap / 重复 / 漂移），绝不把 48 k 当 16 k 发。
- **失败保留已确认文本**：已进草稿的 committed 保留，tentative 清空；不自动重发旧音频、不自动发送；原生流式没有「重试本段」，重试 = 用户重新录一段。

## 4. 文本 UX

- committed 增补按语音原序追加到开始录制锚点之后，保留用户别处的编辑，**不自动发送**（复用 `VoiceDraftAssembler`）；单聊 / 群聊 / 引用 / IME 行为不变。
- tentative 只在录音状态行就地预览（`.pa-voice-partial`，斜体 + 虚线），绝不写输入框。
- 真实音量仍来自实际 PCM 的 `LevelMeter`；reduce motion 只关 CSS 过渡，不产生假运动。

## 5. 默认语义与准备状态（前端只读、不抢写）

- **前端绝不 `PUT source` 抢占默认**：自动采用默认由服务端 `once CAS + optout` 管；前端只读 `selected` / `defaultVoice`。
- **精确解析契约**：`normalizeVoicePrepareView` 只认 `prep.state ∈ {not_applicable, not_prepared, preparing, ready, failed, cancelled}`；认不出 → `ok:false` / `state:"unknown"`，UI 什么都不显示，不猜「已就绪」。
- **进度与操作复用统一模块**：同一稳定 id `asr:<modelId>`（= `prep.jobId`），进度订阅既有 `downloads` store（不轮询）；取消 / 重试走 `POST /api/downloads/:id/cancel|start`，**不另造下载链路**。
- **首次联网如实分层**：`firstRunNeedsNetwork === true` → 「首次使用需联网自动准备（约 X MB，估算非实测），之后可离线使用」；`false` 才写「已内置，可离线」；`null`（未知）什么都不写，**绝不写「首次断网可用」**。
- **不逼用户手动配置**：未配置来源且正在 / 待准备时，点麦克风给「正在自动准备（首次需联网）」而不是「先去设置选模型」；准备失败才指向设置重试。
- 不删 / 不隐藏现有 ASR 选项；默认只是 catalog 里多一个「默认」候选 + 显式入口（`LocalAsrModels` 的「使用这个模型」经服务端 `select`）。

## 6. 文件改动（本树）

| 文件 | 改动 |
|---|---|
| `apps/web/src/api.ts` | `openAsrStream`（真实 wire：create/append/end/cancel + deadline + 错误码归一）、`isStreamingSource`（三项判定）、`streamProtocol`、`AsrSourceView.defaultVoice`、统一下载起停 helper |
| `apps/web/src/voice-stream.ts` | 事件归一化、server-authoritative 句段模型、`splitInt16`、`StreamResampler`、控制器（重采样 + 切帧 + limits）、错误码文案 |
| `apps/web/src/voice-pref.ts` | 按契约精确解析 `defaultVoice` + 进度合并 + 展示 / 操作条件 |
| `apps/web/src/hooks/useVoiceInput.ts` | 同一来源 / 租约 / 采集；三项流式判定；准备状态提示；暴露 `prep` / 取消 / 重试 |
| `apps/web/src/hooks/useDefaultVoicePrep.ts`（新） | 准备状态 hook（读 `defaultVoice` + 合并下载进度 + 取消 / 重试） |
| `apps/web/src/components/DefaultVoicePrep.tsx`（新） | 准备状态面板（设置页 / 本地模型详情） |
| `apps/web/src/components/VoiceInput.tsx` | 传 `openStream`；tentative 预览；输入附近准备状态行 + 取消 / 重试 |
| `apps/web/src/components/VoiceSettings.tsx` | 默认本地语音准备状态（顶部面板） |
| `apps/web/src/components/LocalAsrModels.tsx` | 默认模型「默认」徽标 + 就地准备状态 |
| `packages/server/test/voice-stream.test.ts` | 纯逻辑单测（**已跑 34/34**，见 §7） |
| `packages/server/test/voice-pref.test.ts` | 准备状态归一化单测（**已跑**，含在上面 34 项内） |

## 7. 验收状态（如实）

- **已跑（本树，纯逻辑，无网络 / 无真实下载 / 无真麦）**：`node --import tsx --test test/voice-pref.test.ts test/voice-stream.test.ts` → **34/34 pass**。覆盖：契约事件归一（未知名 / 缺 segmentId 丢弃）、committed 绝对前缀只提交新增、tentative 整体替换、final 只提交剩余 + 重复 final 忽略、晚到 partial / 旧 seq 不回滚、冲突 final / committed 报 mismatch 不重复追加、分片 200 ms 与 flush 不丢尾、`splitInt16` 切帧、48 k→16 k 跨片连续输出长度、控制器串行 seq 单调 / 60 s 上限 / 取消 / 隐藏 / 打开与采集失败释放轨道 / 失败保已确认文本（不自动重发）/ 48 k 采集真重采样、准备状态归一化（`ok:false` 兜底 / 六状态 / jobId 回落 / 进度合并 / 取消重试条件 / 首次联网未知不说离线）。
- **静态检查（已跑）**：用 app 自带 Node + 主仓 TypeScript（`tsc -p apps/web/tsconfig.json`，通过临时软链引用主仓 `node_modules`，**未改任何 node_modules**）——**本树改动文件 0 错**；剩余错误全部为环境固有（`@pi-assistant/shared` 解析到主仓旧版、个别 `implicit any`），与本次改动无关。
- **未跑（等测试槽 / 主放行）**：真实后端联测（真 sidecar + 真权重 + 分片喂 PCM，验证首 partial 早于 stop、endpoint、final 文本）、浏览器 e2e（假 provider + 假麦：自动准备 → ready → 点麦克风建会话 → partial 预览 → committed 进草稿不发送 → stop/cancel → 切来源）、`vite build`、全量 `npm test`。
- **不声称**：native 流式的真实识别质量、交互（嘴到字）延迟；已测的只有 unpaced 喂音频的 decode 吞吐（RTF≈0.06）；`< 300 MB`（约 300 MB）为**估算非实测**。

## 8. 未决 / 已知边界

1. **真实联测**：需要后端权重就绪 + 测试槽；本树只接线，不做真实识别质量结论。
2. **`prep.state="cancelled"` 已可达（已修）**：取消 / 清空 / 改选别的模型都会写 `voiceDefaultOptOut`（`cancelled` / `user_cleared` / `user_chose_other`），显式重试才清；取消后不会自动重启准备。前端按契约解析六态，`cancelled` 显示「已取消」并给重试。
3. **`asr_not_ready` 的 409 body 已带 `defaultVoice.prep`（已修）**：前端仍不依赖它（准备状态从 `GET source` 读），但契约 body 已是真实的。
4. **手机端取消 / 重试已可用（已修）**：默认语音走**窄接口** `POST /api/local-models/asr/default-voice/cancel|retry`（固定默认模型、同一 `asr:<modelId>` job、正常 safe API 鉴权），不再依赖 `localOnly` 的通用下载接口；不能借它操作任意组件。
5. 主会话 / 群聊以外（子代理输入栏）不加麦克风，与既有决策一致。
