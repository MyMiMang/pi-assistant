# SenseVoice 真实 smoke 证据（2026-10-16）

命令：`PIA_SMOKE_MODELS=sensevoice-small-int8 PIA_SMOKE_BUDGET_MB=600 node --import tsx scripts/local-asr-real-smoke.mjs`
- scratch 根：复用前任务自有的 `/var/folders/…/T/pia-asr-smoke-amv7oy7ejb00`（owner 标记 `amv7oy7ejb00`，非用户缓存 / 非真实数据目录）。
- 新增下载：仅 SenseVoice 权重 **239.5MB**（`model.int8.onnx` 239,233,841 B + `tokens.txt` 315,894 B）+ 官方示例 wav 178,988 B；共享 runtime 复用，未重下 wheel。计划 365.4MB < 600MB 预算。
- 未读用户缓存 / 配置 / 密钥 / 麦 / 付费；worker 在 finally 停止（`pidReleased=true`）。

## 首次运行（真实下载 + 安装；日志原文）

```
11:26:18 计划：sensevoice-small-int8(239.5MB) + 运行时估算 126MB = 365.4MB（预算 629MB）
=== SenseVoice Small（本地）（sensevoice-small-int8）许可=unresolved 权重 239.5MB repo=csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17@2365baea
  [sensevoice-small-int8] phase=preflight
  [sensevoice-small-int8] phase=uv
  [sensevoice-small-int8] phase=verify
  [sensevoice-small-int8] phase=activate
  安装完成 28.5s phases=preflight>uv>weights>verify>activate
  权重目录 …/data/local-asr/weights：2 个文件大小/SHA256 与 catalog pin 全部一致
  worker pid=37851 port=53269 health={"ok":true,"device":"cpu","loaded":["model.int8.onnx"],"modelId":"sensevoice-small-int8"}
  示例 wav test_wavs/zh.wav：178988B sha256=b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373
  推理（样本 官方 sherpa-onnx SenseVoice 文档 test_wavs/zh.wav 期望输出）：开饭时间早上9点至下午5点。
  stop：state=stopped 旧 pid 37851 已退出=true
```

首次运行在最后一行单模型日志（`specs[1].id`）抛错（脚本自身缺陷，已修），**安装 / 校验 / 推理 / stop 全部已完成**。

## 二次运行（权重已缓存，复跑确认；`report-2026-10-16T11-27-18.json`）

```
安装完成 0s phases=
权重目录 …/data/local-asr/weights：2 个文件大小/SHA256 与 catalog pin 全部一致
worker pid=38519 port=53392 health={"ok":true,"device":"cpu","loaded":["model.int8.onnx"],"modelId":"sensevoice-small-int8"}
推理：开饭时间早上9点至下午5点。
stop：state=stopped 旧 pid 38519 已退出=true
```

## 核对点

- 权重 SHA256 与 `catalog.ts` pin 一致：`model.int8.onnx=c71f0ce0…cd51`、`tokens.txt=f449eb28…a1dc`。
- `health.modelId = sensevoice-small-int8`（非别的模型 / 非 fallback）。
- 官方中文样例命中关键词「早上 / 下午 / 点」；非空。
- 无新增失败阶段；无网络阻塞。
