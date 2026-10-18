# 高级记忆健康与自动兜底（2026-10-19）

状态：已实现（未打包，待真机），见 decisions/0009

目标：高级记忆（Hindsight）一直可用，基础记忆只是最后兜底；出问题用户第一时间知道。**不改 Hindsight 本身**，只改我们的适配层（`packages/server/src/memory/hindsight/*`、`llm-proxy.ts`、`pi-adapter`），只用官方配置项。

## 根因（2026-10-13～16 用户 Mac 只读诊断）
| 现象 | 根因 | 修法（适配层） |
|---|---|---|
| reflect 第 2 轮起 502「`reasoning_text` must be passed back」；整理时 OutputTooLong | 记忆模型是思考模型（DeepSeek 思考模式），网关把上一轮的思考块丢了；思考还吃掉输出上限 | 网关按工具调用 id 缓存思考块，下一轮原样带回（只给同一个模型）；记忆别名调用 `reasoning: "lowest"`（能关就关，关不掉用最低档并给 8K 余量） |
| 召回中位 3.2s、p90 17s、最长 147s | 本地 flashrank 交叉编码器在 CPU 上约 0.1s/候选，user 库约 234 候选 | 官方 `HINDSIGHT_API_RERANKER_MAX_CANDIDATES=50`（本地重排序时）；两个库并行召回；召回查询改用最后一条真实用户消息（去掉群聊头） |
| 60 次 ONNX 启动崩溃（10-12～13） | 平铺目录里是符号链接，onnxruntime ≥1.20 拒绝 | 已在之前修；这次加：发现符号链接就当作没就绪、启动前换成真实文件；崩溃自动重启（已有 10s→5min 退避）并进健康状态 |

## 健康状态
`memory/hindsight/health.ts`：召回 / 反思 / 读整理好的记忆 / 记忆模型 / 附属进程每次结果进滑动窗口（20 次），汇总成 `ok / slow / failing` + 一句人话（`status().health`）。
- 连续 3 次失败（反思 2 次）或附属进程挂了 → failing；召回经常 >8s → slow。
- 变化时推 `memory.hindsight`（带 health）→ 设置里高级记忆卡角标（黄「变慢」/ 红「有问题」）+ 一句话，细节在 ? 里；设置入口和「记忆」标签上有小圆点（`/api/system.memoryHealth`）。
- 通知（`push.ts notify`，tag `memory-health`）：变 failing 发一次，同一问题 6 小时内不重复，问题变了马上提醒；恢复发一次「已恢复」；换用备用模型发一次。

## 自动兜底
- **备用记忆模型**（最多 3 个，复用模型下拉）：网关在同一请求内按顺序换下一个；主模型连续 3 次失败冷却 10 分钟（排到最后），冷却后自动再试主模型。密钥一直留在我们这边，不用 Hindsight 自带的多 LLM 配置。
- **附属进程**：崩溃 / 无响应自动重启（退避），状态进健康。
- **先基础、后补写**：Hindsight 不可用时写入照常进账本 + `memory_sync` 队列，召回退回基础记忆；恢复后自动补写，队列清空（`hindsight.test.ts`「运行中掉线…」）。
- **每轮自动写入**：一轮结束（`agent_end`）把真实用户消息 + 最终回复写进助理自己的库（`turn:` 文档，带分层标签；像密钥的不写；出错 / 中断不写）。

## 测试按钮
三步，每步显示通过与否和耗时：多轮工具调用（反思同款，验证思考回传）→ JSON 输出（事实整理同款）→ 真实召回（user 库）。

## 上游（2026-10-19 查 GitHub / 文档）
- 最新 **1.0.0**（2026-10-13）；我们 pin 0.10.3。1.0.0 的 breaking change 是拒绝「带 tag 范围的调用方」做整库操作，我们用租户 key，预计不受影响；我们遇到的问题 1.0.0 没有额外修复。
- 重排序候选上限：官方 `HINDSIGHT_API_RERANKER_MAX_CANDIDATES`（0.9.0 起，另有 `_LOW/_MID/_HIGH` 按预算）；0.10.3 有 `RERANKER_MAX_TOKENS_PER_CANDIDATE`、`RERANKER_LOCAL_TIMEOUT`。已用第一个。
- 中文全文检索：内置后端只支持欧洲语言分词；pgroonga / pg_search（jieba）需要外部 PostgreSQL，嵌入式 pg0 不行，且没有现成迁移（文档 multilingual 页、issue #1973）。决定：保持现状，中文靠向量那一路。
- 思考回传：PR #1253 只在 `HINDSIGHT_API_LLM_PROVIDER=deepseek` 时生效；我们是 `openai` 指向本机网关，所以在网关里修（已做）。

## 跟进上游
与 Pi 同一套（§5.15）：`scripts/hindsight-update.mjs`（`check` 看上游；`latest|<版本>` 一起升 Python 两包 + npm 两包、推 `exclude-newer`、同步 `third-party.json` / NOTICES）+ `.github/workflows/hindsight-latest.yml`（每周一：升级 → typecheck + 单测 + Hindsight 真机冒烟 → 通过开 PR、失败开 issue）。用户侧：App 更新后附属进程发现 pyproject 变了自动 `uv sync` 重装，界面 ? 里显示当前 Hindsight 版本。
