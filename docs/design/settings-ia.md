# 设置信息架构（IA）重排：只读审计 + 可实施方案

> **实施修订（2026-10-16，主确认后）——本文件正文的导航与子代理部分以此修订为准：**
> 1. **不新增「后台任务」页**（避免多一个 tab 添乱）：子代理的并发 / 最长运行改为**每助理覆盖**（补在 InfoPane › 设置 › 子代理模型里，缺省继承旧全局默认值），`GET/PUT /api/agents/:id/subagents/settings` 返回 `{settings, overrides, defaults}`；从「模型」页移除旧 `SubagentSection`，**不**建新全局页。
> 2. **不合并 `entry` / `downloads`**（不是用户明确的主要问题，防功能丢失）：两个旧 key 与页面原样保留。
> 3. 导航因此为 **5 组 / 16 项**（原 15 项 + 新增 `voice`）：模型与语音 / 电脑 / 助理能力 / 连接 / 偏好与系统；桌面显分组标题，手机保持横向滚动，不造双重 nav。
> 4. 实施分支 `settings-functional-ui`（基 `a80b2cb`）：前端已完成，后端 `source` / per-agent `subagents/settings` 接口由后端 owner 独立树提供。

### 实施结果（前端 `settings-functional-ui`，后端已合 `fa20815`）

- 已改（apps/web）：`Settings.tsx`（16 项 / 5 组导航 + `voice` 页 + `model` 别名 + 移除模型页子代理区）、`VoiceSettings.tsx`★新、`ModelServices.tsx`（移除 Laya/SenseVoice 卡、ASR 改为「声明」文案、导出 `LocalLayaSection`）、`HostControl.tsx`（接入 Laya）、`DesktopSettings.tsx`（Laya 跳转提示）、`Subagents.tsx`（每助理任务上限）、`ui.tsx`（Help 键盘）、`useVoiceInput.ts`（显式来源 + `dismissError`/`resetContext`）、`VoiceInput.tsx`（去设置→voice 且真清 error）、`api.ts`（冻结 DTO；不再用 `listAsrModels`）。
- 已实施要点：语音来源 `GET/PUT /api/audio/asr/source` 返回 `{source, options[]}`，`availability` 全由后端给（`ready/not_configured/not_installed/not_running/deleted`）；只有 `ready` 或本地 `not_running`（靠录音租赁按需加载）可录，未安装/已删除 0 录音、不回落云端；子代理 `GET/PUT /api/agents/:id/subagents/settings`，缺省/`null` 继承旧全局默认。
- 已跑：web `tsc` + `vite build`；`e2e/settings-functional-ui.mjs`、`e2e/settings-subagent.mjs`（24 项）、`e2e/voice-input-ui.mjs` 全通过；server `tsc` + `voice-source-http` 8 + `subagent-limits-http` 3 + `subagent-limits` 3 = 14/14。
- **未验**：真机麦克风 / 真实云 ASR 计费 / 本地 SenseVoice 实装 / 全量 e2e；截图见 `evidence/settings-functional-ui`、`evidence/settings-subagent`。

#### 视觉精简复核（2026-10-16 第二轮，用户对第一版截图说「还是密集说明」）

用户明确「常规说明都进 Help，别满屏」。定稿（`release-candidate-validation` 候选树，合并前端 `settings-functional-ui` `f566226` 后小改）：

- **语音本地卡**：标题「本地语音识别（SenseVoice） ?」+ `本地` badge + **单一状态 badge**（安装态与运行态合并，不再同时出现「未安装 / 未运行」）；许可被阻塞时主行只有一句 **「许可待确认，暂不提供下载」** + 「?」（完整条款 / 限制 / 链接 / 署名都在 Help 里，许可信息不藏、不折叠遮盖）；主操作按条件渲染（禁用短按钮「下载」+ title 原因；许可 `cleared` 时才显示同意 checkbox + 「下载并安装」——不可绕过的同意不省）；**「导入已有权重」收进可访问折叠**（目录输入与导入动作只在展开里，后端安全路径 API 不变）；规格 / 版本 / 容量 / 采样率 / 渠道 / 许可署名 / 未实测说明收进「详情」折叠；「设为语音来源」按钮从「使用本地语音识别（SenseVoice）」缩短。
- **模型页**：`DefaultModelPicker` 加 `compact`（去掉与按钮文字重复的「当前：…」和不必要的档位说明行，说明并入标题 Help）；`ModelServicesPanel` 底部「生图与快速操作模型统一在这里…」灰字收进 `Fold.desc`（Help）。
- **Laya 卡**：平台 / 来源 / 许可 / 未实测说明同样收进「详情」折叠；不支持原因常驻可见；状态与主操作保留。
- **不新增导航项**（16 项 / 5 组不变）；不改后端契约、不隐式安装 / 启动。

