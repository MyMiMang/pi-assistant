# 进度快照：skill-scope-assignment

树：`skill-scope-assignment`，基 `unified-integration@ad3526f`（干净 HEAD）。**未 push / 未 tag / 未打包。**
目标：技能统一库存（builtin/user/external），默认所有助理不启用任何技能（内置也不例外），每助理一份显式启用清单。

## 已完成（小步中文 commits）
1. `4f5c39b` 技能分配后端核心
   - `packages/server/src/skill-assignments.ts`：`settings.skillAssignments = {agentId: id[]}`，缺失 / `[]` 都是 none，无全局默认无内置例外；enable/disable/batch/agentsUsingSkill/unassignEverywhere/version。
   - `packages/server/src/skills.ts`：`source`(builtin/user/external) + `id`(来源/名称) + 三根目录（顺序即 Pi 发现优先级）+ 库存与 Pi 一致去重。
   - `packages/server/src/pi-adapter/index.ts`：`CreateSessionOptions.skillFilter`，在路径白名单后按选集过滤；不传保持旧行为（低层测试）。
   - `packages/server/src/runtime.ts`：`skillFilterFor(agentId)`，主会话 / 后台任务 / 子代理三处共用；`assignmentsVersion()` 纳入会话 key。
   - 测试 `test/skill-assignments.test.ts` 4/4。
2. `cef247a` 文档边界：`docs/design/skill-scope-assignment.md`、AGENTS.md 约定、ROADMAP 需求行。
3. `d5cd9c5` API + 技能工具收敛
   - `/api/skills` 带 id/source/enabledAgents；`GET/PUT /api/agents/:id/skills`；`POST /api/skills/:name/enable-all`（仅当前 agents）；`DELETE` 有助理在用先 409 + 影响列表，`?force=1` 后 unassign + 删文件；`POST /api/skills` 支持 `agentId`（模型给该助理新建默认只启用它）。
   - runtime 技能工具：`list/get/search` 只在该助理可用集内（不泄露未选中名/描述）；`skill_save` 默认只启用本助理；`skill_delete` 先摘除所有分配再删文件。
   - `skill-intel.searchSkills` 结果带 id/source。
   - 测试补 3 项，共 7/7；`skill-intel` 回归 6/6。
4. `26a9bc9` UI
   - `apps/web/src/components/AgentSkills.tsx`（助理 › 设置 › 技能：搜索 + checkbox + 空态提示 + 计数）。
   - `InfoPane.tsx` 挂载；`SkillsTab.tsx` 来源徽章 / 「N 个助理已启用」/ 按助理配置弹窗 / 未分配提示 / 删除提示受影响助理；`types.ts` SkillMeta 补字段。
5. `faf7174` 外部导入（安全）：`skill-import.ts`（zip 防 `../`/绝对路径/symlink/bomb；同名同内容复用；冲突抛 `ImportConflict`；update/rename 且保留 license/metadata）；`POST /api/skills/import`；SkillsTab 导入弹窗；`test/skill-import.test.ts` 9/9。
6. `984a607` 选集单一来源 + 群成员 skills：`skill-scope.ts`（`skillFilterFor` / `enabledSkillsFor` 唯一实现）；runtime 改用；`rooms` 把成员声明的 skills 映射为 canonical id 写入该成员启用集合；复制不扩。
7. `da25a9a` Pi SDK 边界静态守卫测试。
8. `7ce9c53` checkpoint：进度快照 + ROADMAP 状态。
9. `e92930b` 修复 `deleteSkill` 按来源删目录（之前 external 删不掉）+ `e2e/skills-scope.mjs`。

## CHECKPOINT（最新，HEAD `e92930b`，2026-10-15）
- 工作树干净；**未 push / 未 tag / 未打包**。
- server `tsc --noEmit` exit 0；web `tsc --noEmit` exit 0；web `vite build` 通过（2499 模块）。
- 测试实跑：
  - `skill-assignments` + `skill-import` + `pi-sdk-boundary` → 18/18；最新 `skill-assignments`+`skill-import`+`skill-intel` → 23/23。
  - `rooms` → 14/14；`pi-packages`+`isolation`+`test-data-isolation` → 6/6。
  - **e2e `e2e/skills-scope.mjs` 全部通过（exit 0）**：真实 server + 临时数据 + Mock，覆盖默认 none / 按助理启用 / zip 导入只启用目标 / 同名 409 / 删除影响与 force / 界面（启用数、按助理配置弹窗、助理设置勾选落库）。截图 `evidence/skills-scope/`。

## 验证
- server `tsc --noEmit` exit 0；web `tsc --noEmit -p apps/web` exit 0。
- web `vite build` 通过（2499 模块）。
- 测试：`skill-assignments` 7/7、`skill-intel` 6/6、`isolation` 2/2、`pi-packages` 1/1。

## 环境注意（不是代码问题）
- worktree 需要 `node_modules` 以及各 workspace 的 `node_modules`（尤其 `apps/web/node_modules`，含 highlight.js 主题）。
  只 symlink 根 node_modules 会导致 `vite build` 报 `Can't resolve 'highlight.js/styles/github-dark.css'`，并被 `brand` 插件 closeBundle 的 ENOENT 掩盖。
  修法：把 `node_modules`、`packages/ext-*/node_modules`、`apps/web/node_modules` 都符号链接到 `unified-integration` 对应目录。
- 一律用 `~/.local/bin/node`（v26）/ login shell PATH；`npx` 在非 login shell 下不存在。

## 未做 / 未验证（准确说明，不 claim 全完成）
- 未跑**全量** e2e（仅跑技能专项 `e2e/skills-scope.mjs`）；未真机安装包验证。
- 未接网络 git / URL 导入（本地目录 + zip 已做；网络来源可复用现有 `pi-packages` 导入，未在本轮接线）。
- “升级后 N 个技能未分配”仅有 UI 文案与默认-none 语义，未对真实升级路径做端到端验证。
- 真实桌面 / 真实 Key / 真实用户数据未触碰。

## 约束（硬性）
- 不修改 / 不 fork Pi SDK，不改 node_modules，不 monkeypatch 私有 API；只用公开 `DefaultResourceLoader.skillsOverride` + Agent Skills 规范；运行时统一经 `pi-adapter`。
- 测试全部隔离（`test/setup.ts` 强制临时 `PIA_DATA_DIR` / `PIA_WORKSPACE`，Mock 模型，内存 CredentialStore），不碰系统钥匙串 / 真实数据 / 真实 Key。
