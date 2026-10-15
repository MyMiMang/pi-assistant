# SenseVoiceSmall 权重许可证复核（可否随 App 分发 / 本地下载）

- **任务**：在把 SenseVoiceSmall 作为 Pi 本地语音输入模型之前，用**官方最新公开来源**确认**权重**（不是代码、不是引擎）的适用许可条款，回答「能不能随 App 打包 / 镜像再分发」，并给出产品可落地的门槛。
- **抓取时间**：2026-10-15（Asia/Shanghai）—— 本文件所有结论是该时刻**官方页面原文**所见，会变；升级必须先重跑本复核。
- **方法**：只读公开 HTTP（GitHub raw / GitHub issue 页面 / HuggingFace 模型卡与 API）。**只下几 KB 文本**（`MODEL_LICENSE` 5.3 KB、sherpa-onnx 目录 `LICENSE` 71 B、`tokens.txt` 316 KB 用于 pin 哈希）；**未下载任何权重**（239 MB 的 `model.int8.onnx` 未下），未 pip 安装、未改业务代码、未 push/tag。
- **边界**：本文件是**工程与合规事实核对**，**不是法律意见**（`不是 legal review`）。不声称「已确认可商用」，也不替许可方做解释。

---

## 0. 结论（一句话）

**权重许可证 = `FunASR Model Open Source License Agreement v1.1`（不是 Apache-2.0）；文本允许 `use/copy/modify/share`（须 §2.2 署名并保留模型名），但 §3「for reference and learning purposes only」+ §4.2 + §6 单方改版带来适用范围不确定性，且许可方对商用/再分发的最终确认仍未给出（issue #334 至今 `OPEN`）。**

因此产品判定：**「再分发权利范围不可靠」** →
1. **不随 App bundle 权重、不 mirror / 不代分发**（绝不把 239 MB 权重打进安装包或自建镜像）；
2. 安装入口**默认 blocked**，原因显式可见（不是灰按钮无理由）；
3. 允许**用户自行导入**自己合法取得的权重（canonical 路径 + 清单校验，不读敏感文件）；
4. 「从官方源直接下载」这条路径**代码具备但受同一门槛控制**：必须展示完整条款 + 显式 `acceptLicense`（版本号匹配）才可能放行，且**条款正文必须可见、不能被一次点击遮盖**（企业商用等限制要看得见）。
5. 门槛是**数据驱动**的：`manifest.ts` 里的 `licenseDecision` 一旦被上游最终确认改成 `cleared`，入口自动打开；不改产品逻辑。

---

## 1. 三类对象必须分开（最容易出错的地方）

| 对象 | 许可证 | 来源（本次复核） |
|---|---|---|
| SenseVoice **仓库源码**（`FunAudioLLM/SenseVoice`） | **MIT** | 仓库 `LICENSE` |
| FunASR **工具包源码**（`modelscope/FunASR`） | **MIT** | FunASR README §License |
| **官方 SenseVoiceSmall 权重** | **FunASR MODEL_LICENSE v1.1** | HF 模型卡 front-matter `license: other` / `license_name: model-license` / `license_link: .../MODEL_LICENSE` |
| **sherpa-onnx 引擎** | **Apache-2.0** | PyPI `sherpa-onnx==1.13.8` metadata：「Apache licensed, as found in the LICENSE file」；仓库 `LICENSE` |
| **sherpa-onnx 转换的 SenseVoice 模型目录** | **指向 FunASR 许可，不是 Apache** | 该目录 `LICENSE` 全文仅 71 B：`Ref to https://github.com/modelscope/FunASR?tab=readme-ov-file#license` |

> **禁止**：因为引擎是 Apache-2.0、仓库代码是 MIT，就把**权重**说成 Apache。ONNX / GGUF 转换仓的 `apache-2.0` 是**转换者填的元数据**，不等于权重授权。

## 2. 上游元数据自相矛盾（必须记录，不能装作没看见）

