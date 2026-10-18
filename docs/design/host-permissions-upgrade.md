# 更新后“要重新给电脑权限”：已知事实、风险与边界（host control / macOS TCC）

状态：已实现应用层部分，签名与真机复测待用户

用户原话（beta.28 之后）：**“更新就要重新给工作权限，今天等权限而人不在电脑旁卡很久”**，并明确 **“就是电脑这些授权”**。

**用户没有提供截图，也没说是哪一条弹窗 / 哪个权限、哪个 App 在问。** 所以这份文档只写“已知事实 + 风险 + 待验证”，**不判断用户这次遇到的到底是哪条链路**。结论按“两条独立链路”分开写，不许混成一句“TCC 问题”，也不把签名层面的推断当成已证实的用户现场结论。

---

## 一、结论速览（按证据强度写，不写“必然 / 一定”）

| 链路 | 是什么 | 更新（替换 .app）后的现状 | 依据 / 证据强度 | 代码侧还能做什么 |
|---|---|---|---|---|
| **A 应用内 host control 授权** | 设置 › 操作这台电脑 的“开启 + 审阅权限计划” (approvedHash)、各助理档位、完全权限确认 | **设计上保留**：设置在数据目录 `data.db`，更新只替换 `.app`；计划哈希只盖“能力与作用域”，**不含版本 / 构建 / 驱动版本**；`host-control.ts` 从 beta.20 到当前 HEAD 逐字节相同。**未见按版本主动重置的路径**（不等于任何迁移 / 异常路径都永不丢），**尚无真实升级实测** | 代码与哈希的静态事实（确定性高）；“升级后仍在”属**待实机验证** | 已修“看起来丢了”的**可见性/启动竞态** bug（见 §三）；这是本轮唯一能靠代码确定修好的部分 |
| **B-1 我们自己 App 的 macOS TCC**（桌面 / 文稿 / 下载等受保护文件夹、自动化） | 安装版实测：`Identifier=pi_assistant_tray-415c2cf0da304c33`、`flags=0x20002(adhoc,linker-signed)`、`Info.plist=not bound`、`TeamIdentifier=not set`，`codesign -dr` **只有 cdhash** | **缺乏跨构建稳定的 code identity → 存在系统重授权风险**（每次构建的 cdhash 都不同，系统会把新构建当成“另一个 App”）。**是否每次必丢、用户这次弹的是不是这一类，都还没确认** | 签名事实是**确定**的；“每次都丢 / 用户这次就是它”是**推断**，需实测与用户现场信息 | 单靠改代码**不能**根治；需要稳定的签名身份（见 §四）。但**这不是唯一可能的根因**，也不是“唯一一种用户问题” |
| **B-2 CuaDriver 的辅助功能 / 屏幕录制** | 机器上两份实测：`com.trycua.driver`、`Authority=Developer ID Application: Cua AI, Inc. (YCK386LBJ7)`，DR = `identifier "com.trycua.driver" and anchor apple generic … leaf[subject.OU] = YCK386LBJ7` | 所查官方驱动有 **Developer ID + 稳定 identifier + 与路径无关的 DR**，**降低了**辅助功能 / 屏幕录制在版本升级时被重问的风险。**不保证一定保留**：实际责任进程（我们的服务 / LaunchServices 启动的 `CuaDriver.app`）、安装与注册方式、系统版本差异、macOS 26「直接捕捉」一次性同意都可能影响 | 签名事实确定；“跨版本一定保留”是**推断**，未做真实驱动升级复测 | 发布前守住“只用官方签名 `CuaDriver.app`”的检查（§四末尾命令） |
| **C Tauri 更新签名（minisign）** | 更新包完整性 | 与授权无关 | 只校验更新包，不是 macOS 代码签名 | — |

**给用户能说的一句话（保守版）**：“更新后要重新授权，目前能确定的是：我们自己的安装包还没用固定的开发者身份签名，系统可能因此把它当新 App；具体你遇到的那一次弹的是哪个权限、哪个进程，我还需要你在机器上确认一下（截图或系统设置里那一条）。应用里‘已审阅并开启’的授权是存在数据目录里的，设计上不该随更新重置，这条也需要升级一次后实测确认。”

