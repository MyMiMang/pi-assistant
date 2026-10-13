# Pi Assistant · 助理电脑（sandbox desktop）
# Debian + Xvfb + xfce4 + x11vnc + noVNC + Chromium + 中文字体 + cua-driver（MIT，仅 driver 本体，不含 cua-perception）
# 构建（本机架构）：node scripts/fetch-cua-driver.mjs linux-x64 packages/sandbox-desktop/vendor/amd64 && docker build -t pi-assistant/desktop:dev packages/sandbox-desktop
#   arm64 用 linux-arm64 → vendor/arm64。多架构发布由 .github/workflows/desktop-image.yml 推到 ghcr.io/mymimang/pi-assistant-desktop（DESIGN §15.2）
# 个人微信（可选）不打进镜像：用户在 设置 › 渠道 开启后，由服务端按 third-party.json 固定的 SHA256 下载并解到家目录卷（见 src/wechat.ts）
FROM debian:bookworm-slim
# 注意：TARGETARCH 不能写默认值（写了 =amd64 会盖掉 buildx 按平台注入的值，arm64 镜像就会装进 x86-64 的 cua-driver，
#   在 Apple 芯片的 Lima 虚拟机里报 Exec format error → 容器以 126 退出）。旧的 docker build 不注入时按 amd64 处理。
ARG TARGETARCH
LABEL org.opencontainers.image.source="https://github.com/MyMiMang/pi-assistant" org.opencontainers.image.description="Pi Assistant 助理电脑（sandbox desktop）" org.opencontainers.image.licenses="MIT"
ENV DEBIAN_FRONTEND=noninteractive LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 TZ=Asia/Shanghai \
    DISPLAY=:1 SCREEN=1440x900x24 HOME=/home/agent
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-terminal thunar dbus-x11 \
      chromium fonts-noto-cjk fonts-noto-color-emoji locales ca-certificates curl tini xdotool x11-utils \
      at-spi2-core libatk-adaptor imagemagick procps socat libatomic1 libegl1 \
    && sed -i 's/# zh_CN.UTF-8/zh_CN.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 -s /bin/bash agent
COPY vendor/${TARGETARCH:-amd64}/cua-driver /usr/local/bin/cua-driver
COPY start.sh /usr/local/bin/pia-desktop
COPY pia-screen pia-cua-mcp /usr/local/bin/
RUN chmod +x /usr/local/bin/pia-desktop /usr/local/bin/cua-driver /usr/local/bin/pia-screen /usr/local/bin/pia-cua-mcp \
    && ln -sf /usr/share/novnc/vnc_lite.html /usr/share/novnc/index.html \
    && cua-driver --version >/dev/null || { echo "cua-driver 不是本平台（$(uname -m)）可执行的二进制" >&2; exit 1; }
USER agent
WORKDIR /home/agent
VOLUME /home/agent
# 6080 = noVNC（只给 pi-assistant-server 反向代理用，不对外发布）；9223 = 浏览器调试端口转发（只给本机 Playwright 用）
EXPOSE 6080 9223
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pia-desktop"]
