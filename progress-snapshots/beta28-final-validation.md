# beta.28 候选：最终整合与验收

> 本轮工作树：`release-candidate-validation`（本任务独占）。合并检查点见 [beta28-integration-merge-checkpoint.md](beta28-integration-merge-checkpoint.md)。
> 起始候选 HEAD `6d6c1ee`（= 已公开 tag `v0.1.0-beta.27`）。本文只写**实际跑过什么、结果如何、哪些没验**。
> 环境：Node `v24.20.0`（`/opt/homebrew/opt/node@24`；系统默认 PATH 无 node，node@25 缺 dylib 不可用）。

## 1. 合并的六组分支（`--no-ff`，按序）

| # | 分支 | HEAD | 合并提交 | 说明 |
|---|---|---|---|---|
| 1 | `laya-benchmark-selection-fix` | `9eb23c2` | `9003055` | 基准测试「点哪条测哪条」；快速模型列表随注册表变化刷新 |
| 2 | `voice-incremental-input` | `9f61f1f` | `631456b` | 分段增量按序发射 / 有界队列 / 重试租约；真实音量 |
| 3 | `mobile-chat-history-performance` | `1f6f4b5` | `f3e8f3c` | 手机首屏有界 + 压缩 / WS 去重；引用跳远改 context 窗口 |
| 4 | `chat-content-overflow-fix` | `d4c5899` | `dad9600` | 表格按可用宽度排版 + 局部横滚 |
| 5 | `subagent-composer-navigation` | `17f0652` | `f456c58` | 子代理思考控件移入输入栏 + 同会话切换 |
| 6 | `ui-consistency-motion` | `e47bac8` | `0ccadf4` | UI 一致性 / 动效 token / Steps 完整展开 / Select 键盘 / reduced-motion |

- 六组分支 HEAD 与预期**逐一核对一致**，`git rev-list --count HEAD..<branch>` 全为 **0**（无漏合并）。
- 文档冲突一律**逐段保留双方**（现公开状态段 + 各候选事项段），未用 `-X ours/theirs`。
- 代码文件自动合并抽查：`base.css` 的 `--pa-dur-*` / `.pa-history-window` / `.pa-voice-level` / `.pa-steps-list{display:grid}` / `.pa-scroll-x` 同时在位；`http.ts` 的 `settings.changed` 与 JSON gzip `compress` 同时在位。

## 2. 本轮新增改动（合并之后）

- **提问卡片（ask_user）改版**（用户本轮要求）：选项由横向 chips 改为**一行一个**、整行可点、文案左对齐、长文案自然换行，推荐标 / 选中勾固定右侧；桌面与手机同结构，已回答历史卡片同 render。
  - 改动：`apps/web/src/components/Cards.tsx`（选项正文包一层 `.pa-opt-label`）、`apps/web/src/themes/base.css`（`.pa-opts` 统一纵向、`.pa-opt` 整行 + 换行、`.pa-opt-label` 占据剩余宽度）。
  - 不改：传输、`allowFreeText`、提交行为、已回答语义、权限档位。
- **发布范围改为全平台含 Intel**（用户本轮明确）：`.github/release-scope.json` → `scope: "all-intel"`；`scripts/release-scope.mjs` 支持 `all-intel`（归一成 `all` + Intel）；`release.yml` 的 dispatch 选项加 `all-intel`，注释与说明同步。机制见 [../docs/design/release-scope.md](../docs/design/release-scope.md)。
- **修两个还没跑过的 e2e 脚本自身的 bug**（见 §4.3 / §4.4）：产品行为正确，是脚本读错接口形状 / 探针挂错位置。

## 3. 阶段 1：类型与构建

| 项目 | 命令 | 结果 |
|---|---|---|
| 服务端类型 | `npm run typecheck -w @pi-assistant/server` | **exit 0** |
| 网页类型 | `apps/web` 下 `tsc --noEmit -p .` | **exit 0** |
| 网页构建 | `npm run build -w @pi-assistant/web` | **成功**（vite 8.3.4，2528 modules，产出 `index-*.css` / `index-*.js`，预压缩 .gz） |

## 4. 阶段 2：定向服务端单测

启动方式与 `npm test` 一致：`node --import tsx --import ./test/setup.ts --test --test-concurrency=1 <files>`，并额外把 `HOME` 指到临时目录、`npm_config_offline=true`。`test/setup.ts` 强制把 `PIA_DATA_DIR` / `PIA_WORKSPACE` 指向进程专属临时目录并 `PIA_OFFLINE=1`。
**未跑全量 `npm test`。**

