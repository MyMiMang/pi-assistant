# 交接文档（HANDOFF）

只写**当前状态**，保持一屏到两屏。历史进度在 [history/HANDOFF-2026-10-18.md](history/HANDOFF-2026-10-18.md)，不要再往这里追加长段落。

## 当前版本（2026-10-20）
- 公开版：**v0.1.0-beta.39**（Latest，2026-10-23 16:39 北京时间）。五平台构建、Mac/Windows 安装冒烟一次通过，13 项资产和 latest.json（Mac 两种芯片、Windows 都有签名）已核对。说明见 [release-notes/v0.1.0-beta.39.md](release-notes/v0.1.0-beta.39.md)；之前 beta.38（10-23 10:34）、beta.37（10-22 22:14）。main 上 beta.39 之后没有未打包的改动。
- 发布小坑：Intel Mac 那一路偶尔在上传时和别的平台并发撞车（`Not Found - delete-a-release-asset`），构建本身成功；`gh run rerun <id> --failed` 只重跑这一路即可（beta.34 遇到过，beta.35 没遇到）。
- 已随 beta.37 发布：群聊按「AI 团队」重做第 1 步「项目与方案」（[决策 0019](decisions/0019-group-as-team.md)，取代决策 0018 的「自主推进」开关）：管理者先立项出方案卡（room_plan），用户确认（按钮或群里说「可以」→ room_project_start）后项目才开始，进行中可改方案、完成用 room_project_done、用户可随时停下；服务端 + 界面都已实现。真实模型下方案质量 / 按方案推进得怎样，待真机。第 2 步只做了「看板没变不重复发」。第 3 步已实现：任务依赖（after / stage）、前置核验通过后自动开始并带交接单和文件、项目进度清单（面板 + chip「阶段 n/m」）、验收第三种结果「这条路走不通」、项目级卡住计数（只认提交和完成为进展，到 3 要求 room_project_replan，改过 2 次再卡就报告用户）、停下后 room_project_resume / 「接着做」。第 4 步已实现：任务会话里 ask_colleague 找同事（群里可见，回答直接送回提问者正在跑的执行，没在跑就带着回答重新开始）、answer_colleague、report_upstream + work_rework（只有上游负责人能决定重做，重新通过后新版本自动交给下游）、3 轮 / 20 分钟交给管理者；任务执行说明里带群成员名单；协作工具免审批。第 5 步已实现：阶段完成通知、room_checkpoint 关键点卡片、交付卡、消息带 projectId 与按项目筛选。方案有关键点时，阶段完成后下一阶段任务先暂缓（rooms/hold.ts），管理者回合结束且没有关键点卡片在等用户才放行。group-collab-ui 之前一次中途报错，推测是旧 [G2] 手动 pause 撞上非法状态，已删掉那段，之后连跑三次都通过。第 6 步已实现：单聊遇到多步骤大事也出方案卡 → 确认 → 阶段进度 → 交付卡（`chat-projects/`）；清理了旧自主推进、提问气泡重复的 @X、工具回答后多发的短话、Mock「可以」确认不稳定（断言已改回严格）；临时服务器和单测会去掉继承的模型密钥环境变量。6 步全部做完，待用户说「打包」后真机实测。新建助理加了「全能培训师」模板（启用内置技能 team-onboarding）。单聊输入栏「技能」按钮换成了「权限」按钮（决策 0020）。

