# 本地语音多模型：前端消费契约（已按 backend DTO 对齐）

> 状态：**前端已实施**（分支 `local-asr-model-choice-ui`，基 `release-candidate-validation` = `dcce520`，beta.25 公开版；**未 push / 未 tag / 未打包**）。
> 本文记录前端实际消费的**最终 DTO 行为**，已与 backendowner 的 `local-asr-multi-model`（`packages/server/src/local-asr/{routes,catalog,service}.ts`）对齐；不再是待确认草案。
> 既有冻结合同 `docs/design/local-asr-api.md`（旧 `/api/local-models/asr/sensevoice/*`，保留为存量导入入口）继续有效。

## 0. 红线（沿用既有）

- 不新建第二套下载服务：安装/下载走现 `downloads` 注册表与 `downloads.changed`；组件页 / 语音页两个入口**同一个 job**（stable id `asr:<modelId>`）。
- 硬件档位**由后端从 os metadata 算**（`process.platform` / `process.arch` / `os.totalmem()` / `os.cpus()`），前端不猜、不要求用户先设 CPU/RAM/GPU。
- 不声称任何性能数字：内存门槛是**估算**，必须标「未实测」；用户**可选比建议更大的档位**（不做硬门槛）。
- 许可结论不模糊：`cleared` / `unresolved` / `prohibited` 默认可见；`unresolved`（SenseVoice）不新增同意勾框绕过，只保留既有「自行导入合法权重」。
- 前端**不写死模型清单**：正式可选项全部来自 `GET /api/local-models/asr/catalog`。

## 1. 读：`GET /api/local-models/asr/catalog`

```ts
interface LocalAsrCatalog {
	hardware: { os, arch, cpuCores, memoryBytes, tier: "light"|"balanced"|"high"|"unknown", tierNote };
	runtime: { engine: "sherpa-onnx", version, python, depsBytes: number|null, depsNote };
	recommendedId: string | null;
	models: LocalAsrModelView[];
	notes: string[];
}

interface LocalAsrModelView {
	id: string;                 // 稳定 modelId（也是 voiceSource.model、权重目录名）
	provider: string;           // voiceSource.provider（local-paraformer / local-whisper / local-sensevoice）
	family: string; variant: string;
	name: string; nameEn: string;
	languages: string[];
	note: string;
	tier: "light"|"balanced"|"high";      // 推荐档位（单一值）
	tags: ("light"|"balanced"|"high")[];  // 兼容数组
	recommended: boolean; recommendationReason: string;
	available: boolean; unavailableReason: string | null;
	weightsBytes: number; depsBytes: number|null; depsNote: string;
	suggestedMemoryBytes: number; memoryNote: string;
	capabilities: string[];     // 真实模型事实（如「原生输出（含标点 / 大小写）」「无标点」），原样展示
	multilingual: boolean;
	license: LicenseDisclosure; // licenseName/termsVersion/decision/redistribution/attribution/links/restrictions/reason/acceptValue
	source: { source: AsrSourceMeta; model: { id, repo, revision, files: {path,size,sha256}[] } };
	installed: boolean;
	selected: boolean;          // 服务端算的「当前来源就是它」
	running: boolean;
	install: LocalAsrInstallView;
	runtime: LocalAsrRuntimeView;
}

interface LocalAsrInstallView {
	state: "not_installed" | "installing" | "installed" | "failed";
	phase: string | null;        // 稳定枚举：preflight|uv|venv|engine|weights|verify|activate|rollback|done
	phaseLabel: string | null;   // 中文阶段名（后端给，前端不自己映射）
	received: number; total: number | null; percent: number | null;
	error: string | null;
	installedAt: number | null;  // epoch ms
	source: "download" | "import" | null;
	jobId: string | null;        // = 统一下载注册表 stable id `asr:<id>`
	attempt: number | null;
}
```

要点：
- **一次请求拿全**：档位推荐、体积、依赖、内存估算、许可、来源、安装态、运行态、`selected` 都在 catalog；前端不额外请求 `/source`、`/status` 才能渲染选择器。
- `install.total === null` → 前端画**不确定进度条**（`phaseLabel` + `.pa-dl-bar.indet` 动画），不画假百分比、不卡 99%。
- backend 会把 `install` 投影进统一下载注册表（`asr:<id>`）；前端按 `downloadId`（默认 `asr:<id>`）合并 `downloads.changed` 的实时进度，两个入口同一份。

