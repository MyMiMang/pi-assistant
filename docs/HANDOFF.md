# 交接文档（HANDOFF）

只写**当前状态**，保持一屏到两屏。历史进度在 [history/HANDOFF-2026-10-18.md](history/HANDOFF-2026-10-18.md)，不要再往这里追加长段落。

## 当前版本（2026-10-20）
- 公开版：**v0.1.0-beta.34**（Latest，2026-10-20 08:20 北京时间）。五平台构建、Mac/Windows 安装冒烟通过，13 项资产和 latest.json（darwin-aarch64 / darwin-x86_64 / windows-x86_64）已核对。说明见 [release-notes/v0.1.0-beta.34.md](release-notes/v0.1.0-beta.34.md)。
- 这次 Intel Mac 那一路第一次失败在上传：tauri-action 删旧资产时和别的平台并发撞车（`Not Found - delete-a-release-asset`），构建本身成功；`gh run rerun <id> --failed` 只重跑这一路后全部通过。以后再遇到同样报错先重跑。
- beta.33（2026-10-19 04:07）之前已发布；之前这里写的「公开版 beta.32」是过时的。
- beta.34 之后未打包：群任务卡住由管理者自己处理（决策 0016）。

## 正在做
- 助理设置八页实现（工作树 `agent-settings-redesign`）。高级记忆健康已合入（[设计](design/memory-health.md)），待真机验证。进度看 [ROADMAP.md](ROADMAP.md) 和提交信息。
- 群聊协作已实现（未打包，[设计](design/group-collaboration.md)）：任务由负责人派的帮手在它自己的任务会话里执行，管理者按事件唤醒，三种卡住检测，等你决定，停群不停任务；work-items / rooms 已拆到 600 行以下。单聊入口还没接（核心与来源无关，单聊只需在入口调 setWorkSourceProvider + workItemTools）。
- 任务类机制合并（[决策 0014](decisions/0014-task-and-helper.md)，[设计](design/task-architecture-analysis.md) §5.5 / §7，未打包）：6 步全部做完（第 6 步：界面改名 + 旧 `/api/tasks` 下线）。剩余事项见下面「接手说明」。
- 本地语音已改为可选模块（[设计](design/local-voice-optional.md)，未打包）。

## 接手说明（2026-10-19，给接手的 AI）
**最近提交（main，都已推送）**
- `51acf88` 第 1 步：建会话合成 `createAgentSession`，前端状态词一张表。
- `04695e5` 第 2 步：后台任务重启加安全判定（不安全标「中断待核验」）。
- `b047144` 第 3 步：卡住检测共用规则 `stuck.ts`。
- `fb63378` 第 4 步：后台 / 定时 / 巡检的每次运行都是帮手（subagents.kind），旧 tasks 表启动时迁移。
- `9643651` 第 3 步按用户反馈重做：卡住由主会话自己解决（先诊断、按阶梯处理），只为批准 / 凭据找用户，删掉「继续等 / 停止」卡片；加派帮手成本规则。
- `31cee03` 修 `downloads.ts` 统计时临时文件被删导致的偶发崩溃（CI 里 uvx MCP 测试）。
- `7350689` 第 5 步：群任务执行跑在负责人的帮手上（kind=work）；帮手最多再派一层（上一层等下一层并整合）；群角色范围自动写进帮手规则（`helper-scope.ts`）；可见性设置 `groupHelperDetail`（默认 owner = 派它的助理 + 用户能看完整步骤，群里只看概况和结果）；核验通过后执行记忆草稿自动转正。顺带恢复了后台任务的聊天卡片（第 4 步后丢了）。
- 第 6 步（两个提交）：① 界面上「子代理」改叫「帮手」（帮手详情、执行概览、帮手模型 / 候选池 / 任务上限、工具步骤名、记忆来源、删除服务提示），`taskTitle` 去前缀两个词都认，e2e 选择器同步。② 旧兼容层下线：删 `GET /api/agents/:id/tasks`、`/api/tasks/:id/{messages,cancel,resume}`、`tasks.list/cancel/resume`、`getTask` 和 `task.updated` 事件；前端「后台任务」列表改读 `/api/subagents?agent=` 并听 `subagent.updated`（只取 kind=task/routine），聊天里后台任务卡片的取消 / 继续改调 `/api/subagents/:id/stop|resume`（旧任务迁移时 id 没变，老卡片照样能用）。

