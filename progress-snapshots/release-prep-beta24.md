# beta.24 发布准备（release-candidate-validation，本轮）

> 目标：把候选做成可发布状态——写发布说明、把「发布前的平台静态核查」真正跑一遍并修掉挡路的真问题、提交推送打 tag 触发 CI。
> 树：`release-candidate-validation`（baseline `main` = `8d7a7d8`；候选存在 173 个提交 / 295 个改动文件）。发布范围 `.github/release-scope.json` = `mac-arm64`。
> 状态：**候选，未发布**（tag 推上去由 release workflow 构建 + Mac 安装冒烟通过后才公开）。

## 1. 本轮改了 3 处（都是发布前核查发现的真问题）

### 1.1 CSP 会拦掉「语音采集的 AudioWorklet」和「PDF 预览」——真浏览器实测发现，已修
- 现场：`packages/server/src/http.ts` 给非 `/api` 响应下发的 CSP 是 `script-src 'self'`（无 `blob:`）。而
  - 语音采集 `apps/web/src/hooks/useVoiceInput.ts` 用 `audioWorklet.addModule(URL.createObjectURL(new Blob([...])))`；
  - 文件预览 `apps/web/src/components/FilePreview.tsx` 用 `<object data="blob:…" type="application/pdf">`。
- 实测（真实 server 真响应头 + 真 Chromium，见 `e2e/voice-csp-audioworklet.mjs`）：
  - 修前：`audioWorklet.addModule` 抛 `AbortError: Failed to load worklet module script: blob:…`；控制台两条 violation（worker 一条、PDF 一条 `frame-src` 回落 `default-src`）。也就是说**安装版里语音输入录不了音、PDF 预览打不开**——而既有 e2e（`voice-input-ui.mjs` / `file-preview.mjs`）用的是**不带 CSP 的静态服务器**，所以一直没暴露。
  - 分指令实测（临时探针，4 种 CSP 组合）：worklet 只服 `script-src`（`worker-src` 不管用）；PDF 要 `object-src` + `frame-src`（Chromium 内置查看器会再套一层 frame）。
- 修法（`packages/server/src/http.ts`，只加必需项，**没有**放开 inline / 远程脚本）：
  `script-src 'self' blob:`、`object-src 'self' blob:`、`frame-src 'self' blob:`；`img-src` / `style-src` 保持原样。
- 修后实测：同一脚本 0 violation，worklet 真加载 + `AudioWorkletNode` 真创建、PDF 的 `<object>` 未被拦，首屏 `data-skin`/`data-mode` 已有值。
- 回归防护：探针抽成 `e2e/fixtures/csp-probe.mjs`，被 `e2e/run.mjs` 新增步骤「CSP：语音采集 worklet / PDF 预览 / 首屏主题在真实响应头下可用」与独立脚本共用；静态断言在 `packages/server/test/tray-macos-mic-usage.test.ts`（CI 的 `npm test` 会跑）。

### 1.2 macOS 安装包缺麦克风用途说明（系统会在请求麦克风时直接终止进程）
- 新增 `apps/tray/src-tauri/Info.plist`（Tauri 会合并与 `tauri.conf.json` **同目录**的 Info.plist）：
  只加 `NSMicrophoneUsageDescription`，中文说明「只有你主动点按麦克风后才录音，不录入时不访问」。
  不加 `NSCameraUsageDescription`（不用摄像头，保持最小）。
- **没有**加 entitlements 文件：当前安装包**没开 App Sandbox、也没有 `codesign --options runtime` 的签名步骤**（`docs/beta18-macos-signing-tcc-report.md` 实测：外层只有链接器 ad-hoc 签名），所以不需要 `com.apple.security.device.audio-input`；一旦将来加签名步骤（要把整包 + 内层 node 一起签），必须同时补这条 entitlement——静态测试里已写成「若声明了 entitlements 就必须含 audio-input」的断言，避免漏。
- **未验**：本机无 Rust 工具链，没跑 `cargo build` / `tauri build`，所以「Info.plist 是否真的并进安装包」只做到静态断言（文件在自动合并路径、内容合法、键值齐全、不与其他配置分叉）；真机麦克风（`getUserMedia`）与 WKWebView 的媒体权限行为也没在真机验证。

### 1.3 新增静态测试（保证上面两条不会再退化）
`packages/server/test/tray-macos-mic-usage.test.ts` **3/3**：
- Info.plist 存在 / XML + DTD 合法 / 有非空、含「麦克风 + 语音/录音 + 主动点按」的用途说明 / 不声明摄像头；
- 与 `tauri.conf.json`（`bundle.active`、`minimumSystemVersion`、`infoPlist` / `entitlements` 若声明必须存在且一致）不冲突；
- CSP 必须含三条 `blob:` 且**不得**放开 inline / 远程脚本、不得去掉 `frame-ancestors 'none'`；`apps/web/index.html` 不得出现 inline 脚本、首屏主题必须走同源外部 `theme-boot.js`。

