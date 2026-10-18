# 0011 项目规范化
- 日期：2026-10-19
- 状态：有效
- 决定：AGENTS.md 是唯一规则来源，其他 AI 的入口文件只做指针；docs/MODULES.md 登记所有模块；`npm run check` = 规范检查（行数 600 上限且基线只降、依赖边界、jscpd 重复代码、文档、仓库卫生）+ typecheck + 单测，pre-commit 跑暂存区检查，CI 先跑规范检查。
- 原因：用户以后会换其他 AI 接手，要保证它们理解项目、不把项目弄乱。
- 不做什么：不引入 ESLint、husky 等重依赖；jscpd 用固定版本 npx 运行，不进 devDependencies；knip 不进 CI。
- 影响：scripts/check/、.githooks/pre-commit、.github/workflows/ci.yml。
