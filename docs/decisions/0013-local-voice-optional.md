# 0013 本地语音识别是可选模块
- 日期：2026-10-19
- 状态：有效
- 决定：本地语音识别（运行环境 + 模型）默认不安装、启动时不自动下载；用户在 设置 › 语音 › 本地 点「安装本地语音」（或在「下载与组件」里点下载）才装。云端语音不依赖它。
- 原因：用户要求把语音拆成可选模块；以前新用户首次启动会在后台自动下载约 290 MB。
- 补充（2026-10-19）：改为「先选再装」。模块卡里直接选模型（预选目录默认，每项一行适合什么 + 大约下载量，共享运行环境只算一次），「安装所选模型」只装这一个模型（+ 首次运行环境），装完设为语音来源（安装期间来源被改过则不覆盖）。安装窄接口接受目录 modelId（校验目录 / 平台，仍允许已配对手机），不另开接口；其他模型不再折叠。
- 不做什么：不随安装包内置权重 / 运行环境；不把 local-asr 代码做成插件；不再有「首次启动自动准备」。
- 影响：local-asr/service.ts、catalog.ts、routes.ts、default-voice-prep.ts、http.ts、ui.tsx（Select 的 desc）、DefaultVoicePrep.tsx、LocalAsrModels.tsx、scripts/stage-app.mjs；设计 design/local-voice-optional.md（取代 default-local-voice §4–§5、default-stream-contract §1.2 的自动准备）。