## 2. 顺手核对（没改代码，结论记录）
- **主题首屏**：`theme-boot.js` 是 `apps/web/public` 下的同源外部文件（CSP 是 `script-src 'self'`，不能 inline），DIY 主题 token 注入依赖 `style-src 'unsafe-inline'`（在位），不需要 nonce；`blob:` worker 在当前 CSP 下可用（探针里顺带验证，当前代码没用到）。
- **SenseVoice 手动导入时的引擎依赖**：导入走的还是同一条 `install()`——uv → staging venv → `uv pip install --require-hashes` 装 pinned sherpa-onnx wheel（`darwin-arm64` 有固定 SHA256）→ 导入权重 → 清单校验 → 原子 activate。所以「许可未确认」只关闭**下载**入口，导入路径的引擎依赖照装；失败会 `state=failed` + 中文原因、回滚 staging，**不会**假装 ready（`local-asr-license` / `local-asr-manager` 等 86/86 既有测试覆盖）。平台没有 wheel 固定摘要时 fail-closed（`没有 … 的引擎 wheel 固定摘要，拒绝未校验的安装`）。**未真机**：真实下载 / 安装 / 起 sidecar / 转写都没跑。
- **Pi 依赖**：`git diff main..HEAD -- node_modules` 为空；`packages/server/package.json` 三包一致升 1.2.0，`package-lock.json` 只动 8 个 Pi 包（详见 `progress-snapshots/release-candidate-integration-final.md` §10、`docs/design/pi-1.2-upgrade.md`）。
- **卫生/安全（只看路径元数据，未读 deny 文件内容）**：295 个改动文件里没有 `secrets.ts` / `.env` / `*.key` / `*.pem` / `*.db` / `*.jsonl` / `hosts.yml` / token 之类路径；`screenshots/*.png`（3 张，仓库根下的旧原型图，未被复用的原型，`unified-integration.md` 已注明不复用）是无害的遗留物，本轮不删。
- **测试默认不碰真实数据 / 系统钥匙串**：`packages/server/test/setup.ts` 用 `=` 强制把 `PIA_DATA_DIR` / `PIA_WORKSPACE` 指到临时目录并置 `PIA_OFFLINE=1`（并导出 `isTempDataDir` 供断言）。

## 3. 本次实际跑过的（真实输出）
| 项目 | 结果 |
|---|---|
| `npm run build -w @pi-assistant/web`（含 web `tsc --noEmit`） | 通过，2520 模块，`dist` 有产出 |
| `node --import tsx --test packages/server/test/tray-macos-mic-usage.test.ts` | 3/3 |
| `node e2e/voice-csp-audioworklet.mjs`（真 server + 真 Chromium） | 通过：0 violation、worklet + PDF + 首屏主题都可用（修前失败，见 §1.1） |
| `E2E_ONLY="CSP：" node e2e/run.mjs`（真实主流程里的新步骤） | ✅ CSP 步骤通过（同轮「首次运行向导」仍是既有基线失败，见 §4） |
| `node e2e/session-fork-ui.mjs`（真 server + Chromium，验证 CSP 改动没影响页面加载） | 5/5 |
| `node e2e/voice-input-ui.mjs` | 全通过（含许可卡、导入入口、禁用下载等） |
| `node scripts/release-scope.mjs` / `node --test scripts/release-scope.test.mjs` | `scope=mac-arm64`（只有 1 个 arm64 构建项，无 Windows/Linux/Intel）、3/3 |
| `npm test`（全量） | 757 项：742 过 / 5 失败 / 10 跳过。5 个失败 = **2 项已记录的既有基线**（proactive「空闲→开始」`'held' !== 'started'`；`shared-computer`「合并脚本」macOS bsdtar 不支持 `--skip-old-files`）+ **3 项环境导致**（`mcp.test.ts` 用 `process.execPath` 当命令，本机用的是 App 自带 Node，路径含空格 `…/Pi Assistant.app/…` 被「命令只填可执行文件」校验拒）。用无空格路径的同一 Node 副本单跑 `test/mcp.test.ts` **3/3 通过**，证明与本次改动无关。 |

## 4. 既有基线问题（不是本候选引入，本轮不修）
- `e2e/run.mjs` 第 1 步「首次运行向导」在 `getByRole('button', { name: '设为默认模型' })` 超时：模型选择器统一后，默认模型是在 `default-model-picker` 里选到的（`onSaved` 才推进），**没有**独立的「设为默认模型」按钮；e2e 断言停留在旧 UI 上。
- 复核：在**独立 worktree 的 `main`（`8d7a7d8`）**跑同一条 `E2E_ONLY="首次运行向导"`，**同样的超时**（截图 `/tmp/e2e-fail-1.png`），所以不是本次整合引入。
- 影响：CI 的 `e2e/run.mjs` 会在第 1 步就失败（main 上已如此），不阻塞 release workflow（release 的 build / smoke / publish 是另一套 job）。建议单独一个小提交把该步骤改成操作 `default-model-picker`，再跑一遍全量 e2e——**不在本轮发布范围内**（避免为它引入未验证的改动）。

## 5. 未验（如实，别写进发布说明当已完成）
真实云模型质量与参考图效果、真实云端 ASR、本地 SenseVoice 真实安装 / 转写、真机安装包（含真麦克风与 `tauri build` 后的 plist）、真实手机 / iOS、真实 MCP（cua-driver / http）、真实电脑操控基准、全量 `e2e/run.mjs`、系统钥匙串根因。

## 6. 发布动作
1. 本文件 + 发布说明重写 + §1 的三处改动 → 一个中文提交（release prep）。
2. `git fetch origin main` 确认没前进 → `git push origin HEAD:main`（普通 ff，不 force）。
3. 在同一个验证过的 HEAD 上打 `v0.1.0-beta.24` 并推 tag → 触发 release workflow（`mac-arm64`；`prepare` → `build` → `mac-smoke` → `publish`）。失败不移动 tag；基础设施原因可 rerun 原 run，源码原因必须新 commit + 下一个未占用 tag。
4. 触发后把 commit / tag / run id + URL + 阶段报给主会话（由主会话用 `task_wait` 盯远端 run）。**CI 成功前不写「已发布」**；成功后另起一个文档提交记录 publish（沿用 beta.23 的做法：main 上的「记录 … 已发布」提交）。