验证：`e2e/settings-functional-ui.mjs`（新增紧凑 DOM 断言：默认不出现长规格 / 目录输入 / 安全 checkbox；「未安装」卡内只出现一次；详情展开可看完整信息；模型页无「当前：」/ footer 正文）、`e2e/voice-input-ui.mjs`、`e2e/model-services-ui.mjs`（Laya 用例改到「操作这台电脑」页）全通过；真实 server 闭环 `e2e/voice-source-live.mjs` 全通过；server 相关 126/126。

- 基线：`release-candidate-validation` 候选树 **HEAD `a80b2cb`**（Pi 1.3 已合入；代码 checkpoint `0069d36`，其后 2 个纯文档提交）。**本方案不改任何业务代码**，只做审计 + 设计 + 文件范围。
- 约束：不碰该树的 WIP/未提交改动；不改 `packages/server/src/secrets.ts`、SDK 凭据实现、真实 keys/DB/钥匙串/用户 session；不改 Pi SDK / node_modules / Pi 本体。
- 用户原话要点（2026-10-16）：
  1. 模型页只放**在线模型服务**（地址 / Key / 可提供 chat / vision / image / classifier / ASR 的**能力声明**），业务选择参数不塞进模型页；
  2. 新增独立**语音配置**页：云 / 本地，云只选「模型页已声明的 ASR」，本地 SenseVoice 安装 / 导入权重 / 启停 / idle / status / 选择都在这；**不自动 fallback cloud**；
  3. **Laya 不是 ASR，是电脑快速分类模型**（Jev/System One 一路）。本地 Laya 管理放**电脑操作**相关页；语音页只放真正 ASR；标签用「中文功能名（模型名）」；
  4. 子代理的模型 / 思考 / 并发归**助理配置**单一来源（见 §3 的事实纠正）；
  5. 长说明统一用 `components/ui.tsx` 的 `<Help>` 小问号（悬停 / 点击 / touch / 键盘），主视图只留功能标题 / 简状态 / 主操作 / 必要 error。

---

## 1. 现状盘点（before）

### 1.1 设置导航：15 个平铺标签，无分组

`apps/web/src/components/Settings.tsx` L31-47（`TABS`），顺序即导航顺序：

| # | key | 标签 | 主内容 | 数据 scope |
|---|---|---|---|---|
| 1 | `models` | 模型 | `DefaultModelPicker` + `ModelServicesPanel` + `SubagentSection` | 全局 |
| 2 | `usage` | 用量 | `UsageTab` | 全局 |
| 3 | `skills` | 技能库 | `SkillsTab`（库存 + 每助理启用） | 全局库存 + per-agent 启用 |
| 4 | `extensions` | 扩展（MCP） | `ExtensionsTab` + Downloads(MCP 服务 / Pi 扩展包) | 全局 + per-agent 可见性 |
| 5 | `memory` | 记忆 | `MemorySettings`（全局后端）+ Hindsight | 全局（per-agent override 在 InfoPane） |
| 6 | `channels` | 渠道 | `ChannelsSettings` + Downloads(渠道) | 全局 |
| 7 | `email` | 邮箱 | `EmailSettings` | 全局 |
| 8 | `computer` | 助理电脑 | `DesktopSettings` + Downloads(助理电脑) | 全局（VM 资源 / 空闲关机） |
| 9 | `host` | 操作这台电脑 | `HostControlSettings` + Downloads(操作这台电脑) | 全局（defaultTier / apps / agents） |
| 10 | `remote` | 远程访问与设备 | `RemoteTab` + Downloads(远程访问) | 全局 |
| 11 | `entry` | 固定地址 / 入口 | `EntryTab`（命名隧道 + Rendezvous） | 全局 |
| 12 | `appearance` | 外观 | `AppearanceTab` | 仅本设备（localStorage） |
| 13 | `pet` | 桌宠 | `PetSettings` | 全局 + 每助理桌宠 |
| 14 | `downloads` | 下载与组件 | `Downloads`（全量） | 全局 |
| 15 | `about` | 关于与更新 | `AppUpdate` + 系统信息 + 沙箱模式 | 全局 |

`settings` 值是字符串 key，来自 `store.ts`（`settings: new URLSearchParams(location.search).get("settings")`），**深链形式 `?settings=<key>`**，e2e 依赖（如 `settings-subagent.mjs` 用 `?settings=models`）。

### 1.2 模型页现在的真实结构（投诉集中区）

`ModelsTab` = 3 块（`Settings.tsx` L176-190）：

