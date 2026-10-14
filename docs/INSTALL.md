# 安装 Pi Assistant（测试版）

从 [GitHub Releases](https://github.com/MyMiMang/pi-assistant/releases) 下载：

| 系统 | 文件 |
|---|---|
| macOS（Apple 芯片 M1/M2/M3/M4） | `Pi.Assistant_<版本>_aarch64.dmg` |
| macOS（Intel） | 暂缓发布（等后续开发完善，见 [ROADMAP.md](ROADMAP.md)）；旧版本仍可正常使用 |
| Windows 10/11（64 位） | `Pi.Assistant_<版本>_x64-setup.exe` |
| Linux 服务器（x64 / arm64） | `pi-assistant-<版本>-linux-<x64\|arm64>.tar.gz`，用下面的安装脚本装 |

安装后它常驻在菜单栏（macOS）/ 系统托盘（Windows），开机自动启动；第一次运行会自动在浏览器里打开 http://127.0.0.1:8787 。
一切都在你的电脑上运行，安装包里已带好运行所需的全部组件（Node 运行时、Pi、cloudflared、uv、Cua Driver），不需要另外安装。

## 助理电脑（可选）
设置 › 助理电脑 打开「给助理安装电脑」后才会下载，不需要自己装 Docker：
- **macOS**：自带虚拟机（Lima，macOS 13+）。
- **Windows**：自带 WSL2 发行版 `PiAssistant-Desktop`（Windows 10 2004+ / Windows 11，家庭版也可以）。电脑上还没有 WSL 时，设置里点「安装 WSL」，弹出一次管理员确认（UAC）；装完**需要重启电脑**，重启后回到设置里继续。需要在 BIOS / UEFI 里开启硬件虚拟化（大多数电脑默认开启）。Pi Assistant 只会创建和操作名为 `PiAssistant-*` 的发行版，不会碰你自己的 WSL 发行版和 Docker Desktop；助理电脑看不到 C: 盘上的文件。删除：关闭开关后点「删除虚拟机和镜像」（会执行 `wsl --unregister PiAssistant-Desktop`）。
- **Linux**：使用本机的 Docker 或 Podman。

## Linux 服务器版
在自己的服务器上常驻运行，用任何设备的浏览器访问。支持 x86_64 / aarch64 的 glibc 发行版（Debian / Ubuntu / RHEL / Fedora 等，需要 systemd）。

```bash
# 系统服务（推荐）：安装到 /opt/pi-assistant，数据在 /var/lib/pi-assistant，以 pi-assistant 账号运行
curl -fsSL https://raw.githubusercontent.com/MyMiMang/pi-assistant/main/deploy/linux/install.sh | sudo sh
# 或者装成当前用户的服务（不需要 root）
curl -fsSL https://raw.githubusercontent.com/MyMiMang/pi-assistant/main/deploy/linux/install.sh | sh -s -- --user
```
常用选项：`--port 8787`、`--host 127.0.0.1`（只给反向代理访问）、`--version 0.2.0`、`--docker`（允许使用宿主机 Docker 运行“助理电脑”；这等于给服务 root 权限）。
离线或内网服务器：在别处下载 `.tar.gz` 和 `.sha256` 后 `sh install.sh --file pi-assistant-<版本>-linux-x64.tar.gz`。国内网络可设 `PIA_DOWNLOAD_MIRROR=https://ghfast.top/`。（Linux 包从 v0.1.0-beta.10 开始提供。）

**首次设置**：安装完成时会显示网页地址和一次性**设置码**（也会打印在日志里：`pi-assistant logs`，或随时 `sudo pi-assistant setup-code`）。用浏览器打开网页、输入设置码，这台设备就成为**主人设备**：可以在网页上生成配对码、批准其他设备、修改全部设置。设置码 24 小时有效、只能用一次，过期会自动换新。主人设备丢了：`sudo pi-assistant reset-owner`，然后用新的设置码重新设置。

**命令**：`pi-assistant status | start | stop | restart | logs | setup-code | reset-owner | devices | upgrade | uninstall [--purge]`。配置文件 `/etc/pi-assistant/env`（用户服务：`~/.config/pi-assistant/env`），改完 `pi-assistant restart`。

**公网访问**：默认监听 0.0.0.0:8787（HTTP）。建议放在 HTTPS 反向代理后面，例如 Caddy：
```
pia.example.com {
	reverse_proxy 127.0.0.1:8787
}
```
（这时可以把 `PIA_HOST` 改成 `127.0.0.1`。）也可以用 设置 › 远程访问 的隧道，不开放端口。服务器模式下即使是本机回环请求也必须登录。

### 用 Docker 部署
```bash
git clone https://github.com/MyMiMang/pi-assistant && cd pi-assistant
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml exec server pi-assistant setup-code
```
数据在卷 `pi-assistant-data`。要用“助理电脑”，叠加 `deploy/compose.desktop.yaml`（挂载宿主机 docker.sock，改用宿主机网络；`DOCKER_GID=$(stat -c %g /var/run/docker.sock)`）：
```bash
DOCKER_GID=$(stat -c %g /var/run/docker.sock) docker compose -f deploy/compose.yaml -f deploy/compose.desktop.yaml up -d --build
```

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
Linux 服务器版：`sudo pi-assistant uninstall`（保留数据）或 `sudo pi-assistant uninstall --purge`。

托盘菜单「退出」后：macOS 把应用拖到废纸篓；Windows 在「设置 → 应用」里卸载。
数据目录不会自动删除（macOS `~/Library/Application Support/Pi Assistant`，Windows `%APPDATA%\Pi Assistant`），需要时手动删除。
