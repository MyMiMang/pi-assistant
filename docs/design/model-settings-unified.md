# 统一模型管理 + 本地 Laya 跨平台 + 性能测试（交互架构与接口契约）

> 状态：**设计中 / UI 原型阶段**（`model-settings-unified` 树，基 `hotfix-integration` `b7d33d3`，已合入 `native-dialog-ui-fix` `9554628`）。
> 2026-10-15 用户纠正：**性能测试 = 一次真实受控 CUA 任务评估（不是 API 连接延迟）**，见 §6.5；按钮叫「实际操作测试」，需选测试电脑、明确确认前置条件。
> 本文是**一页精确交互架构 + 接口契约**，主协调据此派 registry / Laya 安装 / benchmark 子任务。UI 实现按本文推进。
> 相关：`docs/DESIGN.md` §18 图片生成、§22 组队/用量、§24 模型选择 UI；`docs/ROADMAP.md`。

## 1. 目标与范围

- 一个 **模型服务（Model Service）** = 一份 baseURL + 一份凭据，可同时含 **chat / vision（识图）/ image（生图）/ classifier（分类器）** 四类能力的模型。
- 官方图标卡：填 Key → 载入模型；中转（同一服务混合能力）按**可信元数据 / 官方目录**自动识别能力，**不靠模型名含 "Jev" 断定协议**，**不逐个隐式付费 probe**；不确定时用户可纠正。
- 模型页：保留默认 chat 紧凑区 + 统一服务卡片网格 + 添加服务（官方 / 自定义 / 本地）；**移除独立「识图模型」选择器**，图片随当前 chat 模型；chat 不支持识图时**明确告知，不静默换模型**。
- **快速服务与生图服务不再另起凭据配置**：统一进模型服务，用能力多标签表达。
- 电脑设置（助理电脑 / 用户电脑）：快速操作 enable + 从统一目录选已配置 classifier（Jev cloud / Laya local），**每台电脑独立偏好、默认 off、主模型 fallback**，**不每 VM 重复安装**；生图功能选统一 registry。
- 本地 Laya：一键下载（环境 / 权重 / 校验三阶段）、cancel / resume / retry / stop / uninstall（确认框）、offline ready；自动地址 + token，用户无需填 key；CPU / GPU 用**实际 health 探测**标签，不是安装时猜。
- **实际操作测试**（新增，优先项）：**不是 API 连接延迟**，而是**一次真实任务评估模型适用性**——在**专用隔离本地测试页 / 窗口**里经 CUA 正式链路（observe → candidate → classify → fresh click → verify）跑**受控任务**；报告 **success / 总时长 / errors / retries / main fallback**，而不是单个 p50。
- 测试**绝不碰真实用户 appdata**；窗口**失焦即 abort**；开发环境未真人接管时**不装模型**；cancel 只释放本次测试自有资源。
- UI 按钮叫**「实际操作测试」**，需先选**测试电脑（assistant / host）**，明确说明会打开专用测试窗口、费用 / 步骤；启动前**条件校验（permissions / VM ready）由用户明确确认，不偷偷开**。
- 报告给**使用 / 谨慎 / 不建议**建议，但**仍允许用户选择**；样本有限，**不 promise 普遍准确**。API 时延仅作**诊断**，不当适用性结论。
- 阈值**不任意编造**：用用户目标预算（可配置）+ 可解释默认；advisory、低可信须 fallback，**不取消 permission**。
- 平台：CPU baseline（Mac Apple MPS / Windows NVIDIA CUDA）；Intel Mac 旧栈 conditional；AMD CPU baseline + XPU experimental；**Windows ARM 不支持，明示不假成功**。

## 2. 核心概念

**ModelService**：`{ id, name, kind: official|custom|local, icon?, baseUrl?, configured, models[] }`。
- `kind=official`：Pi 内置 provider（品牌图标 + 登录流程）。
- `kind=custom`：用户添加的中转 / 自定义（原 `customProviders`）。
- `kind=local`：本地运行时（Laya），无 key，走本机进程 / 端口。

**Capability（能力）**：`chat | vision | image | classifier`，落在**每个模型**上（一个服务里可混合）。
- `source`：`metadata`（对端 `/models` 声明的模态）/ `catalog`（models.dev / Pi 内置目录匹配）/ `user`（用户纠正）/ `unknown`。
- `confidence`：`high | medium | low`。`unknown` 一律 `low`，界面灰态，不作为自动决策依据。

## 3. 交互架构（设置 › 模型）

