# beta.27 最终主审验证

2026-10-16，主会话接手停滞的整合子任务，保留已完成 merge f2bc1a3（SenseVoice a12be8f），祖先包含 Laya 0630693、权限按钮 7ec7169、真实 Laya 启动修复 e60d63d。未重做合并，未重复下载真实权重。

## 独立实跑

- Node v24.19.0；两端 typecheck、web build 通过。
- 前端逻辑 local-asr-models-frontend：6/6。
- 服务端 local-asr-license/deps/multimodel、local-laya-deps/verify-hf/local-laya、voice-source-http：87/87，零失败零跳过。进程外显式临时 DATA/WORKSPACE/HOME、OFFLINE，并预加载 test/setup.ts。
- local-asr-models-ui：全部通过，包含 SenseVoice 原列表位置、一键安装、无多余同意框、导入保留、进度、取消、错误重试、来源状态及390宽度。
- settings-usability-ui：全部通过，含桌面/390真实滚动、不遮提示、review/ack/确认流程。
- 首次将类型/构建/界面合为一条命令，工具60秒总时限中断在ASR UI第2段；随后单独运行完整ASR UI通过。此中断不计成功，也不当成产品故障。

## 真实运行证据复核

- Laya evidence/local-laya-real-smoke/report-2026-10-16T11-25-59.json：固定权重大小/SHA、health loaded multilingual、MPS、一次分类 choice alpha、stop/pidReleased。该次安装5秒是缓存复跑，不是首次下载时长；低confidence不作质量结论。
- SenseVoice evidence/local-asr-real-smoke/report-2026-10-16T11-27-18.json：239549735B权重、SHA与pin一致、health modelId sensevoice-small-int8、中文结果“开饭时间早上9点至下午5点。”、pidReleased。该report安装0秒是缓存复跑，首次下载记录另见sensevoice-2026-10-16.md。
- 没有在用户App上测试、未改真实用户缓存、未做跨平台实机/麦克风全链路。

## 发布准备

远端main核验为476e73a，v0.1.0-beta.27尚不存在。范围沿用mac-arm64，用户已有完成验证后直接推送打包授权；主会话普通push、新建tag，不改旧tag。CI与公开latest.json独立核验后才标已公开。
