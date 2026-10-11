#!/bin/bash
# 在 macOS 上把 Pi Assistant 服务注册为登录后自动启动的 LaunchAgent（开发/源码运行方式；正式安装包由托盘程序负责自启）。
# 用法：bash deploy/macos/install-launchagent.sh        （在仓库根目录运行）
# 会自动卸载旧名字的 LaunchAgent（com.huhao.server）。
set -euo pipefail
LABEL=com.piassistant.server
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NPM="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
LOG_DIR="$HOME/Library/Logs/Pi Assistant"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# 卸载旧的 LaunchAgent
OLD="$HOME/Library/LaunchAgents/com.huhao.server.plist"
if [ -f "$OLD" ]; then
  launchctl bootout "gui/$(id -u)" "$OLD" 2>/dev/null || launchctl unload "$OLD" 2>/dev/null || true
  rm -f "$OLD"
  echo "已移除旧的 com.huhao.server"
fi
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>ProgramArguments</key><array><string>$NPM</string><string>run</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>TZ</key><string>Asia/Shanghai</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.err.log</string>
</dict>
</plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已安装并启动 $LABEL；日志：$LOG_DIR"
