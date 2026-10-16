# 默认本地语音（开箱即用）——选型决策与阻塞（2026-10-24）

> 本树：worktree `default-local-voice`，分支 `default-local-voice`，**基 `release-candidate-validation` 已提交 HEAD `b20ec81`**（`b20ec81f730627b4493fcecaac1c4fa5f38d0782`，"文档：beta.28 已公开为 Latest"）。**未复制该树的 WIP**（`e2e/.dbg-settings.mjs`、`e2e/thinking-slider-ui.mjs` 属主是 candidate owner，本树未取）。
> 本轮范围：**只做选型 + 事实核验 + 设计**。未跑 `npm ci` / 构建 / 浏览器 / 测试 / 真实模型与权重下载（只取公开元数据与几 KB 文本文件）。未 push / 未 tag。
> 上游研究（本树外，只读）：`research/local-streaming-asr-2026-10/research/local-streaming-asr-github-review.md`；摘要已入库 `docs/research/local-streaming-asr-summary-2026-10.md`。

---

## 一、结论：推荐一个默认

**默认本地语音 = 原生流式（sherpa-onnx `OnlineRecognizer`）+ 中英双语 streaming zipformer。**

| 项 | 值 |
|---|---|
| 模型 | `csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20` |
| 固定 revision | `98590b7ed6443e77b714204da2757d75e1a642f4` |
| 运行族（新） | `online-zipformer`（sherpa-onnx `OnlineRecognizer.from_transducer`，**原生流式**：`acceptWaveform → isReady → decode → isEndpoint → reset`） |
| 语种 | 中文 + 英文（同一模型；训练自 AIShell-1 + WenetSpeech，char+bpe） |
| 标点 | **无**（transducer 原生输出无标点；要标点需另配标点模型，不在本轮） |
| 引擎 | `sherpa-onnx==1.13.8`（Apache-2.0），沿用现有 managed Python 运行时（uv + venv + 现有 wheel pin） |

**权重 pin（int8，全部来自公开 HF 元数据 `lfs.oid` = 文件 SHA256）**

| 文件 | 字节 | SHA256 |
|---|---|---|
| `encoder-epoch-99-avg-1.int8.onnx` | 181,895,032 | `8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b` |
| `decoder-epoch-99-avg-1.int8.onnx` | 13,091,040 | `1a70c593d71e53f023f5f55b0b4cfff5055abb786ee3992e5f63dc2e273cc4fa` |
| `joiner-epoch-99-avg-1.int8.onnx` | 3,228,404 | `1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0` |
| `tokens.txt` | 56,317 | `a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3`（**本地实测**，非 LFS） |
| **合计** | **198,270,793 B（≈198.3 MB / 189.1 MiB）** | |

元数据证据（永久 URL）：
- 仓元数据 `https://huggingface.co/api/models/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20` → `cardData.license = "apache-2.0"`，`sha = 98590b7ed6443e77b714204da2757d75e1a642f4`
- 文件树（含 LFS oid / size）`https://huggingface.co/api/models/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/tree/98590b7ed6443e77b714204da2757d75e1a642f4?recursive=true`
- 仓 README：`https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/raw/main/README.md` → 源 torchscript 模型 `https://huggingface.co/pfluo/k2fsa-zipformer-chinese-english-mixed`，训练代码 `https://github.com/k2-fsa/icefall/tree/master/egs/librispeech/ASR/pruned_transducer_stateless7_streaming`
- 源模型仓 card：`https://huggingface.co/api/models/pfluo/k2fsa-zipformer-chinese-english-mixed` → `license: apache-2.0`
- 训练代码 LICENSE（**有真实文件**）：`https://raw.githubusercontent.com/k2-fsa/icefall/master/LICENSE` = Apache License 2.0
- 引擎：`https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE` = Apache-2.0

