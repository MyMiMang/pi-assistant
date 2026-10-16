# 第三方组件与许可证

Pi Assistant 使用了下列第三方项目。版本取自 `package-lock.json`、`apps/tray/src-tauri/Cargo.lock`、Dockerfile 和 [third-party.json](third-party.json)（运行时下载的组件在那里固定版本与 SHA256）。各组件的版权归原作者所有，按各自的许可证使用；完整许可证文本见各项目仓库，或安装后 `node_modules/<包>/LICENSE`、镜像内 `/usr/share/doc/<包>/copyright`。

这里列的是直接依赖和随产品分发 / 下载的组件；npm 与 Cargo 的传递依赖以 lockfile 为准。

## 助理核心

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi) | 1.3.0 | MIT | 智能体运行时（只经 `packages/server/src/pi-adapter` 使用） |
| [@earendil-works/pi-ai](https://github.com/earendil-works/pi) | 1.3.0 | MIT | 模型服务接入 |
| [@earendil-works/pi-mcp](https://github.com/earendil-works/pi) | 1.3.0 | MIT | MCP 工具接入 |
| [Node.js](https://nodejs.org/) | 22.23.3 | MIT | 安装包内置运行时 |
| [typebox](https://github.com/sinclairzx81/typebox) | 1.3.x | MIT | 工具参数模式 |
| [models.dev](https://github.com/sst/models.dev) 数据 | 快照 2026-10-14，运行时每周刷新 | MIT（Copyright (c) 2025 models.dev） | 模型参数库：上下文 / 最大输出 / 识图 / 推理 / 工具调用 / 价格（`packages/server/model-db.json`，由 `scripts/gen-model-db.mjs` 精简生成） |

## 本地服务（packages/server）

| 组件 | 版本 | 许可证 |
|---|---|---|
| [hono](https://github.com/honojs/hono) / [@hono/node-server](https://github.com/honojs/node-server) | 4.13.13 / 2.1.4 | MIT |
| [ws](https://github.com/websockets/ws) | 8.22.0 | MIT |
| [croner](https://github.com/Hexagon/croner) | 10.0.1 | MIT |
| [diff](https://github.com/kpdecker/jsdiff) | 8.0.4 | BSD-3-Clause |
| [qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | MIT |
| [web-push](https://github.com/web-push-libs/web-push) | 3.6.7 | MPL-2.0 |
| [tsx](https://github.com/privatenumber/tsx) | 4.23.15 | MIT |
| [playwright-core](https://github.com/microsoft/playwright) | 1.64.0 | Apache-2.0 |
| [imapflow](https://github.com/postalsys/imapflow) | 2.4.0 | MIT |
| [nodemailer](https://github.com/nodemailer/nodemailer) | 10.1.0 | MIT-0 |
| [mailparser](https://github.com/nodemailer/mailparser) | 3.9.38 | MIT |
| [@larksuiteoapi/node-sdk](https://github.com/larksuite/node-sdk)（飞书） | 1.74.0 | MIT |
| [dingtalk-stream](https://www.npmjs.com/package/dingtalk-stream)（钉钉） | 2.1.5 | MIT |
| [@wecom/aibot-node-sdk](https://www.npmjs.com/package/@wecom/aibot-node-sdk)（企业微信） | 1.0.7 | MIT |
| [@tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)（微信 ClawBot，只复用协议层） | 2.4.10 | MIT |
| [unpdf](https://github.com/unjs/unpdf)（附件：PDF 提取文字，内含 [PDF.js](https://github.com/mozilla/pdf.js)，Apache-2.0） | 1.8.1 | MIT |
| [fflate](https://github.com/101arrowz/fflate)（附件：解压 DOCX / XLSX / PPTX 提取文字） | 0.8.3 | MIT |
| [@silvia-odwyer/photon-node](https://github.com/silvia-odwyer/photon)（附件：图片缩放，经 Pi 的 resizeImage 使用） | 0.3.4 | Apache-2.0 |

## 记忆

| 组件 | 版本 | 许可证 |
|---|---|---|
| [Hindsight](https://github.com/vectorize-io/hindsight)（hindsight-embed、hindsight-api-slim，PyPI） | 0.10.3 | MIT |
| [@vectorize-io/hindsight-all](https://www.npmjs.com/package/@vectorize-io/hindsight-all) / [hindsight-client](https://www.npmjs.com/package/@vectorize-io/hindsight-client) | 0.10.3 | MIT |
| [FlashRank](https://github.com/PrithivirajDamodaran/FlashRank) | 0.2.10 | Apache-2.0 |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime)（Hindsight 的依赖） | 1.x | MIT |
| [uv](https://github.com/astral-sh/uv) | 0.13.0 | MIT OR Apache-2.0 |
| [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small)（默认向量模型，按需下载） | — | MIT |
| [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)（可选向量模型，按需下载） | — | MIT |

## 网页界面（apps/web）

| 组件 | 版本 | 许可证 |
|---|---|---|
| [React](https://github.com/facebook/react) / react-dom | 19.3.0 | MIT |
| [Vite](https://github.com/vitejs/vite) / [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | 8.3.4 / 6.1.2 | MIT |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) / @tailwindcss/typography | 4.3.3 / 0.5.20 | MIT |
| [zustand](https://github.com/pmndrs/zustand) | 5.0.15 | MIT |
| [react-markdown](https://github.com/remarkjs/react-markdown) / [remark-gfm](https://github.com/remarkjs/remark-gfm) / [rehype-highlight](https://github.com/rehypejs/rehype-highlight) | 10.1.0 / 4.0.1 / 7.0.2 | MIT |
| [highlight.js](https://github.com/highlightjs/highlight.js) | 11.x | BSD-3-Clause |
| [lucide-react](https://github.com/lucide-icons/lucide) | 1.55.0 | ISC |
| [@noble/ed25519](https://github.com/paulmillr/noble-ed25519) | 3.2.0 | MIT |
| [@lobehub/icons-static-svg](https://github.com/lobehub/lobe-icons)（设置 › 模型 里内置服务的品牌图标；只提取 `scripts/gen-provider-icons.mjs` 用到的图标，生成 `apps/web/src/components/provider-icons.ts`） | 1.95.1 | MIT |
| [@novnc/novnc](https://github.com/novnc/noVNC) | 1.7.0 | MPL-2.0 |
| [TypeScript](https://github.com/microsoft/TypeScript)（构建） | 5.9 / 7.0 | Apache-2.0 |

## 桌面程序（apps/tray）

| 组件 | 版本 | 许可证 |
|---|---|---|
| [Tauri](https://github.com/tauri-apps/tauri) 及插件 shell、autostart、updater、notification、single-instance、opener | 2.12 | Apache-2.0 OR MIT |
| [@tauri-apps/cli](https://github.com/tauri-apps/tauri) | 2.12.2 | Apache-2.0 OR MIT |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.12 | MIT OR Apache-2.0 |
| [tokio](https://github.com/tokio-rs/tokio) | 1 | MIT |
| [serde](https://github.com/serde-rs/serde) / serde_json | 1 | MIT OR Apache-2.0 |

## 运行时下载的组件（版本与 SHA256 固定在 third-party.json）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [cloudflared](https://github.com/cloudflare/cloudflared) | 2026.10.0 | Apache-2.0 | 远程访问隧道 |
| [Cua Driver](https://github.com/trycua/cua) | 0.35.4 | MIT | 截图与键鼠操作（助理电脑镜像 `0.1.4` 内同为 0.35.4） |
| [Lima](https://github.com/lima-vm/lima) | 2.2.1 | Apache-2.0 | macOS 助理电脑虚拟机 |
| [nerdctl-full](https://github.com/containerd/nerdctl)（containerd、nerdctl、runc、CNI、BuildKit） | 2.4.1 | Apache-2.0 | 虚拟机内容器引擎 |
| [Debian 12 genericcloud](https://cloud.debian.org/images/cloud/) | 20260923-2610 | DFSG 自由软件（各包许可证不同） | Lima 虚拟机系统盘 |
| pia-wsl-rootfs（本项目构建：Debian 12 slim + containerd / nerdctl / runc） | 0.1.0 | 各组件许可证 | Windows WSL2 发行版 |
| 微信 Linux 版（可选，用户主动开启才下载） | 4.1.13.23 | 腾讯专有软件 | 个人微信渠道 |
| [Laya](https://github.com/NandhaKishorM/laya)（可选，用户点「一键安装」才装） | 0.4.8（PyPI `laya`） | Apache-2.0 | 本地判断模型（TypeSafe Jev `/v1/systemone` 分类器） |
| [laya-multilingual / laya-typed-decisions 权重](https://huggingface.co/convaiinnovations)（可选，随本地 Laya 下载） | revision `e4e9ddf2…` / `1a793eb5…`（pin SHA）；每个文件另有大小 + SHA256（大文件取 HF LFS oid），下载后校验通过才启用 | Apache-2.0 | 本地判断模型权重 |

## 助理电脑镜像（packages/sandbox-desktop，基于 debian:bookworm-slim）

通过 Debian 软件源安装，许可证见镜像内 `/usr/share/doc/*/copyright`：

| 组件 | 许可证 |
|---|---|
| [Chromium](https://www.chromium.org/) | BSD-3-Clause 等 |
| [Xvfb](https://www.x.org/)（X.Org）、xdotool、x11-utils | MIT/X11 等 |
| [x11vnc](https://github.com/LibVNC/x11vnc) | GPL-2.0 |
| [noVNC](https://github.com/novnc/noVNC) / [websockify](https://github.com/novnc/websockify) | MPL-2.0 / LGPL-3.0 |
| [Xfce](https://www.xfce.org/)（xfce4-session、xfwm4、xfdesktop4、panel、terminal、Thunar） | GPL-2.0 等 |
| [Noto CJK / Noto Color Emoji](https://github.com/notofonts) 字体 | SIL OFL 1.1 |
| [tini](https://github.com/krallin/tini) | MIT |
| ImageMagick、socat、at-spi2-core、curl 等 | 各自许可证 |

## 桌宠

- 精灵图格式与动画行（8x9 格、每格 192x208、各行帧数与时长）、孵化流程的做法（先定角色再出各个动作、去底后检查透明、按固定格子校验）、风格提示词要求：参考 [openai/skills `hatch-pet`](https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet)，Apache-2.0。我们没有复制它的脚本，`apps/web/src/pet/hatch.ts`、`scripts/pets/gen-presets.py` 是按它的规格自己写的。
- 点击穿透的思路（报告可点区域，按全局鼠标位置切换 `set_ignore_cursor_events`）：参考 [tauri-clickthrough-demo](https://github.com/Xinyu-Li-123/tauri-clickthrough-demo)，没有复制代码。
- 产品形态参考了 [CoPet](https://github.com/ChanceYu/CoPet)、[AgentPet](https://github.com/ntd4996/agentpet)、[UniPet](https://github.com/ydyangdan/UniPet)、[OpenPets](https://github.com/sergiobaiao/openpets)（均为 MIT），没有使用它们的代码和美术素材。
- 内置宠物喵喵、团子、小铁、啾啾是本项目用程序原创绘制的，和项目使用同样的许可。用户导入的第三方宠物包，许可由用户自己负责。社区里很多 Codex 宠物的美术素材是 CC BY-NC，不能商用。

## 其他

- [Docker](https://www.docker.com/) / [Podman](https://podman.io/)：Linux 上助理电脑使用用户自己安装的容器运行时，不随产品分发。
- [WSL](https://github.com/microsoft/WSL)：Windows 系统组件，由用户按需安装。
- 测试用：hoodiecrow-imap、smtp-server（MIT），不随产品分发。

## 本地语音识别（可选，用户自行导入 / 许可未闭环）

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（**Apache-2.0**）：本地 ASR 推理引擎，按需经 uv/pip 安装 `sherpa-onnx==1.13.8`（**不随产品分发**；轮子按平台 / CPython 版本分片，当前只 pin 版本号，未 pin 各轮子 SHA256）。
- [SenseVoiceSmall](https://github.com/FunAudioLLM/SenseVoice) 权重（**FunASR Model Open Source License Agreement v1.1，不是 Apache-2.0**）：**不随产品分发、不镜像**。许可适用范围未最终确认（官方 issue [#334](https://github.com/QwenAudio/SenseVoice/issues/334) 仍 open），因此安装入口默认关闭；用户可自行导入合法取得的权重。使用时须遵守 §2.2 署名与保留模型名要求（界面显示 `SenseVoiceSmall by FunASR / FunAudioLLM`）。复核记录见 `research/sensevoice-weight-license-review.md`。
- 参考项目（未复制代码）：[Handy](https://github.com/cjpais/handy)（MIT）的「独立 worker + 可配置 idle 卸载 + 首按先开麦」思路、[OpenWhispr](https://github.com/OpenWhispr/openwhispr)（MIT）的组件级 idle 超时。