```
设置 › 模型
├─ 默认使用（chat 紧凑区，固定可见，不随折叠隐藏）
│   └─ ModelPickerButton（模型 + 思考强度）+ 「测试连接」
├─ 模型服务（Fold，可整块折叠）  [n 个服务 · m 个已配置]
│   ├─ 搜索 + 「添加服务」→ 官方 / 自定义 / 本地
│   ├─ 官方服务 卡片网格（品牌图标）
│   ├─ 我的服务 卡片网格（自定义 / 本地，字母头像兜底）
│   └─ 服务卡展开：
│       ├─ 能力标签行：对话 · 识图 · 生图 · 分类器（计数）
│       ├─ 模型列表：每行能力标签，可点「能力」纠正（多选）
│       ├─ 官方：登录 / 退出登录；自定义：编辑渠道；本地：安装/health
│       └─ 测试连接（显式点，计费提示）
├─ 生图：从统一服务里选 capability=image 的模型（原 imageProviders 迁入）
└─ 电脑（助理电脑 / 用户电脑）
    └─ 快速操作模型：enable（默认 off）+ 分类器（统一目录里 capability=classifier 且已配置）
        · 每台电脑独立偏好；不可用时主模型 fallback，不阻断
```

**已移除**：独立「识图模型」选择器（`VisionModel.tsx`）。识图改为「当前 chat 模型是否支持 vision」：
- 支持 → 直接看图；不支持 → 明确提示「当前模型不能看图，可在模型服务里换一个支持识图的模型或开启识图」。
- 迁移期保留 `visionModel` 设置作为**自动候选**来源（不删旧 key），但不再有独立选择器入口。

**添加服务流程**（显式、不隐式 probe）：
1. 选类型 → 官方（图标卡）/ 自定义（name + baseUrl + key）/ 本地（Laya）。
2. 官方：凭内置目录直接列模型（不联网 probe）。
3. 自定义 / 中转：填 baseUrl + key → 点「载入模型」显式请求 `GET {base}/models`；对端声明模态 → `metadata`；否则按模型 id 匹配官方目录 → `catalog`；都无 → `unknown`（灰态，用户可纠正）。
4. 本地：一键下载，自动地址 + token。

## 4. 能力识别规则（可信优先，可纠正）

| 顺序 | 来源 | 规则 | source | confidence |
|---|---|---|---|---|
| 1 | 用户纠正 | 用户在模型行手动打标签 | `user` | high（覆盖一切） |
| 2 | 对端元数据 | `GET {base}/models` 声明的 input/output 模态 | `metadata` | high |
| 3 | 官方目录 | 模型 id 命中 models.dev / Pi 内置目录（含 vision / image 标记） | `catalog` | medium |
| 4 | 未知 | 都没有 | `unknown` | low（灰态） |

硬约束：
- **不按名字含 "Jev" / "system-one" 判定 classifier 协议**；classifier 只能是（a）官方目录里明确的分类器模型，或（b）用户在自定义服务里显式声明的 classifier 声明（协议 + 模型 id）。
- **不做隐式付费 probe**：载入模型只打 `GET /models`（免费目录），不做逐个模型的真实推理探测。真实调用只发生在用户显式点「测试连接」或实际使用。
- 识别不确定时界面明示「未知，可纠正」，不假装已知。

## 5. Legacy 迁移（无损、可回退）

迁移是**加法**：旧 settings key 一律保留（`customProviders` / `customHeaders:<id>` / `imageProviders` / `imageKey:<id>` / `defaultImageModel` / `visionModel` / `fastComputer` / `subagentModel:<agentId>` / `defaultModel` / `defaultThinking` / `defaultImageModel`）。统一 registry 是这些旧数据的**派生视图**，不删除、不重置。

```
migrateLegacyModelSettings(input): {
  services: ModelServiceDto[];      // 派生
  settingsPatch: Record<string,unknown>;  // 只写新 key（modelServices:v1 等）
  warnings: string[];
}
```
- `input` 只经**公开读取器**（settings 读取 + 既有 `CustomProviders` 的 `readKey` 回调）拿数据；**不读 `secrets.ts` 实现、不读 SDK 钥匙串实现、不读真实用户 key 明文**。
- 幂等：重复执行结果一致；已迁移则跳过。
- 旧 key 保留 ≥ 两个发布周期；期间统一 registry 与旧路径双读，写入以统一 registry 为准。
- 迁移不丢：services / pool（`subagentModel:*`）/ thinking（`defaultThinking`）/ image providers / keys（凭据仍走原存储，不复制不落明文）。

## 6. 最小 Metadata DTO（我负责定义，registry agent 实现）