```
设置 › 模型
├─ 默认使用            → DefaultModelPicker（全局默认模型 + 默认思考）
├─ 模型服务（Fold）    → ModelServicesPanel（ModelServices.tsx L1123-1232）
│   ├─ ★ 本地 Laya 安装管理卡      LocalLayaCard      L608-800    ← 应归「电脑」
│   ├─ ★ 本地 SenseVoice 安装卡    LocalSenseVoiceCard L802-946   ← 应归「语音配置」
│   ├─ 默认图片模型                DefaultImageModel
│   ├─ 搜索 + 添加服务
│   └─ 服务卡片网格 → 展开：
│        ├─ 模型列表（能力标签 / 能力纠正 / 分类器「实际操作测试」）
│        ├─ 测试连接
│        ├─ 登录 / 编辑 / 删除
│        ├─ 生图适配 ImageAdapterSection
│        └─ 语音识别（ASR）声明 AsrAdapterSection L275-360        ← 声明应留，选择应走语音页
└─ 子代理（折叠）      → SubagentSection L178-200
        └─ SubagentTaskSettings：并发上限 + 最长运行              ← 全局值，被误读成每助理
```

Three 已知「乱」的具体成因：
1. **本地运行时（Laya / SenseVoice）混在「在线模型服务」面板顶部**——Laya 是电脑快速分类模型、SenseVoice 是 ASR，和「一个服务 = 一份地址 + 一份凭据」的模型服务模型不是一类；
2. **ASR 有两处、且没有「当前用哪个」**——模型页按服务「声明为语音识别」（写 `settings.asrProviders`），但**生效选择是前端自动挑的**（见 §3.4），用户找不到「我用的是哪个」；
3. **子代理三件事被拆到两处、且文案误导**——`模型` 页折叠区是**全局**并发/超时，InfoPane › 设置 › 「子代理模型」是**每助理**候选池/思考；模型页文案「按助理计算」让人以为是每助理配置。

### 1.3 助理侧（InfoPane）现状

`components/InfoPane.tsx`：7 个 tab（概览 / 记忆 / 定时任务 / 主动 / 文件 / 电脑 / 设置）；「设置」tab = `AgentSettings`（L225-241）：

| 组件 | 内容 | scope |
|---|---|---|
| `AgentEditor` | 名字 / 头像 / 描述 / 人设 / **模型** | per-agent |
| `AgentImageModel` | 生图模型 | per-agent |
| `SubagentModels` | **子代理候选池 + 思考强度** | per-agent（`settings['subagentModel:<id>']`、`settings['subagentThinking:<id>']`） |
| `AgentExtensions` | 该助理可见的 MCP / 扩展 | per-agent |
| `AgentSkills` | 该助理启用哪些技能 | per-agent |
| `AgentHostTier` | 操作本机的权限档位 | per-agent |
| `AgentComputer` | 助理电脑资源 | per-agent |

**子代理状态列表**不在设置里：在聊天顶部 header 的 `SubagentTasks`（`Subagents.tsx` L111-145，`data-testid="subagent-tasks"` → `task-overview` 弹窗）。

> 结论：用户问「模型页里是不是真有子代理 UI」——**是**，但两处语义不同（全局任务参数 vs 每助理模型池），现状把**全局任务参数放进了模型页**，这是冗余感的来源。规划见 §4。

---

## 2. 全局 vs 每助理 vs 每电脑：数据 scope 审计（实施前必须以此为准）

设置都落在 SQLite `settings(key,value)`（`packages/server/src/db.ts` L136-143，`getSetting/setSetting`）或 `agents` 表列。

| 设置 | 存储位置 | 真实 scope | 当前 UI 位置 | 备注 |
|---|---|---|---|---|
| `defaultModel` / `defaultThinking` | settings | **全局** | 模型页「默认使用」 | 新助理默认；**不得**被当成 per-agent override |
| `visionModel` / `defaultImageModel` | settings | 全局 | 模型服务内 | 识图选择已并入统一面板 |
| `customProviders` / `imageProviders` / `modelStrengths` | settings | 全局 | 模型服务 | 服务 + 凭据（凭据走 CredentialStore，不读明文） |
| `asrProviders` | settings | 全局 | **模型页每个服务卡** | 只是「能力声明」（provider/model/protocol），**不是**生效选择 |
| `subagentModels` | settings | **全局（单一值）** | **模型页折叠区** | 只有 `maxConcurrent`（1-100，默认 10）+ `maxMinutes`（默认 60）；`hasSubagentCapacity(agentId)` 只是**计数按助理**，上限本身全局 |
| `subagentModel:<agentId>` | settings | **每助理** | InfoPane › 设置 › 子代理模型 | 候选池，空池 = 跟随主会话 |
| `subagentThinking:<agentId>` | settings | **每助理** | 同上 | follow / fixed，运行时按实际模型 clamp |
| `subagents.thinking` | 表列 | 单个子代理 | 子代理详情页 | 覆盖值，null = 跟随助理 |
| `agents.model_provider/model_id`、`thinking` | 表列 | 每助理 | InfoPane › 设置 / 聊天输入栏 | 覆盖全局默认 |
| `memoryProvider` | settings | **全局** | 记忆页 | 全局默认后端 |
| `agents.memory_provider` | 表列（NULL = 跟随全局） | **每助理 override** | InfoPane › 记忆 | 语义正确，别改 |
| `fastComputer`（旧） / `fastComputer:hostpc` / `fastComputer:computer` | settings | **按电脑分别** | 操作这台电脑 / 助理电脑 | `fastComputerSettings(scope)` 无 scope 时回落旧全局 key；**两个 scope 不合并** |
| `hostControl`（apps / agents / workspaceFiles / defaultTier） | settings | 全局（含「哪些助理可操作」清单） | 操作这台电脑 | 每助理档位在 `hostControl.tiers[agentId]` → InfoPane › 设置 |
| `sandbox` / `sandboxComputer` | settings | 全局 | 关于与更新 / 助理电脑 | |
| `skillAssignments` | settings | **每助理** | InfoPane › 技能 | 库存全局，默认全部不启用 |
| `pet`、`defaultPet`、`agents.pet` | settings/表列 | 全局 + 每助理 | 桌宠 | |
| 主题 / 明暗 / 强调色 / 语言 | localStorage | **仅本设备** | 外观 | 多设备可不同 |
| `remoteEnabled` / `namedTunnel` / `cloudflare` / `entryDomain` / `tunnelMode` | settings | 全局 | 远程访问 / 固定地址 | 同属「远程连通」，可归一组 |
| `channels` / `email-oauth` / `wechat` | settings + 表 | 全局 | 渠道 / 邮箱 | |
| 定时任务 `routines` | 表 | 每助理 | InfoPane › 定时任务 | 暂停/恢复在行内 |
| 主动性 `proactivity` / `proactive_cfg` | 表列 | 每助理 | InfoPane › 主动 + 聊天输入栏 | 含 followup / inbox |
| 群聊 `rooms.paused` | 表列 | 每个群 | 群聊界面（非设置） | 与设置项无关，别动 |