| 组 | 测试文件 | 结果 |
|---|---|---|
| 手机聊天 / 压缩 | `messages-pagination`、`message-replies-http`、`static-compression-http`、`rooms` | **31 / 31 通过**（压缩 7 项：静态 JS gzip / 不带 gzip / HEAD / Range 206 / index.html gzip+no-cache / API JSON gzip+Vary / 二进制不二次压缩） |
| Laya 基准 + 路由 | `fast-computer-benchmark-model`(6)、`-host`(13)、`fast-computer-benchmark`、`-window`、`local-laya-routes`、`local-laya-register` | **56 / 56 通过** |
| 语音 | `voice-incremental`(30)、`voice-asr`(19)、`voice-source-http`(9)、`voice-input`(16)、`local-asr-multimodel`(20)、`-license`(10)、`-manager`(22)、`-transcribe`(7) | **133 / 133 通过**（含按 index 保序发射 / 积压硬上限 / 重试租约 / 来源 version CAS） |
| 发布范围 | `node --test scripts/release-scope.test.mjs` | **5 / 5 通过**（新增「`all-intel` 传 `intel=false` 也必须进 Intel」与「仓库配置 scope 必须是显式取值」） |

> 注：`scripts/release-scope.test.mjs` **不在** `npm test` 里，要手动跑。

## 5. 阶段 3：浏览器 e2e（串行，一次一个）

运行前先构建 `apps/web/dist`。全部使用 `/Applications/Google Chrome.app` + `playwright-core`，headless。
用仓库里的超时包装 `scripts/run-with-timeout.py` 跑（`python3 scripts/run-with-timeout.py 200 -- node e2e/xxx.mjs`），超时/异常会对整个进程组发 SIGTERM→SIGKILL，避免留孤儿。

| # | 脚本 | 结果 | 耗时 |
|---|---|---|---|
| 1 | `e2e/mobile-chat-pagination-ui.mjs` | **8 / 8 通过** | 14.8s |
| 2 | `e2e/chat-content-overflow-ui.mjs` | **全部通过** | 11.1s |
| 3 | `e2e/subagent-composer-navigation.mjs` | **通过**（修脚本后） | 17.4s |
| 4 | `e2e/ui-consistency-motion.mjs` | **全部通过**（修脚本 + 新增 G 段后） | 9.1s |
| 5 | `e2e/voice-incremental-ui.mjs` | **全部通过**（16 项） | 31.2s |
| 6 | `e2e/voice-input-ui.mjs` | **全部通过**（42 项） | 8.0s |

要点：

- **#1 手机聊天**：首屏只拉 `limit=50`（不是旧版 300）；上滑用复合游标 `before/beforeSeq` 且锚点回填不跳；引用跳远是**一次有界 context 窗口**（`m1..m26`）而不是把沿途 120 条全加载；前向分页到最新无洞无重（`m1..m76`）；「回到最新」恢复最近一页（`m71..m120`）；10k 历史跳最早只发一次有界 context、不进 DOM；历史窗口里新 WS 消息不跨 gap 合入，只计数提示，回到最新后可见。**原先「连续加载 m1..m120」已改成窗口式语义，不再逼全量。**
- **#2 表格溢出**：桌面 2000 / 1280 / 1100 + 手机 390；5 皮肤（glass/warm/pixel/noir）× 明暗 + 自定义 DIY 主题；三列表格按可用宽度排版、最后一列可见、真溢出时局部横滚 + 常显滚动条 + 键盘可聚焦。
- **#4 UI 一致性**：A) 运行中 20 步长列表展开**不被裁**（长步骤高度超过旧 420px 上限，证明修的是真问题）、用户收起后新流式步骤**不把它重新弹开**；B) 已完成默认收起可展开；C) 动效挂在正确的类上且不覆盖 inline transform；D) 应用内 Select 的 ↑↓/Enter/Esc/点外部/焦点回触发器；E) `prefers-reduced-motion`：spinner 停转仍留强调色半环、shimmer 停转不留透明字、modal/menu/fold 无进入动画；F) 390 与桌面 × 4 主题 × 明暗不横向溢出；**G) 新增问题卡片断言（16 项）**：选项 top 逐行递增、整行宽、文案左对齐、长文案在选项内换行不越界、390 无整页横向滚动、推荐标在右、已回答卡片保留 picked 且非选中项禁用。截图 `evidence/ui-consistency-motion/G-question-{desktop,390}.png` 已识图核对。
- **#5/#6 语音 UI**：本地分段增量「边说边出字」且每段唯一 requestId、停止前已出 ≥2 段、停止只等尾段、取消保留已出文字且不再发请求、真实音量条停止后消失；云端**保持整段一次请求**（不因增量拆成多次最小计费）；SenseVoice 仍在列表且一键安装可用、许可标「本地自用可下载」、不显示冗余同意框。

