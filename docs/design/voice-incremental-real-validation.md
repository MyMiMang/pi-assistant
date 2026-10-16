# 分段增量「真实本地模型多段中文」验证方案（**已执行，2026-10-18** / 未 push）

- 状态：**已执行**（脚本 `scripts/voice-incremental-real-validation.mjs`，证据 `evidence/voice-incremental-real/`）。worktree `voice-incremental-input`（基 `release-candidate-validation` `6d6c1ee`）。
- 结论：**通过**。产品 `VoiceInputController` → 真实 SenseVoice sidecar（pid/port/`health.modelId` 证真，非 mock）→ 官方 `zh.wav` 多段组合，四项断言均满足（见文末「实际结果」）。
- 目的：补上 §9 / HANDOFF 里如实标注的**未验**——「真实本地模型多段中文增量的延迟与文本误差」。
  现有证据只到「合成信号 + 假 provider 延迟」（单测）和「假音频喂 Chromium 假麦克风 + page.route 假转写」（e2e），
  **不能当作真实模型效果**。本方案用**产品 controller + 真实 worker + 官方样例多段组合**在 owned scratch 里真跑一次。
- 约束：本方案**只描述怎么跑**，不在 review 阶段启动任何进程；真跑留给重测试槽（手机 `sa_mvb8urvyq64kxc` 或主指定）。
- 红线：只用**自有 owner 标记目录**；不碰用户真实缓存 / 真实 DB / key / `credentials` / `secrets.ts`；不下载 GB 级权重；**不把 mock 当真效果**。

## 1. 可复用的 owned scratch（已存在，勿重建）

- 根：`$TMPDIR/pia-asr-smoke-amv7oy7ejb00`（实际 `/var/folders/2l/fc6qxgld7tj5k67f5_jsr71c0000gn/T/pia-asr-smoke-amv7oy7ejb00`），owner 标记文件 `.pia-asr-smoke-owner` = `amv7oy7ejb00`。
- 已有（`du` ≈ 553 MB，**无需新下载**）：
  - `data/local-asr/weights/model.int8.onnx`（SenseVoice small int8，239.2 MB，SHA256 `c71f0ce0…`）+ `tokens.txt`；
  - `data/local-asr/runtime/env`（共享 venv，含 sherpa-onnx wheel）；`data/local-asr/python/cpython-3.12.15-macos-aarch64-none`；
  - `wav/`：官方样例已缓存 —— SenseVoice `zh.wav`（178,988 B）、Paraformer `0.wav`（179,712 B）、Whisper-base `0.wav`（212,044 B）。
- 若 `PIA_SMOKE_FRESH=1` 会删 `data/home/wav/uv-cache/python` 子目录；**本次真跑不要设**，否则会重下。
- 复用脚本：`scripts/local-asr-real-smoke.mjs`（已实现 owner 校验、预算、真实 install/start/transcribe/stop 回收）。本方案在其基础上**加一段 controller 级验证**，不改其安全边界。

## 2. 隔离与运行时（固定）

- Node：**固定 Node 24**（本环境 `~/.local/node-v24.19.0/bin/node`，Homebrew node 25 有 simdjson 动态库缺失，勿用）。
- 运行：`node --import tsx <脚本>`（server 源码直跑）。
- 进程内**显式覆盖**：`PIA_DATA_DIR`、`PIA_WORKSPACE`、`HOME`、`UV_CACHE_DIR`、`UV_PYTHON_INSTALL_DIR`、`PIP_CONFIG_FILE=/dev/null`，全部指向 scratch 根；不读 / 不写用户真实数据目录。
- 只用 fake `getUserMedia`（不碰真实麦克风）；音频来自**官方样例 WAV**（已缓存），不录用户声音。

## 3. 真实链路（产品 controller → 真实 worker）

用 `apps/web/src/voice-input.ts` 的**产品** `VoiceInputController`，注入：

| 依赖 | 真实实现 | 说明 |
|---|---|---|
| `getUserMedia` | 返回假 stream（`getTracks()` 可控 stop） | 不开麦；只用于状态机 |
| `startCapture` | 把「多段组合 WAV」按真实采样率（48 kHz）切块、按真实时间节奏回调 `onData` | 触发真实分段 / 重采样 / 音量；不假 16k |
| `transcribe` | **真实**：`LocalAsrManager` 起真实 sidecar → `transcribeWav(manager, endpoint, wavBuf)`（HTTP + token + 租约） | **禁止 mock**；用 `pid/port/health.modelId` 与耗时证明真推理 |
| `createRequestId` | 真实自增 id | 便于按段对齐 |

音频构造（脚本内合成，不落用户目录）：`[官方 zh.wav][静音 1.0s][官方 zh.wav][静音 1.0s][官方 zh.wav]`（≈ 18.8 s，远低于 60 s 上限，字节 < 5 MB）。
按 48 kHz 播放以真正走一次 `resampleTo16kRange`；静音 ≥ 700 ms 保证 VAD 切段，最后一段不补静音以逼出 `flush()` 尾段。