**红线（实施时不得违反）**
- `defaultModel/defaultThinking` 仍是**全局**（新助理默认）：不许当成 per-agent override。
- 子代理并发 / 超时：旧 `settings.subagentModels` 保留为**默认值**（兼容只读）；前端用每助理 override（缺省继承默认），不改旧 key、不做破坏性迁移。
- `agents.memory_provider` 为 NULL = 跟随全局，**不要**在迁移里把 NULL 写死成全局当前值。
- `fastComputer:hostpc` / `fastComputer:computer` 不合并；Laya **运行时**共用一份安装，**选择**仍按 scope。
- 迁移只做加法：旧 key 全部保留（`asrProviders` / `fastComputer` / `tasksubagentModels` / `subagentModel:*` / `memoryProvider` …）。

---

## 3. 事实纠正（避免再犯混淆）

1. **Laya ≠ ASR**。`local-laya` 注册为 `type:"classifier"`（System One / Jev 一路），出现在「快速操作模型」下拉（`models.listClassifierModels()` → `fast-computer/routes.ts` L87）。语音输入要走 `type:"asr"`（`voice/index.ts` `registryAsrProviders()`）。之前把 Laya 卡和 SenseVoice 卡并排放在「模型服务」顶部，是命名与布局造成的混淆来源。
2. **子代理「并发/最长运行」是全局值**（`settings.subagentModels`），不是每助理；只有**候选池 + 思考强度**是每助理。规划时不要按「每助理配置」搬。
3. **子代理 UI 不是重复造**：任务列表 = 聊天 header 的 `SubagentTasks`；参数 = 模型页（全局）+ InfoPane（每助理）。规划只做「换位置 + 分组 + 文案」，不新建第二套。
4. **ASR 现在没有「用户显式选源」**：`useVoiceInput.ts` L84 `pickAsrModel()` = **已配置的 local 优先，否则第一个已配置的**（`models.find(local) ?? models.find(configured)`）。所以「没选过也会自己用上云」、且**会静默计费**。这正是不合规点。
5. **语音入口修复（`0069d36`）还有一半没做完**（主会话已指出，实施必须补）：
   - `VoiceInput.tsx` L98 `needSetup = voice.error?.code === "asr_not_configured"`，`showSettings = needSetup`；
   - 但点「去设置」「取消」只 `setNotice("")`，**没有清 hook 的 `error`**（`useVoiceInput` 只在 `start()` / `state==='recording'|'preparing'` 时 `setError(null)`）；
   - 切会话同样只清 `notice`（L88-90），error 还在 → **「去设置」会一直挂着**。
   - 需要：hook 增加 `dismissError()`（或 `resetContext()`），UI 的 `showSettings` 必须绑定**本次用户麦克风尝试 + 当前上下文**，点设置 / 取消 / 切会话 / 换助理后 idle 完全干净。
   - 未配置时按钮 `title` 里说明即可（不要再常驻文案）。
6. **`Help` 组件目前不满足「悬停 / 点击 / touch / 键盘」**：`components/ui.tsx` L144-174 只有 `onMouseEnter` / `onMouseLeave` / `onClick`（切换）/ 外部 `pointerdown` 关闭，**没有 focus 打开、没有 Escape 关闭**（`aria-expanded` 已设，但键盘用户打不开）。要给每个 Help 配 4 类交互，必须先补这个控件。

