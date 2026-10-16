# 本地语音多模型：前端所需 catalog 契约（前端先行草案）

> 状态：**前端先行草案**（分支 `local-asr-model-choice-ui`，基 `release-candidate-validation` = `dcce520`，beta.25 公开版）。
> 本页只写**前端要消费的字段**，用来和 backendowner（`local-asr-multi-model`）冻结 DTO 对齐；**不是**新后端实现，也不定义下载服务。
> 与既有冻结合同（`docs/design/local-asr-api.md`、`docs/design/settings-functional-backend.md`）兼容：旧 `/api/local-models/asr/sensevoice/*` 保留为存量导入入口。

## 0. 红线（沿用既有）

- 不新建第二套下载服务：安装/下载走现 `downloads` 注册表与 `downloads.changed`，两个入口（组件页 / 语音页）**同一个 job**。
- 硬件档位**由后端从 os metadata 算**（`process.platform` / `process.arch` / `os.totalmem()` / `os.cpus()`），前端**不用 UA 猜**，也**不要求用户先设 CPU/RAM/GPU**。
- 不声称任何性能数字：内存门槛是**估算**，必须能标「未实测」。
- 许可结论不模糊：风险与限制（含 SenseVoice 适用范围待确认）默认可见，不用「我已阅读同意」折叠遮盖。
- 正式默认**优先已明确许可**的 catalog 项；SenseVoice 保留为可选项 + 存量导入，不隐藏既有功能，也不把手工导入当新主方案。

## 1. 读：`GET /api/local-models/asr/catalog`

```ts
interface LocalAsrCatalog {
	hardware: {
		os: string; // "darwin" | "win32" | "linux"
		arch: string; // "arm64" | "x64" ...
		cpuCores: number;
		memoryBytes: number; // os.totalmem()
		tier: "light" | "balanced" | "high" | "unknown";
		tierNote: string; // 中文一句话，说明档位怎么来的 + 「估算，未实测」
	};
	runtime: LocalAsrRuntimeView; // 共享引擎（sherpa-onnx）安装态；权重之外另计
	recommendedId: string | null;
	models: LocalAsrModelView[];
	notes: string[]; // 平台/未实测边界声明
}

interface LocalAsrModelView {
	id: string; // 稳定 id，作为安装路由参数，如 "sensevoice-small-int8"
	family: string; // 家族，如 "sensevoice" / "paraformer"
	variant: string; // 变体，如 "int8" / "fp32"
	name: string; // friendly 中文名（用户看得懂）
	nameEn: string; // 英文原名（署名/对得上权重页）
	languages: string[]; // ["zh","en",...]
	note: string; // 中文多语说明（一两句，别塞技术细节）
	tags: Array<"light" | "balanced" | "high">; // 轻量 / 均衡 / 高质量
	recommended: boolean; // 由后端按 hardware.tier 算
	recommendationReason: string; // 「你这台机器推荐它」的一句话
	available: boolean; // 本平台能不能装（平台预检）
	unavailableReason: string | null;
	weightsBytes: number; // 权重体积（用于「下载 weights 体积」）
	depsBytes: number | null; // 依赖/运行环境另计体积（未知就 null + depsNote）
	depsNote: string; // 「另需下载运行环境…」
	suggestedMemoryBytes: number; // 建议内存（估算）
	memoryNote: string; // 「估算，非实测；只用 CPU」
	license: LicenseDisclosure; // 同 /source 的 license 结构（name/termsVersion/decision/redistribution/attribution/links/restrictions/reason/acceptValue）
	source: ModelSource; // 同 /source 的 source + model.files（repo/revision/sha256）
	installed: boolean;
	install: LocalAsrInstallView; // 该模型自己的安装/下载态
	runtime: LocalAsrRuntimeView; // 该模型 sidecar 运行态（lazy 启动，不常驻）
}

interface LocalAsrInstallView {
	state: "not_installed" | "installing" | "installed" | "failed";
	phase: string | null; // 稳定枚举：preflight|uv|venv|weights|verify|activate|rollback|done
	phaseLabel: string | null; // 中文可读阶段名（后端给，前端不自己映射）
	received: number;
	total: number | null; // null = 总量未知 → 前端 indeterminate 进度条（不是没条）
	percent: number | null;
	error: string | null; // 可读失败原因（不是 generic badge）
	installedAt: string | null;
	source: "download" | "import" | null;
	jobId: string | null; // 与 downloads 注册表同一个 job id → 复用统一下载进度
}

interface LocalAsrRuntimeView {
	state: "stopped" | "starting" | "running" | "stopping" | "crashed" | "paused";
	pid: number | null;
	port: number | null;
	host: "127.0.0.1";
	restarts: number;
	lastError: string | null;
	healthOk: boolean;
	loaded: boolean;
}
```

