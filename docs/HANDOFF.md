# 交接文档（HANDOFF）

只写**当前状态**，保持一屏到两屏。历史进度在 [history/HANDOFF-2026-10-18.md](history/HANDOFF-2026-10-18.md)，不要再往这里追加长段落。

## 当前版本（2026-10-19）
- 公开版：**v0.1.0-beta.32**（Latest）。main 上之后的改动均**未打包**。
- 未打包改动：助理/群成员详情经典布局与八页改造；输入框下去掉权限和主动程度按钮；设置页按界面标准改造；中转服务详情单列（按模型自动识别协议）；群成员改名即时刷新；代码清理（http.ts 拆到 routes/*、删 Laya 废代码）；项目规范化（AGENTS.md / MODULES.md / decisions / `npm run check`）。

## 正在做
- 助理设置八页实现（工作树 `agent-settings-redesign`）。高级记忆健康已合入（[设计](design/memory-health.md)），待真机验证。进度看 [ROADMAP.md](ROADMAP.md) 和提交信息。
- 群聊协作已实现（未打包，[设计](design/group-collaboration.md)）：任务在负责人自己的会话里执行，管理者按事件唤醒，三种卡住检测，等你决定，停群不停任务；work-items / rooms 已拆到 600 行以下。单聊入口还没接（核心与来源无关，单聊只需在入口调 setWorkSourceProvider + workItemTools）。
- 任务类机制合并（[决策 0014](decisions/0014-task-and-helper.md)，[设计](design/task-architecture-analysis.md) §7 看进度，未打包）：后台任务（含定时 / 巡检）重启已和子代理同一套判定，结果未知的标「中断待核验」等人点继续。
- 本地语音已改为可选模块（[设计](design/local-voice-optional.md)，未打包）。

## 交付标准
见 [AGENTS.md](../AGENTS.md)「交付清单」。偶发 `deserialize cloned data` 是测试运行器 IPC 抖动，单独重跑该文件确认。

## 待真机 / 待用户
- 真机：Mac Lima / Windows WSL2 助理电脑、用户电脑 cua 控制、渠道真实账号（飞书/钉钉/企业微信/ClawBot）、Web Push、真实模型 Fast/计费、物理手机 / WebKit。
- 待用户决定：许可证（建议 MIT）、代码签名证书、Paseo 式共用中转（暂缓）。完整清单见 [ROADMAP.md](ROADMAP.md)。

## 已知问题 / 限制
- **Windows 日志位置**：托盘和服务日志在 `%LOCALAPPDATA%\com.piassistant.app\logs\server.log`（超过 5MB 轮转为 `server.old.log`）；数据目录 `%APPDATA%\Pi Assistant`。macOS：`~/Library/Logs/com.piassistant.app/server.log`。
- 端口被占改用 8788… 时，网页的本地偏好（布局、语言，存在浏览器 localStorage，按端口区分）会回到默认；本机访问不需要登录，所以不会掉登录。端口记在配置目录 `port.txt`，之后一直用同一个。
- 安装包**没有签名**：macOS 第一次打开要右键选「打开」，Windows 会有 SmartScreen 提示（§5.2）。
- 群聊：复制群专属助理时不会复制它工作区里的文件。管理者派活做得好不好，取决于用的是什么模型。
- 附件：单个文件上限 100MB；文档摘录最多约 2 万 token；扫描版 PDF 不做 OCR。
- cua-driver 已升级到 0.35.4（host 侧 `third-party.json`；助理电脑镜像 `0.1.4`，digest `sha256:6cc5c119…d54a42`）。0.35.0 是 breaking change，适配点见本文 2026-10-22「CUA 0.34.1 → 0.35.4 适配」一条。以后再升级要重新核对 BROWSER.md、WORKFLOW.md 和工具参数格式。
- macOS 系统沙箱档没做。MCP 服务器经 npx 第一次下载时没有字节进度。
- Hindsight 运行环境 / 向量模型的下载百分比是估算的。远程 Hindsight 换不同维度的向量模型时，要对方实例自己迁移。
- 共用中转远程访问（Paseo 式）用户决定暂缓（§15.1）。


## 代码地图
见 [MODULES.md](MODULES.md)（每个文件负责什么 + 必须复用的共用工具清单）。

## 真机测试步骤
见 [history/HANDOFF-2026-10-18.md](history/HANDOFF-2026-10-18.md) 第 8 节。
