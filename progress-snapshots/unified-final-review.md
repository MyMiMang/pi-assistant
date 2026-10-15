# unified-final-review：独立小收尾 review（P0 三项）

更新时间：2026-10-15（Asia/Shanghai）
树：`unified-final-review`（worktree，基 `unified-integration` 干净 HEAD `3bf2c01`）
状态：**本地提交，未 push / 未 tag / 未打包**；仅供主会话合入后统一发布。
边界：全程 Mock、内存凭据、临时数据目录；未碰系统钥匙串 / 真实 keys / config 历史 / `secrets.ts` 实现 / SDK 凭据实现；
未操作真实桌面、未下载 Laya、未装 App；未动任何 memory 树；语音只 research 未实现。

## 一、必要修复（已改 + 已跑测试）

### P0-1 生图 legacy Key 语义与引用安全 — `image-gen/index.ts`
- **`imageKeyMigrated` 不再谎报「已迁移」**：只有 Key 确实在统一凭据存储 / 引用别的服务（`keyStored !== "legacy"`）才为 `true`；
  仍只存在 legacy 加密设置的服务标 `false`。`migrateLegacyImageProviders` 幂等条件也随之改为按 `keyStored` + 该标记判定。
- **`keyOf` 在 `keyFrom` 时不再回退读本服务旧的 `imageKey:<id>`**：避免「引用 A 服务的 Key」时把本服务旧 Key 串到请求上。
- 桥接读取（legacy 密文原样保留、不复制明文）、`removeProvider` 只删自己名下凭据 / 清 legacy、`keyFrom` 不删别人 Key 均保持不变。

### P0-2 Laya sidecar 崩溃后未撤销 provider 注册 — `local-laya/manager.ts`
- sidecar **意外退出**（`onExit`）此前只把内存状态置 `crashed`，没调 `unregisterClassifier` → Pi 目录里会留下一个指向死端口的 `local-laya`。
- 现 `onExit` 显式 `unregisterClassifier(LAYA_PROVIDER_ID)`，并清 `health`。

### P0-3 benchmark 真实驱动读了不存在的字段，真实路径永远跑不起来 — `fast-computer/benchmark.ts` + `benchmark-driver.ts`
- 实测：cua-driver 0.35.4 的 `get_window_state` 只返回 `snapshot_id` / `element_token`（二进制串与官方 `mcp-tools/window-state.mdx` 均无 `window_token`）。
  驱动却读 `window_token ?? windowToken` → 恒为 undefined → `openFixtureWindow` 直接抛「读不到窗口身份 token」，真实 CUA 基准**一次都跑不起来**（此前只有假 driver 测试能过）。
- 修：驱动改用 `snapshot_id`（并在 `observedFrom` 同样回退 `snapshot_id`）；`windowIdentityMismatch` **不再要求 token 相等**
  （`snapshot_id` 每次读取都换新，相等不变量与真实语义冲突），改为「token 必须存在（证明读到了新鲜快照）+ prefix/pid/window_id/session/fixture_id 严格相等」。
  窗口被替换仍由 pid / window_id 变化拦住。

## 二、Review 发现（未修，交主会话决策）

### P0-3（真实可用性）
1. **`capable` 被硬编码为 `true`**：`benchmark-runtime.ts` 的 `createInvokeBenchmarkDriver({ capable: () => ({ ok: true }) })` 与 `benchmark-driver.ts`
   「拿不到独立受控窗口必须 false（fail-closed）」的设计/注释矛盾。结果：只要目标电脑可达就 `fixtureReady=true`，没有真实「能取得独立受控窗口」的证明。
   建议：实现真实能力探测（如目标 MCP 是否暴露浏览器开窗 / 受控窗口能力），拿不到证据则 blocked，但不写死永远 blocked。
