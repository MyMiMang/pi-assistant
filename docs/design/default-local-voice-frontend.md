# 默认本地语音（前端）：原生流式会话层 + 默认准备状态（前端）

> 状态：**前端纯逻辑 + UI 准备已写，未跑测试 / 未接线真实契约**（worktree `default-local-voice-ui`，分支同名，基 `release-candidate-validation` 已提交 HEAD `b20ec81`；**未 push / 未 tag / 未打包 / 未装用户 App**）。
> 后端选型 / 设计 / 阻塞：`default-local-voice` 树 `docs/design/default-local-voice.md`、`progress-snapshots/default-local-voice-decision.md`（默认 = 原生流式 sherpa-onnx `OnlineRecognizer` + 中英双语 streaming zipformer，int8 合计 198,270,793 B）。
> 本文件只讲**前端**：字段级线协议（HTTP 路径 / 事件字段名 / seq-ack 语义）**等主与 backend owner 的契约**，本树不另造第二套协议。

## 1. 范围与边界

**本树做了（纯逻辑，可单测，不碰浏览器 / 真麦 / 网络）**
- `apps/web/src/voice-stream.ts`：稳定前缀、句段模型（committed / tentative）、有界分片器、原生流式控制器，以及**会话层接口**（`VoiceStreamOpen` / `VoiceStreamTransport`）作为唯一接线缝。
- `apps/web/src/hooks/useVoiceInput.ts`：把流式控制器接进现有来源 / 租约 / 采集钩子；**缺 `openStream` 或服务端未声明流式能力时，一律回落既有分段增量 / 整段批量，行为不变**。
- `apps/web/src/components/VoiceInput.tsx` + `themes/base.css`：录音状态行**就地预览未确认文本**（`.pa-voice-partial`，斜体 + 虚线，不写输入框）。
- `apps/web/src/voice-pref.ts`：`GET voicepref` 新状态（default preparing / ready / fail / cancel）的**宽容归一化 + 展示选择器**（纯函数，未接线数据源）。
- `apps/web/src/api.ts`：`VoiceSourceOption.streaming?`（服务端模型能力，缺省不启用）。

**本树没做（等契约 / 等测试槽）**
- 没有实现任何 HTTP 线协议、没有新增端点、没有改后端；没有把 `openStream` 接到真实服务。
- 没有把「默认准备状态」挂到 `VoiceSettings.tsx`（数据源路径未定）；归一化层已就绪，接线只差一次 `setView(normalizeVoicePrepareView(raw))`。
- 没跑任何测试 / 构建（用户本轮口径：本树只 `read/edit/git/syntax`，重测试槽在 candidate owner，主放行后才跑）。
- 没改 `VoiceInputController`（整段批量 + 分段增量）一行逻辑，**不回归**。

## 2. 会话层接口（唯一的接线缝）

```ts
// 归一化事件（由契约的线协议解析后喂进来；模型与 UI 只认它）
type VoiceStreamUpdate = { kind: "partial" | "final"; index?: number; text: string; committed?: string };

interface VoiceStreamTransport {
  append(pcm: Int16Array, seq: number): Promise<void>; // 串行调用；resolve = 后端已 ack
  finish(): Promise<void>;                              // flush 服务端尾 + 等 final；可被 abort
  abort(reason?: string): void;                         // 断开、丢弃未 ack（不等待）
}
type VoiceStreamOpen = (opts: { provider; model; language?; agentId?; conversationId?; sampleRate;
  onUpdate(u: VoiceStreamUpdate): void; onError(e: unknown): void }) => Promise<VoiceStreamTransport>;
```

- 线协议（路径 / chunk 编码 / ack 形态）**不在本文件**：主给契约后，只需在 `api.ts` 实现一个 `openStream` 并在 `VoiceInput.tsx` 透传给 `useVoiceInput`，不碰模型层。
- 事件既支持「服务端已算好 committed」也支持「只给整句 partial，客户端用最长公共前缀算 committed」（`StablePrefixTracker`）。两种都兼容，不赌字段形态。
- **Safari 可用**：不用 `ReadableStream` request body / `duplex: "half"`；会话是有界 seq 追加 + ack 的普通 HTTP，具体形态由契约决定（后端也是 HTTP chunked，不引 WebSocket）。

## 3. 状态与生命周期（对齐后端设计 §3.3/§3.4）

- 状态机与既有控制器一致：`idle → preparing → recording → transcribing → finish/idle`（失败 `error`）。
- **会话先就绪（`STREAM_OPEN_TIMEOUT_MS = 8s`）再开采集**：ready 失败尽早失败，不占麦克风；就绪前后任一步失败 / 取消 / 切来源 / 切会话 / 页面隐藏 / 卸载都 `track.stop()` + `abort()`（租约由 hook 统一释放）。
- **停止只 flush 尾片 + `finish`**（不整段重识别）；`stop` 等 `finish`（含在途 append）但可被 `cancel` abort。
- **有界并发**：`append` 串行（`maxInflight = 1`），慢后端只让分片器缓冲增长（受 60 s 录音上限约束），**不无限排队**；`progress().backlog` 反映积压。
- **失败保留已确认文本**：committed 已进草稿的文本保留；tentative 清空并如实标注未确认；**不自动重发旧音频（重放会重复计费）、不自动发送**；原生流式没有「重试本段」（`retryFailed` 为 no-op），重试 = 用户重新录一段。

