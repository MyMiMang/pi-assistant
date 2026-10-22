# AGENTS.md：给接手的 AI / 开发者（唯一规则来源）

本文件是项目**唯一**的规则来源。CLAUDE.md、GEMINI.md、`.cursor/rules/`、`.github/copilot-instructions.md` 都只是指向这里的指针，规则只在这里改。

## 开工前必读（按顺序）
1. 本文件。
2. [docs/HANDOFF.md](docs/HANDOFF.md)：现在的状态、正在做的事、待用户决定的事；接手的 AI 先读其中「接手说明」。
3. [docs/MODULES.md](docs/MODULES.md)：每个文件负责什么 + **必须复用的共用工具清单**。
4. 与任务相关的 [docs/design/](docs/design/) 设计和 [docs/decisions/](docs/decisions/) 决策。已有决策不能自己推翻，想改先问用户。
5. 数据流见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；需求和计划见 [docs/ROADMAP.md](docs/ROADMAP.md)；`docs/DESIGN.md` 是冻结的总设计参考。

## 这是什么
Pi Assistant：基于 [Pi](https://github.com/earendil-works/pi) SDK 的本地私人助理（多个助理、助理群聊、每个助理一台“助理电脑”、按权限操作用户电脑、微信/飞书/钉钉/企微/邮箱、记忆、技能、定时任务、MCP、图片生成、识图、桌宠）。
形态：本机服务（Node 22.19+）+ React PWA（电脑和手机同一套界面）+ Tauri 桌面程序；另有 Linux 服务器版。界面是中文。

## 硬规则 1：复用优先，先搜再写
- 写任何新函数 / 组件 / 接口前：先按 MODULES.md 找到对应模块，再 `rg` 搜关键词。提交说明或交付说明里写一句「复用了 X」或「搜过 X、Y，没有可复用的」。
- **禁止再写一份同功能实现。** 发现已有重复，在同一提交里合并成一份、改完所有调用方、跑相关测试。
- 不为单一实现加抽象层，不加没人用的配置 / 开关；UI 状态保持最简单（一段一个加载状态 + 一个保存错误）。
- 现成的例子：模型 / 思考强度 / Fast 一律用 `ModelPicker`；「?」说明用 `ui.tsx` 的 `<Help>`；折叠和「高级」区用 `<Fold>`；下拉用 `<Select>`（不用原生 select）；确认框 `useConfirm`；串行保存 `latest-write.ts`；下载 `downloads.ts`；审批和提问 `requests.ts`；停止词 `interject.ts`。
- 实在需要新写的，放进 MODULES.md 规定的位置，并在 MODULES.md 登记一行。

## 硬规则 2：每类逻辑放在哪
- HTTP 接口：`packages/server/src/routes/*`（`http.ts` 只组装）。
- Pi：只经 `packages/server/src/pi-adapter/`；给模型用的工具放 `packages/ext-*`（用 Pi 公开扩展 API）。
- Hindsight：只经 `packages/server/src/memory/hindsight/`。cua：只经 `host-control.ts` 和 `pia-cua-mcp`。
- 纯逻辑单独成文件（便于单测）；前端通用组件进 `ui.tsx`；跨端常量进 `packages/shared`。
- 单个源码文件不超过 600 行；已有的大文件只许变短（`scripts/check/size-baseline.json`）。

## 硬规则 3：不改上游本体，开发时手动升级
- **不修改 / 不 fork** Pi SDK、Hindsight、cua-driver、`node_modules`；不 monkeypatch 私有 API；版本固定，不改依赖版本。
- **不做任何自动升级**：App 里没有 Pi / Hindsight 的检查更新、提醒或后台升级，也没有自动升级的工作流 / Renovate。开发时看到上游新版，手动跑 `scripts/pi-update.mjs` / `scripts/hindsight-update.mjs` 升级、跑测试，再随 App 发布（App 自己的更新保留）。
- 上游的问题在我们的适配层里绕过，并记下「上游哪个版本修好后删掉」；上游修复 / 新功能靠开发时手动升级版本用上，**永远不改上游代码**。
- 技能只用 Pi 公开的 Agent Skills 规范与 `DefaultResourceLoader.skillsOverride` / `additionalSkillPaths`；每个助理一份显式启用清单（`settings.skillAssignments`，默认全不启用），主会话 / 后台任务 / 子代理共用 `skillFilterFor(agentId)`。
- 用户消息在助理忙时走 Pi `steer`（插话），不要改回 `followUp`。
- 有后果的操作统一走 ext-approval / `requests.ts`；完全权限按 `hostFileAccess` 在应用层免审批，其他档位维持审批，凭据 deny、暂停与系统权限弹窗不变。
- 新用到的开源项目写进 `THIRD_PARTY_NOTICES.md`（版本 + 许可证）；下载的组件在 `third-party.json` 固定版本和 SHA256。

## 硬规则 4：测试
- 只用临时数据：`e2e/fixtures/temp-server.mjs` 的 `makeTempRun / startTempServer / browserEnv / cleanupTempRun`、内存凭据（`test/in-memory-credentials.ts`）、Mock 模型（`pi-adapter/mock-provider.ts`）。
- 自动化测试（单测、e2e、`npm run check`）**绝不**碰生产数据、真实付费模型、用户的 Chrome 配置、真实的电脑控制驱动。用户的电脑默认只读，要动先得到用户同意。
- 真实模型实测只在「开发实测环境」`npm run dev:live`（`~/.pi-assistant-dev`，端口 8788，模型渠道由用户自己登录）里做，只用新建的测试助理和测试群；**不在用户装好的 App 里用用户的助理 / 群 / 对话测试**（[0021](docs/decisions/0021-dev-live-testing.md)）。
- 构建和浏览器测试串行跑。改了 Mock 行为同步改 e2e。新功能加单测和相关 e2e。
```bash
npm ci --ignore-scripts      # Node 22.19+
npm run dev                  # Mock 模型，http://127.0.0.1:8787，不花钱
npm run dev:live             # 开发实测：真实模型渠道，http://127.0.0.1:8788，数据在 ~/.pi-assistant-dev
npm run check:static         # 规范检查（几秒）：行数、边界、重复代码、文档、仓库卫生
npm run check                # check:static + typecheck + 服务端单测（推之前必须全过）
npm run e2e                  # 全量 e2e（需要 Chrome；约 25 分钟；截图写 artifacts/）
E2E_ONLY='正则' npm run e2e  # 只跑部分步骤
```

## 硬规则 5：Git
- 推之前 `git pull --rebase`；**永远不 force-push**，不改已推送的历史。改动直接进 `main`。
- 提交信息：**一行中文**，写清做了什么、为什么。代码和截图分开；截图 / 日志 / 证据只写 `artifacts/`（gitignore），**不入库**，不新建 `progress-snapshots/`、`evidence/` 文件。
- 不提交任何密钥（pre-commit 跑 gitleaks）。

## 硬规则 6：发布
- **只有用户明确说「打包」**才打 tag `v0.1.0-beta.N` 并写 `docs/release-notes/v0.1.0-beta.N.md`（中文，写给用户）。不把「已合 main」说成「已发布」。
- 不自动安装、不重启用户的 App；用户只通过装好的 App 自动更新来测试。
- 发布范围、矩阵、冒烟、校验见 [docs/design/release-scope.md](docs/design/release-scope.md)。

## 硬规则 7：界面标准
详见 [docs/design/ui-standard.md](docs/design/ui-standard.md)。要点：
- 每一项 = 名称 + 一行大白话说明（让用户判断它是做什么的）；更深的解释放「?」。不要删成只剩开关。
- 专业参数收进默认折叠的「高级」，给好默认值。
- 会变多的列表默认折叠、显示数量、限高内部滚动。
- 一页只有一个主要焦点。
- 助理详情保持经典布局：64px 居中头像、单行文字标签（放不下进「更多」）、八个分类（概览/模型/资料/能力/任务/记忆/文件/电脑）。模型、思考、Fast 各自即时保存；资料显式保存，草稿切标签保留。

## 交付清单（Definition of Done）
- [ ] 先搜过：按 MODULES.md 找过对应模块，说明里写了复用了什么
- [ ] `npm run check` 通过（规范检查 + typecheck + 服务端单测）
- [ ] 跑了与改动相关的 e2e（临时数据 + Mock，串行）；不跑全量矩阵、不重复多轮
- [ ] 界面改动符合界面标准，前后截图在 `artifacts/` 发给用户，不入库
- [ ] 新文件登记进 MODULES.md；新决定写进 `docs/decisions/`；设计文档状态已更新
- [ ] HANDOFF 改一两行，ROADMAP 改状态
- [ ] 一行中文提交信息，代码和截图分开；`git pull --rebase` 后推送，没有 force-push
- [ ] 没改 Pi / Hindsight / node_modules / 依赖版本；没有密钥
- [ ] 只写实际跑过的结果，没跑的写「未验证」；用户没说「打包」就不发布

## 文档怎么维护
- 新设计写 `docs/design/<主题>.md`，第一行写状态：`状态：草稿 / 已批准 / 已实现(commit) / 已废弃`。
- 用户拍板的决定写 `docs/decisions/NNNN-标题.md`（模板见 [docs/decisions/README.md](docs/decisions/README.md)）。
- 用户提的新需求立刻在 ROADMAP 记一行；HANDOFF 只写当前状态（不超过 120 行）；ROADMAP 一行一事；提交信息就是进度记录。
