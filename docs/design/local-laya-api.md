# 本地 Laya 一键安装：后端 API 契约（v1）

状态：已废弃（Laya / 快速候选选择器已撤下，见 decisions/0005）

> 状态：**契约冻结稿**（后端 local-laya-runtime 分支）。UI owner 按此对接；未经协商不要改路径与字段名。
> 依据：`research/laya-one-click-cross-platform-feasibility.md`。**不声称任何性能数字，不把「已安装」当「能用 GPU」**。

## 1. 路由总览

全部挂 `localOnly`（本机回环），前缀 `/api/local-models/laya`：

| 方法 | 路径 | 作用 | 触发方式 |
| --- | --- | --- | --- |
| GET | `/api/local-models/laya/status` | 读状态（平台 / 安装 / 运行 / health / 注册） | 轮询 / WS `local-laya.changed` |
| GET | `/api/local-models/laya/platform` | 安装前预检：平台能力 + NVIDIA 驱动探测（只看不装驱动） | 打开设置页时 |
| GET | `/api/local-models/laya/source` | 只读来源元数据（版本 / revision / 许可证） | 打开设置页时 |
| GET | `/api/local-models/laya/logs?lines=200` | 最近日志（已脱敏，不含 token） | 用户点「查看日志」 |
| POST | `/api/local-models/laya/install` | 一键安装（提交后异步跑；用 status 轮询进度） | **用户显式按钮** |
| POST | `/api/local-models/laya/cancel` | 取消进行中的安装 / 下载 | 用户点「取消」 |
| POST | `/api/local-models/laya/start` | 启动 sidecar（按需） | 用户点「启动」或按需触发 |
| POST | `/api/local-models/laya/stop` | 停止 sidecar（停进程；不等于卸载内存） | 用户点「停止」/ 空闲策略 |
| POST | `/api/local-models/laya/update` | 更新到清单里的固定版本（原子切换，失败回滚） | 用户点「更新」 |
| DELETE | `/api/local-models/laya` | 卸载：停进程 + 删 own 环境 / 权重目录 | 用户确认后（body `{ "confirm": true }`） |

约定：
- 所有写操作返回 `{ ok: boolean, error?: string }` + 最新 `status`（成功时 `{ ok: true, status }`）。
- 冲突（如重复 install）返回 400 + `{ ok: false, error }`。
- 不支持平台：`install` 返回 400，`error` 为中文说明；`status.platform.support === "unsupported"` 时 UI 应置灰按钮。

## 2. status 结构

```ts
interface LayaStatus {
  platform: {
    key: string;                        // "darwin-arm64"
    os: string; arch: string;
    accelerator: "cpu" | "mps" | "cuda" | "xpu";   // 安装意图（不是实测）
    support: "supported" | "conditional" | "experimental" | "unsupported";
    torchBackend: "default" | "cpu" | "cu130" | "xpu";
    pins: string[];                     // 如 Intel Mac: ["numpy<2","torch==2.2.2","transformers==4.57.6"]
    reason: string;                     // 中文说明，直接可显示
  };
  install: {
    state: "not_installed" | "installing" | "installed" | "failed";
    phase: "idle" | "preflight" | "uv" | "venv" | "torch" | "laya" | "weights" | "verify" | "activate" | "rollback" | "done";
    received: number; total: number | null;   // 当前阶段字节（主要给权重阶段）
    error: string | null;                     // 已脱敏，可显示
    installedAt: number | null;
  };
  runtime: {
    state: "stopped" | "starting" | "running" | "stopping" | "crashed";
    pid: number | null;         // 仅我们自己的 sidecar
    port: number | null;        // 随机空闲端口
    host: "127.0.0.1";          // 固定回环，不默认暴露局域网
  };
  health: {                     // 运行时测量值；未启动为 null
    ok: boolean;
    device: string | null;                       // 实际计算设备（来自 /health）
    checkpointDevices: Record<string, string> | null;
    cpuFallbacks: { count: number; lastReason: string | null } | null;
    revisions: Record<string, string> | null;    // 实际加载的 commit SHA
    loaded: string[] | null;
  } | null;
  registered: { provider: string; modelId: string; protocol: string } | null;  // 进程内已注册（= 当前可用）
  configured: boolean;           // 已安装配置（重启后仍会注册）；与 registered 分开，停止 / 崩溃不改变它
  source: {                      // 界面「来源」标签
    project: string; repoUrl: string; weightsOrg: string;
    codeLicense: string; weightsLicense: string; version: string;
    reviewedRevisions: Record<string, string>;
  };
}
```

