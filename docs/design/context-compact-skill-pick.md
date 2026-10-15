# 整理上下文「指定重点」与本次选用技能（context compact + skill pick）

状态：开发中（分支 `pi-context-skill-actions`，基 `deps/pi-1.2.0@2948a05`，含 `a905b42`，未发布）。
两项小增强，共享一条「用户主动、服务端可信校验」的原则：

1. **整理上下文时可指定重点**：手动 compaction 允许附一段「希望保留什么」的自定义指令，默认空 = 原行为。
2. **发送前点选本次要用的已启用技能**：只列该助理已启用的技能，点选只挂在本条草稿上，发送时随消息带上可信 canonical id，服务端重新校验。**第一版一次只选一个**（Pi 原生只展开开头一个 `/skill:` 命令）。

## 硬约束（不许越界）

- **不修改 / 不 fork Pi SDK、不改 `node_modules`、不 monkeypatch 私有 API**；Pi 调用统一走 `packages/server/src/pi-adapter/`。
- 只用 Pi 公开能力：`AgentSession.compact(customInstructions?)`、Pi **原生** `/skill:name` 技能命令（由 `AgentSession.prompt` 默认展开，Pi 自己读 SKILL.md）、`ResourceLoader.getSkills()` 的公开元数据。
- 不读技能正文、不自己拼技能块、不写 system prompt；技能命令由 Pi 展开。
- 自定义整理指令只进**摘要请求**，不进主会话 system prompt，不改变权限 / 安全 policy。
- 技能只认 **canonical id**（`来源/名称`），不接受客户端自填文件路径或技能正文；服务端按该助理的分配表重新校验，fail closed，不自动启用。
- 沿用「默认 assigned-only、完全权限不新增 OS 隔离」：技能作用域是加载 / 分配，不是文件系统安全边界。

## ① 整理上下文：指定重点

### 契约

`POST /api/conversations/:cid/compact`，可选 JSON body：

```jsonc
{ "instructions": "保留需求、决策和待办" }   // 可选；缺省 / 空串 = 原行为
```

校验（服务端）：

- 非 string（含数组 / 对象 / 数字）→ `400 { error: "invalid_instructions" }`。
- `instructions.trim()` 为空 → 按缺省处理（不报错，保持原行为）。
- 长度 > 2000 字符 → `400 { error: "instructions_too_long" }`。

响应保持原样：`{ ok: true, tokensBefore?, summary? }`；失败 `400 { error }`。
`tokensBefore` / `summary` 只来自 SDK 实际返回，不估、不补 0。

### 行为

- `AgentRuntime.compact(instructions?)`：会话忙（`isSessionBusy`）时**拒绝**并提示「助理正在工作，等这一轮结束再整理」，不自动停任务；否则调用 `compactSession(session, instructions)`。
- `compactSession` 直接把 `instructions` 交给 Pi 的 `session.compact(instructions)`，Pi 只把它用在摘要请求里。
- 成功 / 失败的消息卡沿用现有 `compaction_end` 处理：成功显示「已整理上下文」卡片（原 UI 不变），失败保留现有历史不重置。
- 取消（关弹窗）不发任何请求、不触发模型调用。

### UI

- 对话菜单「整理上下文」与上下文圆环的「整理上下文」都打开同一个应用内小弹窗：标题「整理上下文」，可选输入「希望保留什么？」，占位示例「例如：保留需求、决策和待办」。
- 两个动作：**直接整理**（空指令，提交原行为）、**按重点整理**（提交 trim 后的指令，输入为空时等价直接整理）。
- 助理正在工作时按钮禁用（等待本轮结束），不提供「边跑边整理」。

## ② 本次选用技能（skill pick）

**范围：第一版仅单聊**。群聊多接收人需要按每个目标过滤（未启用则告知、不偷偷 enable），不在本轮；群聊接口不接收 `skills` 字段。

### 数据流

```
composer 技能入口（只列该助理 enabled）
  → 草稿 chip（按 助理+对话 分桶，可取消）
  → 发送 payload { ..., skills: [canonicalId, ...] }
  → POST /api/agents/:id/messages
  → 服务端校验（分配表 + 库存）
  → AgentRuntime.send(..., { skills })
  → pi-adapter 生成 Pi 原生 `/skill:name`，由 promptSession 放在输入最前面
  → session.prompt(...)（Pi 自己读 SKILL.md、拼技能块；不写 system prompt）
```