---

## 4. 目标信息架构（after）

### 4.1 导航：15 个平铺 → 5 组 / 16 项（保留 key 与 URL；**不合并 entry / downloads**）

侧栏加**组标题**（不是二级折叠树，仍是一层点击；桌面显标题，手机保持横向滚动，不造双重 nav）：

```
模型与语音               助理能力                 偏好与系统
  模型服务                 记忆                     外观
  语音配置 ★新增           技能库                   桌宠
                         扩展（MCP）              用量
电脑                                         下载与组件
  助理电脑                连接                    关于与更新
  操作这台电脑            渠道
                         邮箱
                         远程访问与设备
                         固定地址 / 入口
```

| after 组 | 项（key） | 变化 | 来源 |
|---|---|---|---|
| 模型与语音 | 模型服务（`models`） | 瘦身：只留「新助理默认模型」+ 在线服务（地址 / Key / 能力声明 / 模型目录）；**移除** Laya 卡、SenseVoice 卡、子代理折叠区；保留 ASR **声明**（文案改成「声明 ≠ 启用」） | 现「模型」 |
| 模型与语音 | 语音配置（`voice`）★ | 新增：云 / 本地显式切换 + 生效模型 + 本地 SenseVoice 全生命周期 | 新页（内容来自模型页两卡 + 新选择控件） |
| 电脑 | 助理电脑（`computer`） | 不变；快速模型区保留 `scope=computer`，给一行「本地 Laya 去『操作这台电脑』安装 / 查看」 | 现「助理电脑」 |
| 电脑 | 操作这台电脑（`host`） | 新增小节「本地快速操作模型（Laya）」= 现 `LocalLayaCard` 整块迁入（安装 / 启停 / idle / 健康 / 状态 / 实际操作测试） | 模型页 Laya 卡 + 现「操作这台电脑」 |
| 助理能力 | 记忆 / 技能库 / 扩展（MCP） | 不变 | 现同名 |
| 连接 | 渠道 / 邮箱 / 远程访问与设备 / 固定地址 · 入口 | 不变（`entry` 仍为独立页） | 现同名 |
| 偏好与系统 | 外观 / 桌宠 / 用量 / 下载与组件 / 关于与更新 | 不变（`downloads` 仍为独立页） | 现同名 |

**URL 兼容**：全部旧 key（含 `entry` / `downloads` / `models`）继续可用；`?settings=model` 别名指向 `models`。

### 4.2 子代理（回应「冗余」）

- **不再**在模型页出现子代理；`models` 页只留「模型服务」。
- 子代理「并发上限 / 最长运行」→ **每助理覆盖**，放在 `InfoPane › 设置 › 子代理模型` 里；缺省 / 清空 = 继承旧全局默认值（后端 `defaults` 兼容旧 `settings.subagentModels` 只读）。**不新「后台任务」页。**
- 每助理「子代理候选池 / 思考强度」→ 留在 `InfoPane › 设置`（**已经是单一来源**）。
- 子代理任务状态列表 → 保持聊天 header（不搬进设置）。
- 不做：不新增全局子代理入口；不因搬家改旧 key。

### 4.3 模型页瘦身后的职责（回应要求 ①）

模型页 = **服务注册表**：一份地址 + 一份凭据 + 能力声明。
- 保留：默认使用（新助理默认，全局）、服务卡片网格、添加服务、登录、删改、测试连接、生图适配、**能力标签 / 能力纠正**（chat / vision / image / classifier）。
- 保留但改语义：ASR **声明**（「把本服务某模型声明为可做语音转写」），文案明确「只声明能力；真正用哪个在设置 › 语音配置里选」。
- 移出：Laya（→ 电脑）、SenseVoice（→ 语音）、子代理任务参数（→ 每助理 `InfoPane`）。
- 不新增第二套 Key：云 ASR 复用同服务的地址 / Key（`keyFrom` 语义，`voice/index.ts keyOf()` 已只走 `CredentialStore.read`）。

---

## 5. 三块关键界面（ASCII）

### 5.1 模型服务（瘦身后）

```
┌ 设置 › 模型与语音 › 模型服务 ────────────────────────────────┐
│ 默认使用（新助理）                             [?]          │
│   [ mock / Mock 模型 · 思考 中 ▾ ]   [测试连接]              │
│                                                             │
│ ⌄ 模型服务          [7 个服务 · 2 个已配置]        [?]       │
│   [搜索服务…]                                  [+ 添加服务] │
│   ┌────────────────┐ ┌────────────────┐                    │
│   │ [图标] OpenAI  │ │ [图标] 我的中转│                    │
│   │ 对话 识图 生图 │ │ 对话 分类器    │                    │
│   └────────────────┘ └────────────────┘                    │
│   ▾ OpenAI                                                  │
│     · gpt-4o            对话 · 识图      [能力]             │
│     · whisper-1         语音转写(声明)   [能力]             │
│     语音识别（ASR）声明   [?]  ← 只声明能力；实际使用哪个   │
│       已声明：whisper-1（OpenAI 语音转写）   在「语音配置」选 │
│     [测试连接] [登录] [生图适配…]                           │
└─────────────────────────────────────────────────────────────┘
（此页不再有：本地 Laya、本地 SenseVoice、子代理）
```

