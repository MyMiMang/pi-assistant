# Laya 修后受控真实测量（2026-10-17，单次，`laya-benchmark-snapshot-fix` @ `26c5c51`）

只读 preflight + **一次**真实测量；未重跑、未改阈值、未改用户设置、未动 driver / SDK / 凭据、未 push / 未打包。

## 1. 前置（只读）

- 树：`laya-benchmark-snapshot-fix`，HEAD `26c5c51`，`git status` clean。
- 生产 App API `GET /api/local-models/laya/status`：`running pid 27010 port 50418`，`health.ok=true device=mps`，`registered local-laya/multilingual`，`version 0.4.8`。
- 机器上没有别的**本 owner 活跃重任务**（无 harness / supervisor / 新 Chrome）。存在**既有**遗留进程，均无本次归属、未动：
  - daemon pid `5245`（socket `/tmp/pia-laya-bench-2026-10-17T10-58-08-701Z/...`，旧轮残留）；
  - `laya-serve` pid `32630`（生产 env 路径，约 23h）；
  - `laya-serve` pid `31929`（旧 smoke 临时路径，约 1 天）。
- 安装版语义核对（只读公开库源码，未读凭据 / token / 权重）：
  `~/Library/Application Support/Pi Assistant/local-laya/runtime/env/lib/python3.12/site-packages/laya`（`laya-0.4.8.dist-info`）：
  - `common.py:791 answer_confidence` = `max(p)`；
  - `common.py:814 confidence_from_probs` = `1 - H/log k`（归一化熵，文档明写不能与 `max(p)` 同阈值）；
  - `confidence.py:38 jev_confidence` = `(max(p) - 1/n) / (1 - 1/n)`，单候选 1.0。
  与产品 `jevChoiceConfidence()`（`packages/server/src/fast-computer/choosers.ts:84`）公式一致；产品**单候选不合成**（返回 undefined 退回协议值）是既有明确选择，不影响本轮多候选任务。语义吻合 → 按放行执行。

## 2. 执行（唯一一次）

```
PATH=/Users/dengdeng/.local/node-v24.19.0/bin:$PATH \
PIA_BENCH_WATCHDOG_MS=540000 \
/Users/dengdeng/.local/node-v24.19.0/bin/node scripts/laya-benchmark-supervisor.mjs \
  --timeout-ms=720000 -- /Users/dengdeng/.local/node-v24.19.0/bin/node \
  --import tsx scripts/laya-benchmark-isolated-harness.mjs
```

- Node `v24.19.0`（明确全路径，PATH 含其目录）；`PIA_BENCH_RAW` **未设** → 无额外诊断请求。
- 开始 `2026-10-17T13:59:29Z`（上海 21:59:29），结束 `14:00:00.974Z`，**wall ≈ 31.5 s**；supervisor `exit=1`（分数不满分），`cleanup.failures=[]`。
- 原始证据：`evidence/laya-benchmark-real/report-2026-10-17T13-59-29-808Z.json`（tracked）；supervisor 日志 `evidence/laya-benchmark-real/supervisor-2026-10-17T13-59-29Z.log`（`*.log` 被 gitignore，原样留盘）；supervisor 状态 `/tmp/pia-lb-amv7oy7ejb00-mvcgqk6v/supervisor-state.json`。

## 3. 隔离与环境（实测）

- 服务进程：`HOME=/tmp/pia-lb-amv7oy7ejb00-mvcgqk6v/home`（非 OS 家目录）、`TMPDIR` / `PIA_DATA_DIR` / `PIA_WORKSPACE` 全在本次 scratch 根内；`homeIsOsAccount=false`。
- 原生边界（交给启动器的输入配置，非子进程实际环境）：`HOME=/Users/dengdeng`（= OS 账户家目录）、无 `CFFIXED_USER_HOME`、`strippedKeys=[TMPDIR,TEMP,TMP]`、`diverged=true`、`problems=[]`、`evidenceScope=input-config-not-actual-child-process-env`。
- MCP：生产启动器 `commandIsLauncher=true`、`inheritEnv=false`、`envReplaced=true`、socket 指向本次独占 daemon。
- 独占 daemon pid `31328`；驱动自有隔离浏览器 pid `31357` / window `17759` / target `bt-dd635e20-…` / tab `tab-7d697bb8-…` / pin `p1`。
- 自有 Laya pid `31340` port `57813`（token 只记摘要 `42b0c2bfcf88`，权重为已物化目录的 clonefile 副本）。
- 生产 Laya：baseline `running pid 27010` → 经生产 API **停一次**（`ok:true`）→ 结束恢复 `running pid 34607 port 58038, health ok, mps, registered local-laya/multilingual`（`14:00:00Z`，`attempts:[{ok:true,status:200}]`）。生产 daemon `22313` 全程未动。