**CI**：`7350689` 的 ci 只有 Intel Mac 的 Lima 测试下载失败（`fetch failed`，网络偶发）；紧接着的 `420fe5b`（只改文档）ci 全绿，含 `e2e/run.mjs` 后台任务那步。

**还要做**
1. 模型对用户也说「帮手」已按用户决定做完（决策 0014 补充）：给模型看的文字全改，事件标记新旧都认；Mock 的假台词和触发词（「派个子代理」「子代理回报」）没改，e2e 依赖它们。
2. 测试不再碰 Mac 钥匙串：直接启动 `src/main.ts` 的 13 个 e2e、`server-setup.test.ts` 和 3 个 smoke 改走 `test/launch-memory.ts`（之前在 Mac 上会用真实 App 的钥匙串主密钥，曾差点用 `-U` 覆盖，已拦下，条目未改）。待做：规范检查加一条「测试禁止直接启动 src/main.ts」；主密钥读不到时停下、不覆盖已按用户决定做完（[0015](decisions/0015-master-key-never-overwrite.md)；单测 + 假 `security` 实启 `main.ts` 演练过，真机 Mac / Windows 未验证）；单测 `setup.ts` 在 PATH 上放假的 `security`。
2b. 原来就失败的 e2e：`subagent-composer-navigation.mjs` 已修（只取档位刻度，Fast 开关不是档位）；`send-shortcut-ui.mjs` 第 3 步偶发等不到主会话发送键，复跑两次都过，原因未查明；`file-preview.mjs` 手机 390 宽时预览框量到 388.8（像进场动画没走完），待查。
3. 拖文件到聊天框：`main.rs` 那一行没在本地编译过（Mac 没装 Rust，CI 不编译桌面程序），下次打包时 release 构建才会编译；装好新版后要在 Mac / Windows 上真拖一次确认。
4. 群任务卡住 / 反复退回改由管理者自己处理已按用户决定做完（[0016](decisions/0016-group-stuck-manager-handles.md)，未打包）；真实模型下管理者会不会按规则换做法、向用户说明得清不清楚，待真机。
5. 群里帮手查看方式已按用户决定改完：没有开关，别的成员列表只看概况、点名查看完整过程（决策 0014 补充）。
6. 没在真机验证过：Web Push（真手机）、真实模型下的帮手嵌套 / 角色范围效果、Mac 上的整套行为。

**规矩（必须遵守）**
- 只在用户说「打包」时打包 / 发版；绝不在用户的 Mac 上安装或重启任何东西（只读）。
- 推送前 `git pull --rebase`，绝不 force-push、不改写历史；每步一个提交，提交信息一行简短中文。
- 不改 Pi SDK、Hindsight、node_modules 和依赖版本（要升级由人手动做）。
- 测试只用临时数据目录 + mock 模型，测试串行跑；不碰生产数据、真实付费模型、用户的 Chrome 配置和真实电脑驱动；仓库里不放密钥。
- 复用现有代码（见 MODULES.md 必须复用清单），界面遵守 UI 标准（AGENTS.md / design/settings-ia.md），单文件不超过 600 行（`npm run check:baseline` 收紧基线），新文件登记到 MODULES.md。
- 每次推送前 `npm run check` 必须通过。
- 只用中文回复用户。改架构前先画清楚现状和方案，等用户批准再动手。

**怎么跑**
- Linux 开发机：`export PATH=~/.nvm/versions/node/v22.23.3/bin:$PATH`（Node 22），`export CHROME=/usr/bin/google-chrome`。
- 用户的 Mac（`~/Documents/AI/pi-assistant`）：用已装的 Homebrew Node 24（`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`），e2e 默认用 /Applications 里的 Chrome（无头、临时配置），跑时加 `HOME=$(mktemp -d)`；Mac 没有 `timeout` 命令。用户装的 App 占着 8787，e2e 都用随机端口。
- 全量：`npm run check`；只做静态检查：`npm run check:static`。
- 单个单测（在 `packages/server` 里）：`node --import tsx --import ./test/setup.ts --test test/X.test.ts`。
- e2e：先 `npm run build -w @pi-assistant/web`，再 `node e2e/X.mjs`（整套：`npm run e2e`）。
- 截图放 `artifacts/screenshots/`（第 5 步：`group-helpers-overview.png`、`group-helpers-detail.png`）。

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
