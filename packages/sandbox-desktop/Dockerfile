# Pi Assistant · 助理电脑（sandbox desktop）
# Debian + Xvfb + xfce4 + x11vnc + noVNC + Chromium + 中文字体 + cua-driver（MIT，仅 driver 本体，不含 cua-perception）
# 构建：node scripts/fetch-cua-driver.mjs linux-x64 packages/sandbox-desktop/vendor && docker build -t pi-assistant/desktop packages/sandbox-desktop
# 个人微信（可选）不打进镜像：用户在 设置 › 渠道 开启后，由服务端按 third-party.json 固定的 SHA256 下载并解到家目录卷（见 src/wechat.ts）
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 TZ=Asia/Shanghai \
    DISPLAY=:1 SCREEN=1440x900x24 HOME=/home/agent
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-terminal thunar dbus-x11 \
      chromium fonts-noto-cjk fonts-noto-color-emoji locales ca-certificates curl tini xdotool x11-utils \
      at-spi2-core libatk-adaptor imagemagick procps socat libatomic1 libegl1 \
    && sed -i 's/# zh_CN.UTF-8/zh_CN.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 -s /bin/bash agent
COPY vendor/cua-driver /usr/local/bin/cua-driver
COPY start.sh /usr/local/bin/pia-desktop
RUN chmod +x /usr/local/bin/pia-desktop /usr/local/bin/cua-driver \
    && ln -sf /usr/share/novnc/vnc_lite.html /usr/share/novnc/index.html
USER agent
WORKDIR /home/agent
VOLUME /home/agent
# 6080 = noVNC（只给 pi-assistant-server 反向代理用，不对外发布）；9223 = 浏览器调试端口转发（只给本机 Playwright 用）
EXPOSE 6080 9223
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pia-desktop"]