### 为什么不选其它（都核过，不是猜）
| 候选 | 中文 | 英文 | 原生流式 | 体积(int8) | 许可证据 | 结论 |
|---|---|---|---|---|---|---|
| **bilingual zipformer zh-en** | ✅ | ✅ | ✅ | 198.3 MB | 两处 card `apache-2.0` + icefall 真 LICENSE | **默认** |
| streaming paraformer bilingual zh-en（`8e40c43232a1c5c66c82111efc5820d3accca11b`） | ✅ | ✅ | ✅ | 237.2 MB | card `apache-2.0`，但源是 ModelScope `damo/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8404-online`，**源许可未核** | 备用（体积更大、证据链更弱） |
| Moonshine（Handy 推荐的那些） | ❌ | ✅ | ✅（`moonshine_streaming`） | 50 MB | — | **否**：Handy catalog 里 `moonshine-streaming-tiny` 的 `languages=['en']`，**英文专用**；Moonshine 的 zh 变体是**单语 zh**（`moonshine-tiny-zh-gguf`），没有中英双语流式模型；且是 GGUF + Handy 自有 runtime，**不是我们的栈** |
| Handy 的多语流式（`nemotron-3.5-asr-streaming-0.6b-gguf` 含 zh / Voxtral / Qwen3-ASR） | ✅ | ✅ | ✅ | 0.6B~4B | GGUF 仓，许可需另核 | 否：需引入全新 GGUF runtime，体积/复杂度都远超本轮 |
| zh-14M streaming zipformer（`204ad334e2e683fd295359930cc16fc0432a23ac`） | ✅ | ❌ | ✅ | 25.4 MB | card `apache-2.0` | 轻量备用（**中文单语**） |
| en-20M streaming zipformer（`d42f2d9f7ca24806fb667456a18a9f1b60f70d16`） | ❌ | ✅ | ✅ | 43.6 MB | card `apache-2.0` | 轻量备用（**英文单语**） |
| 现状 SenseVoice / Paraformer / Whisper（beta.28 分段增量） | ✅ | ✅ | **❌ 非原生** | 已装 | — | 保留，不删不改 |

---

## 二、运行时的两条路（事实对比）

### 路 P：现有 managed Python sidecar（**推荐，最小改动**）
- 现链路已真实跑通三族（SenseVoice / Paraformer / Whisper）：`preflight>uv>venv>engine>weights>verify>activate`，租约 / idle 卸载 / 取消 / 重试 / 统一「下载与组件」面板都已有（`packages/server/src/local-asr/{manager,deps,download,service}.ts`）。
- 离线成本（实测数）：**CPython 3.12 由 uv 在首次安装时下载 ≈71 MB**（uv 本体已随包 `bin-seed`，见 `scripts/fetch-bins.ts`；Laya 首跑证据 `evidence/local-laya-real-smoke/`）+ **sherpa-onnx wheel 2.1–4.4 MB + sherpa-onnx-core wheel 9.5–20.4 MB**（PyPI 1.13.8 公开元数据）+ 权重 198.3 MB。
- 平台覆盖（官方 wheel，全部已有 pin）：`darwin-arm64` / `darwin-x64` / `win32-x64` / `win32-arm64`（**有** cp312 wheel，1.6 MB，我们标 conditional）/ `linux-x64` / `linux-arm64`。
- 缺口：**sidecar 现在只有「一次性 POST 整段 WAV」**（`serve-script.ts`），没有流式端点 → 新增流式协议是本次真正的新件。

### 路 N：`sherpa-onnx-node` 原生 Node addon（**备选，值得做但本轮不选**）
- npm 上真有：`sherpa-onnx-node@1.13.8`，**license Apache-2.0**，`optionalDependencies` 按平台分：`sherpa-onnx-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win-x64,win-ia32}`；解包 19.9–40.3 MB（含 onnxruntime）。
- JS 绑定确实暴露流式 API（我读了 npm 包内的 `streaming-asr.js`）：`OnlineRecognizer.createStream / acceptWaveform / isReady / decode / isEndpoint / reset / getResult`。
- 好处：**运行时随 `npm ci --omit=dev` 自动进安装包**（`scripts/stage-app.mjs` 已按目标平台装生产依赖），**没有 CPython / uv / venv / pip**，离线成本只剩权重。
- 不选的原因（不是不好，是本轮不该赌）：① 无 `win-arm64` 包（我们 catalog 现在把 win32-arm64 列为 conditional）；② 要把 sidecar 换成进程内 addon，`manager.ts` 的「子进程 + pid + 端口 + 健康检查 + 租约」生命周期要重写，且要 `worker_threads` 避免阻塞事件循环；③ **本机未做任何真实验证**（本树不许跑）。→ 列为**下一阶段候选**，作为「彻底去掉 Python 依赖、体积再降 ~70 MB」的路径。

