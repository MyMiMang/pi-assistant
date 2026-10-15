# hotfix-integration 整合进度（beta.24 候选，未发布）

更新时间：2026-10-15（Asia/Shanghai）
执行者：后台子代理（热修整合）
树：`hotfix-integration`（worktree，基 `origin/main` = `8d7a7d8`，含 beta.23 tag）
状态：**本地提交，未 push / 未 tag / 未打包 / 未安装真机**。等主会话 review 与其余对话弹窗修复 commit 后，统一发下一个未占用号 **beta.24（仅 mac-arm64）**。

## 已合入的 4 项（按顺序）

| # | commit | 内容 | 根因 |
|---|---|---|---|
| 1 | `bd174fd` | 单测数据目录 fail-closed | `test/setup.ts` 用 `PIA_DATA_DIR ??=`；外部已有该环境变量（或 WIP 删掉那一行）时，`clawbot.test.ts` 把测试助理「小微/wa/W/#000」与一条 `owner@im.wechat+bot1@im.bot` 渠道行写进用户真实数据目录 → 下次启动「微信凭据无法解密」。改 `=` 强制覆盖 + 新增 `test-data-isolation.test.ts` + `seed-copy.test.ts` 补 setup 前置 |
| 2 | `eb111b9` | 聊天外链左键点击无反应 | 主窗口是远程页面，opener 插件默认 JS 拦截 `preventDefault` 后 invoke `plugin:opener|open_url`，但 `remote-ui` capability 未放行该命令（`opener:default` 的 `windows: []`）→ ACL 拒绝、点击被吞。页面侧显式接管 + 放行 `opener:allow-open-url`/`opener:allow-default-urls` + Rust `is_external_link` 白名单并不再吞错误 |
| 3 | `48c50b0` | 升级后已配置仍强制首次向导 | `/api/system.onboarded` 依赖 `defaultModel()` 实时解析，模型/凭据暂时读不出返回 null → 已配置被误判未配置。改为只看持久信号（向导标志 / `defaultModel` 设置 / 助理数量）+ 启动幂等恢复标志 + 前端 `modelReady` 可恢复提示，不重走向导 |
| 4 | `91d3b94` | 渠道删除按钮点不动 | 原生 `window.confirm` 在 Tauri remote webview 里不弹窗且返回 false → DELETE 不执行。换应用内 `useConfirm`（ConfirmDialog）+ aria-label/data-testid，删除中 disabled + ref 防双击，失败显示原因 |

`public-startup-audit`（`2d9d95d`）与 `f1fcf11` 的 models 启动注入重叠：**只复用** `f1fcf11` 里经公开 `initModels(credentials?)` 的内存 `CredentialStore` 注入（`test/launch-memory.ts` + `models.ts` 同进程复用），未重复全合，树内无 `PIA_CREDENTIAL_STORE` 依赖、未碰 `secrets.ts` WIP。

## 实测（本机，Node 24.20.0，全程 Mock / 注入内存凭据，未碰系统钥匙串，未安装 App）

- 服务端 `tsc --noEmit -p packages/server` exit 0；网页 `tsc --noEmit -p apps/web` exit 0。
- 网页 `vite build` 通过（2493 模块，含 `externalLinks.ts`）——**注意**：在 worktree 里 node_modules 为复制/软链时，`brand` 插件 `closeBundle` 会报 `dist/manifest.webmanifest` 缺失（构建环境问题，与代码无关）；本次用「主树放入同样源文件构建」验证通过。
- 单测（`node --import tsx --test --test-concurrency=1`）：
  - `test-data-isolation` + `seed-copy` **3/3**
  - `external-links` **13/13** + `onboarding` **7/7** + `onboarding-recovery` **1/1** = **21/21**
  - `channels` + `clawbot` + `isolation` **18/18**（含坏渠道解密失败启动不崩、旧 token 可重扫码、真实库不被写）
- e2e `e2e/channel-delete.mjs`（纯前端 fixture，静态 dist + 拦截 /api，不启动 main、不碰钥匙串）：**通过**（取消零请求 / 失败保留并提示 / 慢删除防双击 / 坏凭据可删 / 390 宽 / 无原生 confirm）。

## 未做 / 明确边界

- 未 push / 未 tag / 未打包 / 未安装真机；**未验证**安装包外链真机点击、`cargo build`（本机无 Rust 工具链）、真实 VM。
- 钥匙串系统弹窗根因**仍未证**，本轮没有修复钥匙串，也没有宣称已修。本任务未访问 / 删除用户真实「小微」与微信连接。
- 其余 `Settings/Extensions/Email/Conversations/Memory/Skills/DesktopSettings` 里的原生 `confirm/alert/prompt` 由主会话另一个任务统一改，本树不碰；发布需等这些 commit 到齐。
- 未审阅 WIP（`secrets.ts`、`e2e/*`、`package.json`）、未 pop `models.ts` stash、未 reset。

## 复现命令（本树）

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # 本机 homebrew node 25.x 的 simdjson 坏了，用 node@24
cd packages/server
node --import tsx --test --test-concurrency=1 \
  test/test-data-isolation.test.ts test/seed-copy.test.ts \
  test/external-links.test.ts test/onboarding.test.ts test/onboarding-recovery.test.ts \
  test/channels.test.ts test/clawbot.test.ts test/isolation.test.ts
```