---

## 二、实测证据（只读，未改任何系统设置）

被检对象：用户当前安装版 `/Applications/Pi Assistant.app`（安装时 `0.1.0-beta.27`；主会话本轮独立复核结果一致）。

```
$ codesign -dv --verbose=2 "/Applications/Pi Assistant.app"
Identifier=pi_assistant_tray-415c2cf0da304c33
CodeDirectory v=20400 size=156136 flags=0x20002(adhoc,linker-signed)
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none

$ codesign -dr - "/Applications/Pi Assistant.app"
designated => cdhash H"d33596fc239287837cfe3f27c0270115b31a0da6"
```

→ 外层 App 的 designate requirement 只有一个 cdhash：**没有稳定身份**。宿主上跑的命令、读写的受保护文件夹归属于这个进程，所以这类 TCC 授权**有被系统重新询问的风险**。
**注意边界**：这证明的是“身份不稳定”，**不证明**用户这次遇到的必定是文件夹 TCC、也不证明“每次更新必丢”（哪种权限、由哪个进程负责、系统如何判定，都要单独确认并实测）。

```
$ codesign -dv --verbose=2  ~/…/bin/cua-driver-0.34.1/…/CuaDriver.app
Identifier=com.trycua.driver
Authority=Developer ID Application: Cua AI, Inc. (YCK386LBJ7)
TeamIdentifier=YCK386LBJ7
$ codesign -dr - …  → identifier "com.trycua.driver" and anchor apple generic … OU = YCK386LBJ7
（0.35.4 结果相同）
```

→ 驱动是 Cua 官方 Developer ID 签名，DR 与版本无关：**降低了**升级新驱动版本时辅助功能 / 屏幕录制被重问的风险。**但这是签名层结论**，不等于实机验证过；责任进程、系统版本、安装注册方式仍可能带来额外询问。

应用内授权：

```
$ git diff v0.1.0-beta.26 HEAD -- packages/server/src/host-control.ts   # 空
$ git diff v0.1.0-beta.27 HEAD -- …                                     # 空
$ git diff v0.1.0-beta.28 HEAD -- …                                     # 空
```

→ 计划文本、`ALLOWED_TOOLS`、`buildManifest`、`hostPlan` 全都没变 → `approvedHash` 跨版本一致；数据目录 `~/Library/Application Support/Pi Assistant/data.db` 不随 `.app` 替换。
**能说的**：设计上保留、代码里未发现按版本重置的路径。
**不能说的**：任何迁移 / 异常路径都永不丢；用户实际升级后一定还在（待实机）。

---

## 三、A 链路里真实存在的三个应用层缺口（可修，已修最小部分）

1. **启动竞态会让 host 工具整组消失。**
   `main.ts` 里 `void startDaemon()`（不等待）先起 HTTP；`runtime.ts` 只有 `hostStatus().daemon.state` 是 `running` / `paused` 时才挂 `pia-hostpc` 扩展。更新后服务重启，第一批会话可能在 `starting` 阶段建立 → 那个会话**完全看不到电脑工具**，用户看到的就是“授权没了，去设置重新开一次（才好）”。
   修：按“授权在不在 + 驱动已安装”挂载（`starting` 阶段工具可用，动作由 `before`/审批逐层把关），启动失败时保留结构化原因。

2. **守护进程启动失败被吞掉 / 重试边界划错。**
   原来 `startDaemon().catch(console.warn)`：控制台一行、UI 只有 `daemon.detail`，没有“需要你做什么”；且 10 秒内没就绪就永久 `error`。
   修：
   - 启动有限重试（0 / 2 / 5 秒），**每次失败单独判定原因**（`HostDaemonError.reason` + `retryableDaemonFailure()`）：只有“没在 10 秒内就绪”“下载中断”两类瞬时原因重试；**权限计划已变化、校验失败、以及任何没认出来的错误立即停**，等用户或人来看。（旧实现是 `!/就绪|10秒/.test(msg) && i===0`：正则连自己的文案都匹配不上，等于第一次失败就放弃；而且 `i===0` 让第二次失败后不再判定原因——两处都改了。）
   - 不用“消息里出现‘权限’就重试”这种模糊判断：详细错误文本里带“权限”不代表可重试。

