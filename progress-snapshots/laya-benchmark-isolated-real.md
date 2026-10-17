# 真实 Laya 完整 benchmark（隔离 daemon + 真实隔离浏览器）

> 2026-10-17，worktree `laya-benchmark-snapshot-fix`（HEAD `35574ef` + 本轮改动），未 push / 未 tag / 未打包。
> 设计契约见 `docs/design/fast-model-benchmark.md` §9.6–§9.7；脚本 `scripts/laya-benchmark-isolated-harness.mjs`（`npm run smoke:laya-benchmark`）。

## 做了什么

按 §9.6 的验收方法，一次跑完“环境已修 + 真实 Laya 模型质量”两件事，**没有**拿脚本 chooser 冒充模型验收：

1. 先断言本进程是原生环境（白名单只看 `HOME` / `CFFIXED_USER_HOME` / `TMPDIR` 三项，不打印其它 env）。
2. 起**本次独占**的 CuaDriver daemon：独立 `PIA_DATA_DIR`（socket 落在 `…/host-control/cua-open.sock`）、独立 `CUA_DRIVER_BROWSER_PROFILE_ROOT`；环境用生产 `nativeLaunchEnvForChild`，macOS 经 LaunchServices `open -n -g -a <官方签名 CuaDriver.app> --env HOME=… --args serve …`。
3. 用**生产同一套** `hostMcpCommand()`（`mcp-env-launcher.mjs`，`inheritEnv:false`、环境全量替换）连它；`createInvokeBenchmarkDriver` 真实走 `browser_prepare{allow_launch,isolated_new}` → `list_windows(prepared_pid)` → `get_browser_state` bind → `browser_navigate`（fixture + nonce）→ `get_browser_state{semantic_v2}` 取 pin `snapshot.id` → `browser_click{ref}`。
4. 真实 Laya：经生产 API 停原 runtime（16GB 不同时热两个模型），用生产 `LocalLayaManager` 在**自有 data dir** 起本次 runtime（自有端口 + 自有 token；权重来自本机已物化目录的 **clonefile 副本**，不写回原目录、不读生产 token / DB），经生产 `buildChooser()`（systemone → `models.classify`）+ `selectFastAction()` 跑完整 4 题；`finally` 停自有 runtime 并用生产 API 恢复原 runtime。
5. 每题记 decision / confidence / latency / fallback / 派发动作 / 双证据（fixture 机器状态 + 独立 UI 观测）；被阈值拦下时额外用同一个生产 chooser 记一次“本来想选谁”（**只诊断、不执行、不计入结果**）。

## 结果

证据：`evidence/laya-benchmark-real/report-2026-10-17T12-34-52-131Z.json`（含 raw chooser 诊断）、`report-2026-10-17T12-33-19-290Z.json`（同一流程无诊断）、同目录 `run-*.log`。

| 任务 | decision | confidence | 决策延迟 | 双证据 |
|---|---|---|---|---|
| pick-submit | fallback `low_confidence` | 0.3969 | 105 ms | unknown（未派发） |
| pick-city | fallback `low_confidence` | 0.1854 | 107 ms | unknown（未派发） |
| scroll-target | selected | 0.926 | 158 ms | **correct**（`clicked=deep-target` + UI「深度目标完成」） |
| dynamic-2step | fallback `low_confidence` | 0.2593 | 167 ms | unknown（未派发） |

- 预热 1 条（不计分）：`low_confidence 0.4673`，929 ms（冷启动）。
- 汇总：**1/4 correct，successRatio 0.25，fallback 3（全部 low_confidence），timeout 0，abstain 0，p50 107 ms / p95 167 ms**。
- 两次独立运行一致（第一次 0.3693 / 0.1165 / 0.9597 / 0.3204，同样 1/4）。
- 诊断（非生产决策）：3 条被阈值拦下的题，raw chooser 都指向**正确目标**（`提交` 0.6277、`城市` 0.1935、`下一步` 0.1813）→ 本地 Laya 在这批 synthetic 选择题上“选得对但没信心”，0.6 阈值让它按设计回退主模型；同题两次置信度也会变（`提交` 0.3969 vs 0.6277）。

## 隔离 / 清理证据

- 宿主与 daemon 白名单：`HOME=/Users/dengdeng`（= OS 账户家目录）、无 `CFFIXED_USER_HOME`、`TMPDIR` 不在合成根内；`nativeLaunchEnvProblems` 空。
- 独占 daemon 自报 pid `20158`（第二次 `24761`），`unrestricted`；工具清单含 `browser_prepare/browser_navigate/get_browser_state/browser_click/browser_pointer`。
- 生产 App 的 daemon（pid `22313`，`~/Library/Application Support/Pi Assistant/host-control/cua-open.sock`）**未被停止、未被复用**；生产 socket 文件仍在。
- 隔离浏览器：prepared pid `20461` / window `17463` / `target_id bt-238383f8-…` / `tab_id tab-e5420be6-…` / pin `p1`；结束后进程已退出。
- Laya：baseline `running pid 7991 port 60869` → 停 → 自有 runtime（token 只记摘要）→ 恢复后 `running pid 27010 port 50418, health ok, device mps, registered local-laya/multilingual`。
- 结束时无本次遗留进程 / socket（`daemonLeftoverPids:[]`、`socketExistsAfterStop:false`）；scratch 目录 2.1 MB（权重副本已删）。

## 本轮脚本自检发现的两个真实坑（已修）

1. **unix socket 路径长度**：macOS `sun_path` ≈ 104 字节。默认 scratch 落在 `/var/folders/…/T/pia-laya-bench-<长 ISO 时间戳>/…` 时 socket 路径 135 字节 → daemon 直接 bind 失败，症状只是“20s 内不就绪”。改成短根 `/tmp/pia-lb-<owner>-<base36>` 并在启动前显式断言长度。
2. **`pgrep -f "--socket …"` 被当成选项**：`--socket` 以 `--` 开头，pgrep 会按长选项解析 → 匹配 0 个进程，误报“无法证明归属”。改成 `pgrep -f -- "…"`。

## 边界（不得宣称）

- 「钥匙串弹窗已修好」**仍未证**：本轮没有弹窗，但只有一次运行、没有系统弹窗日志，不能当永久修复结论。
- 只有 4 个固定 synthetic 任务、单机（Apple 芯片 macOS arm64）、单一 checkpoint `multilingual`；不据此给 Laya 整体能力 / 准确率结论。
- 系统 TCC 授权、Intel / Windows / Linux、真实 GPU、其它 checkpoint、真实付费模型、全量 `npm test` / 全量 `e2e/run.mjs` 均未跑。
- 与生产 `benchmark-host` 唯一的实现差异：熔断作用域按任务分开（否则前几条 fallback 会把后面几条直接熔断成 `circuit_open`，扭曲每题结论）；已写进 report 的 `model.circuitKeyScope`。
