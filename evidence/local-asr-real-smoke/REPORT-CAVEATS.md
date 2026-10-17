# 旧 report / log 的口径限制（2026-10-24 发布前修正）

**旧证据文件按原样保留、不改写**（`report-2026-10-17T03-28-23.json`、`03-30-05.json`、`03-31-33.json` 与
同名 `smoke-*.log`）。本文件说明它们**能证明什么、不能证明什么**，以及脚本已修但**未重跑**的地方。
引用这些证据时，必须连着这份说明一起引用。

## 1. 不能说的结论（已发生过的夸大）

| 旧写法 | 实际是什么 | 现在只能这样说 |
|---|---|---|
| 「中英 CER 0 / 0」「官方样例对照文本 CER 0/0」 | `STREAM_EXPECT` 里 0.wav 的对照串**没有可公开核对的来源**：该模型官方文档页面只有 `test_wavs/1.wav` 的示例输出，同页「昨天是 MONDAY TODAY IS THEY AFTER TOMORROW是星期三」属于**另一个模型**（`streaming-zipformer-small-bilingual-zh-en-2023-02-16`）而且是 `THEY` 不是 `LIBR`。1.wav 的对照串可核（官方文档 int8 段原样） | 「与上游文档的**模型示例输出**复现一致」（1.wav 可核；0.wav 无源，不给结论）。**不是准确率、不是中英文质量、不是 CER 质量指标** |
| 「分别真实 zh / en 专项测试通过」 | 0.wav 是**中英混说**，1.wav 是**中文夹 ALWAYS**，两个都不是纯英语 / 纯中文语料 | 只能说「官方 wav 两个样本各出一个段」；**独立英文语料、独立中文语料都没跑** |
| 「首字 3–6 ms」「首 tentative 距首帧 3ms」 | 该值取的是**第一条 tentative 事件**，而 92 条 tentative 里大量是**空串**；喂音频是 unpaced（decode 完就喂下一帧），测的是进程内吞吐 | 「真实 `OnlineRecognizer` 分帧返回假设；样例快速喂音频吞吐 RTF≈0.06（**仅 decode 吞吐，非交互端到端延迟**）；**首非空文本时延未在实时节奏下测**」 |
| 「首字先于 stop」 | 旧脚本用「`firstPartialMs` < 该 wav 时长(ms)」当判据，混了 wall clock 与音频时长 | 「在调用 `end()` 之前就收到了非空增量假设」= **协议增量返回事实**，不等于人声延迟 |
| 「禁网复跑零外部请求」 | 只 monkeypatch 了**当前 Node 进程**的 `globalThis.fetch`，拦非回环 host | 「**离线请求拦截条件下**本地复跑成功」（该 JS 边界没外请求）；**不是系统断网 / 路由阻断，也不审计 Python sidecar 子进程网络** |
| `decodeMs.p50 = 26 ms` | 旧脚本把 **p95 估计算子**挂在 `p50` 字段上 | 旧 json 不重写；新脚本已算真 p50 / p95。旧值只能当「量级」，不当分位数结论 |

## 2. 确实可信、已复核的部分（保留）

- 权重：4 个文件 198,270,793 B，逐文件 size + SHA256 与 catalog pin 一致；`health.ok` / `modelId` 正确 / `loaded` 列出三个 onnx。
- 生命周期：`end` 出 final、`seq` 重放被拒（`asr_stream_seq_replay`）、`cancel` 后活跃会话 0 / 租约 0 / worker 存活、stop 后 pid 回收。
- 流式行为：端点触发（endpoint 3 次）、committed 前缀自洽、final 与 committed 前缀一致。
- RTF 数：旧报告 0.064 / 0.069（墙钟/音频），只能当 **unpaced decode 吞吐**。

## 3. 脚本已修、但**本轮没有重跑**（不补数）

`scripts/local-asr-real-smoke.mjs` 本轮只改证据结构（无生产代码改动）：

1. 首字：只认 `trim()` 非空的 tentative，记 `firstNonEmptyMs` / `firstNonEmptyText` / `firstNonEmptyAudioFedMs`，
   并显式标 `pacing: "unpaced"`；协议事实另记 `firstNonEmptyBeforeEndCall`。
2. final：`append` 期间回包的 final 也进 `finalBySegment`（旧逻辑只收 `end()` 的 finals，前段 final 会丢）。
3. 分位数：`quantile()` 真 p 分位，`decodeMs.p50` / `.p95` 分开（旧值不再冒充 p50）。
4. 对照：`referenceKind` / `referenceSource` / `agreementScore` 进 report（不再只有 log），
   `cer` / `qualityCer` 保 `null` 表示**不做质量 CER**；0.wav 标 `unverified-legacy-string`。
5. 离线：`offline.scope` / `what` / `notProven` / `runnerStaticNote` 写明边界。

**未跑**：独立英文语料、独立中文语料、真实麦克风、弱网 / 实时节奏（paced）下的首字时延、
系统级断网、Windows / Linux / Intel Mac 实机。

## 4. 生产侧静态结论（不是本次 smoke 实测）

生产 runner 由**已 SHA256 校验的本地 ONNX** 构造（`OnlineRecognizer.from_transducer` 读本地文件），
运行期不下载权重；权重只在「首次自动准备」时联网下载。这条是**代码静态结论 + 上述进程内 fetch 边界验证**，
不等于「物理断网下已全平台验证」。产品目标仍是「准备完成之后可以离线使用」。