## 2. 写：按模型 id 路由

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/local-models/asr/models/:id/install` | body `{ acceptLicense?, source?: "download"\|"import", importDir?, intent?: "install"\|"install_and_use" }` |
| POST | `/api/local-models/asr/models/:id/cancel` | 取消进行中的安装 / 下载（有界回滚） |
| POST | `/api/local-models/asr/models/:id/select` | 切到该模型（停旧 worker；忙时拒绝） |
| POST | `/api/local-models/asr/models/:id/start` / `stop` / `pause` / `resume` / `idle` / `update` | 生命周期（lazy，idle TTL 沿用 90s） |
| DELETE | `/api/local-models/asr/models/:id` | body `{ confirm: true }`，只删自己目录 |
| GET | `/api/local-models/asr/models/:id/status` | 单模型 status（catalog 的子集，轮询用） |

- `install` 只负责**装**；来源写入见 §3。许可门槛在 `precheckInstall` 同步判定（HTTP 4xx）。
- 旧 `/api/local-models/asr/sensevoice/*` **保留**，语义不变（存量导入 / 已装用户）。

## 3. 「安装并使用」的 intent 与 stale 语义（**服务端权威**）

- 语音页「安装并使用」= `POST install { intent: "install_and_use", acceptLicense }`。
- 后端在**装完且选择自安装开始后未变**时写「用本地」来源（`selectionAtStart` 对比，防迟到 job 覆盖后来的 cloud 选择）。**前端不自己 late PUT**，只看 catalog 的 `selected` 显示「使用中」。
- 用户在安装期间改选云端 / 另一个模型：改选通过既有 `PUT /api/audio/asr/source`（前端显式动作）写入；后端发现选择已变即**不写**，UI 因此 `selected=false`，不显示「使用中」。
- 关面板 / 刷新：安装 job 在服务端继续，装完按同一规则写来源，**不留用户手配**（无需前端 pending 持久化）。
- `PUT /api/audio/asr/source` 失败：前端重新拉取服务端实际来源回滚（`VoiceSettings` 既有逻辑），不留下假「使用中」。
- 已安装但未选中 → 前端「使用这个模型」调 `POST /api/local-models/asr/models/:id/select`（后端内部同样走 `selection.write` 写来源 + 启停 worker，忙时拒绝）。**前端不另造写 source 的路径**（避免两处同时写 / 迟到覆盖）；状态一律以 catalog `selected` / `GET source` 为真。
- 许可分级（后端 `18478d4`）：`license.agreementRequired`；MIT/Apache-2.0（Paraformer / 4 个 Whisper）为 `false` → 不弹「我同意」、**不传 `acceptLicense`**、正常展示署名与许可链接即可一键装；SenseVoice `unresolved` 为 `true` 但仍禁下载（仅自行导入，不洗白）。

## 4. 前端拆分（本树 ownership）

- 新增 `apps/web/src/local-asr-api.ts`：catalog / 写接口 + `normalizeLocalAsrCatalog` 对齐层（字段名与后端一致时近恒等；缺字段给安全缺省；结构不对 → `ok=false`，UI 明确说不可用）。
- 新增 `apps/web/src/local-asr-intent.ts`：显示格式化（十进制体积 / 档位标签 / 内存「估算，未实测」）+ 显式「使用」的 seq 守卫 + 统一下载进度合并（纯函数，可单测）。
- 新增 `apps/web/src/hooks/useLocalAsrCatalog.ts`：拉 catalog、订阅 `downloads`、安装态 1s 轮询、`selected` 翻转时通知语音页刷新、install/use/cancel/start/stop/update/remove。
- 新增 `apps/web/src/components/LocalAsrModels.tsx`：`Select`（不用原生 select）+ 推荐/体积/依赖/内存/许可 + 「安装并使用」/「使用」+ 进度/取消/重试 + 详情折叠（来源 / 运行态 / 启停 / 删除）。
- `VoiceSettings.tsx`：「本地」tab 顶部挂 `LocalAsrModels`；`onVoiceSourceChanged` 时刷新状态徽标；旧 `LocalSenseVoiceCard` 保留在下方（存量导入 / 许可待确认），`voice-local-use` 行不动。
- 复用 `ui.tsx` 的 `Select` / `Help` / `Button` / `Badge`；进度条复用 `.pa-dl-bar`。不改 `ModelServices.tsx`、`Downloads.tsx`、共享下载 API。

## 5. 已确认（原「待确认」项结果）

1. catalog 字段接受；`tier` 单值 + `tags` 兼容数组；推荐由后端按硬件档位算。
2. 按模型 id 路由 `models/:id/*`（旧 sensevoice 前缀保留为兼容入口）。
3. `jobId` = 统一下载注册表 stable id `asr:<modelId>`；两个入口同一 job。
4. `phase` 稳定枚举 + `phaseLabel` 中文名由后端给；`total: null` = 不确定进度条。
5. 正式清单（本批 5 个，均 `cleared`）：`paraformer-zh-2023-09-14-int8`、`whisper-base-int8`、`whisper-small-int8`、`whisper-turbo-int8`、`whisper-large-v3-int8`；SenseVoice 保留但 `unresolved`（正式入口关闭，仅导入）。Qwen 未 pin SHA 不进目录。

## 6. 验证与未验证边界

- **纯逻辑单测** `e2e/local-asr-models-frontend.test.mjs`（6/6）：catalog 归一（snake/camel、缺省、结构不对）、indeterminate 进度、intent seq 守卫、下载进度合并、十进制体积格式化。
- **UI fixture** `e2e/local-asr-models-ui.mjs`（`page.route` 拦 `/api/**`）：真实前端代码渲染 5 个服务端模型；安装并使用（`intent=install_and_use`，cleared 不传 `acceptLicense`，不确定进度条）→ 装好 `selected` 显示使用中；改选云端后装完不 late 覆盖；已装未选中「使用这个模型」调 `/select`；取消；失败重试；390 不溢出。截图 `evidence/local-asr-models-ui/`。
- **真实 API 契约 smoke** `e2e/local-asr-catalog-real.mjs`：用内存 launcher + tmp DATA/WORKSPACE 起本仓库真实 server，`GET /api/local-models/asr/catalog` 真实 JSON（6 模型，含真实权重 pin）喂进 `normalizeLocalAsrCatalog` 全过（`ok=true`、id/provider/tier/许可/`source.revision+files` 齐全、`agreementRequired` 真值正确）。本树已合并后端 `18478d4`，即真跑通过。
- **未验证（如实）**：真实下载 / 校验 / 启动 / 转写（不装大权重、不用真实麦克风 / GPU）；真机 App；全量 `e2e/run.mjs` / 全量 `npm test`。UI 里的模型 name / 说明是 fixture，**不代表真实权重已在本机跑过**；能力标签以 catalog 返回为准，不按研究报告臆断。