3. **macOS 权限状态每次轮询都单独起进程，且状态不进入 `hostStatus`。**
   `GET /api/host-control` 每次调用 `macPermissions()`（`cua-driver permissions status`，最多 8s 超时）。设置页轮询会把探测打满，且后台任务/子代理看不到“现在是不是缺系统授权”。
   修：15s 只读缓存（**`null` 结果也缓存**，不再每次重新起进程；并发探测合并为一次），结果放进 `hostStatus().macPermissions`；另加 `macPermissionState()` 三值判定——**`unknown` / 空 / 认不出的值一律不得当“已授权”**，只有明确 denied 才提示用户去开授权。

**刻意没做的事**（避免把“无人值守”做成“跳过保护”）：不自动点系统弹窗、不写 TCC 数据库、不 `tccutil reset`、不改系统安全设置、不读凭据/私钥；`full` 档位仍然只是“应用层不弹审批”，凭据 deny、暂停/降权、系统权限弹窗照旧。UI 文案也不再写“这不是你的权限被重置”这类过断言，只说“驱动尚未就绪，不一定是授权丢失”，并按实际 `daemon.detail` / 权限探测指出该确认还是稍后重试。

---

## 四、B 链路：能做的、做不到的、以及常见误解

**做不到（必须如实告知）**：拿到稳定签名身份前，**无法用代码保证**桌面/文稿/下载这些授权跨更新保留。ad-hoc + 固定 identifier 已被实测证伪（DR 仍只有 cdhash）。**不把 ad-hoc 签名宣传成“能保留授权”，也不伪造证书、不自签 CA。**

**签名与公证要分清**（两个目标不同，不能混）：

- **稳定 code identity（Developer ID Application 证书签名）** 才是让 TCC 认为“还是同一个 App”的前提。有开发者身份、DR 稳定，**有助于**授权在更新后沿用。
- **公证（notarization）** 是 **分发/首次启动时的 Gatekeeper 信任**机制，**不是 TCC 持久性的同义必要条件**。没有公证不等于授权一定丢；有公证也不等于授权一定不丢。
- 两者都拿不到“永不询问”的保证：系统更新、用户重置、权限责任进程变化、系统版本升级，都可能再次询问。

**代价与前提（不能承诺只改代码解决）**：通常需要用户的 Apple 开发者账号与证书（Apple Developer Program，约 $99/年），并按平台要求在 CI 里安全配置证书 / 团队信息（`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`）。这是**用户侧的资源与安全配置决策**，我们只能把代码位置准备好、把验证做完，不能替用户开户或写入证书。

**另外**：切换到正式签名身份后，**通常还需要用户再授权一次**（TCC 里旧的 ad-hoc 记录不会被自动继承 / 清理），之后才稳定；**之后也不是“永不询问”**。这点必须写进发布说明。

| 项 | 现状 | 需要 |
|---|---|---|
| `apps/tray/src-tauri/tauri.conf.json` | `bundle.macOS` 只有 `minimumSystemVersion` | 加 `signingIdentity` + `entitlements` |
| `.github/workflows/release.yml` | 只有 `TAURI_SIGNING_PRIVATE_KEY`（minisign） | 加 Apple 证书 / 公证相关 secret，签名后 `notarytool submit` + `stapler` |
| 校验断言 | 无 | CI 里 `codesign --verify --deep --strict`、`codesign -dv` 顶层 Identifier/TeamIdentifier、`spctl -a -vv`、dmg 内 App 与构建产物同签名 |

**驱动侧要守住的规则**：只用 Cua 官方 release 里的 `CuaDriver.app`（当前 `Developer ID Application: Cua AI, Inc. (YCK386LBJ7)`，`com.trycua.driver`）。若某天官方改成 ad-hoc 或换 Team，辅助功能/屏幕录制**更可能**开始反复要授权——发布前用下面的命令确认一次即可发现，不需要跑 GUI：

```bash
app=$(ls -d ~/Library/Application\ Support/Pi\ Assistant/bin/cua-driver-*/cua-driver-rs-*/CuaDriver.app | tail -1)
codesign -dv --verbose=2 "$app" | grep -E "Identifier|TeamIdentifier|Authority"
codesign -dr - "$app"   # 期望：identifier "com.trycua.driver" and anchor apple generic … OU = YCK386LBJ7
```

