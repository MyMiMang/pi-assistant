#!/bin/bash
# 启动虚拟显示器 + xfce 桌面 + VNC + noVNC。cua-driver 由 huhao-server 按需通过 `docker exec -i … cua-driver mcp` 启动（MCP stdio）。
set -e
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvfb :1 -screen 0 "${SCREEN}" -nolisten tcp &
for i in $(seq 1 50); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.1; done
export $(dbus-launch)
mkdir -p ~/.config/chromium
startxfce4 >/tmp/xfce.log 2>&1 &
# VNC 只监听容器内回环；外部只能通过 noVNC（websockify）访问，且该端口只绑定到宿主机 127.0.0.1
x11vnc -display :1 -forever -shared -nopw -localhost -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/novnc.log 2>&1 &
cua-driver telemetry disable >/dev/null 2>&1 || true
echo "huhao-desktop ready"
wait -n