### 5.2 语音配置（新增页，云 / 本地显式切换）

```
┌ 设置 › 模型与语音 › 语音配置 ────────────────────────────────┐
│ 语音识别（ASR）用于把麦克风录音转成文字草稿。   [?]         │
│                                                             │
│ 来源：[ 云端 ] [ 本地 ]        ← 显式选择，切换不自动改源     │
│                                                             │
│ ── 云端 ─────────────────────────────────────────────────  │
│ 使用哪个模型：[ OpenAI · whisper-1 ▾ ]      ← 只列模型页已声  │
│                （没有可选项时：）            明的 ASR 且已配置│
│   ⚠ 还没有可用的云端语音模型。                              │
│   [去模型服务声明 ASR →]   ← 不常驻，只在空态显示           │
│   说明：音频会先到本机服务再转发到该服务（会离开本机）。     │
│                                                             │
│ ── 本地 ─────────────────────────────────────────────────  │
│ 使用哪个模型：本地 SenseVoice（sherpa-onnx int8 · CPU）      │
│ 状态：未安装 / 已安装未运行 / 运行中（空闲 90s 后释放）      │
│ 许可：模型权重许可未解决 —— 下载不可用（不隐藏）  [详情 ▸]   │
│ [安装/导入权重] [启动] [停止] [卸载]   进度条 ███░ 42%       │
│ 高级（折叠）：来源 / 系统路径 / 安装日志 / idle 秒数         │
│                                                             │
│ ℹ 没有选择就是「未配置」：麦克风按钮会提示去语音配置，       │
│   不会自动改用云端（不静默计费）。                          │
└─────────────────────────────────────────────────────────────┘
```

### 5.3 电脑 › 操作这台电脑 › 本地快速模型（Laya）