| 位置 | 声称 |
|---|---|
| HuggingFace `FunAudioLLM/SenseVoiceSmall` front-matter | `license: other` / `license_name: model-license` → FunASR MODEL_LICENSE |
| ModelScope `iic/SenseVoiceSmall` 模型页 License 字段 | 「Apache License 2.0」 |
| HF `FunAudioLLM/SenseVoiceSmall-GGUF`（转换仓） | `apache-2.0` |
| HF `csukuangfj/sherpa-onnx-sense-voice-...-2024-07-17`（转换目录） | 目录 `LICENSE` 指向 FunASR 许可 |

→ 本项目以 **HF 官方模型卡 + FunASR `MODEL_LICENSE` 正文**为准（**非 Apache**）。

## 3. `MODEL_LICENSE` v1.1 正文关键条款（原文摘录）

版本：`1.1`；版权方：`Alibaba Group`（`[2023-2028]`）。`[FunASR Software]` 定义 = FunASR 开源模型**权重及其衍生**（含微调模型）。

- **§2.1 License**：「You are free to **use, copy, modify, and share** [FunASR Software] under the terms of this agreement.」
  → 文本**字面上允许分享（再分发）**，但受 §2.2 / §3 / §4.2 / §5 / §6 约束。
- **§2.2 Restrictions**：「you must **attribute the source and author information and retain relevant model names**」
  → 署名 + 保留模型名是硬要求（我们的 UI 必须显示 "SenseVoiceSmall by FunASR / FunAudioLLM" + 链接）。
- **§3 Responsibility and Risk**：「provided for **reference and learning purposes only**」
  → 与 §2.1 的 "use/share" 存在张力；官方在 issue #334 解释这只是免责声明、不构成额外非商用限制——**但该解释未被最终确认**（见 §4）。
- **§4.2 Prohibited Behavior**：禁止无端贬损 / 恶意抹黑，违反即**自动丧失全部许可**。
- **§5 Termination**：违反任一条款即许可自动终止，须停止使用 / 复制 / 修改 / 分享。
- **§6 Revisions**：「may be updated and revised occasionally… **will take effect automatically**. Continuing to use… indicates your acceptance」
  → **许可方可单方改版并自动生效**。这是「产品级依赖」最危险的一条：今天放行、明天条款变了，已分发制品无法回收。

## 4. 商用澄清：**存在，但未最终确认**（本次复核仍成立）

`FunAudioLLM/SenseVoice` issue **#334**（本次复核抓取 GitHub 页面）：

- issue **state = `OPEN`**（页面 JSON `"state":"OPEN"`，出现 3 次；含 1 次 closed 事件、多次 reopened）。
- 页面上有一段维护者置顶的 **Status update (2026-09-22)** 原文：
  > 「**This is an earlier response, not final license-owner confirmation.** … this issue **remains open pending license-owner/core-maintainer confirmation** and an opportunity for the reporter to respond. The original response below is retained as discussion history and **should not substitute for that confirmation**.」
- 即：维护者此前回复「允许商用（需 §2.2 署名）/ 微调权重可闭源」，**被官方自己标注为非最终确认**，且该澄清**只覆盖官方权重**，第三方转换 / 打包制品需另行核对。

→ **诚实版结论**：工程上可做（署名 + 保留模型名 + 展示条款），**法务上未闭环**；不得写成「已确认可商用」。

## 5. 产品门槛（本次实现采用）

`packages/server/src/local-asr/manifest.ts` 的 `SENSEVOICE_LICENSE`：

```ts
{
  decision: "unresolved",              // cleared | unresolved | prohibited
  termsVersion: "1.1",                 // 用户必须接受的就是这个版本
  redistribution: false,               // 不可靠 → 不打包、不镜像
  attribution: "SenseVoiceSmall by FunASR / FunAudioLLM",
  links: { modelCard, modelLicense, issue },
}
```

门槛规则（`license.ts`，纯函数，可单测）：

| 情况 | 行为 |
|---|---|
| `decision === "unresolved"` | **`install`（含从官方源下载）默认 blocked**，返回中文原因 + 条款链接；**`import`（用户自行导入）仍开放** |
| `decision === "cleared"` | 允许 `install`，但仍要求 `acceptLicense === termsVersion`（防跳过阅读） |
| `decision === "prohibited"` | 两条路都 blocked |
| 任何情况 | **绝不**把权重打进 App bundle / 自建镜像（`redistribution:false` 时 `bundleAllowed()` 恒 false） |

