# 语音分段增量 静态 review 发现（候选，未 push）

> **2026-10-18 续作更新**：本 review 的 F1 / F6 / F7 已在本树后续提交中修复并**真跑验收**（F2 / F3 / F4 的修复与新增测试也已执行）。详见下方各节「后续」与 `docs/HANDOFF.md` 顶部条目；真实模型验证见 `docs/design/voice-incremental-real-validation.md`。

- 日期：2026-10-18。范围：worktree `voice-incremental-input` HEAD `c286efd`，review `a7c3727` / `e5ca592` / `c286efd`。
- 方式：**只读 + 轻量 edit**，未启动 build / tsc / 测试 / 服务 / 浏览器 / 模型（重测试槽归 `sa_mvb8urvyq64kxc`）。所有「已修」均**未运行验证**，留给重测试槽。
- 结论：分段增量的主链路（只有 local 才增量、云端整段、连续重采样、草稿装配、取消不写旧返回）**方向正确**；发现 1 个需产品决策的顺序 bug + 3 个真实竞态/泄漏（已最小修）+ 3 条低风险记录。

## 已确认正确（对照用户点名）

| 点 | 结论 | 依据 |
|---|---|---|
| 只有 selected local 才增量、不伪 stream | ✅ | `hooks/useVoiceInput.ts:279` `incremental: asrModel.location === "local"`；云端 `opts.incremental` 假走整段分支 |
| 云仍整段 1 请求 | ✅ | `voice-input.ts` `stop()` 批量分支只发 1 次；e2e 断言录音期 0 次、停止 1 次 |
| 取消后旧返回不写 | ✅（增量）/ 见 F3（批量） | `pump` 用 `gen` 代际校验，`onSegment` 前 `gen !== this.gen` 直接返回 |
| 草稿手动编辑 anchor 不覆盖 | ✅ | `VoiceDraftAssembler.sync` + `mapPositionThroughEdit`（前后缀 diff）；组件 `appendSegments` 走 assembler |
| 相同口语不去重误删 | ✅ | 全程无 substring 去重，只按段边界 |
| 停顿不重复（不重叠窗口） | ✅ | 分段在原始采样坐标上首尾相接，无滑窗上下文 |
| group/subagent hook 统一接入 | ✅ | `VoiceInput` 只在 `Chat.tsx`（单聊）/ `RoomChat.tsx`（群聊）；子代理输入栏无麦克风，符合设计 §5 |

## F1（P1，**已修**，2026-10-18）失败重试会让后段**乱序**

- 位置：`voice-input.ts` `pump()`（失败段入 `failedTasks` 后继续处理后续段）+ `retryFailed()`（`waiting.unshift(...failedTasks)`）；`components/VoiceInput.tsx:64` `appendSegments`（按**到达顺序**追加，**未使用** `VoiceSegment.index`）。
- 复现：段0 连续失败 → `failedTasks=[0]`，段1 成功先 `onSegment(index=1)` → 输入框出现「段1」；用户点「重试这段」→ 段0 成功 `onSegment(index=0)` → 追加到末尾，结果 **「段1段0」**，违反 §9「不乱序」。
- 影响：仅在「中间段最终失败且后续段成功」时出现；文本不丢，但顺序错。
- 两种修法（各有取舍，需产品定）：
  1. **按 index 缓冲发射**：控制器持有 `nextEmitIndex` + 乱序缓冲，只有连续 index 才回调；失败段未解决前后续段**暂不显示**（用户须先重试）。保序、不丢；但一次失败会暂停「边说边出字」。
  2. **组件按 index 落位**：assembler 记录每段 index 对应的位置，重试段插回原位置。保序且不暂停；但需要位置追踪，改动更大。
- **后续（已修）**：按用户指定的「按语音原序稳定出字」实现**控制器保序发射**：`VoiceInputController` 维护 `nextEmitIndex` + `held`，只有连续 index 才回调 `onSegment`；前段失败时后续成功段进 held**不提前进草稿**，重试成功后**按原序一次补上**（不再「段1段0」）；仍照常转写后段音频（不静默 block）。UI 明确显示失败段 + 后续处理中。单测见 `voice-incremental.test.ts` 的 F1 单 / 多空洞两项。

