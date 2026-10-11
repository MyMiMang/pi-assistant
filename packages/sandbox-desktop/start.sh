#!/bin/bash
# 启动虚拟显示器 + xfce 桌面 + VNC + noVNC + cua-driver 守护进程；pi-assistant-server 经 `docker exec -i … cua-driver mcp`（MCP stdio）连上。
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
# 浏览器调试端口：Chromium 只监听容器内 127.0.0.1:9222，socat 转到 9223 供宿主（只绑定 127.0.0.1）上的 Playwright 连接
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 >/tmp/cdp.log 2>&1 &
cua-driver telemetry disable >/dev/null 2>&1 || true
# 助理自己的电脑 = 完全权限：Cua 守护进程以 unrestricted 模式运行（这台虚拟电脑只属于助理，与用户的电脑隔离）。
# 是否逐项审批、一键暂停、操作记录都在 pi-assistant-server 这一层做。`cua-driver mcp` 会连到这个守护进程。
cua-driver serve --permission-mode unrestricted --dangerously-bypass-approvals --no-permissions-gate >/tmp/cua-serve.log 2>&1 &
echo "pia-desktop ready"
wait -n
