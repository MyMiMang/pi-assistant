# macOS 每次更新重复授权（桌面目录）——只读诊断报告

范围：只读调查，未改任何 App / 权限 / TCC，未读密钥，未跑 tccutil，未碰 main.rs，未 push/tag。
仓库：`…/workspace/amv7oy7ejb00/pi-assistant-release`（release 调查树）
被检对象：`/Applications/Pi Assistant.app`（用户当前安装版，`CFBundleShortVersionString = 0.1.0-beta.18`）

---

## 一、结论（先说结果）

1. **当前 macOS 安装包根本没有做 bundle 级代码签名**，只是链接器给单个 Mach-O 打的 ad-hoc 签名（`flags=0x20002(adhoc,linker-signed)`），`Contents/_CodeSignature` 目录不存在，`Sealed Resources=none`，`Info.plist=not bound`。
2. **ad-hoc 签名的「指定要求」（designated requirement）只有 cdhash**，不含 identifier、不含任何证书锚点 → **每次构建 cdhash 必变 → macOS TCC 认为是“另一个 App” → 桌面/文稿/下载等受保护目录重新弹窗**。这正是“每次更新都要再允许一次桌面目录”的直接原因。
3. **本地和 CI 都没有 Developer ID 证书**（`security find-identity -v -p codesigning` → `0 valid identities found`；release.yml 无任何 Apple 证书/公证步骤）。
4. **不能谎称“ad-hoc + 固定 identifier 就能保住系统授权”**：本条经实测证伪——用 `--identifier com.piassistant.app` 做 ad-hoc 重签，DR 仍然只有 `cdhash`，identifier 不进入 DR。固定 identifier 只能让包更规范，**解决不了 TCC 重复授权**。
5. **唯一可靠修法是付费 Apple Developer Program（Developer ID Application 证书 + 公证）**，需要用户决定是否购买/提供证书；**我们不能也不应伪造证书或密钥**。因此在拿到证书前，这个重复授权无法从根上消除，只能如实告知用户。
6. 三件事必须分清（第 5 节详述）：
   - **OS 授权（TCC）**：桌面/文稿/下载/辅助功能/屏幕录制，由 macOS 按代码签名身份绑定 → 受签名影响。
   - **App 内权限**：`完全权限档位` / `approvedHash` 清单哈希 / 暂停降权，是我们 server 自己实现的（`host-control.ts`），**与代码签名完全无关**。
   - **Tauri 更新签名（minisign）**：只校验更新包完整性与来源，**不是 macOS 代码签名，不能替代 Developer ID**。

---

## 二、证据（命令 + 原始输出）

### 1. 主程序：ad-hoc、无 Team ID、identifier 还不稳定
```
$ codesign -dv --verbose=4 "/Applications/Pi Assistant.app"
Executable=…/Contents/MacOS/pi-assistant-tray
Identifier=pi_assistant_tray-219bcdb490433d36     # ← 不是 com.piassistant.app，是链接器生成的 ad-hoc 名
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=155688 flags=0x20002(adhoc,linker-signed hashes=4861+0 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
Internal requirements=none
CDHash=063e78f6d480afc880edc3708f690088a064fc3d
```
信息量：`Info.plist=not bound`、`Sealed Resources=none`、`TeamIdentifier=not set`、identifier 带构建哈希后缀 → macOS 几乎拿不到任何“跨版本稳定”的身份特征。

### 2. 指定要求（TCC 判断“是不是同一个 App”的依据）只有 cdhash
```
$ codesign -dr - "/Applications/Pi Assistant.app"
# designated => cdhash H"063e78f6d480afc880edc3708f690088a064fc3d"
```
**DR 里没有 `identifier`，没有 `anchor apple generic`** → 每次构建 cdhash 变，系统就当成新 App。

### 3. 整包校验失败 / 没有 bundle 签名
```
$ codesign -v --deep --verbose=2 "/Applications/Pi Assistant.app"
…: code has no resources but signature indicates they must be present

$ ls "/Applications/Pi Assistant.app/Contents/_CodeSignature"
ls: No such file or directory
```
→ 这是“未做 bundle 签名”，只有内层二进制各自的链接器 ad-hoc 签名。