### 体积账（每平台，相对现状的增量）
| 方案 | 权重 | 运行时 | 合计 |
|---|---|---|---|
| **P0 全内置（真 offline-first）** | 198 MB | CPython ~71 MB + wheel ~12–25 MB | **≈ +285–295 MB** |
| P1 只内置权重，运行时首次联网自动准备 | 198 MB | 0（首次下 ~85–95 MB） | +198 MB（**首次需联网**） |
| P2 全不内置，首次联网自动准备 | 0 | 0 | 0（首次下 ~285–295 MB，**首次需联网**） |
| N0（Node addon）全内置 | 198 MB | addon 20–40 MB（自动随包） | ≈ +220–240 MB |

---

## 三、阻塞与口径（不把没核完的叫「可随包」）

1. **权重再分发许可：证据充分度「中」，bundle 需主口径。** 两个权重仓（转换仓 + 源模型仓）**都没有 LICENSE 文件**，只有 HF card `license: apache-2.0`；真实 LICENSE 文件只在**上游训练代码 icefall**（Apache-2.0）。按本轮规则「不用 HF tag 单独确认商用」，所以：
   - **本地按需下载（`selfServe`）= 放行**（与 SenseVoice 同口径：用户本人在自己电脑上从官方源按需下载自用，不随 App 分发）；
   - **随安装包内置（bundle / 再分发）= 暂不放行**，等主确认「两处 HF card 声明 + 上游 icefall Apache-2.0」是否足以支撑再分发。
   - 未核：训练数据（AIShell-1 / WenetSpeech）自身的许可条款。**不把它当已确认商用。**
2. **流式传输是新件。** 现有 sidecar 只有一次性 WAV POST；要做原生流式必须新增「分块喂 + 增量回」的端点（推荐 HTTP chunked POST + 换行分隔 JSON 事件，复用现有 `ThreadingHTTPServer`，不引入 WS 依赖），并给 `manager.ts` 加流会话生命周期（复用 lease / idle / 录制中不卸载）。
3. **真 offline-first 需要新的「内置 CPython」打包机制**：uv 已内置，CPython 没有（现在靠 uv 首次联网下载 ~71 MB）。要 P0 就得在 `bin-seed` 里多一个 pinned CPython（新增构建步骤 + 体积）。
4. **质量/性能未实测**：中文、英文的真实识别质量与 RTF、首字延迟**都没跑**。不得引用官方指标冒充。
5. **win-arm64**：PyPI 有 cp312 wheel（现有 pin 已含），node addon 没有 → 若将来走 N 路要单独处理。
6. **不能覆盖用户已有选择**：`settings.voiceSource != null` 时默认一律不写；`null`（全新/从未选）才谈默认。

---

## 四、建议的下一步（主拍板后即可实施）

- **口径建议（推荐 P1 → 逐步 P0）**：先按 **P1** 落地（权重随包？——**受阻塞 1 限制，先按「自动准备 + 明示」落地**，即 P2 的诚实版本：首装即可用，但**首次需要联网自动准备，界面明说「首次使用需联网准备约 285 MB，之后可离线使用」**，绝不写「首次断网可用」），同时把 P0/P1 的 bundle 开关按数据准备好，主确认许可口径后一行开启。
- **实现顺序**：① 新增 `online-zipformer` 运行族 + 流式端点（sidecar）；② `manager` 流会话（复用 lease/idle，录制中不卸载）；③ catalog 加条目 + `isDefaultVoice` 标记 + 统一「下载与组件」登记；④ `voiceSource == null` 时的默认语义（不覆盖已选）；⑤ 前端 committed/tentative 稳定前缀；⑥ 真实 smoke（官方 `test_wavs/0.wav` 中文 + `1.wav` 英文，分块喂，证 partial 在 stop 前出字、endpoint 触发 reset、final 文本、RTF 本机实测）；⑦ 断网复测。
- 设计与最小实现清单见 `docs/design/default-local-voice.md`。