### 安全不变量（UI 不得依赖 status 拿 token）
- **status 里永远没有 token**，也不回显 baseUrl 里的凭据。
- token 只在 server 进程内存 + Laya 子进程环境；重启会重新生成并重注册。
- `host` 恒为 `127.0.0.1`，不提供「自动局域网开放」开关。
- `health.device` / `cpuFallbacks` 是**测量值**；UI 能力标签必须读它，不能只用 `platform.accelerator`。

## 3. install 请求体（可选）

```jsonc
{
  "cuda": false,          // x64 平台可请求 CUDA（需检测到 NVIDIA 驱动；缺失则回落 CPU）
  "xpu": false,           // Intel XPU，experimental
  "checkpoint": "laya-multilingual"   // 默认只下 multilingual；其余按需
}
```

## 4. WS 事件

`bus` 推 `{ type: "local-laya.changed", status: LayaStatus }`；UI 也可轮询 status（安装中建议 1s）。

## 5. UI 分工

- 「模型服务」页：安装 / 更新 / 停止 / 卸载 / 进度 / health 能力标签 / 来源与 revision。
- 「电脑 → 快速操作模型」页：仅从**已注册的 classifier 目录**里选（`local-laya · multilingual`）；未就绪置灰并提示去模型服务页装。
- **不把 Laya 当 chat 模型**（协议是 `/v1/systemone`，没有 OpenAI 兼容端点）。

## 6. 权重供应链完整性（下载后校验，通过才 activate）

一键安装的「校验」阶段不只看 `import laya`，还会对下载到**我们自己的 HF 缓存目录**里的每个文件做完整性校验：

- 固定清单在 `packages/server/src/local-laya/checkpoint-files.ts`：每个 checkpoint 的**必需文件 + 大小 + SHA256**。
- SHA256 来源：大文件（`model.safetensors`、`tokenizer/tokenizer.json`）取 HuggingFace **LFS oid**（`/api/models/<repo>/revision/<sha>?blobs=true`，公开、无需 Key、不下载权重）；
  小文件（config / tokenizer_config / rl_agent_config）在**同一 reviewed revision** 下取回后本地算 SHA256。
  绝不用 `main` / `latest` 的哈希去套旧 revision；升级 revision 必须重算清单。