```ts
export type ModelCapability = "chat" | "vision" | "image" | "classifier";
export type CapabilitySource = "metadata" | "catalog" | "user" | "unknown";

export interface ModelCapabilityDto {
  capability: ModelCapability;
  source: CapabilitySource;
  confidence: "high" | "medium" | "low";
  verifiedAt?: number;          // 显式测试通过的时间（可选，不代表付费 probe）
}

export interface ModelEntryDto {
  id: string;                   // 对端模型 id
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinking?: string[];
  capabilities: ModelCapabilityDto[];
}

export interface ModelServiceDto {
  id: string;
  name: string;
  kind: "official" | "custom" | "local";
  icon?: string;                // provider-icons key
  baseUrl?: string;             // official 可空
  configured: boolean;          // 有可用凭据（不暴露内容）
  source?: string;              // stored / env / runtime …
  models: ModelEntryDto[];
  counts: Record<ModelCapability, number>;
  references?: ProviderReferences;   // 复用现有引用统计
  local?: LocalRuntimeDto;      // kind=local
}
```

**Registry 接口**（registry agent 实现；UI 只消费）：
```
GET    /api/model-services                         → { services: ModelServiceDto[], capabilities: ModelCapability[] }
POST   /api/model-services                         # 添加（official/custom/local）
PUT    /api/model-services/:id                     # 改名 / baseUrl / 凭据
DELETE /api/model-services/:id                     # 带 references 影响说明
POST   /api/model-services/:id/fetch-models        # 显式载入模型（免费 GET /models）
PUT    /api/model-services/:id/models/:modelId/capabilities   # 用户纠正（source=user）
POST   /api/model-services/:id/models/:modelId/test          # 显式测试（可能计费，前端提示）
GET    /api/model-services/:id/local               # kind=local 状态
```

> 兼容：现有 `/api/models/*` 与 `/api/models/custom*` 继续可用，统一 registry 是其上层聚合，不破坏既有 e2e / 单测。

## 6.5 实际操作测试（受控 CUA 任务，优先项）

**与 API 诊断的区别**：API 延迟只能回答「服务连得上、多快」；「模型适不适合操作电脑」必须跑一次**真实受控任务**。

**流程**（专用隔离页 / 窗口）：
1. 用户点「实际操作测试」→ 选**测试电脑**（assistant / host）。
2. 展示**步骤预览 + 费用提示**（cloud Jev 可能计费；local 无费用）+ **前置条件校验**（permissions / VM ready）→ **用户明确确认**才启动（不偷偷开、不偷偷装）。
3. 在**专用测试窗口**里经 CUA 正式链路跑受控任务：`observe → candidate → classify → fresh click → verify`。
4. 全程**不碰真实用户 appdata**；**失焦立即 abort**；**cancel 释放本次测试自有资源**（不影响用户其它会话）。
5. 报告：`success / 总时长 / errors / retries / mainFallback`，**不是单个 p50**；API 时延只作诊断附注。

**ActualTaskTestDto**
```ts
interface ActualTaskTestDto {
  kind: "controlled-cua-task";
  target: "assistant" | "host";
  steps: { id: string; label: string }[];      // observe/candidate/classify/fresh-click/verify
  success: boolean;
  totalMs: number;
  errors: { step: string; message: string }[];
  retries: number;
  mainFallback: number;                        // 快速模型失手、回退主模型的次数
  preflight: { permissionsOk: boolean; vmReady: boolean; confirmedByUser: boolean };
  samples: number;                             // 样本有限
  verdict: { level: "recommended" | "caution" | "not_recommended"; advisory: true;
             reason: string; accuracyNote: string };   // 仍允许用户选择
  apiLatency?: { p50: number; p95: number };   // 仅诊断
}
```

**接口**
```
GET    /api/actual-task-test/preflight?target=assistant|host   → 前置条件（permissions/vm/费用）
POST   /api/actual-task-test/start   { target }                  → { taskId }（用户已确认）
GET    /api/actual-task-test/:taskId                             → ActualTaskTestDto（进度 / 结果）
POST   /api/actual-task-test/:taskId/cancel                      → 释放自有资源
```
- 报告文案：使用 / 谨慎 / 不建议 + 「样本有限，不代表普遍准确」；**不取消 permission、不禁用**，用户仍可继续用。

## 7. 本地 Laya：安装 / health / API 诊断契约（交主协调派子任务）