## 正在做
- 已随 beta.38 发布：beta.37 真机实测发现的群聊问题：群里不再出只有名字的空行；管理者自己负责、直接做完的任务能用 work_verify 收尾，有任务没收尾不让 room_project_done；交付卡带文件，不再先逐个 deliver_file；交付后不再补一句重复的话（项目结束后排着的阶段提醒作废，不再叫醒管理者）；一步跑超过 1 分钟时提示可能在等系统权限弹窗。都在 dev:live 用真实模型 + 测试助理验证过（[决策 0021](decisions/0021-dev-live-testing.md)）。
- 已随 beta.38 发布：第二轮实测打磨：分工名字带「（管理者）」或 @ 也认得出；群顶部「等你回答」和「等待审批」分开；项目进行中不弹「存成技能？」，技能提议内部轮模型多说的话不留；单聊运行中状态条下的「已经 1 分钟」提示不再被输入框挡住；管理者自己核验让阶段完成时提醒随核验结果回给它，不另叫醒；在等用户回答关键点 / 提问 / 审批时不兜底叫醒管理者（免得把「等你回复」说好几遍）；管理者自己直接收尾任务时停掉还在做同一任务的帮手。除「停掉帮手」只有单测外，其余都在 dev:live 用真实模型验证过。
- 已随 beta.39 发布：群项目交付后自动整理群会话（决策 0022，[设计](design/context-growth.md)）：唤醒消息不再重复群规则；交付时用户原话写进管理者记忆（只对 Hindsight 生效）；交付后读入超 15 万时整理，小结带真实项目状态和用户原话，群规则写明已交付项目。dev:live 用真实模型实测过三次整理和「上次那件事 / 上次那份 / 上次口味」。
- 已随 beta.39 发布：助理工作状态：群成员条每人一个状态（在群里回复 / 做任务「X」/ 等你审批 / 空闲）+ 最左群总状态（全停下明说「都停下了」），单聊顶部名字下同样一行；`member-status.ts` + `MemberStatus.tsx`，e2e `room-member-status-ui`。没在真实模型 / 真机上看过。
- 已随 beta.39 发布：每条消息加「复制」按钮；右键不再弹浏览器自带菜单，改成程序自己的（`ContextMenu.tsx`）；所有复制统一走 `clipboard.ts`（手机局域网 http 也能复制）。message-replies-ui e2e 通过；桌面程序（Tauri）里的右键还没真机看过。
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
2b. 原来就失败的 e2e：`subagent-composer-navigation.mjs` 已修（只取档位刻度，Fast 开关不是档位）；`send-shortcut-ui.mjs` 第 3 步偶发等不到主会话发送键，复跑两次都过，原因未查明；`file-preview.mjs` 手机 390 宽时预览框量到 388.8（像进场动画没走完），待查。`voice-input-ui.mjs`「配置 ASR：录音 → 停止」偶发等不到停止键（2026-10-20 子代理连跑两次失败，主会话在同一份代码上连跑两次都过，改动前也过，判为时机偶发）；`run.mjs`「首次运行向导」在 Mac 上等不到密码输入框，还没在改动前的代码上对照，待查。`room-member-model-settings-ui.mjs`「按两个已配置服务分组」断言失败，在第 1 步改动前的代码上同样失败（2026-10-22 对照过），待查。
3. 拖文件到聊天框：`main.rs` 那一行没在本地编译过（Mac 没装 Rust，CI 不编译桌面程序），下次打包时 release 构建才会编译；装好新版后要在 Mac / Windows 上真拖一次确认。
4. 群任务卡住 / 反复退回改由管理者自己处理已按用户决定做完（[0016](decisions/0016-group-stuck-manager-handles.md)，已发布 beta.35）；真实模型下管理者会不会按规则换做法、向用户说明得清不清楚，待真机。
5. 群里帮手查看方式已按用户决定改完：没有开关，别的成员列表只看概况、点名查看完整过程（决策 0014 补充）。
6. 群成员每次调用读入 20–37 万 token（2026-10-20 只读查看用户真实数据：导演当天 213 次调用、平均 23.5 万，靠缓存命中压着花费），会话历史越攒越长，要单独查清给方案；那个群里两个分镜任务的负责人都是导演自己，没交给「分镜」成员，原因待看；同一次派活在 work_item_runs 里出现 3 条相同 run（服务端子代理在测试里看到），待查。
7. 没在真机验证过：Web Push（真手机）、真实模型下的帮手嵌套 / 角色范围效果、Mac 上的整套行为。

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