要点：
- **一次请求拿全**：档位推荐、体积、依赖、内存估算、许可、来源、安装态、运行态都在 catalog 里，前端不额外请求 `/source`、`/status` 才能渲染选择器（旧 `/status` 仍返回同一 shape 供存量卡用）。
- `install.total === null` 时前端画**不确定进度条**（phase 名 + 动画），不画 8% 假进度、不卡 99%。
- `jobId` 让「组件页下载安装」和「语音页安装并使用」显示**同一个 job 的同一份进度**，无重复请求。

## 2. 写：按模型 id 路由（catalog 替换旧的 sensevoice 单例路由）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/local-models/asr/models/:id/install` | body `{ acceptLicense?, source?: "download"\|"import", importDir? }` → `{ ok, status }`（许可门槛同步 precheck 定状态码） |
| POST | `/api/local-models/asr/models/:id/cancel` | 取消进行中的安装/下载，回滚 staging |
| POST | `/api/local-models/asr/models/:id/start` / `stop` / `pause` / `resume` | 生命周期（lazy，idle TTL 沿用 90s） |
| POST | `/api/local-models/asr/models/:id/idle` | `{ seconds }` |
| POST | `/api/local-models/asr/models/:id/update` | 重装 + 原子切换 |
| DELETE | `/api/local-models/asr/models/:id` | body `{ confirm: true }`，只删自己目录 |
| GET | `/api/local-models/asr/models/:id/status` | 单模型 status（catalog 的子集，轮询用） |

- 旧 `/api/local-models/asr/sensevoice/*` **保留**（存量导入 / 已装用户），可内部转发到 `models/sensevoice-small-int8/*`；不 silently 改语义。
- `install` 只负责**装**：不改当前 ASR 来源。「装完就用」是前端在 PUT source 成功后自己做的**显式 intent**（见 §3），后端 PUT 仍是唯一来源真相。
- 组件页（`ModelServices` 本地段）只调 install，不调 source PUT。

## 3. 来源 intent 与 stale 语义（前端实现约定，复用 `PUT /api/audio/asr/source`）

- 语音页「安装并使用」= `install` → 轮询/WS 到 `installed` → `PUT /api/audio/asr/source` **显式 intent**；PUT **成功返回后**才把该项标「使用中」。
- PUT 失败：**回滚显示到服务端实际来源**（重新 GET source），清错误、可重试；不留下假「使用中」。
- 用户中途改选云端 / 另一个模型：**后一次 PUT 必须生效**，先前的安装完成回调**不得 late 覆盖**（用 intent 序号 + 当前选择校验，过期回调丢弃）。
- 云端安装/配置与本地无关；本地「已装但没选」不进「已装模型」以外的状态。

## 4. 前端拆分（本树 ownership）

- 新增 `apps/web/src/components/LocalAsrModels.tsx`：catalog 选择器 + 推荐标签 + 体积/依赖/内存/许可/来源 + 「安装并使用」/「使用」+ 进度/取消/重试。
- 新增 `apps/web/src/hooks/useLocalAsrCatalog.ts`：拉 catalog、订阅 `local-asr.changed` / `downloads.changed`、安装态轮询（仅 installing 时）、intent 序号 & stale 防护。
- `VoiceSettings.tsx`：「本地」tab 挂 `LocalAsrModels`，去掉手写 `LocalSenseVoiceCard` 直连（改为由新模块统一渲染），保留旧来源状态徽标逻辑。
- `ModelServices.tsx`：**只把原 `LocalSenseVoiceCard` 段拆出 / re-export**，不动其余；Layaowner 的 Laya 段并行小改，commit 要小、易合。
- 不碰 `Downloads.tsx` / HostControl / Desktop / 共享下载 API / backend types；统一进度条复用 `pa-dl-bar`（如需导出交 Layaowner 对接，别复制）。
- 不用浏览器 native `<select>`：复用 `ui.tsx` 的 `Select`。

## 5. 待 backendowner 确认（回主转达）

1. catalog 字段名/结构是否接受；`tier` 的分档阈值与 `recommendationReason` 由谁写。
2. 是否按模型 id 路由（`models/:id/*`）而不是继续单例 sensevoice 前缀。
3. `jobId` 是否就是 downloads 注册表 id；安装是否直接注册进同一个 registry（两个入口同一 job）。
4. `phase` / `phaseLabel` 取值表；`total: null` 的 indeterminate 约定。
5. 正式 catalog 首选哪几个「许可明确」的模型（research owner 的 3 档清单），以及各自 license 字段来源。

## 6. 未验证边界

- 本页是**前端先行草案**；backend DTO 落地前，UI 用**真实 API fixture**（`page.route` 拦 catalog）验证渲染与 intent，不把 UI label 当模型能力。
- 未跑真机下载 / 启动 / 转写；不发虚构模型当真实部署。