## 4. 结果（生产 `selectFastAction`，threshold 0.6 / timeout 4000ms）

| 任务 | decision | 阈值比较值 gate（Jev 标度） | 选项概率 p | 协议 confidence（熵） | 决策延迟 | wall | 结果（双证据） |
|---|---|---|---|---|---|---|---|
| pick-submit（点「提交」） | fallback `low_confidence` | **0.5302** | 0.5973 | 0.4862 | 112 ms | 123 ms | unknown（未派发） |
| pick-city（下拉选「北京」） | fallback `low_confidence` | **0.4036** | 0.4888 | 0.2750 | 98 ms | 108 ms | unknown（未派发） |
| scroll-target（滚动后点「深度目标」） | selected | 0.8812 | 0.8981 | 0.7487 | 155 ms | 2692 ms | **correct**（machine `clicked=deep-target` + UI「深度目标完成」） |
| dynamic-2step（下一步→完成） | fallback `low_confidence` | **0.3558** | 0.4478 | 0.1972 | 149 ms | 165 ms | unknown（未派发） |

预热 1 条（不计分）：`pick-submit` fallback `low_confidence` gate `0.5302` / p `0.5973` / 熵 `0.4862`，1251 ms（冷启动；与计分那次数字相同，仅记录，不据此宣称逐位确定性）。

汇总：**1/4 correct、successRatio 0.25、fallback 3（全 `low_confidence`）、timeout 0、abstain 0、p50 112 ms / p95 155 ms**。

**与 §9.7 旧轮的对照（只作标度说明，不合并统计）**：旧轮 0.3816 / 0.1854 / 0.2593 是**归一化熵**；本轮同一族任务的 gate 升到 0.5302 / 0.4036 / 0.3558（概率 0.5973 / 0.4888 / 0.4478），仍全部 < 0.6 → 结论不变：**在这 4 个固定任务、这个 checkpoint、默认阈值下仍 3 题回退**。未下调阈值、未改用脚本 chooser、未额外发 raw 推理。

## 5. 清理与恢复（本次归属证明）

- 自有 daemon：`cleanup.daemon.stopped=true`，`found=[]`，`leftoverPids=[]`，停后 socket 不存在。
- 自有 Laya：`layaStopped=true`，`cleanup.laya={pid:31340, stopped:true, source:"already-dead"}`（worker 内已停，supervisor 复核）。
- 生产 Laya：worker 内已恢复 → supervisor `cleanup.restore.skipped="没有暂停过生产 Laya 或已恢复"`、`prodRestored=true`；**未重复 stop / start**。
- fresh 复核：`pgrep -f -- "--socket /tmp/pia-lb-amv7oy7ejb00-mvcgqk6v"` 无结果；`pgrep -f pia-lb-amv7oy7ejb00-mvcgqk6v` 无结果；`browser-profile/` 为空；无本次 Chrome 残留。
- 正常 API 复核：`running pid 34607 port 58038, health ok, mps, registered`。
- 系统钥匙串 / 权限弹窗：本轮**没有出现**，未点任何按钮、未动 security / 系统权限。

## 6. 边界（不得宣称）

- **不是完整 production benchmark**：4 个固定 synthetic 任务、单机 arm64、单一 checkpoint；熔断 key 按任务分开（生产 `benchmark-host` 是同一 key）；runner `retries=1` 是内部未选中诊断，`fallbackCount=0` 是基准不真的执行主模型回退，summary `fallbacks=3` 是 decision 计数。
- **`pick-city` 的 `afterSelect` 是程序固定下拉选择、`scroll-target` 的 scroll 是程序侧 `programAssist`**，都**不计入 Laya 能力**；模型只做有界 click。
- **主模型接管未执行**：harness 不跑会话主模型接管；fallback 链路只在单测里证到「工具返回回退」，**真实主接管仍未验**，没有接管速度 / 总耗时数据。
- fallback 的 3 题**未派发动作**，所以本轮**没有**可观测的误选执行；也不反推「本来选对了」。
- 不宣称 Laya 准确率；温度未拟合（`temperature=[1,1,1]`、无 `binning_map`）→ `max(p)` 偏 over-confident，阈值不能读成准确率。
- 「钥匙串弹窗已修好」仍未证（本轮无弹窗，但没有系统弹窗日志 / 因果证据）。
- 未跑全量 `npm test` / 全量 e2e；未测 Intel Mac / Windows / Linux / 真实 GPU / 其它 checkpoint / 真实付费模型。
