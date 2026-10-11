# 安装 Pi Assistant（测试版）

从 [GitHub Releases](https://github.com/MyMiMang/pi-assistant/releases) 下载：

| 系统 | 文件 |
|---|---|
| macOS（Apple 芯片 M1/M2/M3/M4） | `Pi Assistant_<版本>_aarch64.dmg` |
| macOS（Intel） | `Pi Assistant_<版本>_x64.dmg` |
| Windows 10/11（64 位） | `Pi Assistant_<版本>_x64-setup.exe` |

安装后它常驻在菜单栏（macOS）/ 系统托盘（Windows），开机自动启动；第一次运行会自动在浏览器里打开 http://127.0.0.1:8787 。
一切都在你的电脑上运行，安装包里已带好运行所需的全部组件（Node 运行时、Pi、cloudflared、uv、Cua Driver），不需要另外安装。

## 目前是未签名构建

### macOS：Gatekeeper 提示“无法验证开发者”/“已损坏”
1. 把 Pi Assistant 拖进「应用程序」。
2. 在「应用程序」里**右键（或按住 Control 点按）Pi Assistant → 打开 → 打开**。只需要第一次这样做。
3. 如果提示“已损坏，无法打开”：打开「终端」执行
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Pi Assistant.app"
   ```
   然后再打开。也可以在「系统设置 → 隐私与安全性」底部点「仍要打开」。

### Windows：SmartScreen 提示“Windows 已保护你的电脑”
点「**更多信息**」→「**仍要运行**」。安装到当前用户目录，不需要管理员权限。

## 从源码安装迁移过来
如果之前用源码 + LaunchAgent（`com.piassistant.server`）运行：安装包和源码版用**同一个数据目录**（macOS `~/Library/Application Support/Pi Assistant`），数据、助理、配对的手机都保留。
建议先停掉源码版再装：
```bash
launchctl bootout gui/$(id -u)/com.piassistant.server 2>/dev/null; rm -f ~/Library/LaunchAgents/com.piassistant.server.plist
```
（如果源码版还在 8787 端口运行，托盘程序会直接复用它，不会再启动一份。）

## 自动更新
托盘菜单「检查更新」；启动时也会检查一次。更新包有签名校验（公钥内置在应用里）。

## 卸载
托盘菜单「退出」后：macOS 把应用拖到废纸篓；Windows 在「设置 → 应用」里卸载。
数据目录不会自动删除（macOS `~/Library/Application Support/Pi Assistant`，Windows `%APPDATA%\Pi Assistant`），需要时手动删除。