---

## 五、无人值守时怎么表现（设计目标）

- **权限缺口不无声卡住**：缺系统授权时动作直接失败并给出中文原因（辅助功能/屏幕录制/文件夹），指向 设置 › 操作这台电脑 › 打开授权引导；模型不再无限重试同一动作。
- **系统弹窗只有用户能点**：后台/子代理**不发起**授权请求（只做只读 status 探测），所以人不在电脑旁时不会排一排弹窗等人；任务会明确停在这一步并说明原因。
- **应用内授权不因版本/构建变化重置**：计划哈希只覆盖“能力与作用域”（工具清单、应用清单、工作区、档位），不包含版本号、构建号、驱动版本等易变信息；只有**新增能力/新作用域**才需要重新确认，且只重新确认变化的那部分。
- **partial 不会自动变 full**：升级不改变任何助理档位；`full` 仍需用户在设置里确认；`hostFileAccess` 每次调用实时求值，暂停/降权立即生效。

---

## 六、验证命令（轻量，不占用重测试槽）

```bash
# 类型（本树改的是 host-control / runtime / main / 测试）
npm run typecheck
# 定向单测（20 条：授权语义 + 启动重试边界 + 系统权限三值判定与只读缓存）
node --import tsx --import ./test/setup.ts --test packages/server/test/host-control.test.ts
```

真机（必须人看着，本轮**未做**，属于未验项）：

1. 装 beta.N，在 设置 › 操作这台电脑 开启并审阅；记下 `approvedHash`（接口返回）。
2. 升级到 beta.N+1，重启后确认 `GET /api/host-control` 的 `settings.enabled` 仍为 true、`approvedHash` 不变、`daemon.state` 为 `running`——**这一步才算验证 A 链路跨升级保留**（目前只是设计 + 静态证据）。
3. 让助理在桌面/文稿目录读写一次：观察是否被要求重新允许，并**记录是谁在问**（`Pi Assistant` / `CuaDriver` / 其他），截图留证。
4. 在系统设置里看“辅助功能 / 屏幕录制”里 `CuaDriver` 是否仍被勾选；升级 Cua 版本（变更 `third-party.json`）后再看一次。

---

## 七、未验证 / 边界（写清楚“不知道”）

- **A 链路是否真的跨升级保留**：只有设计 + 静态证据（数据目录、哈希不含版本、`host-control.ts` 未变），**没有做“升级一次再检查”的实机验证**；也没验证数据目录迁移 / 异常路径。
- **B-1 是不是用户这次遇到的**：用户只说“电脑这些授权”，没有截图、没说是哪个权限。**不归因**：可能是文件夹 TCC、也可能是自动化 / 辅助功能 / 屏幕录制 / 系统版本升级后的重新确认。需要用户现场确认（谁在问、问什么）与升级复测。
- **B-1 的“每次都丢”**：目前是签名层面的**推断**（cdhash 每次不同），没有做连续两次升级的对照实测。
- **B-2 是否真保留**：只做了签名层面核对，没有真实驱动升级后的 TCC 复测；责任进程（我们的服务 vs `CuaDriver.app`）、LaunchServices 注册方式、macOS 26「直接捕捉」一次性同意是否与路径 / 实例绑定，**都未验证**。
- **签名链路**：无证书，未在 CI 跑过 `codesign` / `notarytool`；切换身份后的再次授权行为也未实测（预期需要用户再允许一次）。
- **启动重试**：只做了纯逻辑判定测试（`retryableDaemonFailure`），**没有**在真实“旧实例退出中 / 下载中断”场景里跑过；重试上限是 3 次、总时长约 7 秒，不引入常驻轮询，也不触发系统授权请求。
- `PIA_HOST_CONTROL_DRY_RUN` 演练模式不覆盖真实 Cua 进程，真机行为仍需在装好的 App 上确认。
- 旧驱动目录（`bin/cua-driver-0.34.1`、`0.35.4`）升级后不会自动清理：目前只占磁盘，不影响授权；是否清理另议（会连带失效旧路径的 TCC 记录）。
