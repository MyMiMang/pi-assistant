# 统一模型管理 + 本地 Laya 跨平台 + 实际操作测试（交互架构与接口契约）

> 状态：**UI 已落地并接真实 CRUD**（统一整合树 `unified-integration`，基 `hotfix-integration` `b7d33d3`，已 merge `native-dialog-ui-fix` `9554628`）。旧区（`VisionModelPicker` / `ImageModelsSection` / 快速操作独立区）已删除，e2e 已迁移。
> 2026-10-15 用户纠正：性能测试 = **一次真实受控 CUA 任务**（不是 API 连接延迟），按钮叫「实际操作测试」，见 §6.5。
> 契约以两个已落地模块为**唯一事实来源**：
> - registry agent：`packages/server/src/model-registry.ts` + `GET /api/models/registry`（`unified-model-registry` 树，`98415a8`+`54b1ef1`）
> - benchmark agent：`packages/server/src/fast-computer/benchmark.ts` + `GET/POST /api/fast-computer/benchmark`（`fast-model-benchmark` 树，`12fa47d`）

## 1. 目标与范围

- 一个 **模型服务** = 一份 baseURL + 一份凭据，可同时含 **chat / vision（识图）/ image（生图）/ classifier（分类器）**；生图与快速操作模型**不再单独配凭据**。
- 官方图标卡填 Key → 载入模型；中转按**可靠元数据 / Pi 官方目录**识别能力，**不靠名字含 "Jev" 断协议**，**不逐个隐式付费 probe**；猜出来的标「未确认」，用户可纠正。
- 模型页：默认 chat 紧凑区 + 统一服务卡片网格 + 添加服务（官方 / 自定义 / 本地）；**移除独立「识图模型」选择器**（图片跟当前 chat，不支持时明确告知，不静默换）。
- 电脑设置：快速操作 enable + 从统一目录选 classifier，每台电脑独立偏好、默认 off、主模型 fallback。
- 本地 Laya：一键下载（环境 / 权重 / 校验）、cancel / resume / retry / stop / uninstall 确认、offline ready；自动地址 + token；CPU / GPU 用实际 health 探测标签。
- 实际操作测试（新增）：local Laya 或 cloud Jev **显式点按钮**，真实受控 CUA 任务；报告 success / 总时长 / errors / retries / fallback；advisory 建议但不 hard-disable；**不是** API 时延，也不等于整个 CUA 速度。
- 平台：Mac Apple MPS / Windows NVIDIA CUDA baseline；Intel Mac 旧栈 conditional；AMD CPU baseline + XPU experimental；**Windows ARM 不支持，明示不假成功**。

## 2. 核心概念

**服务（RegistryProvider）**：`{ id, name, kind: builtin|custom|imagegen|local, configured, baseUrl?, protocols[], models[], local? }`。
**能力（capability）**：`chat | vision | image | classifier`，落在每个模型上；`vision` 属于 chat 能力，不是独立服务。
**可靠来源**：Pi 目录 / 用户显式配置 / 服务端 `/models` 模态元数据 → `confirmed=true`；靠 models.dev / 名字猜的 → `inferred[]`、`confirmed=false`，界面标「未确认」。

## 3. 交互架构（设置 › 模型）

```
设置 › 模型
├─ 默认使用（chat 紧凑区，固定可见）
│   └─ ModelPickerButton（模型 + 思考强度）+ 「测试连接」
├─ 模型服务（Fold，可整块折叠）  [n 个服务 · m 个已配置]
│   ├─ 搜索 + 「添加服务」→ 官方 / 自定义 / 本地
│   ├─ 服务卡片网格：图标 + 名称 + 能力标签 + 模型数
│   └─ 卡片展开：
│       ├─ 模型列表（type + 能力标签；推断的标「未确认」；可点「能力」纠正）
│       ├─ 生图模型显示适配器（kind / 是否支持改图 / 参考价）
│       ├─ 分类器模型带「实际操作测试」
│       └─ 官方：登录；自定义：编辑渠道；本地：安装 / health
└─ 电脑（助理电脑 / 用户电脑）
    └─ 快速操作模型：enable（默认 off）+ 统一目录里的 classifier；每机独立，不可用主模型 fallback
```

**已移除**：独立「识图模型」选择器、独立 `ImageModels` 配置区、快速操作单独凭据区、「模型服务 / 渠道」旧折叠区。生图服务在统一面板的「添加服务 › 生图服务」里新建，或把已有服务的生图能力按 `keyFrom` 绑定到同一个 provider；默认图片模型在统一面板里选。

