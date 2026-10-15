# 技能作用域与分配（skill scope assignment）

状态：实现中（分支 `skill-scope-assignment`，基 `unified-integration@ad3526f`，未发布）。

## 目标
把「技能」从「装进技能目录就对所有助理可见」改成**每个助理一份显式启用清单**：内置、用户自建、外部导入都进同一个库存，但**默认谁都不启用（内置也不例外）**，必须显式分配给某个助理。分配改变后，下一轮对话前重建会话生效，不打断正在进行的一轮。

## 硬约束（不许越界）
- **不修改 / 不 fork Pi SDK，不改 `node_modules`，不 monkeypatch 私有 API。**
- 只用 Pi 公开能力：Agent Skills 规范（`SKILL.md` frontmatter `name`/`description`）、`DefaultResourceLoader` 的公开 `skillsOverride` / `additionalSkillPaths` / `noSkills`。
- 运行时对 Pi 的调用**统一走 `packages/server/src/pi-adapter/`**；技能相关的新逻辑放在 Pi Assistant 自有模块，小而完整、可维护、可扩展。
- 不能给每个助理复制 N 份技能文件，也不改 Pi 的加载规范。

## 数据模型
- **库存（inventory）**：`packages/server/src/skills.ts` 扫描三个根目录，顺序即 Pi 的发现优先级（先出现者胜，与 Pi 同名去重一致）：
  1. `user`：`dataDir/skills/<name>/SKILL.md`（用户自建 / `skill_save`）
  2. `external`：`dataDir/skills-external/<name>/SKILL.md`（外部导入）
  3. `builtin`：`packages/server/skills/<name>/SKILL.md`（随 App 发布，只读）
- **canonical id** = `来源/名称`（如 `builtin/web-research`、`user/my-skill`）。会话选集按 id 过滤，**不用文件 name**，避免同名内置与外部互相错启。
- **分配表（唯一事实来源）**：`settings["skillAssignments"] = { [agentId]: string[] }`（canonical id 列表）。缺失 / `[]` 都表示不启用任何技能；**没有全局默认、没有内置例外**。见 `packages/server/src/skill-assignments.ts`。

## 生效路径
- `pi-adapter.createPiSession` 新增可选 `skillFilter({name, filePath})`：在路径白名单之后按选集过滤。不传则保持旧行为（仅路径白名单，供低层测试 / 诊断）。
- `runtime.ts` 的**主会话 / 后台任务 / 子代理**三处共用同一个 `skillFilterFor(agentId)`：只保留 canonical id 在分配表里的技能。子代理、群成员、后台任务都按**所属助理 id** 取同一份 effective 选集，不额外 expand。
- 分配版本号 `assignmentsVersion()` 纳入会话重建 key：改动后下一轮重建，运行中的一轮不强制 reload。
- 只 inject 被启用技能的 `name` / `description` / `path`；正文仍由 Pi 按需 `read`。未选中技能的 name/description 不进 system prompt。

## 边界
- **不因为技能为空而禁用 Pi 扩展包**：`noSkills` / 选集过滤只影响技能，包的扩展照常加载。
- `skill_search` 只检索**该助理可用集**，不泄漏未选中的技能名。
- `skill_save` 仍遵守「用户要求 / 同意」规则；模型给本助理新建的技能默认只启用给本助理。
- `skill_delete` 只删物理库存文件；先提示影响哪些已启用它的助理；`unassign` 只摘分配不删文件。
- 外部导入（zip / 目录 / URL）先**安全导入库存同一份**，再仅 enable 目标助理；同名内容不同必须让用户选 update / new name，**不可静默覆盖**；同内容同来源则复用并仅 enable 目标。
- 全文读取权限不因技能作用域额外收紧（作用域是「加载与分配」，不是 OS 安全）。
