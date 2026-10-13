#!/bin/bash
# 在 rootful containerd + nerdctl（与 Mac 上 Lima 虚拟机里同一套：nerdctl-full，版本取自 third-party.json）下真实启动助理电脑镜像，
# 按服务端的参数开机（--user 镜像默认 agent、家目录卷、2G shm、低端口 sysctl），确认不会开机即退出、noVNC / cua-driver 就绪。
# 防止“Docker 下能跑、nerdctl 下 126 退出”这类回归（例：arm64 镜像装进 x86-64 的 cua-driver）。
# 用法：sudo scripts/smoke-desktop-nerdctl.sh <镜像引用>   需在与目标架构一致的运行器上跑（ubuntu-latest / ubuntu-24.04-arm）
set -euo pipefail
IMG="$1"
cd "$(dirname "$0")/.."
ARCH=$(uname -m); case "$ARCH" in x86_64) K=linux-x64;; aarch64) K=linux-arm64;; *) echo "不支持 $ARCH"; exit 1;; esac
read -r V FILE SHA < <(node -e '
const c=require("./third-party.json").components.find(x=>x.name==="nerdctl-full");const a=c.assets[process.argv[1]];
console.log(c.version,a.file.replaceAll("{v}",c.version),a.sha256)' "$K")
T=/opt/pia-nerdctl
if [ ! -x "$T/bin/nerdctl" ]; then
  curl -fsSL -o /tmp/nerdctl-full.tgz "https://github.com/containerd/nerdctl/releases/download/v$V/$FILE"
  echo "$SHA  /tmp/nerdctl-full.tgz" | sha256sum -c -
  mkdir -p "$T" && tar xzf /tmp/nerdctl-full.tgz -C "$T"
fi
export PATH="$T/bin:$PATH" CNI_PATH="$T/libexec/cni"
S=/run/pia-ctd; mkdir -p "$S"
# 独立的 containerd（不碰运行器自带 Docker 的那个）
if ! [ -S "$S/containerd.sock" ]; then
  "$T/bin/containerd" --address "$S/containerd.sock" --root /var/lib/pia-ctd --state "$S/state" >/tmp/pia-ctd.log 2>&1 &
  for i in $(seq 1 50); do [ -S "$S/containerd.sock" ] && break; sleep 0.2; done
fi
N="nerdctl --address $S/containerd.sock"
$N pull -q "$IMG"
$N rm -f pia-desk-nerdctl-ci >/dev/null 2>&1 || true
$N run -d --name pia-desk-nerdctl-ci --shm-size 2g --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  -v pia-home-nerdctl-ci:/home/agent -p 127.0.0.1:16080:6080 "$IMG"
ok=
for i in $(seq 1 60); do
  st=$($N inspect -f '{{.State.Status}}' pia-desk-nerdctl-ci)
  [ "$st" = running ] || { echo "容器退出了（$st，退出码 $($N inspect -f '{{.State.ExitCode}}' pia-desk-nerdctl-ci)）"; $N logs pia-desk-nerdctl-ci; exit 1; }
  $N logs pia-desk-nerdctl-ci 2>&1 | grep -q "pia-desktop ready" && { ok=1; break; }
  sleep 1
done
[ -n "$ok" ] || { echo "60 秒内没就绪"; $N logs pia-desk-nerdctl-ci; exit 1; }
sleep 8
[ "$($N inspect -f '{{.State.Status}}' pia-desk-nerdctl-ci)" = running ] || { echo "就绪后又退出了"; $N logs pia-desk-nerdctl-ci; exit 1; }
$N exec pia-desk-nerdctl-ci cua-driver --version
$N exec pia-desk-nerdctl-ci test -S /tmp/cua-main.sock
$N exec pia-desk-nerdctl-ci curl -sf -o /dev/null http://127.0.0.1:6080/
d=$($N exec pia-desk-nerdctl-ci pia-screen add s-ci 5910 | tail -1) && [ "$d" -ge 100 ]
$N exec -e DISPLAY=:$d pia-desk-nerdctl-ci xdpyinfo >/dev/null
$N rm -f pia-desk-nerdctl-ci >/dev/null; $N volume rm pia-home-nerdctl-ci >/dev/null || true
echo "nerdctl 冒烟通过（$ARCH）：$IMG"
