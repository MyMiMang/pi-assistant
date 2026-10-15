# Pi SDK 1.1.0 → 1.2.0 升级（设计 + 验收）

- 状态：**已合入候选** `release-candidate-validation`（合并提交 `bfd621a`，`--no-ff` 保留 `deps/pi-1.2.0` 的四个提交），未 push / 未 tag / 未打包。
- 约束：不改 Pi 本体 / 不 fork / 不改 `node_modules` 内上游文件 / 不 monkeypatch 私有接口；兼容逻辑只放自有 `pi-adapter` 与 `packages/ext-*`，只走公开 API。
- 本文自包含设计结论与验收；`packages/server/test/pi-1.2-*.test.ts` 是可执行的验收用例。

## 1. 依赖变更

三个包一致 `^1.1.0 → ^1.2.0`（`packages/server/package.json`），`package-lock.json` 锁精确 1.2.0。
锁文件差异只涉及 8 个 `@earendil-works/*` 条目：`pi-agent-core` / `pi-ai` / `pi-codemode` /
`pi-coding-agent` / `pi-mcp` / `pi-telemetry` / `pi-tui` 升 1.2.0，上游 1.2.0 移除了对
`@earendil-works/chord` 的依赖（锁里删除该条目）。没有其它依赖浮动。
`SessionManager.CURRENT_SESSION_VERSION` 仍是 3，会话 JSONL 无需迁移。

## 2. 唯一 breaking 与适配

1.2.0 的 `before_agent_start` 事件按 `messageType` 变成 union：

- `messageType: "user"` → 有 `prompt` / `images`（RPC prompt、`sendUserMessage`）
- `messageType: "custom"` → 只有 `message`（扩展 `sendCustomMessage({triggerTurn:true})` 触发的唤醒回合）

两处 handler 直接读 `event.prompt` 会编译不过、运行时在 custom 回合拿到 `undefined`：

| 文件 | 改法 | 语义 |
|---|---|---|
| `packages/ext-skills/src/index.ts` | `lastPrompt = e.messageType === "user" ? e.prompt : ""` | 只记用户原话；唤醒回合置空，避免后台唤醒顶替/继承用户输入去影响「要不要做成技能」的授权判断 |
| `packages/ext-memory/src/index.ts` | `const query = event.messageType === "user" ? event.prompt : ""` | 唤醒回合用空 query 调 `host.context`：仍注入 bootContext / 已记事实，只是不做本轮召回；不能 `return` 跳过（会连记忆块一起丢） |

`ext-computer` / `ext-connectors` 只读 `event.systemPrompt`（union 两支都有），不受影响。

## 3. 公开 API 面核对（对已安装包实测，不是只读 tarball）

| 包 | `.d.ts` 文件数 1.1→1.2 | 内容不同 |
|---|---|---|
| `pi-coding-agent` | 246 → 251 | 20 |
| `pi-ai` | 196 → 199 | 3 |
| `pi-mcp` | 18 → 18 | 5 |

三个包入口 `dist/index.d.ts` 的变化都是**新增导出**（`BeforeAgentStartUserEvent` /
`BeforeAgentStartCustomEvent`、`McpTransportSendOptions`），`pi-ai/models.d.ts` 只多一个可选
`baseUrl?`；没有删掉我们在用的符号。私有 import / 深链 0 个：只用三个包入口 + `pi-ai` 的
官方子路径导出（`compat`、`models`、`api/*`）。静态守卫见 `test/pi-sdk-boundary.test.ts`。

## 4. 1.2.0 上要盯住的 MCP / 模型行为

- **MCP 工具结果**：`content` 数组、`structuredContent`（对象 / 原始值 / null）都经 Pi 的
  `convertMcpResult` 归一化成模型可见内容；`content` 为空时回落到 `structuredContent` 的 JSON。
- **取消**：会话 abort 时 Pi 把信号透传到 `McpClient.callTool`，客户端发出
  `notifications/cancelled`（1.2.0 新增 `McpTransportSendOptions`）。
- **resources 不再预列举**：连接时不再阻塞地拉 `resources/list`；服务端即使挂住不回，
  `initialize` / `tools/list` / `tools/call` 也照常。需要资源时走 `list_mcp_resources` /
  `read_mcp_resource` 工具。
- **自定义模型服务 / models.json**：结构仍写入 Pi 的 `models.json`，由 Pi 的 TypeBox schema 在
  加载时校验；Key 只在凭据存储里，request-time 由 Pi 按 provider 解析（`models.json` 不含 Key /
  请求头值，只有 `${PIA_H_xxx}` 插值）。