## 4. 能力识别规则

| 顺序 | 来源 | 规则 | confirmed |
|---|---|---|---|
| 1 | 用户纠正 | 手动打标签（落 `CustomModel.capabilities`，只存本地元数据） | true |
| 2 | 对端元数据 | `GET {base}/models` 的 `input` / `capabilities.input` / `modalities.input` / OpenRouter `architecture.input_modalities` | true |
| 3 | Pi 官方目录 | 命中 Pi 内置 chat / classifier 目录 | true |
| 4 | 推断 | models.dev / 模型名 → `inferred[]` | false（标「未确认」） |

硬约束：不按名字含 "Jev" 判协议；不做隐式付费 probe（`GET /models` 免费目录除外）；真实调用只发生在显式「测试连接 / 实际操作测试」。

### 4.1 快速操作（classifier）自动识别（2026-10-22 用户纠正后）

用户只需在「模型服务」里配好 Jev（官方登录或自定义中转地址 + Key），**无需**再手动声明分类器；快速操作模型列表自动出现它。

可靠来源（任一即可，均不按名字猜）：
1. 对端 `GET {base}/models` 明确给 `type/model_type/kind = classifier`，或 `api/protocol` 是我们的公开 classifier 协议，或 `capabilities` 含 classifier（`detectClassifierMetadata`）；
2. 模型 id 与 Pi **官方目录**里 canonical classifier id **完全相同**（`jev-latest` / `~typesafe/jev-latest` / `@cf/cloudflare/clef` …），协议一并取自官方目录（`canonicalClassifierProtocols`，同名歧义丢弃）；
3. 用户在「能力」里手动标 classifier。

fail-closed：协议无法确定、或官方目录里的协议本层无公开实现（如 `openai-decisions`）→ **不注册**，界面标「未确认」（能力 chip 带 `?`），快速操作下拉不列出；不向未知端点乱发 `/systemone`，不伪造可调用。用户显式改回 chat（capabilities 非空且不含 classifier）时尊重纠正，不做 canonical 自动识别。

存储与生命周期：`CustomProviderMeta.discoveredClassifiers`（只存公开元数据，含协议 + 模型 id）；与用户 `classifiers` 合并后注册（`effectiveClassifiers`）。保存 / 启动 `reapplyClassifiers` / 编辑 / 删除都按此同步；鉴权始终由 Pi 按同一 provider 在请求时解析，**不新增第二份 Key、不造第二个 provider 对象**。每台电脑的 `fastComputer:<scope>` 引用仍按 scope 独立。

## 5. Legacy 迁移（无损、可回退）

迁移是**加法**：旧 settings key 一律保留（`customProviders` / `customHeaders:<id>` / `imageProviders` / `imageKey:<id>` / `defaultImageModel` / `visionModel` / `fastComputer` / `subagentModel:<agentId>` / `defaultModel` / `defaultThinking`）。统一 registry 是派生视图，不删、不重置。只经公开读取器（settings + 既有 `CustomProviders.readKey`）取数；**不读 `secrets.ts` / SDK 钥匙串实现 / 真实用户 key 明文**。

## 6. Registry 契约（registry agent 已落地，UI 直接消费）

`GET /api/models/registry` → `{ providers: RegistryProvider[] }`。类型见 `packages/server/src/model-registry.ts`（勿另发明 schema）：

```ts
type ModelCapability = "chat" | "vision" | "image" | "classifier";
type ModelType = "chat" | "image" | "classifier";
interface RegistryModel { provider; id; name; type; capabilities: ModelCapability[]; protocol; confirmed: boolean; inferred: ModelCapability[]; source: "pi-catalog"|"custom"|"imagegen"|"guess"; configured; contextWindow?; maxTokens?; reasoning?; thinkingLevelMap?; input?; edit?; costNote?; imageAdapter? }
interface RegistryProvider { id; name; kind: "builtin"|"custom"|"imagegen"|"local"; configured; baseUrl?; protocols: string[]; models: RegistryModel[]; local? }
```

### 6.1 本任务需要的最小 schema 增量（请 registry agent 采纳）

1. **`RegistryProvider.kind` 增加 `"local"`**（本地 Laya），并带 `local: LocalRuntimeDto`（§7）。
2. **`RegistryModel.imageAdapter`（仅 type=image）** —— 生图统一的关键，取代 `imageProviders` / `imageKey:<id>` 两套 key：
```ts
interface ImageAdapter {
  kind: "openai" | "dashscope" | "ark" | "gemini" | "xai";  // image-gen/providers.ts 的 kind
  baseUrl: string;     // 生图端点基址；未填则用 provider.baseUrl
  edit: boolean;       // 是否支持改图 / 参考图
  costNote?: string;   // 参考价；未知不填
}
```
3. **能力纠正接口**：`PUT /api/models/registry/:providerId/models/:modelId/capabilities` body `{ capabilities: ModelCapability[] }` → 落 `CustomModel.capabilities`（用户显式来源）。