### 5.1 修过的两个脚本 bug（产品行为正确）

- **`subagent-composer-navigation.mjs`**（该分支 commit 自述「新增未运行的 DOM e2e」，首次实跑暴露 3 处脚本问题）：
  1. `GET /api/subagents/:id` 返回 `{ subagent, messages }`，脚本按扁平字段读 `detail.model_provider/thinking` → `entry` 恒为空、断言假失败；改为 `detail.subagent.*` 并加 `assert.ok(entry)`。
  2. 子代理面板打开时主会话 `.pa-chat` 是 `display:none`，脚本却往隐藏输入框写草稿 → 改为「先回主会话写草稿 → 再进子代理 → 再返回」验证草稿不丢。
  3. 关闭面板用 `page.getByTestId("subagent-detail").count()===0`，但已打开的 tab 仍挂载在 DOM（只是隐藏）→ 改用**可见性**计数 `panel.count()===0`。
- **`ui-consistency-motion.mjs`**：reduced-motion 探针元素挂在 `document.body`，而规则是 `.pa-app *`（`body` 不是 `.pa-app` 后代）→ 探针命不中规则、两个断言假失败；改为把探针挂进 `.pa-app`。

## 6. 本轮**未验**（如实，不要当成已通过）

- **未跑全量** `npm test`（757 项）与全量 `e2e/run.mjs`（约 25 分钟）。
- 浏览器脚本都是 **headless Chrome + fixture / mock**；**不代表真机 App、真手机（含隧道）、真实麦克风、真实云模型**。手机首屏性能数字若引用，来自模拟环境，与真机口径不同。
- **真实模型**：未重新下载 GB 级权重、未重新跑真实 smoke。语音真实证据沿用上一轮（**非本次实跑**）：`evidence/voice-incremental-real/report-2026-10-16T18-00-18.json`。时间口径按该报告与 `docs/design/voice-incremental-real-validation.md`：段 0 在**录音开始后 +7.2s（7011ms，stop 前）出字**、段 1 在 +13.8s（13793ms，stop 前）、tail 在 21388ms（stop 后 flush）；共 3 次请求、各自 1.05–1.91s、CPU、`health.modelId=sensevoice-small-int8`、stop 后 pid 回收、`lease=true`。**注意：这只能说链路与分段行为打通，不能声称「分段未增误差」**——其中一段文本与 baseline 有差异。
- **发布流程**：未在本地跑全平台构建（按用户要求由 CI 执行）；**没有真实推过 `all-intel` 的 tag**，`macos-15-intel` 实机与 Windows/Linux 实机未验；`release-scope` 只跑了纯逻辑单测与矩阵推导。
- **Intel**：CI 是否成功、耗时多久，本轮无数据。
- 未改 Pi SDK / `node_modules` / 私有接口。

## 7. 复现命令（可直接抄）

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
cd "<repo>/release-candidate-validation"

# 类型 + 构建
npm run typecheck -w @pi-assistant/server
(cd apps/web && ../../node_modules/.bin/tsc --noEmit -p .)
npm run build -w @pi-assistant/web

# 定向服务端单测（临时 HOME + 离线）
H=$(mktemp -d); (cd packages/server && HOME=$H npm_config_offline=true \
  node --import tsx --import ./test/setup.ts --test --test-concurrency=1 \
  test/messages-pagination.test.ts test/message-replies-http.test.ts test/static-compression-http.test.ts test/rooms.test.ts \
  test/fast-computer-benchmark-model.test.ts test/fast-computer-benchmark-host.test.ts test/fast-computer-benchmark.test.ts test/fast-computer-benchmark-window.test.ts test/local-laya-routes.test.ts test/local-laya-register.test.ts \
  test/voice-incremental.test.ts test/voice-asr.test.ts test/voice-source-http.test.ts test/voice-input.test.ts test/local-asr-multimodel.test.ts test/local-asr-license.test.ts test/local-asr-manager.test.ts test/local-asr-transcribe.test.ts)

# 发布范围单测 + 矩阵预览
node --test scripts/release-scope.test.mjs
node scripts/release-scope.mjs

