# 需求与计划（ROADMAP）

**一行一事**：`- [状态] 事项（设计 / 决策链接）`。状态：设计中 / 开发中 / 已完成(未打包) / 已发布(版本) / 待用户决定 / 暂缓。
新需求立刻记一行；做完改状态，不写长段落（细节写进设计文档，进度看提交信息）。2026-10-18 以前的长记录见 [history/ROADMAP-2026-10-18.md](history/ROADMAP-2026-10-18.md)。

## 进行中
- [开发中] 助理设置八个页面按效果图改造，模型页复用 ModelPicker（[0008](decisions/0008-agent-details-classic.md)）
- [已发布(beta.37)，待真机] 高级记忆健康：思考回传 / 关思考、重排序限 50 候选、两库并行召回、健康角标 + 通知、备用记忆模型、三步真实测试、每轮写入（[设计](design/memory-health.md)、[0009](decisions/0009-memory-reliability.md)）
- [已发布(beta.37)] 设置页按界面标准逐页改造（[界面标准](design/ui-standard.md)）
- [已发布(beta.37)] 中转服务详情单列重做：按模型自动识别协议、可按模型覆盖、测试全部模型
- [已发布(beta.37)] 项目规范化：AGENTS.md 唯一入口、MODULES.md、决策记录、`npm run check` 护栏（[0011](decisions/0011-project-standards.md)）

