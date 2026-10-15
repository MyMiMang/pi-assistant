# 本地 Laya 一键安装：后端 API 契约（v1）

> 状态：**契约冻结稿**（后端 local-laya-runtime 分支）。UI owner 按此对接；未经协商不要改路径与字段名。
> 依据：`research/laya-one-click-cross-platform-feasibility.md`。**不声称任何性能数字，不把「已安装」当「能用 GPU」**。

## 1. 路由总览

全部挂 `localOnly`（本机回环），前缀 `/api/local-models/laya`：

| 方法 | 路径 | 作用 | 触发方式 |
| --- | --- | --- | --- |
| GET | `/api/local-models/laya/status` | 读状态（平台 / 安装 / 运行 / health / 注册） | 轮询 / WS `local-laya.changed` |
| GET | `/api/local-models/laya/platform` | 安装前预检：平台能力 + NVIDIA 驱动探测（只看不装驱动） | 打开设置页时 |
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
  registered: { provider: string; modelId: string; protocol: string } | null;  // 已注册进 classifier 目录
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

## 6. 与统一模型注册表的关系

Laya 启动后经 Pi 公开的 `registerClassifiers` 注册本地 provider，凭据只在进程内（`setRuntimeApiKey`，不落盘）。因此它会自动出现在统一注册表 `GET /api/models/registry` 里：

- provider id：`local-laya`；模型：`multilingual`；`type: "classifier"`；`protocol: "typesafe-system-one"`；`capabilities: ["classifier"]`。
- registry 的 `source` 目前归入 `pi-catalog`（因为它经 Pi 运行时注册）；**界面可用 provider id `local-laya` 识别为本地条目**，无需后端另加来源字段。
- 未启动 / 已停止时不会出现在 classifier 目录里（未就绪）；这是预期的 fail-closed 行为。
- 本模块**不新建 chat 模型**，也不自造 chat 模型入口。
