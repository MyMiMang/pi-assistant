# 设置按功能重排：后端契约（语音显式选源 + 助理级子代理上限）

- 基线：`release-candidate-validation` 候选树 `a80b2cb`（Pi 1.3 已合入）。本树只做**后端**，前端由另一 owner 按本文件冻结的 DTO 接。
- 依据：设置 IA 只读审计与方案（`research/settings-ia-plan.md`、`docs/design/settings-ia.md`，由 IA owner 维护）。本文件只记**后端实现状态与冻结接口**，不重复 IA 全文。
- 约束：不改 Pi SDK / node_modules / Pi 本体；不改 `secrets.ts` / `CredentialStore` 实现；不动真实用户 DB / 钥匙串 / 云费用 / 麦克风 / 本地安装。

## 1. 语音识别：显式来源 `voiceSource`

### 1.1 数据与迁移

- 新设置键：`settings.voiceSource = { location: "cloud" | "local", provider: string, model: string } | null`。
- `null` / 缺省 / 形状不合法 = **未配置**；**不凭客户端当前值自动挑源**，也不静默回落第一个云端（不静默计费）。
- 只做加法：`asrProviders`（云声明）与本地 SenseVoice 安装数据**原样保留**，不删不改写。
- 存的值指向已删除的服务 / 已移除的声明时，**不改写存的值**，只在视图里标 `availability:"deleted"` + 原因，让用户重选。

### 1.2 `GET /api/audio/asr/source`

只读元数据；**不启动 / 不下载 / 不连云 / 不读 Key 内容**。

```json
{
  "source": null,
  "options": [
    {
      "location": "cloud",
      "provider": "openai",
      "model": "whisper-1",
      "name": "OpenAI / whisper-1",
      "protocol": "openai-audio-transcriptions",
      "availability": "ready",
      "reason": null,
      "selected": true
    },
    {
      "location": "local",
      "provider": "local-sensevoice",
      "model": "sensevoice-small-int8",
      "name": "本地语音识别（SenseVoice）",
      "protocol": "local-asr-http",
      "availability": "not_installed",
      "reason": "本地语音识别未安装",
      "selected": false
    }
  ]
}
```

- `availability`：`ready` | `not_configured` | `not_installed` | `not_running` | `deleted`；**只有 `ready` 表示现在可用**，其余必须带 `reason`（中文，可直接显示）。
- 云端候选来自**已声明的 ASR**（`asrProviders`）；`ready` 才算已登录 / 有密钥。
- 本地候选来自运行时上报（`local-asr.changed` → `local-models.ts`）**或固定清单 id**（`local-sensevoice` / `sensevoice-small-int8`）：**未安装也会出现**（允许先存「用本地」的意图），但可用性如实标 `not_installed`，绝不标 `ready`。
- 当前值不在候选里时，`options` 追加一条 `availability:"deleted"`、`selected:true` 的条目。

### 1.3 `PUT /api/audio/asr/source`

请求体**严格**只认 `{ "source": null | { "location", "provider", "model" } }`（未知字段 / 缺字段 / 类型不对 → `400 asr_invalid_source`，**不落库**）。响应与 GET **同一 DTO**。

- 未知 / 未声明的 provider-model → `400 asr_not_declared`；云已声明但未配置（缺密钥）→ `400 asr_not_configured`；都不写库。
- `source: null` = 清空（回到未配置）。
- 本地未安装**允许选择**（合法已知 id）；保存成功只代表「意图已存」，可用性仍由 GET 的 `availability` 如实反映。
- 保存失败**不留假值**（GET 仍读到旧值）。

### 1.4 转写 / 租约按来源授权

`POST /api/audio/transcriptions`（multipart 的 `provider`/`model`）与 `POST /api/audio/asr/lease`（JSON 的 `provider`/`model`）：

- 未配置来源 → `409 asr_not_configured`（不猜、不上传）。
- 客户端带的 provider/model 与当前来源不一致 → `409 voice_source_changed`（旧 UI / 过期状态；**source=local 时绝不把过期客户端的云端当默认上传**）。
- 两者都不带 → 按当前来源执行。
- `resolveAsrEndpoint()` 仍只按给定 provider/model 解析，**fail-closed**，不回落第一个云端；选的是本地但未安装 / 未运行 → `409`，不自动改云端。
- 幂等（同 `requestId` 仅复用 **completed** 结果，不重复计费）与取消语义不变。

生产装配在 `mountAsrRoutes()` 注入来源访问；不注入（旧测试 / 嵌入用法）时来源路由不挂载、转写保持旧行为。

## 2. 子代理：并发 / 最长运行上限按助理

### 2.1 数据与继承

- 全局默认仍是 `settings.subagentModels`（`maxConcurrent` 默认 10，范围 1–100；`maxMinutes` 默认 60）——**语义不变**，旧接口继续可读写。
- 助理级覆盖是**独立键** `settings.subagentLimits:<agentId> = { maxConcurrent?: number, maxMinutes?: number }`：只存显式覆盖字段，缺省 = 继承全局默认；**绝不**把全局值 copy 成每个助理的覆盖（不悄悄 global→每代理）。
- 有效值唯一入口：`getSubagentSettings(agentId?)`（不传 = 全局默认）。`hasSubagentCapacity` / `pumpSubagents` / `checkSubagents` 的超时判定都按**该行的 owner agentId** 取有效值；高并发排队仍是**按助理分别计数**（不回退成全局池）。新值对**新任务与下一次 pump** 生效，正在跑的任务不回溯。

### 2.2 `GET /api/agents/:id/subagents/settings`

```json
{
  "settings": { "maxConcurrent": 3, "maxMinutes": 30 },
  "overrides": { "maxConcurrent": 3 },
  "defaults": { "maxConcurrent": 10, "maxMinutes": 60 }
}
```

- `settings` = 该助理有效值；`overrides` = 只含显式覆盖的键（没有就是 `{}`）；`defaults` = 全局默认。
- 助理不存在 → `404 not_found`。

### 2.3 `PUT /api/agents/:id/subagents/settings`

patch 语义：`{ "maxConcurrent"?: number | null, "maxMinutes"?: number | null }`

- 省略 = 保留原值；`null` = 清除覆盖（继承全局默认）；数字 = 校验后写覆盖。
- `maxConcurrent` 必须是 1–100 的整数；`maxMinutes` 必须是 > 0 的有限数；越界 → `400`（消息中文），**不落库**。
- 未知字段 / 类型不对 → `400`。
- 响应与 GET 同一 DTO。
- 旧 `GET/PUT /api/subagents/settings` 保留兼容（只读写全局默认），**不碰**任何助理的覆盖键。

## 3. 测试与验证状态

见 `packages/server/test/voice-source-http.test.ts`、`packages/server/test/subagent-limits-http.test.ts`（真实服务 + 临时数据目录 + 内存 CredentialStore，不联网 / 不开麦 / 不下载 / 不碰真实数据）。未验证项：真实云 ASR 计费链路、真机麦克风、本地 SenseVoice 实装。
