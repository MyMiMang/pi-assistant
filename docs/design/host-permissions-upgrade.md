# 更新后“要重新给电脑权限”：根因与边界（host control / macOS TCC）

用户原话（beta.28 之后）：**“更新就要重新给工作权限，今天等权限而人不在电脑旁卡很久”**，并明确 **“就是电脑这些授权”**。

这份文档只回答一件事：**升级一次 Pi Assistant 之后，哪些授权真的会丢、为什么、代码里能不能修、什么时候必须用户本人点。**
结论按“两条独立链路”分开写，不许混成一句“TCC 问题”。

---

## 一、结论速览

| 链路 | 是什么 | 更新（替换 .app）后会丢吗 | 依据 | 能不能用代码修 |
|---|---|---|---|---|
| **A 应用内 host control 授权** | 设置 › 操作这台电脑 的“开启 + 审阅权限计划” (approvedHash)、各助理档位、完全权限确认 | **不会丢** | 保存在数据目录 `data.db` 的 settings 表，更新只替换 `.app`，不碰数据目录；`host-control.ts` 从 beta.20 到当前 HEAD **逐字节相同**，权限计划哈希不会因版本变化 | 已经是稳定的；只需修“启动竞态/失败被吞掉”这类**可见性**问题 |
| **B-1 macOS TCC（我们自己的 App）** | 桌面 / 文稿 / 下载等受保护文件夹、自动化 | **会丢，每次更新必丢** | 安装的 beta.27 仍是 ad-hoc、`Info.plist=not bound`、`TeamIdentifier=not set`；`codesign -dr` 只有 `cdhash` → 每次构建都是“另一个 App” | **不能**。唯一可靠解是 Developer ID 证书 + 公证（用户提供，我们自己不能造） |
| **B-2 macOS TCC（CuaDriver.app）** | 辅助功能 / 屏幕录制 | **不会丢**（驱动版本升级也保留） | 机器上两个版本实测：`com.trycua.driver`，`Authority=Developer ID Application: Cua AI, Inc. (YCK386LBJ7)`，DR = `identifier "com.trycua.driver" and anchor apple generic … leaf[subject.OU] = YCK386LBJ7` → 身份与构建无关，路径变化（`bin/cua-driver-<版本>/…`）不影响 TCC | 已经是稳定的；发布时保持“只用官方签名的 CuaDriver.app”即可 |
| **C Tauri 更新签名（minisign）** | 更新包完整性 | 与授权无关 | 只校验更新包，不是 macOS 代码签名 | — |

一句话给用户：**“电脑上点、看屏幕”这类授权（Cua Driver）升级不会丢；“读写桌面/文稿/下载这些文件夹”的授权每次更新都会丢，因为安装包没有 Apple 开发者证书签名——这不是我们的设置被重置，等我们拿到证书才能真正修好。**

---

## 二、实测证据（只读，未改任何系统设置）

被检对象：用户当前安装版 `/Applications/Pi Assistant.app`（`0.1.0-beta.27`）。

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

→ 外层 App 的 TCC 身份 = 一个 cdhash，**每次构建/每次更新都不一样**。宿主上跑的命令、读写的文件夹都归属于这个进程，所以受保护文件夹授权必然重来。

```
$ codesign -dv --verbose=2  ~/…/bin/cua-driver-0.34.1/…/CuaDriver.app
Identifier=com.trycua.driver
Authority=Developer ID Application: Cua AI, Inc. (YCK386LBJ7)
TeamIdentifier=YCK386LBJ7
$ codesign -dr - …  → identifier "com.trycua.driver" and anchor apple generic … OU = YCK386LBJ7
（0.35.4 结果相同）
```

→ 驱动是 Cua 官方 Developer ID 签名，**DR 与版本无关**：升级到新驱动版本时，macOS 仍认为是同一个 App，辅助功能 / 屏幕录制授权保留。这一条此前没人验证过，是本次新增事实。

应用内授权：

```
$ git diff v0.1.0-beta.26 HEAD -- packages/server/src/host-control.ts   # 空
$ git diff v0.1.0-beta.27 HEAD -- …                                     # 空
$ git diff v0.1.0-beta.28 HEAD -- …                                     # 空
```

→ 计划文本、`ALLOWED_TOOLS`、`buildManifest`、`hostPlan` 全都没变 → `approvedHash` 跨版本一致；数据目录 `~/Library/Application Support/Pi Assistant/data.db` 不随 `.app` 替换 → **应用内“已审阅并开启”不会被更新重置**（此前“每次更新都要重开”的直觉对应用内授权不成立）。

---

## 三、A 链路里真实存在的三个应用层缺口（可修，已修最小部分）

1. **启动竞态会让 host 工具整组消失。**
   `main.ts` 里 `void startDaemon()`（不等待）先起 HTTP；`runtime.ts` 只有 `hostStatus().daemon.state` 是 `running` / `paused` 时才挂 `pia-hostpc` 扩展。更新后服务重启，第一批会话可能在 `starting` 阶段建立 → 那个会话**完全看不到电脑工具**，用户看到的就是“授权没了，去设置重新开一次（才好）” 。
   修：把 `starting` 也算可用状态（工具在，动作由 `before`/审批逐层把关），启动失败再重试，仍失败时保留结构化原因。

