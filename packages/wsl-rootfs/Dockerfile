# Pi Assistant · Windows 助理电脑运行时的 WSL2 发行版根文件系统（DESIGN §15.2 第 3 步）
# Debian 12 slim + containerd / nerdctl / runc（来自 nerdctl-full，构建脚本按 third-party.json 校验 SHA256）。
# 用户电脑上：Pi Assistant 下载 rootfs 压缩包（Release 资产，固定 SHA256）→ `wsl --import PiAssistant-Desktop <数据目录> <压缩包> --version 2`。
# 构建：packages/wsl-rootfs/build.sh <amd64|arm64> <输出.tar.gz>（CI：.github/workflows/wsl-rootfs.yml）
FROM debian:bookworm-slim
ARG TARGETARCH=amd64
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates iptables procps util-linux \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/share/doc/* /usr/share/man/* \
    && update-alternatives --set iptables /usr/sbin/iptables-legacy || true
# nerdctl-full 里只取运行容器需要的部分（containerd / shim / runc / nerdctl / ctr / CNI），不要 BuildKit / stargz / rootless 组件
COPY vendor/${TARGETARCH}/ /usr/local/
COPY wsl.conf /etc/wsl.conf
COPY pia-engine /usr/local/bin/pia-engine
COPY nerdctl.toml /etc/nerdctl/nerdctl.toml
RUN chmod 755 /usr/local/bin/pia-engine && containerd --version && nerdctl --version && runc --version \
    && echo "PiAssistant-Desktop" > /etc/hostname \
    && printf 'Pi Assistant 助理电脑运行时（WSL2）。请不要手动修改；在 Pi Assistant 设置里可以关机或删除。\n' > /etc/motd