**LocalRuntimeDto**
```ts
export interface PhaseDto { state: "idle"|"downloading"|"verifying"|"done"|"error"|"cancelled"; percent: number; bytes?: number; total?: number; speed?: number; error?: string; }
export interface LocalHealthDto {
  status: "ok" | "degraded" | "unavailable";
  checkedAt: number;
  cpu: { label: string; cores?: number; baseline: true };
  gpu: { vendor: "apple"|"nvidia"|"amd"|"intel"|"none"; backend: "mps"|"cuda"|"xpu"|"cpu"|"none";
         available: boolean; label: string; source: "probe" };   // 实际探测，不是安装时猜
}
export interface LocalRuntimeDto {
  installed: boolean;
  ready: "not_installed"|"installing"|"offline_ready"|"ready"|"error"|"stopped";
  offlineReady: boolean;
  taskId?: string;
  phases: { env: PhaseDto; weights: PhaseDto; verify: PhaseDto };
  health?: LocalHealthDto;
  platform: { os: string; arch: string; support: "baseline"|"conditional"|"experimental"|"unsupported"; note: string };
}
```

**接口**
```
GET    /api/model-services/:id/local
POST   /api/model-services/:id/local/install                 → { taskId }  # 一键下载（自动地址+token，用户无需 key）
GET    /api/model-services/:id/local/install/:taskId         → LocalRuntimeDto（三阶段进度）
POST   /api/model-services/:id/local/install/:taskId/cancel
POST   /api/model-services/:id/local/install/:taskId/resume
POST   /api/model-services/:id/local/install/:taskId/retry
POST   /api/model-services/:id/local/install/:taskId/stop
DELETE /api/model-services/:id/local                         # 卸载（前端 confirm）
GET    /api/model-services/:id/local/health                  → LocalHealthDto
POST   /api/model-services/:id/local/benchmark               → { taskId }   # 仅 synthetic choice，无副作用
GET    /api/model-services/:id/local/benchmark/:taskId        → BenchmarkDto（可取消）
```

**API 诊断 DTO**（只诊断连接与推理时延，**不作为适用性结论**）
```ts
export interface ApiDiagnosticDto {
  kind: "api-latency";
  device: string;
  load: { at: number; note: string };   // 当前负载，仅当时
  samples: number;
  successRate: number;
  p50: number; p95: number; p99?: number; unit: "ms";
  verdict: { level: "ok" | "slow"; advisory: true; reason: string; budgetMs?: number };
  notCuaSpeed: true;               // 明确不代表整个 CUA 速度
}
```
- 预算：`benchmarkBudgetMs` 可配置；默认给**可解释默认**，advisory 不阻断。
- 慢：只提示，**不禁用、不取消 permission**。
- 云 Jev 前弹**可能计费**提示；local 无费用。
- **适用性结论一律来自 §6.5 的实际操作测试**，API 诊断只作附注。

## 8. 平台支持矩阵（源码必须定义真实支持）

| 平台 | CPU 基线 | 加速 | 支持级别 | 说明 |
|---|---|---|---|---|
| macOS Apple Silicon | ✅ | MPS | `baseline` | Laya local 推荐 |
| Windows + NVIDIA | ✅ | CUDA | `baseline` | |
| Intel Mac | ✅ | 旧栈 | `conditional` | 仅 CPU / 旧框架，性能不保证，明示 |
| AMD GPU | ✅ | XPU | `experimental` | CPU baseline，XPU 实验 |
| Windows ARM | — | — | `unsupported` | **明示不支持，不假装成功** |

## 9. 分工与实施步骤（小步 commit，不 push/tag）

| 步骤 | 负责 | 产出 |
|---|---|---|
| S0 设计 + 契约 + 进度 | 本任务（已完成） | 本文 + `progress-snapshots/model-settings-unified.md` |
| S1 UI 契约与原型（纯前端 fixture） | 本任务 | 统一模型服务组件 + 添加服务 + 能力标签 + 折叠，`Select`/`Modal`/`useConfirm` 复用，390 / 键盘 / Esc / focus |
| S2 Registry DTO + 迁移 | registry agent | §6 接口 + `migrateLegacyModelSettings` |
| S3 Laya 安装 / health | 安装子任务 | §7 前半 |
| S4 实际操作测试 + API 诊断 | benchmark 子任务（主协调派） | §6.5 受控 CUA 任务测试（优先）+ §7 诊断 |
| S5 UI 接 API（去掉 fixture 开关） | 本任务 | 真实 registry 接入 |
| S6 电脑设置快速/生图统一 | 本任务 + registry | 每机独立偏好、fallback |

## 10. 边界与禁令

- **不改** shared credential backend / `secrets.ts` / SDK 钥匙串实现；不引入明文；不重置用户配置。
- 测试所有 node **先强制 tempdata**（内存 `CredentialStore`，`test/setup.ts` 隔离 `5a4614f` 必须已含）；不跑真实 API 收费 / 桌面 VM / App 安装。
- 只做**专项** typecheck / build / UI 测试，不全量。
- 未支持能力用**灰态 + 说明**，不假成功。