「条款可见」的具体要求（写进契约，UI owner 执行）：
- `/source` 返回**完整条款链接 + 关键限制摘要**（署名、§3 用途声明、§6 单方改版、issue 未闭环）；
- `install` 必须带 `acceptLicense`，值必须是当前 `termsVersion`；不匹配 → 400；
- UI 不能用一次「我已阅读并同意」把法律文本折叠掉——**条款正文与限制摘要必须默认可见**，勾选只是确认，不是遮盖。

## 6. 供应链 pin（本次复核得到的确切值）

sherpa-onnx 转换模型：`csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`
revision = `2365baeacb507f821a0c8120fcee3d484dba7a07`（HF `/api/models/.../revision/main?blobs=true` 的 `sha`）：

| 文件 | 字节 | SHA256 | 来源 |
|---|---|---|---|
| `model.int8.onnx` | 239 233 841 | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` | HF **LFS oid**（未下载权重） |
| `tokens.txt` | 315 894 | `f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc` | 同 revision 取回 316 KB 本地算 |

引擎：PyPI `sherpa-onnx==1.13.8`（Apache-2.0），**无 torch 依赖**；本次核对到的官方轮子覆盖：`macosx_11_0_arm64` 2.1 MB、`macosx_10_15_x86_64` 2.4 MB、`win_amd64` 2.3 MB、`manylinux2014_x86_64` 4.4 MB、`manylinux2014_aarch64` 4.2 MB（另有 win_arm64）。**轮子哈希未 pin**（按平台/Python 版本分片，uv/pip 从 PyPI 索引按版本解析；见 §7 限制）。

## 7. 未确认 / 限制（不掩盖）

1. **许可适用范围未闭环**：issue #334 仍 `OPEN`；§3 与 §2.1 的张力未由许可方最终裁决。
2. **§6 单方改版**：条款可被上游自动更新；本产品不能保证已分发制品永远合规——这也是「不 bundle / 不镜像」的另一个理由。
3. **本次未做法律意见**；也未联系许可方。
4. **sherpa-onnx 轮子 SHA256 未 pin**：官方索引按平台分片，v1 只 pin 版本号（`==1.13.8`），依赖 uv/PyPI 索引完整性；要 pin 需按平台/CPython 版本逐条记哈希（后续可做）。
5. **VAD 未纳入 v1**：单句输入不需要 VAD；silero-vad 的哈希未 pin（如需再加）。
6. **性能数字未实测**：`research/sensevoice-local-asr-feasibility.md` 的 20× 实时等均为**上游自测**，本实现**不承诺** RTF / 内存；`ready but untested`。

## 8. 参考来源（2026-10-15 抓取）

- FunASR `MODEL_LICENSE`（v1.1 正文，5 306 B）— https://raw.githubusercontent.com/modelscope/FunASR/main/MODEL_LICENSE
- HF `FunAudioLLM/SenseVoiceSmall` 模型卡 front-matter（`license: other`）— https://huggingface.co/FunAudioLLM/SenseVoiceSmall/raw/main/README.md
- HF API `FunAudioLLM/SenseVoiceSmall`（`cardData.license=other`，sha `3847d57b…`）— https://huggingface.co/api/models/FunAudioLLM/SenseVoiceSmall
- SenseVoice issue #334（**state=OPEN** + 2026-09-22「not final license-owner confirmation」）— https://github.com/QwenAudio/SenseVoice/issues/334
- sherpa-onnx 转换模型 HF API（`sha=2365baea…`、LFS oid、体积）— https://huggingface.co/api/models/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/revision/main?blobs=true
- sherpa-onnx 模型目录 `LICENSE`（71 B，指向 FunASR）— https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/raw/main/LICENSE
- PyPI `sherpa-onnx` 1.13.8（Apache、轮子矩阵与体积）— https://pypi.org/pypi/sherpa-onnx/json
- 复用：`research/sensevoice-local-asr-feasibility.md`（§2 许可证、§3 路线、§8 实测清单）、`research/voice-input-project-comparison.md`（§3.2⑤ Handy 的 catalog 也把 SenseVoiceSmall 标 `"other"`）