## F2（P2，已修）打开采集期间取消 → 会话被「复活」成 recording

- 位置：`voice-input.ts` `start()` 在 `await startCapture` 之后**没有**重新校验状态（getUserMedia 之后有校验，startCapture 之后没有）。
- 复现：点麦 → `preparing` → 在 `audioWorklet.addModule` 等 in-flight 期间页面隐藏 / 切会话 / 换来源 / 卸载 → `cancel()`（置 idle、停轨道、清 60s 定时器）→ `startCapture` 随后 resolve → `set("recording")` 复活，且定时器已清、轨道已停 → **卡在 recording**。
- 修：`await startCapture` 后加 `if (this.state !== "preparing") { this.capture.stop(); this.capture = null; this.releaseStream(); return; }`。
- 精准单测：`packages/server/test/voice-incremental.test.ts` 新增「打开采集期间被取消 → 不复活 recording，停掉刚拿到的采集」。

## F3（P2，已修）云端整段转写中途取消 → 误报 error

- 位置：`voice-input.ts` 批量分支 `stop()`：`cancel()` 会 `this.abort.abort(); this.abort = null;`；旧代码 `await` 之后读 `this.abort.signal.aborted` → `this.abort` 为 null → 抛 TypeError → 被 `catch` 当成失败 → `set("error")` + `onError`（取消反而弹错）。增量分支无此问题（用局部 `gen` 校验）。
- 复现：云来源，点停止进入 `transcribing`，转写 in-flight 时切会话 / 卸载（`cancel()` 可达 `transcribing`）→ 取消后状态变 `error`。
- 修：批量分支改用**局部** `const abort` 引用，`catch`/`finally` 都读局部；`finally` 只在 `this.abort === abort` 时置空。
- 精准单测：新增「批量（云端）整段转写中途取消 → 保持 idle、不误报 error」。

## F4（P2，已修）录音租约并发开始 → 旧 leaseId 丢失、不释放

- 位置：`hooks/useVoiceInput.ts` `beginLease`：旧实现 `.then` 里读 `leaseRef.current`（**最新**对象）且直接覆盖引用。若 `beginLease` 被连续调用（极快重复点击，或 `start` 在 `preparing` 期间被再次触发——`controller.start` 会早退，但 hook 已先 `beginLease`），两次 acquire 都写进同一个对象 → 其中一个 `leaseId` 丢失、永不 `release`；服务端 `leases` 计数不归零 → 本地模型无法 idle 卸载。
- 修：`beginLease` 先 `prev.cancelled=true` 并释放 `prev.id`；回调只读写**本次创建**的 `entry`（不读 `leaseRef.current`）。
- 注：该逻辑已抽为 `voice-input.ts` 的 `AsrLeaseManager`（hook 改用它），新增单测覆盖并发 begin 只留最新 / 旧与迟到租约释放（F4）、end 后重试重取租约（F7）；不再有「无测试基建」缺口。

## F5（P3，已修）未使用 import / 注释与设计不符

- `components/VoiceInput.tsx` 删掉未使用的 `RotateCcw` import。
- 组件头注释原写「主会话 / 群聊 / 子代理三处都复用它」，与设计 §5「子代理输入栏不加麦克风」矛盾 → 改为「主会话 / 群聊复用它（子代理输入栏不加麦克风）」。

## F6（P3，**已修**，2026-10-18）积压时合段可长到录音上限

- `SpeechSegmenter.frameEnd` 在 `if (this.backpressure) return;`（`voice-input.ts:300`）位于 `maxSegmentMs` 判断**之前** → 慢模型积压期间当前段不设上限，最长可到 60s 录音上限。
- 与 server `ASR_MAX_DURATION_MS = 60000` 边界重合：因录音 60s 上限，单段 ≤ 60s，理论上刚好通过（`> maxSeconds` 才拒）。- **后续（已修）**：`SpeechSegmenter` 新增 `hardMaxSegmentMs`（默认 55s），在 `backpressure` 早退**之前**判定：到上限**强制切段**（余下语音进入下一段，不丢音频），保证单段 WAV 时长 ≤ 服务端 `ASR_MAX_DURATION_MS`（60s）。单测用服务端 `validateAsrAudio` 精准证明每段 WAV 通过校验、且覆盖整段录音（尾部不丢）。

