# 本地流式语音（默认本地语音）验证口径与限制

> 状态：**beta.29 候选树的口径基线（2026-10-17，未发布 / 未 push / 未 tag）**。
> 本文是**仓库内可读的受控版本**：其他 agent 拉到 repo、或在客户端看不到被忽略证据目录时，以这里为准。
> 旧证据文件（`evidence/local-asr-real-smoke/report-2026-10-17T03-28-23.json`、`03-30-05.json`、`03-31-33.json` 与同名 `smoke-*.log`）**按原样保留、不重写**；引用它们时必须连带本文。
> 相关设计：`docs/design/default-local-voice.md`；契约：`docs/design/default-stream-contract.md`。

## 1. 能证明什么（已验事实）

- **原生流式协议真的跑通**：真实 `sherpa-onnx` sidecar（`OnlineRecognizer.from_transducer`）按 200 ms 分帧喂音频，**调用 `end()` 之前**就收到**非空** tentative（分帧增量返回；空串不计数）。这是协议事实，**不是**人声到文字的延迟。
- **权重与运行身份**：4 个文件共 198,270,793 B，逐文件 size + SHA256 与 catalog pin 一致；`health.ok` / `modelId` 正确 / `loaded` 列出三个 onnx；`pid` 租约（lease）在 cancel 后释放、worker 不杀，stop 后 pid 回收。
- **生命周期**：`end` 出 final；`seq` 重放被拒（`asr_stream_seq_replay`）；endpoint 触发 3 次；committed 前缀自洽、final 与 committed 前缀一致。
- **离线边界（仅本进程）**：`scripts/local-asr-real-smoke.mjs` 在**当前 Node 进程**内拦截非回环 `fetch` 后复跑成功（外部请求 0）。**只证明这个 JS 边界没外请求**。
- **吞吐量级**：样例快速喂音频 RTF≈0.064 / 0.069（墙钟 / 音频）。**只是 unpaced decode 吞吐**，不是交互端到端延迟。

## 2. 不能声称什么（已撤掉的夸大写法）

| 旧写法（作废） | 实际是什么 | 现在只能这样说 |
|---|---|---|
| 「中英 CER 0 / 0」「官方样例对照 CER 0/0」 | `0.wav` 的旧对照串**没有可公开核对的来源**：该模型官方文档页只给 `1.wav` 示例，同页「昨天是 MONDAY TODAY IS THEY…」属**另一个模型**且是 `THEY` 不是 `LIBR`。`1.wav` 的对照串可核（官方文档 int8 段原样） | 「与上游文档的**模型示例输出**复现一致」（1.wav 可核，0.wav 无源 → 不给结论）。**不是准确率、不是中英质量、不是 CER 指标** |
| 「分别真实 zh / en 专项通过」 | `0.wav` 是**中英混说**，`1.wav` 是**中文夹 ALWAYS**，都不是纯语料 | 「官方两个 wav 各出一个段」；**独立英文语料、独立中文语料都没跑** |
| 「首字 3–6 ms」「firstPartial 3 ms」 | 取的是**第一条 tentative**，其中大量是空串；喂音频 unpaced | 「协议上在 `end()` 前就收到非空增量」；**实时节奏下的首非空文本时延未测** |
| 「禁网复跑、零外部请求」 | 只 monkeypatch 了当前 Node 进程的 `globalThis.fetch`，**没有**审计 Python sidecar 子进程网络 | 「**离线请求拦截条件下**本地复跑成功」；**不是系统断网 / 路由阻断** |
| 「RTF 说明交互延迟低」 | RTF 是墙钟 / 音频时长，喂音频不按实时节奏 | 只当 decode 吞吐量级；**不推交互延迟、不做性能承诺** |
| `decodeMs.p50 = 26 ms` | 旧脚本把 p95 估计算子挂在 `p50` 字段上 | 旧 json 不重写；只能当「量级」，不当分位数结论 |
| 调参 / 换机器更好 | 单机单样本 | **质量与速度都不做泛化承诺** |

**一句话**：只证明了「模型能加载、原生流式协议按段出字、生命周期与租约正确、本进程 fetch 边界下可复用已下权重」，**没有**证明准确率、中英文本质量、实时嘴到字延迟、系统级断网、跨平台可用。

## 3. 未跑 / 未验（不要写成已完成）

- 独立英文语料、独立中文语料、真实麦克风、噪声环境。
- 弱网 / 实时 pacing 下的首非空文本时延（脚本已能记 `firstNonEmptyMs` + `pacing:"unpaced"`，但**修了未重跑**）。
- 系统级（物理）断网；Python sidecar 子进程的网络审计。
- Windows / Linux / Intel Mac 实机；真手机与真实隧道链路。
- 默认模型**输出无标点**（不接付费补标点），这是产品事实，不是缺陷。

## 4. 本轮测试证据（主会话独立跑）

| 检查 | 结果 | 说明 |
|---|---|---|
| 服务端 `tsc --noEmit -p packages/server` | **exit 0** | 2026-10-17 |
| 网页 `tsc --noEmit -p apps/web` | **exit 0** | 同上 |
| 服务端定向单测（默认语音 / 权限 / 相关模块） | **75/75** | 主会话自己跑的定向集合，不是子代理自报 |
| 滑块纯逻辑 + 静态 DOM 夹具 `e2e/thinking-slider-frontend.test.mjs` | **27/27** | 无浏览器、无真实模型 |
| 子代理思考档位「加载中不误报不支持」`e2e/subagent-thinking-loading.mjs` | **18/18** | 真实服务端 + 真实构建 + Chromium，纯前端拦截 `/api/models` |
| 真实 198 MB 模型 smoke | 见 §1 / §2 | 旧 json 不重写；本文是口径 |

`npm test` 全量（757）/ 全量 `e2e/run.mjs` / 真机 App 全流程本轮**未跑**。

## 5. 系统权限（TCC）与稳定签名

代码**不能保证** macOS「辅助功能 / 屏幕录制」在每次更新后都不再询问。事实边界：

- 当前安装版 App 是 **ad-hoc 签名**（无 Team ID，DR 只有 cdhash），系统按签名身份记授权 → 每次构建可能被当成另一个 App，存在**重授权风险**。
- 本版只修了**应用启动侧**：电脑操作工具按实际授权挂载、启动失败有限次重试并按真实原因提示，不再把「驱动没就绪 / 还没授权」说成「权限被重置」。
- **稳定签名（Developer ID）有助降低重问概率，但不是「一签永不询问」**：签名后系统通常仍会再确认一次；而且**需要真实跨版本升级实测**才算验证过。本轮**没有**证书，没做这条验证。
- **notarization 不是 TCC 持久性的必要条件**：它是 Gatekeeper 的分发信任，和「系统记住授权」不是同一件事；不要把公证写成解决重授权的前提。
- 不采用：写 TCC 库、`tccutil reset`、自签 `security` 导入、伪造固定 identifier 保授权（已实测证伪）。系统权限弹窗仍由用户自己点。

## 6. 复现命令（本机 Apple 芯片 macOS，Node 22）

```bash
npm run build -w @pi-assistant/web                      # 网页构建
node --import tsx --test e2e/thinking-slider-frontend.test.mjs   # 27/27
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node e2e/subagent-thinking-loading.mjs                # 18/18（自建临时数据目录 + server 进程组清理）
PIA_SMOKE_MODELS=<model-id> PIA_SMOKE_BUDGET_MB=<MB> \
  node --import tsx scripts/local-asr-real-smoke.mjs    # 真实模型 smoke（手动，不进 npm test）
```