### 4. 内嵌 node：有 Node.js Foundation 的 Developer ID，但救不了外层
```
$ codesign -dv "/Applications/Pi Assistant.app/Contents/MacOS/node"
Identifier=node
flags=0x10000(runtime)
Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)
TeamIdentifier=HX7739G8FX
designated => identifier "node" and anchor apple generic … subject.OU = HX7739G8FX
```
TCC 追的是**负责进程（外层 Pi Assistant.app）**，不是子进程 node 自己的签名，所以 Node 的正式签名不改变结论。

### 5. 本机没有可用签名身份
```
$ security find-identity -v -p codesigning
     0 valid identities found
```

### 6. Release 流程里确实没有 Apple 签名/公证
- `.github/workflows/release.yml`：只有 Tauri updater 的 `TAURI_SIGNING_PRIVATE_KEY`，**无** `APPLE_CERTIFICATE` / `APPLE_SIGNING_IDENTITY` / `notarytool`。
- `apps/tray/src-tauri/tauri.conf.json`：`bundle.macOS` 只有 `minimumSystemVersion`，**无 `signingIdentity`、无 `entitlements`**。
- `apps/tray/scripts/build-sidecar.mjs`：无 codesign 步骤；仓库里没有 `*.entitlements` / `Info.plist` 模板文件。
- 文档已写明现状：`docs/DESIGN.md` §5.2「安装包没有签名」、`docs/HANDOFF.md`「代码签名：Apple Developer ID 公证…都要用户提供账号或证书」、`docs/ROADMAP.md`「待用户决定」。

### 7. 实测：ad-hoc + 固定 identifier，DR 仍然只有 cdhash（关键反证）
在临时目录对主程序副本重签（**只动副本，未碰安装的 App**）：
```
$ codesign --force -s - --identifier com.piassistant.app tray
Identifier=com.piassistant.app
flags=0x2(adhoc)
$ codesign -dr - tray
# designated => cdhash H"0a83bfc2039e44e1afc74fcefa2b49e2ed48a0ee"

# 再加 entitlements 重签，DR 依旧只有 cdhash：
# designated => cdhash H"832c8dde21bb089fc6be60d4edc377d1b4c8d3c8"
```
→ **固定 identifier / 加 entitlements 都不能让 ad-hoc 签名获得稳定 DR**。

### 8. 更新是整包替换
`apps/tray/src-tauri/src/updater.rs::install()`：先 `stop_server`，再 `u.install(bytes)`（Tauri 内置更新器替换 `.app`），再 `app.restart()`。每次更新产生全新二进制 → 全新 cdhash → TCC 授权失效。

> 诚实边界：按任务要求未读取 TCC 数据库，因此无法打印系统里实际存的 csreq。但 §2 的 DR 证据 + 用户观察到的“每次更新都再允许一次”与 ad-hoc 签名的预期行为完全一致。

---

## 三、为什么“没有证书时”修不彻底

| 方案 | 能否跨更新保住 TCC 授权 | 说明 |
|---|---|---|
| 维持现状（链接器 ad-hoc） | ❌ | DR = cdhash，每次变 |
| 显式 ad-hoc 重签整包 + 固定 `--identifier com.piassistant.app` | ❌（但包更规范） | 实测 DR 仍只有 cdhash |
| 自签（自建 CA）证书签名 | ⚠️ 未验证，不建议当方案 | 非 Apple 签发，无法得到 `anchor apple generic`；TCC 是否长期信任不可靠，且会给用户造成“以为修好了”的误导 |
| **Developer ID Application + 公证（付费）** | ✅ | DR 变为 `identifier "com.piassistant.app" and anchor apple generic and certificate leaf[subject.OU] = <TEAMID>`，跨更新稳定 |

局限（有证书后也要知道）：
- 授权绑定的是 **bundle id + Team ID**；一旦改 bundle id、换签名身份或换 Team，历史授权会一次性失效。
- 公证能消掉 Gatekeeper「无法验证开发者」和“右键首次打开”，**但公证本身不负责 TCC 稳定性**，稳定性来自 Developer ID 的 DR。
- TCC 目录里的旧授权不会自动清理；升级身份后可能需要用户手动允许一次，之后才稳定。

---

## 四、最小可维护实施方案（分两步，改动都很小）