```
┌ 设置 › 电脑 › 操作这台电脑 ──────────────────────────────────┐
│ ⚠ 让助理操作你自己的电脑 …（原样）                          │
│ 状态 [未开启]  Cua Driver 0.35.1 · 已安装          [?]      │
│ ⌄ 本地快速模型（Laya）  [未安装]                   [?]      │
│   在有限候选里挑控件的快速分类模型（不是语音识别）。         │
│   这台电脑和助理电脑共用同一份安装；开关与选择的模型分别设置。│
│   平台：macOS Apple Silicon 支持 / 该平台不支持（原因可见）  │
│   [一键安装]  进度：preflight→uv→venv→torch→weights  ███░ 42%│
│   安装后：local-laya / multilingual · 分类器                │
│   [启动] [停止] [更新] [卸载]  [实际操作测试]                │
│   未验证声明：下载 / 启动尚未在本机实机验证（如实显示）。     │
│                                                             │
│ 快速操作模型（只看你电脑）                         [?]      │
│   ☑ 开启（关闭时完全沿用主模型）                             │
│   模型：[ TypeSafe · System One ▾ ]  ← 含 local-laya（装好后）│
│ ⌄ 新助理的默认权限（原样）                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. 帮助文案规则（Help text rule，全设置通用）

1. **主视图只允许**：功能标题（中文功能名）、一行简状态、主操作按钮、**真实 error / 阻塞原因**。
2. 解释、背景、来源、许可、链路、系统路径、安装日志 → `<Help>` 或折叠「高级 / 详情」。
3. **不能藏进 tooltip 的**（必须常驻可见）：
   - 真实不可用原因（未装 / 平台不支持 / 权限被拒 / 许可未解决）；
   - **许可未解决的「下载不可用」**（一句「许可待确认，暂不提供下载」常驻；许可名 / 完整条款 / 限制 / 链接放同一行「?」，不算藏）；
   - 下载 / 安装进度；
   - 涉及花钱 / 隐私的关键风险：音频会离开本机、云端按量计费、费用未知（**一条短句可见**，不用大警告框多段）；
   - 保存失败的错误与回滚结果。
   - 许可 `cleared` 之后的「同意条款」checkbox 只能在**真能下载**时出现；许可未解决时不显示永远勾不上的冗余 checkbox。
4. **标签命名**：一律「中文功能名（模型名）」，如「本地快速模型（Laya）」「本地语音识别（SenseVoice）」「快速操作模型（原生 Jev / System One）」；不出现只有 `Laya` / `SenseVoice` / `Jev` 的裸名。
5. `<Help>` 必须支持：鼠标悬停、点击 / 触摸切换、键盘 Tab 聚焦打开、**Escape 关闭**、点击外部关闭（见 §3.6，实施前先补 `ui.tsx`）。
6. 同一件事只在一处写详细，别处链接过去（`Fold` 的 `desc` 已是这个模式）。

---

## 7. 前后端分工 + 文件 / 接口范围

### 7.1 前端（apps/web）

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/components/Settings.tsx` | `TABS` → `{group, items}`；`ModelsTab` 瘦身；新增 `VoiceTab` / `TasksTab` 挂载；`entry`/`downloads` 旧 key 兼容；`AboutTab` 并入 Downloads | 主要工作量 |
| `src/components/ModelServices.tsx` | 删 `LocalLayaCard`(L608-800)、`LocalSenseVoiceCard`(L802-946) 与 `ModelServicesPanel` 顶部两行(L1192-1193) 的渲染；`AsrAdapterSection`(L275-360) 保留 + 改文案；`AddServiceDialog` 里「本地模型（Laya 一键安装）」选项文案改为指向电脑页 | 不删接口，只删 UI 归属 |
| `src/components/VoiceSettings.tsx` ★新 | 云 / 本地切换、云端模型选择、SenseVoice 卡（从 ModelServices 迁入并抽出成独立组件）、空态跳模型服务 | 新增 |
| `src/components/LocalLayaSection.tsx` ★新（或从 ModelServices 抽出） | Laya 卡 + 接入「操作这台电脑」页 | 新增（复用现有 API） |
| `src/components/HostControl.tsx` | `HostControlSettings` 里插入 `<LocalLayaSection/>`（放在「快速操作模型」上方） | L211-213 附近 |
| `src/components/DesktopSettings.tsx` | 快速模型区加一行「本地快速模型运行时未安装 → 去操作这台电脑」；不复制安装卡 | L240-243 |
| `src/components/ui.tsx` | `Help` 补 `onFocus` / `onKeyDown(Escape)` / `aria-describedby`；保持现有 portal 定位 | L144-174 |
| `src/hooks/useVoiceInput.ts` | 删「自动选源」；改为读服务端持久化的 voice source；新增 `dismissError()` / `resetContext()`；`asrModel` 由显式选择决定 | L84、L108-231 |
| `src/components/VoiceInput.tsx` | `showSettings` 绑定本次尝试 + 当前 context；点「去设置」「取消」「切会话」都调 `dismissError()`；`openSettings({settings:"voice"})`；未配置说明只留 `title` | L60、L88-144 |
| `src/api.ts` | `listAsrModels` 返回值加 `selected`/`source`；新增 `getVoiceSource()` / `setVoiceSource()` | L167-198 |
| `src/store.ts` | 无结构性改动（`settings` 仍是字符串 key）；可选加 key 白名单校验 | — |

### 7.2 后端（packages/server）

| 文件 | 改动 |
|---|---|
| `src/voice/index.ts` | `registryAsrProviders()` 附带当前选择；新增读取/写入 `voiceSource` 的纯函数；`resolveAsrEndpoint()` 用显式选择，找不到时 **fail-closed**（不再回落第一个 cloud） |
| `src/voice/routes.ts` | 新增 `GET /api/audio/asr/source`、`PUT /api/audio/asr/source`（body `{source:"cloud"\|"local", provider?, model?}`；校验 provider/model 必须在已声明/已上报的 ASR 里，否则 400 `asr_not_declared`） |
| `src/http.ts` | `GET /api/audio/asr/providers` 响应加 `source` 字段（L308-330，只读，不泄露 Key） |
| `src/db.ts` | 无表结构改动（`settings` key-value 复用）；**不**改 `secrets.ts` |
| `src/local-asr/*`、`src/local-laya/*` | 不改接口（`status/install/cancel/start/stop/pause/resume/idle/update/DELETE/transcribe` 已齐） |
| `src/onboarding.ts` | 不改：新用户不自动选 ASR（保持「未配置」） |

新增设置 key：`voiceSource = { source: "cloud"|"local"|null, provider?, model? }`（null / 缺省 = 未配置）。

### 7.3 迁移（不丢配置）

| 项 | 规则 |
|---|---|
| `asrProviders`（云 ASR 声明） | **原样保留**，语义从「生效」变为「声明」；不删、不改写 |
| `voiceSource`（新） | 旧库没有该 key；**不臆造历史选择**。默认「未配置」；语音页显示「检测到 N 个已声明/已安装的语音模型」+ 一个显式「使用这个」按钮（用户点一下才写入），**不静默选第一个 cloud** |
| `subagentModels` | 原值保留（`maxConcurrent` / `maxMinutes`）；只换 UI 位置，**不做** global→per-agent 迁移；`migrateSubagentModelSettings()` 现有逻辑不动 |
| `subagentModel:<id>` / `subagentThinking:<id>` | 原样保留（已是 per-agent 单一来源） |
| `memoryProvider` + `agents.memory_provider` | 不动；NULL 继续表示「跟随全局」 |
| `fastComputer` / `fastComputer:hostpc` / `fastComputer:computer` | 不动；Laya 只是被选择的一个分类器，**不因搬家改 key** |
| `defaultModel` / `defaultThinking` | 不动，继续全局 |
| 主题 / 语言（localStorage） | 不动 |
| 旧 URL `?settings=entry|downloads|models` | 兼容：`entry`→远程页内「固定地址 / 入口」小节；`downloads`→关于页内下载小节；`models` 不变 |

