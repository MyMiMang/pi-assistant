# 统一模型服务注册表（后端 / legacy 迁移）——进度与契约

分支 `unified-model-registry`（基 `hotfix-integration` b7d33d3）。负责人：registry 后端 + legacy 迁移。
**不写模型页面 UI**（UI owner：sa_mv9gctzplto13n）、**不做本地安装/一键部署**（laya owner：sa_mv9gdd04sgasad）。

## 与 Pi SDK 的对齐（事实来源）

- 事实来源是 **Pi 公开的多类型运行时**：`ModelRuntime.getAllModels() / getModelsOfType(type) / getModelsOfType("chat")`；
  一个 provider（一份凭据 + 一个 baseUrl）可同时挂 **chat / image / classifier** 模型（见 `pi-ai/README.md`「Image Generation」「Classification」）。
- 鉴权**只由 Pi 在请求时按 `model.provider` 解析**，本模块不存 key、不读 `secrets.ts`、不自造 auth resolver。
- 自定义服务经 `models.json`（chat）与扩展 `registerProvider`（classifier，见 `pi-adapter/index.ts:registerClassifiers`）注册；
  SDK `models.json` 不能直接持久注册 classifier，所以复用现有 `CustomProviders` 的 classifier 声明 + `reapplyClassifiers()`（保留 chat/reload/delete 引用语义）。

## 元数据 / API 契约（第一批，已落地）

新增 `packages/server/src/model-registry.ts`：纯函数 `buildRegistry(input)`，把内置目录 + 自定义服务 + 生图服务汇总成统一视图。

```
RegistryProvider { id, name, kind: "builtin"|"custom"|"imagegen", configured, baseUrl?, protocols[], models[] }
RegistryModel {
  provider, id, name,
  type: "chat"|"image"|"classifier",
  capabilities: ("chat"|"vision"|"image"|"classifier")[],   // vision 属于 chat 能力，不是独立服务
  protocol: string,          // chat=api id；classifier=协议；image=生图服务 kind
  confirmed: boolean,        // 全部能力都有可靠来源
  inferred: ModelCapability[], // 靠 models.dev / 名字猜的能力（界面标“未确认”）
  source: "pi-catalog"|"custom"|"imagegen"|"guess",
  configured, contextWindow?, maxTokens?, reasoning?, thinkingLevelMap?, input?,
  edit?, costNote?,          // 生图：是否支持改图 / 参考价（未知不填 0）
}
```

- 能力判定只按可靠来源：Pi 目录 / 用户显式配置 / 服务端 `/models` 返回的模态元数据；
  猜出来的（`inputAuto`，来自 models.dev）标 `inferred` + `confirmed=false`，不假装事实。
- `fetchModels()` 新增 `detectInput()`：从服务端 `/models` 读 `input` / `capabilities.input` / `modalities.input` / `openrouter architecture.input_modalities`，
  拿到就是可靠来源（写入模型 `input`，不再被 models.dev 覆盖）。
- 自定义模型元数据新增可选 `capabilities?: ModelCapability[]`（“手动设能力”的落点），只存我们的元数据，不写进 `models.json`。
- API：`GET /api/models/registry` → `{ providers: RegistryProvider[] }`。

## 已验证

- `packages/server` `tsc --noEmit -p .` ✅
- `test/model-registry.test.ts` 6/6 ✅（多类型同服务 / 识图属 chat / 猜的能力标未确认 / 生图合并 / 同 id 去重 / 按能力筛选）
- `test/custom-providers.test.ts` 8/8 ✅（回归，未读凭据）
- `test/vision.test.ts` 3/3 ✅（回归，未改识图行为）

## 删除引用清理（已修）

`providerReferences()` / `clearProviderReferences()` 以前只看默认 / 识图 / 助理 / 子代理池 / 快速操作，
**漏了生图服务复用自定义服务 Key（`keyFrom`）的引用**：删掉自定义服务后生图服务会留着指向已删服务的 keyFrom。
现在 `ProviderReferences` 增加 `imageProviders`（受影响的生图服务名），删除时清掉这些生图服务的 `keyFrom`
（只清引用，**不删生图服务本身、不动凭据**），界面可据此提示“这些生图服务需要重新配 Key”。

## A. 图片理解只跟当前对话模型（已落地）

**行为变化（API 契约）**：
- 聊天附件、`look_at_image`、`read` 读到的图片**只跟随当前对话/会话模型**：
  - 当前模型 Pi 公开元数据 `input` 含 `image` → 图片作为真正的内容发给它；
  - 不含 `image` → 明确提示换模型（`visionUnsupportedMessage`），**不再静默改用别的模型**（不产生额外云费用）。
- `GET /api/models/vision`：保留为 **deprecated 只读兼容**，返回增加 `deprecated: true` / `deprecatedNote`；旧字段 `setting/current/source/candidates` 不变。
- `PUT /api/models/vision`：保留写入（旧 UI 可用），返回 `{ ok: true, deprecated: true }`；只存设置，不影响图片路由，**不删凭据 / 模型**。
- `visionModel` 设置**保留不删**；删除服务时仍按原逻辑清引用（`clearProviderReferences` 不变）。

**代码落点**：`vision.ts`（`supportsVision` 按 Pi 公开 `input`；新增 `visionUnsupportedMessage`；`pickVisionModel`/`describeImages` 降级为 legacy/显式）、`vision-ext.ts`（不再 import `describeImages`，去掉 `onUsage`）、`runtime.ts`（`withAttachments` 不再传 `describe`，去掉识图用量上报）、`attachments.ts`（不支持看图时的文案改为引导换当前对话模型）。

**测试**：`test/vision.test.ts` 4/4（models.dev 标记 / 当前模型支持图片直接给图且不调别的模型 / 不支持时明确报错且不调别的模型 / legacy 设置保留）。回归：`attachments` 3/3、`custom-providers` 8/8、`model-registry` 6/6，服务端 `tsc` 通过。

## 后续（未做，按小步推进）

1. **生图服务迁移**：`imageProviders`/`imageKey:<id>` 独立 settings → 统一 registry（一个 provider 一份 key 可同时 chat+image），
   `image-gen` 调用改走统一 provider；不能只搬 UI、后端仍两套 key。迁移必须**幂等、不删原数据/凭据**。
2. **legacy 识图选择器移除**：`visionModel` 移除后图片跟 current chat，模型不支持识图**明确报错，不静默换模型**；
   迁移默认不删 model/credentials，旧 API 保留为 deprecated 兼容（防移动客户端破）。
3. **快速操作模型**：cloud/native/local 从**同一个 classifier 模型目录**筛选；两台电脑的 scope 由 UI + fast agent 协调。
4. 服务删除引用清理（默认/识图/子代理池/生图/分类器）在统一 registry 下保持一致。

## 协调

本会话没有可用的子代理 message 工具，无法直接给 sa_mv9gctzplto13n / sa_mv9gdd04sgasad 发消息；
以上契约即本模块与 UI/安装的对接面，请以 `model-registry.ts` 的类型为准，勿各自另发明 schema。
`GET /api/models/registry` 的返回结构如需调整，改动集中在该模块与本文件。
