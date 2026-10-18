# scripts

每个脚本一行：做什么、什么时候跑。规范检查规则见 [AGENTS.md](../AGENTS.md)。

| 脚本 | 做什么 | 什么时候跑 |
|---|---|---|
| `check/index.mjs` | 规范检查：行数基线、依赖边界、jscpd 重复代码、文档、仓库卫生（`npm run check:static`；`--staged` 给 pre-commit；`--update-baseline` 收紧基线） | 每次提交 / 推送前，CI 第一步 |
| `check-pi.mjs` | Pi 已装版本 vs 兼容基线 vs npm 最新（只提示） | CI；开发时 |
| `pi-update.mjs` | 手动升级 Pi 三个包并同步兼容基线（`latest` / `finalize`） | 开发者看到新版时手动跑（不自动升级，decisions/0012） |
| `hindsight-update.mjs` | 手动升级 Hindsight（`check` 只看新版；`latest` / 版本号 升级并同步版本记录；测试 `hindsight-update.test.mjs`） | 开发者看到新版时手动跑（不自动升级） |
| `release-scope.mjs` | 推导 / 校验发布范围（测试：`node --test scripts/release-scope.test.mjs`） | release 工作流 |
| `release-notes.sh` | 生成发布说明草稿 | 用户说「打包」时 |
| `stage-app.mjs`、`package-linux.mjs`、`fetch-bins.ts`、`fetch-cua-driver.mjs` | 打包：组装 App、Linux 包、下载并校验二进制 | release 工作流 |
| `ghcr.mjs`、`smoke-desktop-nerdctl.sh` | 助理电脑镜像发布与开机冒烟 | desktop-image / CI |
| `deploy-rendezvous.mjs` | 部署可选的 Rendezvous Worker | 手动 |
| `smoke-app.mjs`、`cua-browser-smoke.py`、`local-asr-real-smoke.mjs`、`voice-incremental-real-validation.mjs` | 真实环境冒烟（不进 CI） | 真机验证时 |
| `gen-icons.mjs`、`gen-provider-icons.mjs`、`gen-model-db.mjs`、`pets/` | 生成图标、服务图标、模型参数库、内置宠物 | 改对应素材 / 数据后 |
| `perf/`、`run-with-timeout.py` | 性能脚本、带超时运行 | 排查时 |