### 7.4 明确不做（防越界）

- 不改 Pi SDK / node_modules / Pi 本体；不改 `packages/server/src/secrets.ts`、CredentialStore 实现、真实用户 DB / 钥匙串 / session。
- 不新增第二套模型凭据 / Key 输入（云 ASR 复用服务的地址 + Key）。
- 不做双向语音通话；不做「Laya 当 ASR」的兼容命名。
- 不为对齐 Pi 功能把终端专属项搬进设置。
- 不在本轮改业务逻辑；`voiceSource` 的**默认未配置**会改变「已配置就自动用」的体验，属于**用户已明确要求的变更**，需在语音页给一次显式引导（非静默）。

---

## 8. 最小测试验收（实施完成后必须实跑）

单元 / HTTP（server）：
1. `PUT /api/audio/asr/source` 写入后 `GET` 可读；provider/model 不在已声明列表 → 400 `asr_not_declared`，**不落库**。
2. 未配置 `voiceSource` 时 `resolveAsrEndpoint()` **不会**回落到第一个 cloud（fail-closed，返回「请先在语音配置里选择」）。
3. `voiceSource.source="local"` 但本地未安装/未运行 → 明确 409（不自动 fallback cloud）。
4. 迁移：预置 `asrProviders` + `subagentModels` 的旧库启动后，两 key 原值存在且未被改写；`agents.memory_provider` 仍为 NULL。
5. `subagentModels` 保存只改并发/超时，**不**产生任何 `subagentModel:<id>` 记录（global→per-agent 不乱迁）。

前端 / e2e（`e2e/`，复用 `settings-*.mjs` 模式，静态 fixture + mock server，不碰真麦 / 付费模型 / 真实下载）：
6. 390 + 矮窗：设置导航分组不横向溢出；语音页 / 模型页无横向滚动。
7. 已配 provider 后刷新：在语音页「去模型服务声明 ASR」→ 声明后回语音页，云端下拉**出现新模型**（不刷新整页也可以）。
8. 空态 / 阻塞态如实显示：未装 SenseVoice、平台不支持、许可未解决 → 卡片上有**常驻**文案「下载不可用」，且安装按钮禁用；不是只藏在 Help 里。
9. 保存失败回滚：`PUT /api/audio/asr/source` 失败时下拉/单选**回到原值**并显示错误（不留下假值）。
10. 不重复凭据：语音页与模型页都**没有** ASR 专用 Key 输入框（断言不存在第二个 key 输入）。
11. 全局设置不乱迁：模型页**不含** Laya / SenseVoice 卡、不含子代理折叠区；子代理并发 / 超时只在 `InfoPane`（每助理覆盖）。
12. `Help` 可访问性：Tab 聚焦 → 弹出；Escape 关闭；点击外部关闭；touch 点击打开/关闭。
13. 聊天 idle 干净：未配置 ASR 时**没有** `voice-status` / `voice-open-settings`（沿用 0069d36 断言）；点麦克风出现提示 + 「去设置」；**点「去设置」后 `voice-status` 消失**（`dismissError` 真生效）；切会话后同样消失；已配置并录音时流程不变（0 回归）。
14. 打开语音页不产生副作用：进入设置不启动/安装本地模型、不请求麦克风（0 `getUserMedia`）、不下载。
15. 导航深链：`?settings=models|voice|host|computer|entry|downloads` 全部能打开到预期位置。

---

## 9. 风险与待用户确认

1. **「未配置」默认值**会改变已配 ASR 用户的即刻体验（原来是自动用）。方案：语音页给显式「使用这个」引导 + 聊天里点麦克风时提示去语音配置。若用户希望「本地已装好就沿用」，需要用户明确点头——**默认不静默沿用云端**。
2. `entry` / `downloads` 两个 tab 是否合并进远程 / 关于：本方案建议合并（减少平铺项），但会让 `EntryTab` 变长；若主会话倾向小步，可先只做分组、合并放第二步。
3. Laya 安装卡的唯一管理位放「操作这台电脑」：助理电脑页只给跳转提示（不复制卡）。若用户希望两页都能装，需要新的共享组件方案（成本更高）。
4. `settings.subagentModels` 的并发/超时如果用户**真想要每助理**，那是行为变更（后端 + 迁移 + 队列语义），不是「搬位置」；本方案默认不改，需用户确认后再开单独任务。