### 6.2 生图迁移 schema（不能留两套 key）

- **凭据唯一**：生图模型的凭据 = provider 自己的凭据（`credentialId === provider.id`），**不存在 `imageKey:<id>` 作为运行时来源**。
- **`keyFrom` 过渡语义**：旧生图服务若复用自定义服务 Key（`keyFrom=<customId>`），迁移后其 image 模型直接挂到那个 `customId` provider 下，`imageAdapter.baseUrl` 记生图地址，**不新建 provider、不复制 Key**。
- **独立 Key 的旧生图服务**：迁移为 `kind:"custom"`（或 `imagegen`）provider，Key 从 `imageKey:<id>` 写入统一凭据（provider id）；旧密文**保留但标 `imageKeyMigrated:<id>=<providerId>`，运行时只读统一凭据**（幂等，不删原数据）。
```ts
migrateLegacyImageProviders(input: { imageProviders: ImageProvider[]; customProviders: CustomProviderMeta[] }): {
  imageModels: { providerId: string; adapter: ImageAdapter; modelIds: string[] }[];
  credentialMoves: { from: string; to: string }[];
  markers: Record<string, string>;   // imageKeyMigrated:<id>
  warnings: string[];
}
```
- **legacy vision 移除**：`visionModel` 不再作为独立选择入口；图片跟当前 chat，不支持时**明确报错**。旧 `GET/PUT /api/models/vision` 保留为 deprecated 兼容（移动端），迁移不删 model / credentials。

## 6.5 实际操作测试（benchmark agent 已落地，UI 直接渲染）

**不是 API 延迟**：让快速模型在专用隔离 fixture 窗口里真实走 observe → candidate → classify → fresh click → verify，评估适用性。

- API：`GET /api/fast-computer/benchmark` → `{ availability: BenchmarkAvailability, runs: FastBenchmarkResult[] }`；`POST` body `{ provider, model, maxTrials?, warmup?, target? }`，`target: "hostpc" | "computer"`（未就绪 → `409 { blocked, availability }`）；`GET /:id`；`POST /:id/cancel`；fixture 页 `GET /fixture/:id` + `POST /fixture/:id/state?nonce=`（nonce 强绑定）。
- `BenchmarkAvailability = { cuaReady, modelReady, fixtureReady, reasons[] }`；任一 false → UI 显示 reasons 并禁用开始（**不偷偷开 VM**；hostpc 需先开启「操作这台电脑」）。
- 结果 `FastBenchmarkResult`：`status / provider / model / modelVersion / target{prefix,fixtureId} / startedAt / finishedAt / samples / coldStartMs / p50Ms / p95Ms / p95Approx / timeouts / errors / successRatio / actions / retries / fallbackCount / abstains / correctness / note / advisory{verdict,recommended,message,reason} / reason`。
- UI 展示重点：**冷启动（单次）· 任务成功率 · 总用时**（由 `startedAt`/`finishedAt` 算）；**p50 标「步骤延迟（诊断）」**，不代表整个 CUA 速度；正确率是本轮 bench task 正确率（不是泛化 accuracy）。
- advisory **不 hard-disable**：`successRatio<0.6` 或 `errors≥3` → unstable（建议排查）；`p50>responseBudgetMs`（默认 1000）→ slow（仍可继续用）。
- UI 必显：**尚未运行**（无 runs 时）；结果来源按每次的 `provenance` 标明（`cua` = 真实 CUA 驱动；`fixture` = 测试 / 假驱动，只验证路径；`unknown` = 未知）——不用永久硬文案，真实执行情况写文档而不是常驻提示。
- `fallbackCount` 只在真正执行主模型回退时才算，基准不执行回退 → 恒 0；**不得当「接管收益」报告**。
- 云分类器前提示**可能少量计费**；local 无费用。

## 7. 本地 Laya：安装 / health 契约（laya agent 已冻结，UI 直接对接）