## 计划
- [已合 main] HTML / SVG 文件在应用内直接显示（像 Claude 一样渲染网页、可切源码；隔离运行）；Office 第二期（[设计](design/html-file-preview.md)、[0024](decisions/0024-html-preview-sandboxed.md)）
- [已发布(beta.42)] 本机编程命令行当模型：模型列表可选 Claude Code、Codex、Antigravity（实验性）的模型，用本机已登录的命令行，工具仍由 Pi 执行（审批、记忆、助理电脑照旧）；模型服务页每家一张检测卡片。第三期当帮手待做（[设计](design/cli-models.md)、[0023](decisions/0023-cli-agents.md)）
- [已发布(beta.37)] 群聊按「AI 团队」重做：先出方案、确认后按分工推进到交付，去掉自主推进开关；6 步全部做完（含单聊走方案），待打包实测（[设计](design/group-team.md)、[0019](decisions/0019-group-as-team.md)）
- [已发布(beta.38)] beta.37 实测问题修复：群里空名字行、管理者自己的任务停在「待安排」、交付文件发两遍、交付后重复一句话、一步跑太久没提示；加 `npm run dev:live` 用真实渠道开发实测（[0021](decisions/0021-dev-live-testing.md)）
- [已发布(beta.38)] 群聊第二轮实测打磨：分工名字后缀、「等你回答」状态、项目中不提技能、慢步骤提示不被挡、自己核验不重复叫醒、等用户时不兜底叫醒、自己收尾时停掉在做同一任务的帮手
- [已发布(beta.41)] 记忆修正（只查记忆 / 助理「已记下」不写入、召回去重、刚记的必能召回）；测试连接带工具；额度 / 限流 / 冷却报错带恢复时间的中文；备用记忆模型同渠道提醒
- [已发布(beta.40)] 聊天代码块右上角一键复制；点「N 人等你」/「等你审批」跳到要处理的卡片；往上翻时输入框上方出现「回到最新」按钮（带新消息数）
- [已发布(beta.39)] 助理工作状态：群顶部成员条每个成员显示在做什么（在群里回复 / 做任务「X」/ 等你审批 / 空闲），最左边群总状态（几人在干活 / 有人等你 / 都停下了）；单聊顶部名字下同样显示（[设计](design/group-team.md) §10）
- [已发布(beta.39)] 消息「引用」旁加「复制」按钮；右键改成程序自己的菜单（消息：复制 / 引用 / 另开新对话；其他地方：选了字给复制、链接给复制链接），所有复制统一走 `clipboard.ts`
- [已发布(beta.37)] 第 1 步「项目与方案」：room_plan / room_project_start / room_project_done、方案卡、项目面板
- [已发布(beta.37)] 第 2 步缩小为「去重复」：管理者被叫醒时看板没变只说没变化；不提前整理上下文、不截断工具输出（上下文按模型配置来，不为省钱降质量）
- [已发布(beta.37)] 第 3 步「任务依赖与自动交接」：依赖自动开始 + 交接单 + 文件、项目进度清单、验收「这条路走不通」、项目级卡住检测与改计划、停下后接着做
- [已发布(beta.37)] 第 4 步「成员直接协作」：干活中途找同事（回答送回手上）、一个问题 3 轮或 20 分钟没解决交给管理者、上游有问题由负责人决定重做、新版本自动交给下游、拿不准先对齐
- [已发布(beta.37)] 第 5 步：阶段完成通知（每阶段一次）、关键点确认卡（复用提问卡，项目显示「等你看一眼」）、交付卡（文件可预览，不谈花费）、群消息标明项目并可按项目筛选、失败通知说清原因和谁处理
- [已废弃，被 0019 取代] 目标清楚由导演自己开启推进、模糊先问、干完交付结果，不再要用户手动开或点确认卡（[0018](decisions/0018-manager-starts-autonomy.md)）
- [已发布(beta.36)] 群聊去掉每轮 token 预算、暂停不挡唤醒、自主推进开关放顶部且真能自己推进、派活附件真的交给负责人（[0017](decisions/0017-room-no-token-budget-autonomy.md)）
- [已发布(beta.36)] 文件卡片路径超出、「任务提交」卡片贴边并和系统提示叠在一起
- [已发布(beta.39)] 群成员读入越攒越多：唤醒消息去重复、交付时用户原话存进记忆、交付后读入超 15 万自动整理群会话（[设计](design/context-growth.md)、[0022](decisions/0022-tidy-after-delivery.md)）
- [已发布(beta.35)] 群任务卡住 / 反复退回由管理者自己处理，办法用尽才向用户说明需要什么帮助（[0016](decisions/0016-group-stuck-manager-handles.md)）
- [已发布(beta.37)] 主密钥读不到（钥匙串拒绝 / 锁着、DPAPI 解不开）时服务停下并说明原因，不再另造密钥覆盖（[0015](decisions/0015-master-key-never-overwrite.md)）
- [已发布(beta.37)，待真机] 桌面 App 里把文件拖到聊天框 = 点「上传」：主窗口关掉 Tauri 自带的拖放拦截，交给网页现有的拖放（e2e `chat-file-drop.mjs`）
- [已发布(beta.37)] 任务类机制合并：界面只用「任务 / 帮手」两个词，后台 / 定时 / 巡检 / 群任务执行都跑在帮手上，旧 `/api/tasks` 下线（[0014](decisions/0014-task-and-helper.md)、[设计](design/task-architecture-analysis.md)）
- [已发布(beta.37)] 群聊协作：管理者 + 自主模式 + 任务看板 + 三种卡住检测；单聊入口未接（[设计](design/group-collaboration.md)、[0006](decisions/0006-group-collaboration.md)）
- [已发布(beta.37)] 拆大文件：work-items.ts、rooms/index.ts（runtime.ts 已另行拆分）
- [已发布(beta.37)] 群任务不受人数上限影响、群停止不暂停任务
- [已发布(beta.37)] 本地语音识别改为可选模块：默认不装、启动不自动下载，设置 › 语音 里安装（[设计](design/local-voice-optional.md)、[0013](decisions/0013-local-voice-optional.md)）
- [已发布(beta.37)] Pi / Hindsight 不自动升级：删除自动升级工作流与 Renovate 规则，开发时手动跑升级脚本（[0012](decisions/0012-no-auto-upstream-updates.md)）
- [待用户决定] Hindsight 0.10.3 → 1.0.0（PyPI 已有，需开发时手动升级并测试）
- [待用户决定] 中文关键词搜索是否换能切分中文的方案

- [已发布(beta.37)] 新建助理加「全能培训师」模板：自动填人设，建好后启用内置技能「组建团队与入职强化」（team-onboarding），用来组建团队、培训其他助理

- [已发布(beta.37)] 单聊输入栏「技能」按钮换成「权限」按钮：直接看 / 切这个助理操作你电脑的档位（[0020](decisions/0020-composer-permission-button.md)）

## 待用户决定
- [待用户决定] 开源许可证（建议 MIT，还是暂不加）
- [待用户决定] 安装包签名：Apple 公证、Windows 代码签名（需要付费证书）
- [暂缓] Paseo 式共用中转远程访问

## 待真机验证
- Mac Lima / Windows WSL2 助理电脑、用户电脑 cua 控制、渠道真实账号（飞书/钉钉/企微/ClawBot）、Web Push、真实模型 Fast/计费、物理手机 / WebKit
