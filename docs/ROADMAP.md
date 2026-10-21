# 需求与计划（ROADMAP）

**一行一事**：`- [状态] 事项（设计 / 决策链接）`。状态：设计中 / 开发中 / 已完成(未打包) / 已发布(版本) / 待用户决定 / 暂缓。
新需求立刻记一行；做完改状态，不写长段落（细节写进设计文档，进度看提交信息）。2026-10-18 以前的长记录见 [history/ROADMAP-2026-10-18.md](history/ROADMAP-2026-10-18.md)。

## 进行中
- [开发中] 助理设置八个页面按效果图改造，模型页复用 ModelPicker（[0008](decisions/0008-agent-details-classic.md)）
- [已完成(未打包)，待真机] 高级记忆健康：思考回传 / 关思考、重排序限 50 候选、两库并行召回、健康角标 + 通知、备用记忆模型、三步真实测试、每轮写入（[设计](design/memory-health.md)、[0009](decisions/0009-memory-reliability.md)）
- [已完成(未打包)] 设置页按界面标准逐页改造（[界面标准](design/ui-standard.md)）
- [已完成(未打包)] 中转服务详情单列重做：按模型自动识别协议、可按模型覆盖、测试全部模型
- [已完成(未打包)] 项目规范化：AGENTS.md 唯一入口、MODULES.md、决策记录、`npm run check` 护栏（[0011](decisions/0011-project-standards.md)）

## 计划
- [已完成(未打包)] 目标清楚由导演自己开启推进、模糊先问、干完交付结果，不再要用户手动开或点确认卡（[0018](decisions/0018-manager-starts-autonomy.md)）
- [已发布(beta.36)] 群聊去掉每轮 token 预算、暂停不挡唤醒、自主推进开关放顶部且真能自己推进、派活附件真的交给负责人（[0017](decisions/0017-room-no-token-budget-autonomy.md)）
- [已发布(beta.36)] 文件卡片路径超出、「任务提交」卡片贴边并和系统提示叠在一起
- [计划] 群成员每次调用读入 20–37 万 token：会话历史越攒越长，查清后单独给方案
- [已发布(beta.35)] 群任务卡住 / 反复退回由管理者自己处理，办法用尽才向用户说明需要什么帮助（[0016](decisions/0016-group-stuck-manager-handles.md)）
- [已完成(未打包)] 主密钥读不到（钥匙串拒绝 / 锁着、DPAPI 解不开）时服务停下并说明原因，不再另造密钥覆盖（[0015](decisions/0015-master-key-never-overwrite.md)）
- [已完成(未打包)，待真机] 桌面 App 里把文件拖到聊天框 = 点「上传」：主窗口关掉 Tauri 自带的拖放拦截，交给网页现有的拖放（e2e `chat-file-drop.mjs`）
- [已完成(未打包)] 任务类机制合并：界面只用「任务 / 帮手」两个词，后台 / 定时 / 巡检 / 群任务执行都跑在帮手上，旧 `/api/tasks` 下线（[0014](decisions/0014-task-and-helper.md)、[设计](design/task-architecture-analysis.md)）
- [已完成(未打包)] 群聊协作：管理者 + 自主模式 + 任务看板 + 三种卡住检测；单聊入口未接（[设计](design/group-collaboration.md)、[0006](decisions/0006-group-collaboration.md)）
- [已完成(未打包)] 拆大文件：work-items.ts、rooms/index.ts（runtime.ts 已另行拆分）
- [已完成(未打包)] 群任务不受人数上限影响、群停止不暂停任务
- [已完成(未打包)] 本地语音识别改为可选模块：默认不装、启动不自动下载，设置 › 语音 里安装（[设计](design/local-voice-optional.md)、[0013](decisions/0013-local-voice-optional.md)）
- [已完成(未打包)] Pi / Hindsight 不自动升级：删除自动升级工作流与 Renovate 规则，开发时手动跑升级脚本（[0012](decisions/0012-no-auto-upstream-updates.md)）
- [待用户决定] Hindsight 0.10.3 → 1.0.0（PyPI 已有，需开发时手动升级并测试）
- [待用户决定] 中文关键词搜索是否换能切分中文的方案

## 待用户决定
- [待用户决定] 开源许可证（建议 MIT，还是暂不加）
- [待用户决定] 安装包签名：Apple 公证、Windows 代码签名（需要付费证书）
- [暂缓] Paseo 式共用中转远程访问

## 待真机验证
- Mac Lima / Windows WSL2 助理电脑、用户电脑 cua 控制、渠道真实账号（飞书/钉钉/企微/ClawBot）、Web Push、真实模型 Fast/计费、物理手机 / WebKit