- 校验方式：`verify.ts` 对每个文件**流式**算 SHA256 + 比对大小；缺文件 / 大小或哈希不符 → 抛错 → manager 回滚 staging、置 `failed`，**绝不产生半安装 ready**。
- 路径安全：**受信根是自有 HF 缓存内的目录，且可以有多个**（2026-10-17 扩）。
  - 主根：同 cache 根的 `hub/models--org--repo/`（旧实现把根设成 snapshot 目录，把自控 cache 的合法 blob 链接误报「符号链接越界」——beta.25 用户实报失败，已修）。
  - 额外根：自有 hub 缓存内的共享 `hub/blobs/`。本机已观察到真实缓存形态：较大的 LFS 文件是 `snapshots/<rev>/<file>` → `models--org--repo/blobs/<sha>` → `hub/blobs/<aa>/<hash>` 普通文件的**两层 symlink**；beta.26 只把 repo 目录当受信根，大文件因此被判「越界」、安装卡在校验（小文件通过，故不是所有文件都失败）。这不是某个用户的特殊部署，而是真实会出现的缓存落盘形态，产品校验必须承认它。
  - 防滥用：所有受信根的 realpath 必须落在**自有**缓存根（`hub/`）内（`trustRootBase`），某个根本身被换成指向外部的 symlink → fail closed；跨到任意用户目录、同前缀兄弟目录（如 `blobs-evil/`）仍拒绝。
  - **断链与真外跳分开报**：symlink 目标缺失（缺 blob / 缓存残缺）报「符号链接断链（目标缺失）」，跳过受信根的外跳才报「越界」，用户 / 日志能区分「没下完」和「有东西想读缓存外」。
  - 路径安全与根边界统一按 `/` 比较（`isSafeRelPath` / `containedIn`）：POSIX 绝对路径、Windows 盘符 / UNC / `\` 都收口，跨盘符直接拒绝；纯字符串判断，可离线单测（**不宣称 Windows 实机已验证**）。
- 辅助元数据（`README.md` / `.gitattributes`）标 `optional`：缺失不算失败；存在仍校验大小 / SHA256。`encoder/config.json`、`model.safetensors`、`tokenizer/*` 仍逐个严格校验，**不是跳过 symlink 放弃校验**。
- 校验通过后 `materializePinnedFiles` 把必需文件**物化成 staging 里的普通文件**（优先硬链接真实 blob，跨设备退回复制）并再核大小 / SHA256；`activate` 原子 rename 到生效目录。**不动 HF 缓存**，partial 保留。
- 只按清单 `allow_patterns` 下载，**不执行 checkpoint 仓库里的任何脚本**（safetensors-only；清单出现 `.py` / `.bin` 等直接判不安全）。
- 取消下载：保留 HF 缓存里的 partial（可续传恢复），但安装状态回到 `not_installed`，不会误判 ready。
- 复核清单：`npx tsx scripts/laya-checkpoint-digests.ts`（只读 HF 元数据 + 小文件，不下载 GB 权重）。

> 说明：清单里的 SHA256 已与公开 HF 元数据逐条核对一致；**未在真机上下载 GB 权重做过端到端实测**，因此「校验 / 物化链路在共享 blob 形态下成立」由离线小文件夹具证明，**不等于本机真下 GB 权重并启动 Laya 已验证**。
> 证据与推断分开：上文的「`snap → repo/blobs/<sha> → hub/blobs/<aa>/<hash>` 两层链接」是**本机只读观察到的缓存落盘形态**（一个具体证据）；「这是 huggingface_hub / Xet 官方普遍采用的布局」属于推断，本仓库**不以此作结论**，代码只按实际 realpath 落在自有缓存内判定。

## 7. 与统一模型注册表的关系

Laya 启动后经 Pi 公开的 `registerClassifiers` 注册本地 provider，凭据只在进程内（`setRuntimeApiKey`，不落盘）。因此它会自动出现在统一注册表 `GET /api/models/registry` 里：

- provider id：`local-laya`；模型：`multilingual`；`type: "classifier"`；`protocol: "typesafe-system-one"`；`capabilities: ["classifier"]`。
- registry 的 `source` 目前归入 `pi-catalog`（因为它经 Pi 运行时注册）；**界面可用 provider id `local-laya` 识别为本地条目**，无需后端另加来源字段。
- 未启动 / 已停止时不会出现在 classifier 目录里（未就绪）；这是预期的 fail-closed 行为。UI 用 `configured`（已安装）与 `registered`（进程内已注册）区分：没在跑也不显示成「没配置」，停止不删配置。
- 本模块**不新建 chat 模型**，也不自造 chat 模型入口。

## 8. 统一下载登记（Laya ↔ ASR 共用契约）

Laya **登记进统一「下载与组件」面板**（`packages/server/src/downloads.ts`，不新建 registry / controller）；
电脑页 Laya 卡与「下载与组件」页读同一个 job，避免二次安装。适配器 `packages/server/src/local-laya/download.ts`
只观察 manager 状态，不复制安装逻辑。通用契约（本地 ASR 直接复用，勿另写一套）：

- `registerDownload({ id, name, group, size, installed, start, cancel?, status?, hidden? })`
  - `installed()`：首屏「已下载 / 未安装」；`start()`：下载 / 重试；`cancel()`：取消（走各自 manager 的同一个 AbortController）；
  - `status()`：组件自己的阶段状态投影，字段 `{ state, received?, total?, detail?, error? }`，比内部计数权威。
- `followStatus(id, read, intervalMs?)`：轮询组件阶段 → Progress。**已知总字节 → 字节进度 / 百分比；未知 → 不定进度（界面 `pa-dl-bar indet`）+ 阶段文字，不编假百分比。**
- `notifyDownload(id, force?)`（**推荐给有自己状态事件的组件**）：在自己的 bus 事件里把 `status()` 投影转发给 `downloads.changed`，不用每项再起一个永久 `setInterval`；`force=true` 用于首 / 终事件（立即推，不走 500ms 节流）。Laya 已改用它（订阅自身 `local-laya.changed`），**不再全局轮询**；`followStatus` 保留给无事件源的组件按需用。
- 取消：`POST /api/downloads/:id/cancel`（服务端只调你登记的 `cancel()`）。
- **每个模型一个 id**（如 `asr:sensevoice` / `asr:<model>`）：两个官方权重可同时各占一行，不要用一条唯一 ASR 行藏真实选项。
- 复用既有 `downloadFile`（Range 续传 / sha 校验 / 原子改名）与 `watchDir`，不新下载引擎。
- Laya 的投影：`installed→ready`、`installing→downloading`、`failed→error`、未安装→`missing`；**只有 `weights` 阶段带真实 `total`**，其余阶段 `total=null`（不定进度）。

## 9. 运行时的本地权重来源（`LAYA_EXTRA_MODELS`）——已对公开源码逐行核对

`materializePinnedFiles` 物化出来的 `runtime/weights` 目录，`manager.start()` 用 Laya 的**公开环境变量**交给 sidecar
（`packages/server/src/local-laya/manager.ts` `start()`）：

```
LAYA_MODELS        = "multilingual"                                   # 只预加载我们装的这一个（默认会预加载全部三个）
LAYA_EXTRA_MODELS  = {"multilingual": "<dataDir>/local-laya/runtime/weights"}   # 把内置 multilingual 重指到本地物化目录
```

- `LAYA_EXTRA_MODELS` 缺失（没有物化目录）时不设，不改 sidecar 默认来源，避免指向空目录。

**2026-10-16 核对（不装 Torch、不下权重）**：所 pin 的 PyPI `laya==0.4.8` wheel（`__version__ = "0.4.8"`）
内公开源码：

- `laya/serve.py:672 _extra_models_option()`：把 `LAYA_EXTRA_MODELS` 解析成 `{名字: 源}`，源允许**字符串**（Hub repo id
  或**本地 checkpoint 目录**）或 `["repo","subfolder"]`；`:1124` 取用 → `:1131` `options["models"] = extra_models`
  → `:1132 Router(**options)`。
- `laya/router.py:791 register()` / `:881 _add()`：local path 源被接受（`:895` 会 `expanduser`，`:910` 存进 `models[key]`）；
  名字命中内置 checkpoint（`multilingual`）时**重指该内置项**，不是新增别名。已用该 wheel 的纯 Python resolver 实测：
  `Router(models={"multilingual": "/tmp/..."})` → `models["multilingual"] == "/tmp/..."`、`_split() == ("/tmp/...", None)`；
  不设时 `multilingual` 仍解析为 `("convaiinnovations/laya","multilingual")`（走 HF）。
- `laya/agent.py:575`：`model_dir` 存在时**不进** `snapshot_download`（`:581/:595` 只在路径不存在时下载 → 不会去 HF 其它 repo、
  也不会退回默认三个模型）；`:596` 的 revision pin 同样只在下载分支用。
- 本地目录读取的四个入口（**这就是固定清单必须覆盖它们的原因**，`test/local-laya-deps.test.ts` 有一条断言钉住）：
  `:611` `model_dir/rl_agent_config.json`、`:623` `model_dir/model.safetensors`、`:672 _load_tokenizer(model_dir/tokenizer)`
  （`:221`，目录存在则 `AutoTokenizer.from_pretrained(<本地目录>)`，否则才回落 `cfg["encoder"]`）、
  `:675 build_model(encoder_dir=model_dir/encoder, pretrained=False)`（`laya/common.py:707` 用 `encoder_dir` 本地 config，
  `from_config` 不下载权重）。
- digest pin 同样对本地目录生效（`agent.py:607 verify_digests(model_dir, expected_sha256)`）。

**结论**：这条本地链路是公开、真实存在的，**不是 unused mirror**，保留接线；同时也说明固定清单里的
`encoder/config.json` / `tokenizer/*` / `rl_agent_config.json` 是运行时真正会读的文件，不能删。

**未验（如实）**：没有真机装 Torch / 下 GB 权重 / 起真实 Laya，所以「0.4.8 在真机从该目录加载成功」仍未实测；
另注 Laya 加载时可能改写 `tokenizer/tokenizer_config.json`（`agent.py:61 _fix_tokenizer_config`，仅当字段需修正），
这会让该文件的字节与固定 SHA256 不再一致；当前 `checkpointSourcePath()` 只看 `rl_agent_config.json` 是否存在，
启动不会因此失败，但「运行时文件字节永远等于清单哈希」这条更强的话不成立（与 HF 缓存路径同样）。
