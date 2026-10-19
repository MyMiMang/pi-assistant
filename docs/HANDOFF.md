# 交接文档（HANDOFF）

只写**当前状态**，保持一屏到两屏。历史进度在 [history/HANDOFF-2026-10-18.md](history/HANDOFF-2026-10-18.md)，不要再往这里追加长段落。

## 当前版本（2026-10-19）
- 公开版：**v0.1.0-beta.32**（Latest）。main 上之后的改动均**未打包**。
- 未打包改动：助理/群成员详情经典布局与八页改造；输入框下去掉权限和主动程度按钮；设置页按界面标准改造；中转服务详情单列（按模型自动识别协议）；群成员改名即时刷新；代码清理（http.ts 拆到 routes/*、删 Laya 废代码）；项目规范化（AGENTS.md / MODULES.md / decisions / `npm run check`）。

## 正在做
- 助理设置八页实现（工作树 `agent-settings-redesign`）。高级记忆健康已合入（[设计](design/memory-health.md)），待真机验证。进度看 [ROADMAP.md](ROADMAP.md) 和提交信息。
- 群聊协作已实现（未打包，[设计](design/group-collaboration.md)）：任务由负责人派的帮手在它自己的任务会话里执行，管理者按事件唤醒，三种卡住检测，等你决定，停群不停任务；work-items / rooms 已拆到 600 行以下。单聊入口还没接（核心与来源无关，单聊只需在入口调 setWorkSourceProvider + workItemTools）。
- 任务类机制合并（[决策 0014](decisions/0014-task-and-helper.md)，[设计](design/task-architecture-analysis.md) §5.5 / §7，未打包）：6 步里做完 1–5 步，**第 6 步没做**。见下面「接手说明」。
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

**CI**：`fb63378`、`9643651` 的 ci 失败：单测里的 uvx 偶发（已由 `31cee03` 修）和 `e2e/run.mjs`「后台任务」那步等不到「后台任务：统计工作区文件」卡片（`7350689` 已在 `tasks.spawn` 补回卡片，**本地没跑完 run.mjs 验证**，先看 `7350689` 的 CI）。`npm run check` 本地 981 过 / 0 失败。

**还要做**
1. 第 6 步：界面上「子代理」改叫「帮手」（`apps/web/src` 约 70 处，大多在 `Subagents.tsx`、`Tasks.tsx`、`ChatMessages.tsx`、`MemoryTab.tsx`、`CustomProvider.tsx`）。注意 `Tasks.tsx` 里剥服务端前缀「（后台子代理任务）」的正则要同时认两个词；改完跑 `e2e/subagents.mjs` 等相关 e2e、截图。旧路由兼容层下线也在这一步。
2. 确认 `7350689` CI 全绿（尤其 `e2e/run.mjs`）。
3. 待用户决定：群看板「等你决定」仍会在反复退回 / 长时间没进展时问用户「换个方法 / 改派 / 暂停」，和第 3 步「只为用户才能给的东西找用户」的原则不一致，要不要改由用户定。
4. 可见性设置目前只有接口 `/api/settings/group-helper-detail`，没有界面。
5. 没在真机验证过：Web Push（真手机）、真实模型下的帮手嵌套 / 角色范围效果、Mac 上的整套行为。

**规矩（必须遵守）**
- 只在用户说「打包」时打包 / 发版；绝不在用户的 Mac 上安装或重启任何东西（只读）。
- 推送前 `git pull --rebase`，绝不 force-push、不改写历史；每步一个提交，提交信息一行简短中文。
- 不改 Pi SDK、Hindsight、node_modules 和依赖版本（要升级由人手动做）。
- 测试只用临时数据目录 + mock 模型，测试串行跑；不碰生产数据、真实付费模型、用户的 Chrome 配置和真实电脑驱动；仓库里不放密钥。
- 复用现有代码（见 MODULES.md 必须复用清单），界面遵守 UI 标准（AGENTS.md / design/settings-ia.md），单文件不超过 600 行（`npm run check:baseline` 收紧基线），新文件登记到 MODULES.md。
- 每次推送前 `npm run check` 必须通过。
- 只用中文回复用户。改架构前先画清楚现状和方案，等用户批准再动手。

**怎么跑**
- `export PATH=~/.nvm/versions/node/v22.23.3/bin:$PATH`（Node 22），`export CHROME=/usr/bin/google-chrome`。
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