# 浏览器 e2e（先构建 dist；**串行**跑，一次一个；用仓库自带超时包装避免留孤儿）
for f in mobile-chat-pagination-ui chat-content-overflow-ui subagent-composer-navigation ui-consistency-motion voice-incremental-ui voice-input-ui; do
  python3 scripts/run-with-timeout.py 260 -- node "e2e/$f.mjs" || break
done
```

## 8. 资源与清理

- **上一轮事故（非本次产生）**：机器 16GB，事故当时 15 分钟 load 到过 ≈ 92，并有一个跑了约 26 小时的遗留 `hindsight` 进程占 400%+ CPU。那是**上一轮孤儿测试 / supervisor 导致的事故**，不是本轮造成的；本轮开始时它仍在，**本轮没有杀它**（不是本任务起的进程，风险不归我）。
- 本轮自己的约束：**未跑任何全量测试、没有并行跑浏览器 / 构建 / 模型**，一次只跑一个脚本；每个重脚本都用 `scripts/run-with-timeout.py` 超时包装（超时 `killpg`）。结束时本机 load ≈ 7，无 `pia-test` / e2e 服务器残留。
- 本轮临时目录（可删）：`/tmp/pia-e2e-subagent-composer-navigation`（子代理 e2e 的 DATA/WS/HOME）、`/tmp/pia-probe-*`（只读探针）、`/tmp/pia-home-*`（定向单测的临时 HOME）。测试数据目录由 `test/setup.ts` 建在系统临时目录。
- 未碰用户真实数据目录 / 配置 DB / 钥匙串 / `secrets.ts` / 模型缓存大文件；未用模糊 `pkill` 杀用户 App。

## 9. 证据摘要（`evidence/` 不入库，关键数字抄在这里）

| 项目 | 证据路径（`evidence/` 不入库） | 关键数字 / 结论 |
|---|---|---|
| 手机聊天分页 / 窗口 | `evidence/mobile-chat-history-performance/` | 首屏 `limit=50`；引用跳远只发 1 次有界 context（窗口 `m1..m26`，不是 120 条）；前向分页 `m1..m76` 无洞无重；回到最新 `m71..m120`；10k 历史跳最早不进 DOM |
| 表格横向溢出 | `evidence/chat-content-overflow/` | 桌面 2000/1280/1100 + 手机 390；5 皮肤 × 明暗 + 自定义主题；表格宽 = 容器宽、最后一列可见、溢出时 `overflow-x:auto` + 常显滚动条 + `tabIndex=0` |
| UI 一致性与动效 | `evidence/ui-consistency-motion/`（含 `G-question-desktop.png` / `G-question-390.png`，已识图核对） | 长步骤高度 > 旧 420px 上限且展开不被裁；reduced-motion 下 spinner/shimmer/modal/menu/fold 均无动画；问题卡片桌面与 390 各 8 项断言全过 |
| 语音增量 UI | `evidence/voice-incremental-ui/` | 停止前已出 ≥2 段、每段唯一 requestId、停止只等尾段、取消保留文字、真实音量条停止后消失；云端只有 1 次整段请求 |
| 语音输入 UI | `evidence/voice-input-ui/` | 42 项：未配置不常驻提示、录音→停止→插入草稿不自动发送、取消不误发、切后台停轨、390 无溢出、SenseVoice 仍在列表且一键安装可用 |
| 语音真实链路（**上一轮，非本次**） | `evidence/voice-incremental-real/report-2026-10-16T18-00-18.json` | 见 §6「真实模型」 |
| 入库截图 | `docs/screenshots/100-subagent-switch-overview.png`、`101-subagent-composer-390.png` | 子代理切换列表 + 390 输入栏思考控件 |

## 10. 剩余待办 / 交接

1. **思考强度 7 档滑块**：只有设计稿（[../docs/design/thinking-strength-slider.md](../docs/design/thinking-strength-slider.md) + `-prototype.html`），**设计稿待确认，生产仍是原来的选择器（未合入）**。用户希望将来 7 档动画随各主题变化并纳入 AI DIY，但那部分依赖下面的 DIY 动效 token（**尚不存在**）。
2. **AI DIY 主题的动效参数**：manifest schema 里**还没有**动效字段，自定义主题改不了时长 / 缓动 / 光晕；7 档滑块的 `--mo-*` 旋钮也**尚不存在**。缺口与落地顺序见 [../docs/design/ai-theme-diy.md](../docs/design/ai-theme-diy.md)。
3. **发布**：范围已是 `all-intel`；主会话确认后再推 main / 打下一个未使用 tag（当前预计 `v0.1.0-beta.28`）。