### 步骤 A（现在就能做，不花钱；规范 + 消除误导，**但不解决重复授权**）
放到 mac build job 里、`tauri-action` 产出 `.app` 之后、`hdiutil` 打包之前，一段小步骤：
1. 新增一个 entitlements 文件（如 `apps/tray/src-tauri/entitlements.macos.plist`）：`com.apple.security.cs.allow-jit`、`allow-unsigned-executable-memory`、`disable-library-validation`（sidecar node / WebView 需要）。
2. 新增 `apps/tray/src-tauri/Info.plist`（Tauri 会合并），补 `NSDesktopFolderUsageDescription` / `NSDocumentsFolderUsageDescription` / `NSDownloadsFolderUsageDescription`——只让弹窗文案更清楚，**不减少弹窗次数**。
3. 明文 ad-hoc 重签（先内层后整包），并加断言：
   ```bash
   APP=$(ls -d "$B"/macos/*.app | head -1)
   codesign --force -s - --identifier com.piassistant.app \
     --entitlements apps/tray/src-tauri/entitlements.macos.plist "$APP/Contents/MacOS/node"
   codesign --force -s - --identifier com.piassistant.app \
     --entitlements apps/tray/src-tauri/entitlements.macos.plist "$APP"
   codesign --verify --deep --strict --verbose=2 "$APP"
   ```
   ⚠️ 必须签名所有内层 Mach-O（node、以及将来加入的 cua/cloudflared/uv），否则 `--verify --deep` 不通过。
4. 在 `tauri.conf.json` 里设 `bundle.macOS.signingIdentity: "-"` + `entitlements: "entitlements.macos.plist"`，让本地 `tauri build` 与 CI 行为一致。
- 收益：`_CodeSignature` 存在、整包可校验、identifier 统一。
- **必须对用户讲清楚：这一步不会消除“每次更新重新授权”。**

### 步骤 B（需用户决定并付费；真正的修复）
1. 用户加入 Apple Developer Program（个人 $99/年），生成 **Developer ID Application** 证书。
2. 仓库 secrets：`APPLE_CERTIFICATE`(base64 p12) / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD`(app-specific) / `APPLE_TEAM_ID`。
3. `bundle.macOS.signingIdentity` 改为证书名；签名加 `--options runtime`。
4. 打完 dmg 后 `xcrun notarytool submit --wait` + `xcrun stapler staple`，`codesign --verify`/`spctl -a -vv` 作为 CI 断言。
- 收益：TCC 授权跨更新保留；Gatekeeper 提示消失；Windows 侧同理需要代码签名证书（另议）。

> 隐私/安全前提：证书私钥只能由用户或用户的 CI secret 提供，**我们不能生成、不能导入、不能读取任何密钥**。所以步骤 B 必须先由主会话征询用户是否购买/提供证书。

---

## 五、分清三件事（避免再次混淆）

| | 是什么 | 由谁管理 | 与代码签名关系 |
|---|---|---|---|
| **OS 授权 TCC** | 桌面 / 文稿 / 下载 文件夹、辅助功能、屏幕录制等系统弹窗 | macOS | **强相关**：身份不稳定 → 每次更新重新允许 |
| **App 内权限** | 完全权限档位、`approvedHash`（`host-control.ts` 的 `manifestHash(hostPlan())`，设置里“确认并开启电脑操作”）、暂停 / 降权 | Pi Assistant server 自己 | **无关**，不受重签名影响 |
| **Tauri 更新签名** | 内置 minisign 公钥校验更新包 | Tauri updater | **无关**：只证明更新包完整性与来源，不等于 macOS 代码签名，不能替代 Developer ID，也不改变 TCC |

---

## 六、下一步建议

1. 主会话先问用户：**是否愿意购买/提供 Apple Developer ID 证书**（唯一根治路径）。
2. 若暂不购买：先合入步骤 A（让包规范、弹窗文案清楚），并在 INSTALL/FAQ 里如实说明“未签名构建每次更新需重新允许系统文件夹访问”，避免用户以为是我们 bug。
3. 实施时只动 `release.yml` + `tauri.conf.json` + 两个 plist，**不碰 `apps/tray/src-tauri/src/main.rs`**；验证：CI 里 `codesign --verify --deep --strict` 通过、`codesign -dv` 顶层 `Identifier=com.piassistant.app`、`_CodeSignature` 存在；TCC 是否跨更新稳定只能靠真实的“更新一次”来确认。