## 4. 文本 UX（用户要求）

- 复用 `VoiceDraftAssembler`：committed 增补按语音原序追加到开始录制锚点之后，保留用户别处的编辑，**不自动发送**；单聊 / 群聊 / 引用 / IME 行为不变。
- tentative 只在录音状态行预览；**同一句的 revision 覆盖 tentative**，绝不把 partial 误当 final 重复追加。
- **不做 substring 去重**：重复口语「你好你好」原样保留。
- **真实音量不变**：波形仍来自实际 PCM 的 `LevelMeter`；reduce motion 下 CSS 只关过渡，保实时数值与条高（`voice-stream.ts` 不产生任何假运动）。

## 5. 默认语义与准备状态（前端只读、不抢写）

- **前端绝不 `PUT source` 抢占默认**：自动默认是服务端 `once CAS + optout` 管的；`resolveSelected` 仍只读后端 `selected`。
- 归一化层 `voice-pref.ts`：认不出 / 缺字段 → `ok:false` / `state:"unknown"`（**UI 什么都不显示，不猜「已就绪」**）；进度可并入统一下载注册表（`asr:<modelId>`）；`canCancelPrepare` / `canRetryPrepare` 给取消 / 重试条件。
- **首次联网如实分层**：权重再分发许可未充分确认 → **不随 app 捆绑**，因此**不把首次联网叫「首断网开箱」**；`firstUseNote()` 只在 `firstUseOnline === true` 时写「首次使用需联网自动准备（估算 < 300 MB，非实测），之后可离线」，`firstUseOnline === false` 才写「已内置，可离线」，**未知时什么都不写**。
- **不删现有六个 ASR 选项**：默认只是新增一个「默认」候选，用户以后觉得好用再谈精简；当前严禁删 / 隐藏（业务决策不在本树）。

## 6. 文件改动

| 文件 | 改动 |
|---|---|
| `apps/web/src/voice-stream.ts`（新） | 稳定前缀 / 句段模型 / 分片器 / `NativeVoiceController` / 会话接口 |
| `apps/web/src/voice-pref.ts`（新） | `GET voicepref` 归一化 + 展示选择器（纯） |
| `apps/web/src/hooks/useVoiceInput.ts` | 两条路径共用来源 / 租约 / 采集；`openStream` 可选接线；新增 `tentative` / `streaming` / `nativeCapable` |
| `apps/web/src/components/VoiceInput.tsx` | 录音状态行就地预览 tentative（`data-testid="voice-partial"`） |
| `apps/web/src/themes/base.css` | `.pa-voice-partial`（仅 voice 段，不动 slider / 公共 token） |
| `apps/web/src/voice-input.ts` | `VoiceProgress.stream?`、两个流式错误码文案（既有控制器逻辑不动） |
| `apps/web/src/api.ts` | `VoiceSourceOption.streaming?` + `isStreamingSource()` |
| `packages/server/test/voice-stream.test.ts`（新） | 合成 PCM + 假 transport 单测（**已写未跑**） |
| `packages/server/test/voice-pref.test.ts`（新） | 默认准备状态归一化单测（**已写未跑**） |

## 7. 验收方案（留给测试槽，本树不跑）

- **单测（已写、未跑）**：稳定前缀只增不减；partial 覆盖 tentative / final 只提交一次 / 重复 final 忽略 / 重复口语保留 / 晚到 partial 忽略 / final 不自洽不重复追加；分片 200–400 ms 与尾片不丢；控制器串行 ack、seq 单调、慢后端有界积压、stop flush 尾片 + finish、取消 / 隐藏 abort、打开 / 采集失败释放轨道、失败保已确认文本、60 s 上限、重试不重发；默认准备状态归一化（unknown → 不显示、首次联网未知不说离线、取消 / 重试条件）。
- **静态检查（已跑）**：用 app 自带 Node + 主仓 TypeScript（`tsc -p` 临时配置，指向主仓 `node_modules`，**未改任何 node_modules**）检查 `apps/web/src` 与两个新测试文件；**我的改动文件 0 错**，剩余 19 条为环境固有（`@pi-assistant/shared` 未解析、CSS side-effect import）。
- **真实 e2e（未跑，等测试槽）**：假 provider 服务 + 浏览器假麦（合成 PCM）验证「边说边出字 / tentative 就地预览不写输入框 / 停止 flush 尾 / 取消 / 失败保文本 / Safari 可跑」；**未跑不能宣称支持**。

## 8. 未决 / 待办

1. **线协议契约**：等主 / backend 给 `openStream` 的具体实现（路径 / 字段 / chunk / ack）；接线只改 `api.ts` + `VoiceInput.tsx`。
2. **`streaming` 能力字段名**：本树按 `VoiceSourceOption.streaming === true` 读；若契约用别的名字（如嵌套 `capabilities`），只改 API 类型与 `useVoiceInput` 一处判断。
3. **默认准备状态 UI 接线**：`VoiceSettings.tsx` 挂 `normalizeVoicePrepareView(await getVoicePref())` + 统一下载进度 / 取消 / 重试；**无强制 consent checkbox**。
4. **模型 / 运行时准备量**：< 300 MB 是**估算非实测**；权重 198.3 MB 有 pin，runtime（CPython / wheel）未真跑。
5. **真实质量 / RTF / 首字延迟**：未实测，不引用官方指标。
