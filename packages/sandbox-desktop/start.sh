#!/bin/bash
# 启动主屏幕：虚拟显示器 + xfce 桌面 + VNC + noVNC + cua-driver 守护进程；pi-assistant-server 经 `docker exec -i … pia-cua-mcp <助理>`（MCP stdio 中继）连上。
# 同一台电脑里的其他屏幕（每个助理自己的屏幕）由 pia-screen 按需创建，共用家目录（DESIGN §15.4）。
# 端口与显示器编号都可用环境变量改（DESIGN §15.2）：Windows 的 WSL2 后端用 host 网络，同一个发行版里的多个桌面必须错开
#   DISPLAY_NUM（默认 1）、VNC_PORT（5900，只在回环）、NOVNC_PORT（6080）、CDP_PORT（Chromium 调试端口 9222，只在回环）、
#   CDP_PROXY_PORT（9223，socat 转发给宿主 Playwright）、BIND_ADDR（noVNC / socat 的监听地址：默认 0.0.0.0 = 容器自己的网络；host 网络时设 127.0.0.1）
set -e
DISPLAY_NUM="${DISPLAY_NUM:-1}"; VNC_PORT="${VNC_PORT:-5900}"; NOVNC_PORT="${NOVNC_PORT:-6080}"
CDP_PORT="${CDP_PORT:-9222}"; CDP_PROXY_PORT="${CDP_PROXY_PORT:-9223}"; BIND_ADDR="${BIND_ADDR:-0.0.0.0}"
export DISPLAY=":${DISPLAY_NUM}"
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
Xvfb "$DISPLAY" -screen 0 "${SCREEN}" -nolisten tcp &
for i in $(seq 1 50); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 0.1; done
export $(dbus-launch)
mkdir -p ~/.config/chromium
if [ "$BIND_ADDR" = "0.0.0.0" ]; then
  startxfce4 >/tmp/xfce.log 2>&1 &
else
  # host 网络（多个桌面共用一个网络命名空间）：xfce4-session 的 ICE 抽象套接字按进程号命名，各容器进程号相同会撞车，
  # 所以不用会话管理器，直接拉起桌面组件（窗口管理器 / 桌面 / 面板 / 设置守护进程，挂了自动重启）
  ( xfsettingsd >/tmp/xfce.log 2>&1 & while :; do xfwm4 --sm-client-disable >>/tmp/xfce.log 2>&1; sleep 1; done ) &
  ( while :; do xfdesktop --disable-wm-check >>/tmp/xfce.log 2>&1; sleep 1; done ) &
  ( while :; do xfce4-panel --disable-wm-check >>/tmp/xfce.log 2>&1; sleep 1; done ) &
fi
# VNC 只监听回环；外部只能通过 noVNC（websockify）访问，且该端口只绑定到宿主机 127.0.0.1
x11vnc -display "$DISPLAY" -forever -shared -nopw -localhost -rfbport "$VNC_PORT" -quiet >/tmp/x11vnc.log 2>&1 &
# 一个 noVNC 端口服务所有屏幕：按 ?token=<屏幕名> 转到那块屏幕的 VNC（主屏幕 = main；其他屏幕由 pia-screen 登记）
mkdir -p /tmp/pia-vnc-tokens /tmp/pia-screens
echo "main: 127.0.0.1:${VNC_PORT}" > /tmp/pia-vnc-tokens/main
echo "${DISPLAY_NUM} ${VNC_PORT} 0" > /tmp/pia-screens/main
websockify --web /usr/share/novnc --token-plugin TokenFile --token-source /tmp/pia-vnc-tokens "${BIND_ADDR}:${NOVNC_PORT}" >/tmp/novnc.log 2>&1 &
# 浏览器调试端口：Chromium 只监听 127.0.0.1:CDP_PORT，socat 转到 CDP_PROXY_PORT 供宿主（只绑定 127.0.0.1）上的 Playwright 连接
socat "TCP-LISTEN:${CDP_PROXY_PORT},bind=${BIND_ADDR},fork,reuseaddr" "TCP:127.0.0.1:${CDP_PORT}" >/tmp/cdp.log 2>&1 &
cua-driver telemetry disable >/dev/null 2>&1 || true
# 助理自己的电脑 = 完全权限：Cua 守护进程以 unrestricted 模式运行（这台虚拟电脑只属于助理，与用户的电脑隔离）。
# 是否逐项审批、一键暂停、操作记录都在 pi-assistant-server 这一层做。`cua-driver mcp` 会连到这个守护进程。
cua-driver serve --socket /tmp/cua-main.sock --permission-mode unrestricted --dangerously-bypass-approvals --no-permissions-gate >/tmp/cua-serve.log 2>&1 &
echo "pia-desktop ready"
wait -n