### HTTP 契约

- `GET /api/agents/:id/skills` 响应新增 `enabledSkills`：

```jsonc
{
  "enabled": ["user/foo", "builtin/bar"],
  "enabledSkills": [
    { "id": "user/foo", "name": "foo", "description": "…", "source": "user" }
  ]
}
```

`enabledSkills` 只含**已启用**技能的元数据；未分配的技能名 / 描述不下发到 composer。
`enabled` 字段与旧行为一致（AgentSkills 设置页继续用它）。

- `POST /api/agents/:id/messages` body 新增 `skills?: string[]`：

```jsonc
{ "text": "…", "attachments": [], "conversationId": "…", "replyToId": "…", "clientId": "…", "skills": ["user/foo"] }
```

校验（服务端，fail closed）：

- 非数组 / 元素非 string / 元素长度 > 200 → `400 { error: "invalid_skills" }`。
- 去重前数组长度 > 1 → `400 { error: "本次只能选一个技能", code: "too_many_skills" }`（Pi 原生只展开开头一个）。
- 去重后，任一 id 不在该助理的 `assignedSkillIds(agentId)` 里，或不在库存里 → `400 { error: "技能未启用或不存在", code: "skill_not_enabled" }`，**不自动启用、不落库、不唤醒**。
- 校验通过后把解析出的 `{ id, name, filePath, baseDir }` 传给 `runtime.send`。

幂等：同 `clientId` 重复投递仍直接返回已存在消息（含技能），不重复唤醒；`clientId` 的草稿签名纳入 `skills`。

### Pi 侧技能调用（原生公开路径）

Pi 的 `/skill:name` 只展开**开头的一个**命令，因此第一版一次一个技能。pi-adapter 只把 canonical id 对应到会话**已加载**技能（= 已分配给该助理、通过 `skillFilterFor`），再交给 Pi 自己的展开：

- `skillCommand(session, skills)` 返回 `/skill:name`（Pi 解析出的名字），由 `promptSession(..., leading)` 放在输入最前面；
- Pi 的 `AgentSession.prompt` 默认 `expandPromptTemplates`，由 Pi **自己**读 `SKILL.md`、去掉 frontmatter、拼出 `<skill name=… location=…>` 块并附上用户参数；
- 我们**不读技能正文、不自拼技能块、不写 system prompt**，也不接受客户端路径 / 正文；
- 不在会话里的 id 直接抛错（调用方 400）；插话（忙时 steer）也把命令放在最前面，保证仍能展开。

模型是否严格遵照技能执行不保证；payload 里含明确的 `/skill:name` 本次使用引用。

### UI / 草稿

- composer 工具行（现「更多」/ 技能入口，不新增一排按钮，不挤麦克风 / 发送）显示技能入口，只列当前助理 `enabledSkills`；搜索过滤。
- 空态：没有已启用技能时提示「先为此助理启用技能」并提供跳转到该助理的技能设置；不自动全局启用。
- 点选只在本条草稿挂 chip（单选，选另一个会替换；再点已选的取消），不立即发消息、不执行脚本。
- 草稿按「助理 + 对话」分桶（复用引用草稿的键规则），切换对话不串；取消语音输入不清技能；发送失败保留 chip；发送成功才清 chip 与 clientId。
- 技能 chip 与引用条共存；窄屏 390 下菜单限高可滚动、不挤压麦克风 / 发送。

## 测试与边界

- HTTP：`instructions` 类型 / 长度 / 空值 → 默认行为；`skills` 只接受 assigned；同名不同来源按 canonical id 精确匹配；停用中途再发 → fail closed 不自动启用；自填假路径 → 400。
- 适配层：`skillCommand` 返回 Pi 原生 `/skill:name`；多个 / 未加载直接拒；正文由 Pi 自己展开（不是 system prompt）。
- HTTP：真实服务进程验证 `/skills` 实际被 Pi 展开进会话文件（正文真到了模型上下文）。
- 单聊 + 群聊路由优先级（@ > 引用作者 > 管理者）不变。
- 全部用临时 `PIA_DATA_DIR` / `PIA_WORKSPACE` + 内存凭据 + Mock 模型，不碰钥匙串 / 真实 Key / 付费模型。