2. **`scroll-target` 任务不可达**：基准白名单只允许 `click`，runner 也没有程序侧滚动；fixture 底部目标在折叠线以下，`goal` 要求「向下滚动后点击」。
   除非 `get_window_state` 的 AX 树把屏幕外元素也当可点候选，否则该任务结构性失败/unknown。建议：像 type / 下拉一样，把「滚动」作为程序侧固定动作（不计模型能力），或删除/改标该任务。
3. **助理电脑（`computer`）fixture 回调不可达**：fixture URL 与状态上报都基于 `http://127.0.0.1:${config.port}`。
   在助理电脑 VM 里 `127.0.0.1` 指向 VM 自己，页面加载不到、`fixtureId/nonce` 状态也 POST 不回宿主 store。需按目标提供宿主可达地址（VM → 宿主映射）。
4. **fixture 唯一性证据偏弱**：驱动用 `list_windows` 的 `title/url` 匹配 `fixtureId+nonce`；cua `list_windows` 对浏览器标签未必给 `url`，目前靠标题里的 nonce。可接受但建议以受控窗口工具返回为准。

### P0-2（Laya）
5. **权重无 SHA256 校验**：「校验」阶段只 `python -c "import laya"`；权重完整性依赖 HF `revision`（commit SHA）由 HF 端强制，本地无独立摘要校验。供应链上属于可接受，但「verify 通过」不等于权重字节校验通过，文档/UI 不应暗示已校验。
6. 其余（pinned uv + SHA256、下载进度、取消回滚 staging、只绑 127.0.0.1、token 只在进程内、卸载 canonical 校验、不自动装驱动）经代码 review 与既有测试确认无问题。

### P0-1（生图）
7. **`hasKey()` 与真实解析可能不一致**：`hasKey` 只看 `keyFrom/hasCredential/legacy`，若统一凭据存储里有 Key 但 `hasCredential` 未置位（例如别的路径写入），界面会显示「未配置」而实际能用。属只读状态展示瑕疵，非安全泄露。

### memory（仅报告，本 task 不负责）
8. `memory-scope-safety` 分支 `a43b55f`（reflect 源端隔离）已有代码但存在未知并发未提交的 promote / evidenceRefs WIP，**不得合入 WIP**；本树未动 memory。
9. 语音仅 research，未实现，本树未碰。

## 三、验证（本树实际跑过）

- 环境：Node `v24.20.0`（`/opt/homebrew/opt/node@24`；系统 node 25.8.2 因 simdjson 缺库不可用）、tsx、Mock、内存凭据、临时数据目录（`setup.ts` 强制覆盖 `PIA_DATA_DIR/PIA_WORKSPACE`）。
- 服务端 `tsc --noEmit -p .` → exit 0；网页 `tsc --noEmit -p apps/web` → exit 0。
- 定向单测（逐文件跑，全部 0 fail）：
  `fast-computer` 25 · `fast-computer-benchmark` 13 · `fast-computer-benchmark-host` 7 · `fast-computer-guard` 2 · `fast-computer-tool` 14 ·
  `local-laya` 9 · `local-laya-deps` 3 · `local-laya-register` 3 · `local-laya-routes` 8 ·
  `image-gen` 13 · `model-registry` 9 · `custom-providers` 10 · `vision` 4 · `isolation` 2 · `test-data-isolation` 2 → 合计 **124/124**。
- 新增/加强断言：
  - `image-gen`：legacy 服务 `imageKeyMigrated === false`；`keyFrom` 且引用目标无 Key 时不得用自己旧 legacy Key 顶上（返回 undefined）。
  - `local-laya`：崩溃后 `deps.unregisterClassifier` 被调用（`state.registered === null`）。
  - `fast-computer-benchmark` / `-host`：token 换新不再算失配；改为 window_id 变化 → fail-closed（`blocked`，0 执行）。

## 四、边界

- 未跑全量单测 / 全量 e2e；未跑 web `vite build`（本次未改前端）。benchmark 未在真实桌面开窗跑 CUA，`capable`/VM 回调问题即为此环境无法证实。
- 未 push / 未 tag / 未打包；不移动既有 tag；仅 Apple 芯片 macOS 由主会话统一发下一版。