2. **守护进程启动失败被吞掉。** `startDaemon().catch(console.warn)`：控制台一行、UI 只有 `daemon.detail`，没有“需要你做什么”。用户不在电脑旁时无从知道卡在哪。
   修：启动带有限重试（不改权限语义），失败原因写进 `hostStatus().daemon.detail`（已有字段，UI 徽标会显示）。

3. **macOS 权限状态每次轮询都单独起进程，且状态不进入 `hostStatus`。**
   `GET /api/host-control` 每次调用 `macPermissions()`（`cua-driver permissions status`，最多 8s 超时）。设置页轮询会把探测打满，且后台任务/子代理看不到“现在是不是缺系统授权”。
   修：加 15s 缓存（只读探测，**绝不 request/prompt**），并把结果放进 `hostStatus().macPermissions`，供 UI 与系统提示引用；后台永不主动弹系统框。

**刻意没做的事**（避免把“无人值守”做成“跳过保护”）：不自动点系统弹窗、不写 TCC 数据库、不 `tccutil reset`、不改系统安全设置、不读凭据/私钥；`full` 档位仍然只是“应用层不弹审批”，凭据 deny、暂停/降权、系统权限弹窗照旧。

---

## 四、B 链路：现在能做的与做不到的

**做不到（必须如实告知）**：拿不到 Developer ID 证书前，**无法用代码保证**桌面/文稿/下载这些授权跨更新保留。ad-hoc + 固定 identifier 已被实测证伪（DR 仍只有 cdhash）。**不把 ad-hoc 签名宣传成“能保留授权”，也不伪造证书。**

**能做的（等用户提供证书/CI secret 后一次到位，代码侧已留好位置）**：

| 项 | 现状 | 需要 |
|---|---|---|
| `apps/tray/src-tauri/tauri.conf.json` | `bundle.macOS` 只有 `minimumSystemVersion` | 加 `signingIdentity` + `entitlements` |
| `.github/workflows/release.yml` | 只有 `TAURI_SIGNING_PRIVATE_KEY`（minisign） | 加 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`，签名后 `notarytool submit` + `stapler` |
| 校验断言 | 无 | CI 里 `codesign --verify --deep --strict`、`codesign -dv` 顶层 Identifier/TeamIdentifier、`spctl -a -vv`、dmg 内 App 与构建产物同签名 |

拿到证书后的**一次性代价**：TCC 目录里旧 ad-hoc 授权不会被自动清理，**切换签名身份后用户需要再允许一次**，之后才稳定。这点必须写进发布说明，不能承诺“一次就好”。

**驱动侧要守住的规则**：只用 Cua 官方 release 里的 `CuaDriver.app`（当前 `Developer ID Application: Cua AI, Inc. (YCK386LBJ7)`，`com.trycua.driver`）。若某天官方改成 ad-hoc 或换 Team，辅助功能/屏幕录制就会开始反复要授权——发布前用下面的命令确认一次即可发现，不需要跑 GUI：

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
npm run typecheck                                   # 类型（本次改了 host-control / runtime / main）
node --test packages/server/test/host-control.test.ts   # 应用内授权语义（含本次新增用例）
```

真机（必须人看着，属于未验项）：

1. 装 beta.N，在 设置 › 操作这台电脑 开启并审阅；记下 `approvedHash`（接口返回）。
2. 升级到 beta.N+1，重启后确认 `GET /api/host-control` 的 `settings.enabled` 仍为 true、`approvedHash` 不变、`daemon.state` 为 `running`——**这一步验证 A 链路不重置**。
3. 让助理在桌面/文稿目录读写一次：观察是否被要求重新允许（**B-1 预期仍会要**，直到有 Developer ID）。
4. 在系统设置里看“辅助功能 / 屏幕录制”里 `CuaDriver` 仍是勾选状态；升级 Cua 版本（变更 `third-party.json`）后再看一次（**B-2 预期保留**）。

## 七、未验证 / 边界

- **TCC 是否真的跨更新保留**（B-1 会丢、B-2 应保留）只做了签名层面推断 + 用户观察，没有读 TCC 数据库、没有 `tccutil reset`、没有实测“升级一次再点一次”，属于**待实机**。
- macOS 26 Tahoe 的“直接录屏”一次性同意（ScreenCaptureKit）是否与驱动路径/实例绑定，**未验证**；如果它与路径绑定，Cua 版本升级可能额外多一次同意。
- `PIA_HOST_CONTROL_DRY_RUN` 演练模式不覆盖真实 Cua 进程，真机行为仍需在装好的 App 上确认。
- 旧驱动目录（`bin/cua-driver-0.34.1`、`0.35.4`）升级后不会自动清理：目前只占磁盘，不影响授权；是否需要清理另议（会连带失效旧路径的 TCC 记录，属于无害垃圾）。
