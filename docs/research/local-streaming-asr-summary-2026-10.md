# 本地流式听写：外部成品研究摘要（2026-10）

> 完整研究（本树外、只读）：`research/local-streaming-asr-2026-10/research/local-streaming-asr-github-review.md`（固定 SHA 浅克隆，未跑第三方脚本 / 未下权重）。
> 本文件只留**与 Pi Assistant 选型直接相关**的结论，证据链接指向固定 SHA 的永久 blob。

## 1. 必须区分「产品流式接口」与「模型原生流式」
- **Handy**（MIT，`9e57a0d7929fcc6417ea0d6e54c1b57f62635edd`）同时有两条路：离线切块 batch（`audio_toolkit/chunking.rs` + `managers/transcription/chunked.rs`）与**真 streaming worker**（`managers/transcription.rs` 的 `StreamTextEvent{committed,tentative}` / `StreamRouter`）。
- **VoiceInk**（**GPL-3.0，只学思路不复制代码**）走 FluidAudio 原生流式（`StreamingTranscriptionProvider.swift`），并有 `partial/committed/finalized` + **provider 不确认 finalization 就回落 batch**。
- **OpenWhispr**（MIT）本地 whisper 是**停止后批量**；只有会议/云有 partial。
- **whisper_streaming / WhisperLive**（均 MIT）是**滚动窗重识别**，**不是 Whisper 原生流式**。
- **结论**：不能凭 worker 名或事件结构推断「模型原生流式」；本轮默认模型必须落在**引擎原生支持**的 `OnlineRecognizer` 上。

## 2. 可直接借鉴的机制（都自研实现，不搬代码）
- **committed + tentative 两段 UI**（Handy）：稳定前缀只追加、临时结果可重写。
- **最长公共前缀 + n-gram 去重**（whisper_streaming `HypothesisBuffer.insert/flush`）：稳定前缀的教科书做法；**注意不要按字符串删用户真实重复的口语**。
- **VAD 预卷 / 尾段 / 起音**（Handy `SmoothedVad`）：我们现有单一 700 ms 静音容易吃字头；流式模型需要更长的尾段 hangover。
- **端点语义**（sherpa-onnx `EndpointRule{min_trailing_silence=2.0,…}` + `IsEndpoint → Reset` 逐句切）：比「固定静音阈值」稳。
- **worker 空闲卸载但录制中绝不卸载**（Handy `engine_supervisor/supervisor.rs`）：与我们 `manager.ts` 的 lease / idle 思路一致，对齐即可。
- **下载注册表**（OpenWhispr `modelRegistryData.json` = url/size/fileName + 校验）：与我们 catalog/sha256 同构 → **扩 catalog 即可，不另造 registry**。

## 3. 结论（已并入选型）
- 底座选 **sherpa-onnx `OnlineRecognizer`**（Apache-2.0，与我们现有 Python 运行时同栈）。
- 默认模型选 **streaming zipformer bilingual zh-en int8**（中英双语、原生流式、198.3 MB、许可证据链见决策文档）。
- **明确否掉**：Moonshine 路线（Handy catalog 里 `moonshine-streaming-tiny` 是 `languages=['en']`，中文只有单语变体，**无中英双语流式模型**，且是 GGUF + Handy 自有 runtime）。
- **Whisper 流式不作为默认**（CPU 慢机代价高，保留为可选批量）。
- 选型、pin、体积与阻塞见 `progress-snapshots/default-local-voice-decision.md`；设计见 `docs/design/default-local-voice.md`。