- **系统提示稳定**：一轮里第一次工具调用之后的下一步，`systemPrompt` 与首步一致（不在中途重算）。

## 5. compat 基线 + 每周自动升级的语义（重要）

`packages/server/src/pi-adapter/compat.json` 的 `testedWith` 是**「已经跑过测试」的声明**。
`scripts/pi-update.mjs` 拆成两步：

- `node scripts/pi-update.mjs [版本|latest]`（bump）：升三包 + 同步 `third-party.json` /
  `THIRD_PARTY_NOTICES.md`（依赖事实），compat.json **只写 `target`（预期版本），不动 `testedWith`**。
- `node scripts/pi-update.mjs finalize [版本]`（默认已安装版本）：**测试通过后**才把 `testedWith`
  提升到目标版本。只有这一步会改 `testedWith`。

`.github/workflows/pi-latest.yml` 仍是「升级 → 跑 typecheck + 单测 + build + e2e → 通过才开 PR、
失败开 issue、不自动合并」，但把 `finalize` 放在**测试步骤之后、且仅当测试成功**才执行；失败时的
issue 正文明确写「`testedWith` 仍停在上一版（finalize 未执行）」。这样不会再出现「刚下载就宣称已测试」。
`scripts/check-pi.mjs` 在有 `target != testedWith` 时打印一条提示（待验证的升级目标）。

## 6. 验收（本轮实际跑了什么）

Node 24.19.0；依赖装在 `release-candidate-validation` 自有 `node_modules`（官方 `npm install
--ignore-scripts`，无源码 patch），未系统升级 Node。

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（server + apps/web） | exit 0 |
| `npm run check:pi` | `Pi 已安装 1.2.0 · 兼容基线 1.2.0 · npm 最新 1.2.0` |
| `npm run build -w apps/web` | 2507 模块，`vite build` 通过（原 feature 无回退） |
| `test/pi-sdk-boundary.test.ts` | 通过（无深链 / 无 `node_modules/` 路径） |
| `test/pi-compat.test.ts` | 5/5 |
| `test/pi-events-union.test.ts` | 2/2 |
| `test/pi-mcp-1.2.test.ts`（新增，A） | 3/3：真实本地 fake MCP（stdio）走 **Pi 会话 + 内置 MCP 扩展**；content 数组 / `structuredContent` null、42、对象；abort 触发 `notifications/cancelled`；`resources/list` 挂着不回也不阻工具发现 |
| `test/pi-1.2-custom-provider.test.ts`（新增，B） | 3/3：真实 loopback HTTP 中转 + 假 Key；`models.json` 不含 Key 且由 Pi 解析；新建 `PiModels`（模拟重启）+ `initModels()` reload 后目录仍在、假 Key request-time 解析；无凭据也能解析 schema |
| `test/pi-1.2-boot-context.test.ts`（新增，C） | 5/5：真实 Pi 会话 + `triggerHidden`；唤醒回合 bootContext 注入、context 收空 query；一轮内工具后 systemPrompt 不变、context 只调一次；唤醒回合 `skill_save` 的 `userText` 为空（不误授权）；`injectContext` nextTurn 可见、忙时 steer 在工具边界送达；abort 后会话不卡死 |
| 受影响定向测试（pi-sdk-boundary / pi-compat / pi-events-union / mcp / mcp-install / custom-providers / host-control / shared-computer + 上述 3 个） | **57 通过 / 1 失败 / 2 跳过**；唯一失败 `shared-computer`「合并脚本」是 macOS 自带 bsdtar 不支持 `--skip-old-files`，**升级前基线同样失败**，与 Pi 无关 |
| `node scripts/pi-update.mjs` 语义（临时目录 harness） | bump 只写 `target`、`testedWith` 不变；`finalize` 才提升；同版本幂等 |

## 7. 未验（明确边界，不 claim）

- 真实 MCP 服务器（cua-driver / 真实 http MCP 服务）：本轮只用本地 fake MCP。
- 真实云模型 / 真实自定义服务 Key：只用本地假 Key + loopback。
- 真实后台唤醒（proactive / 定时任务的真实触发）：本轮用 `triggerHidden` 驱动，未等真实定时。
- 全量 `e2e/run.mjs`、桌宠 e2e、安装包真机、真实 VM / 用户电脑：未跑。