## F7（P3，**已修**，2026-10-18）重试失败段未重新获取录音租约

- `retryFailed()` 在 stop 后调用，此时租约已随 `idle` 释放；`transcribeWav` 自身有 `beginInference`（active++）防止推理中被卸载，但 stop→重试间隔若超过本地 idle TTL（默认 90s）可能 `not_running`。- **后续（已修）**：抽出可测的 `AsrLeaseManager`（并发 begin 只留最新、旧 / 迟到租约释放）；hook 在停止后重试前**按需补一次租约**（只对本地源、确有失败段时；不切云 / 不换模型），来源变更时中止 transcribing 重试。单测见 `voice-incremental.test.ts` 的 F4 / F7 租约三项。

## 附：服务端 `tsc` `ext-memory` / `ext-skills` `messageType` 报错 —— 是环境符号链接污染，不是源码 bug

只读核查（未改 `node_modules` / 共享 `@pi` / 未 patch SDK）：

- worktree `voice-incremental-input` 的 `node_modules/@earendil-works` 是指向**主仓库** `node_modules/@earendil-works` 的**符号链接**（`readlink` 已确认）。
- worktree 声明并 lock 的是 Pi SDK **1.3.0**（`packages/server/package.json` + `package-lock.json`：`pi-coding-agent 1.3.0`、`pi-ai 1.3.0`）。
- 但主仓库 `node_modules` 实际装的是 **1.1.0**（主仓库 `package.json` 声明 `^1.1.0`，lock `1.1.0`）。
- 已装 1.1.0 的 `BeforeAgentStartEvent`（`pi-coding-agent/dist/core/extensions/types.d.ts:708`）**没有 `messageType` 字段**；`messageType` 是 1.2.0 起才有的（源码注释亦如此写）。因此 `ext-memory/src/index.ts:50`、`ext-skills/src/index.ts:45` 读 `event.messageType` 在 1.1.0 下必然报错。
- **结论**：这是「worktree 复用主仓库 1.1.0 的 node_modules、却按 1.3.0 写代码」的依赖版本符号链接污染，**不是**新版 SDK 不兼容，也**不是**本次语音改动的 bug（voice 相关 0 错）。
- **正确修法**（由主在正确环境做）：让该 worktree 用**自己的 lock** 安装自己的 `node_modules`（`npm ci`），或把符号链接指向一份 1.3.0 安装；**不要**修改共享 `@earendil-works` 指向、**不要** patch SDK 代码消错。

## 验证状态（2026-10-18 续作）

- **已跑**：`voice-incremental.test.ts` **30/30**（含 F1 保序、F6 硬上限 + WAV 服务端校验、F4/F7 租约）；语音 / ASR 相关 **148/148**；两端 `tsc --noEmit` 通过；`npm run build -w @pi-assistant/web` 通过；`e2e/voice-incremental-ui.mjs` 全过；真实本地模型多段中文验证 `scripts/voice-incremental-real-validation.mjs` 通过（证据 `evidence/voice-incremental-real/`）。
- 依赖环境：本树 `node_modules` 已改为**本树 1.3.0 lock 独立安装**（Node 24），不再有 1.1.0 symlink 污染。

- F2 / F3 的新增单测已执行；F4 的 hook 层逻辑已抽为可测的 `AsrLeaseManager`（`voice-incremental.ts`），新增单测覆盖并发 begin / 迟到租约 / 重试重取；不再有「无测试基建」缺口。
- 真实本地模型多段中文验证已执行（见 `docs/design/voice-incremental-real-validation.md` 与 `evidence/voice-incremental-real/`）。
