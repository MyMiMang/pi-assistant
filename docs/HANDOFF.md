# 交接文档（HANDOFF）

只写**当前状态**，保持一屏到两屏。历史进度在 [history/HANDOFF-2026-10-18.md](history/HANDOFF-2026-10-18.md)，不要再往这里追加长段落。

## 当前状态（2026-10-18）
- 公开版：**v0.1.0-beta.32**（Latest）。main 上之后的改动均**未打包**。
- 未打包改动：助理/群成员详情经典布局（八分类、64px 居中头像、单行标签 + 更多）；群成员改名/改头像后群里即时刷新（`e2e/room-member-rename-ui.mjs`）；代码清理（见下）。
- 高级记忆健康（未打包）：思考回传 / 关思考、重排序限 50 候选、健康角标 + 通知、备用记忆模型、三步测试、每轮自动写入、每周跟进 Hindsight 上游（`design/memory-health.md`）。待真机验证。
- 清理进度：已完成 主题测试/档位统一、artifacts+精简文档、拆 http.ts（2004→277 行，routes/*）、Pi 边界去 as never、群聊上限与改名刷新修复。未做：Subagents.tsx 简化（会改失败提示行为，待用户确认）、语音/本地ASR/Laya 挪包（牵涉打包，待确认）、拆 runtime/work-items/rooms 与群任务钩子化（见 [群聊协作设计](design/group-collaboration.md)）。

## 交付标准（Definition of Done）
1. `npm run typecheck` 通过。
2. 改动涉及的单测通过；动了服务端就跑 `npm test`（全绿，偶发 `deserialize cloned data` 是测试运行器 IPC 抖动，单独重跑该文件确认）。
3. 跑**与改动相关**的 e2e（`e2e/*.mjs`，用 `fixtures/temp-server.mjs` 的临时数据 + Mock）。不跑全量矩阵、不重复跑多轮。
4. 截图/日志写 `artifacts/`（已 gitignore），不入库；需要给用户看的截图直接发给用户。
5. 在本文件「当前状态」改一两行；ROADMAP 改状态。不写长篇进度记录、不新建 progress-snapshot / evidence 目录。

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