契约唯一事实来源：`local-laya-runtime` 树 `docs/design/local-laya-api.md`（前缀 `/api/local-models/laya`）。
```
GET    /api/local-models/laya/status          → LayaStatus（轮询 / WS local-laya.changed）
GET    /api/local-models/laya/platform        → 安装前预检（能力 + NVIDIA 驱动探测，只读）
GET    /api/local-models/laya/source          → 来源元数据（版本 / revision / 许可证）
GET    /api/local-models/laya/logs?lines=200  → 已脱敏日志（无 token）
POST   /api/local-models/laya/install         body {cuda?,xpu?,checkpoint?} → {ok,status}（异步，轮询 status）
POST   /api/local-models/laya/cancel | start | stop | update → {ok,status}
DELETE /api/local-models/laya                 body {confirm:true} → {ok,status}
WS     local-laya.changed                     → {type,status}
```
`LayaStatus = { platform{key,os,arch,accelerator,support,torchBackend,pins,reason}, install{state,phase,received,total,error,installedAt}, runtime{state,pid,port,host}, health|null{ok,device,checkpointDevices,cpuFallbacks,revisions,loaded}, registered|null{provider,modelId,protocol}, source{project,repoUrl,weightsOrg,codeLicense,weightsLicense,version,reviewedRevisions} }`。

UI 硬约束：
- **永不显示 / 依赖 token**（status 里没有）；`host` 恒 `127.0.0.1`。
- **能力标签读 `health.device` / `cpuFallbacks` 实测值**，不用 `platform.accelerator`（后者只是安装意图）。
- **安装管理卡始终可见（`source=local`）**；`stop` 后模型显示**未就绪**，**不删配置、不删条目**。
- 未启动 / 已停止时 registry 不会出现 `local-laya`（fail-closed），UI 用 provider id `local-laya` 识别本地条目。
- **不把 Laya 当 chat 模型**（协议 `/v1/systemone`）；快速操作只从已注册 classifier 目录选 `local-laya · multilingual`。
- **不声称实机验证**：后端 22 local + 80 class + 46 download 测试均为 fake / 环回 HTTP，未真下载 venv、未启动 Laya、未跑 GPU；UI 明写「尚未在本机实机验证」。

## 8. 平台支持矩阵

| 平台 | CPU 基线 | 加速 | 支持级别 | 说明 |
|---|---|---|---|---|
| macOS Apple Silicon | ✅ | MPS | baseline | Laya local 推荐 |
| Windows + NVIDIA | ✅ | CUDA | baseline | |
| Intel Mac | ✅ | 旧栈 | conditional | 仅 CPU / 旧框架，性能不保证，明示 |
| AMD GPU | ✅ | XPU | experimental | CPU baseline，XPU 实验 |
| Windows ARM | — | — | unsupported | **明示不支持，不假装成功** |

## 9. 分工与进度

| 步骤 | 负责 | 状态 |
|---|---|---|
| S0 设计 + 契约 + 进度 | 本任务 | ✅ 已完成 |
| S1 UI 契约与原型（纯前端 fixture，默认不渲染，`?unified=1` 预览） | 本任务 | ✅ 已完成（e2e 通过） |
| S2 Registry DTO + 能力纠正 + 生图迁移 | registry agent | 已完成（GET registry + `PUT /capabilities` + `imageAdapter` + `kind:"local"` + legacy key 幂等迁移，已合入 `unified-integration`） |
| S3 Laya 安装 / health（`/api/local-models/laya`） | laya agent | 契约冻结 + 后端完成（未实机验证）；已合入整合树，`GET /status` 现会刷新 registry hints |
| S4 实际操作测试 runner + fixture | benchmark agent | 契约/runner/routes/host 已合入整合树；真实 CUA 运行仍 blocked（hostpc 未开 / VM 未就绪） |
| S5 UI 接真实 API（去掉默认隐藏开关） | 本任务 | ✅ 已完成（面板随 registry 就绪默认渲染；接口失败错误 + 重试，无 demo fallback） |
| S6 电脑设置快速 / 生图统一（删旧区） | 本任务 + registry | ✅ 已完成（AddServiceDialog 接 `/api/models/custom` / `/api/image-models` 真实 CRUD；删旧识图 / 生图 / 快速操作区；快速操作按 hostpc/computer 各一份 scope；e2e 已迁移） |

## 10. 边界与禁令

- 不改 shared credential backend / `secrets.ts` / SDK 钥匙串实现；不引入明文；不重置用户配置；各自独立 tree，不改对方。
- 测试先强制 tempdata（内存 `CredentialStore`，`test/setup.ts` 隔离 `5a4614f` 已含）；不跑真实 API 收费 / 桌面 VM / App 安装。
- 只做专项 typecheck / build / UI 测试；未支持能力用灰态 + 说明，不假成功。