## 4. 断言（对着用户点名的四点）

1. **首段可见（边说边出字）**：`stop()` 被调用之前，至少收到一次 `onSegment`（`index===0`），且文本非空。
2. **尾 flush（不丢尾）**：最后一段（无后续静音）在 `stop()` 后经 `flush()` 转写并回调；`stop()` 只等「在途 + 尾段」，**不整段重传**（请求数 == 段数，无额外整段请求）。
3. **停顿不重复 / 不漏**：把各段文本按 `index` 拼接，与「同一 WAV 整段一次转写」的基线比对：
   - 相邻段不出现长公共子串（≥ 4 个汉字）→ 无重复；
   - 每个 `zh.wav` 官方关键词（如「早上」「下午」「点」）出现次数 == 该样例重复次数（3）→ 无漏。
4. **实文误差（如实记录，不夸大）**：对 SenseVoice 用官方 `zh.wav` 期望串计算**字符错误率（CER）**或关键词命中率，记录真实数字；多段拼接与整段基线都记，供主判断「分段是否引入额外误差」。**只报实测值，不写「准确率 X%」这类结论。**

附加（可选）：记录每段「音频时长 → 转写耗时」（RTF 单样本），**只记一次值，不作性能结论 / 机器推荐**。

## 5. 预算与失败边界

- 默认只跑**已缓存**的 SenseVoice；若要跑 Paraformer（243 MB，未在缓存里）才触发一次真实下载，仍受 `PIA_SMOKE_BUDGET_MB` 与单模型上限约束。
- 单模型权重 > 500 MB（Whisper turbo / large-v3）**本次不测**。
- 任何中途失败都要在 `finally` 里 `stop()` 回收 worker（复用现有脚本的 `waitDead` 断言，pid 必须退出）。
- 证据写到本 worktree 的 `evidence/voice-incremental-real/`（含 `OWNER` 标记），报告 JSON 记：scratch 根、模型、每段文本与耗时、整段基线、CER / 命中、pid 与回收结果。**不写用户路径。**

## 6. 本方案**不**证明什么（写死）

- 不证明真实麦克风 / 真机 App 的采集质量与时延；不证明 700 ms / 12 s / 300 ms 阈值最优；不证明云端真实计费差异；不证明跨平台（Win / Linux / Intel Mac）。
- 只用一次单样本，**不作智能 / 准确率 / 性能结论**。

## 实际结果（2026-10-18，脚本一次跑通，35s）

- 环境：Node 24；真实 sidecar `pid=3171` `port=62663`，`health={ok:true,device:"cpu",loaded:["model.int8.onnx"],modelId:"sensevoice-small-int8"}`（非 mock）；`physicalCores/logicalCores` 覆盖为 4 → sidecar `--num-threads` ≤ 4。
- 音频：官方 `zh.wav`（178,988 B，sha256 `b77f1794…`）按 48k 升采样，组合 `[zh][静音1s][zh][静音1s][zh]` = **18.78s**，走真实 `resampleTo16kRange`。
- 断言（全部 true）：`firstSegmentBeforeStop`、`segmentIndices=[0,1,2]`、`ordered`、`uniqueRequestIds`、`noWholeRetranscribe`、`tailFlushed`、`maxWavWithinServerBound`、`noError`、`trackStopped`、`captureStopped`、`stateAfterStop=idle`。
- 时间口径（相对录音开始 / stop）：段 0 在 **+7.2s（stop 前）** 出字，段 1 在 **+14.7s（stop 前）**，段 2 在 **+21.2s（stop 后 flush）**。
- 单段推理（真实 HTTP + token + 租约）：`wavMs=4500/4500/4876`，`inferenceMs=1074/1048/1906`，`audioSeconds=4.5/4.5/4.876`；3 次请求无整段重传。
- 实文如实记录（**未做 ITN / 不做纠错**）：每段均为「开饭时间早上9点至下午5点。」——是**「开饭」不是「开放」**。
- 整段一次基线（同一组合，18.776s，4.72s）：输出「开放时间早上9点至下午5点开放时间早9点至午5点开放时间早上9点至下午5点。」；关键词命中：分段拼接 `早上=3/下午=3/点=6`，基线 `早上=2/下午=2/点=6`。**单样本观察：分段未引入额外误差，反而更稳**（不作准确率结论）。
- 回收：`leaseReleased=true`；`workerStop={pid:3171,state:"stopped",pidReleased:true}`（pid 已退出，无泄漏）。
- 证据：`evidence/voice-incremental-real/report-2026-10-16T18-00-18.json` / `validation-2026-10-16T18-00-18.log`（时间戳为 UTC）。
- 仍未证（照旧）：真实麦克风 / 真机 App、云端真实计费差异、跨平台；单样本不作智能 / 准确率 / 性能结论。
