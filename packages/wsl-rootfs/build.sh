#!/usr/bin/env bash
# 构建 WSL 发行版根文件系统压缩包：./build.sh <amd64|arm64> <输出.tar.gz>
# nerdctl-full 按 third-party.json 固定版本 + SHA256 下载校验；输出可直接 `wsl --import`。
set -euo pipefail
ARCH="${1:?amd64 或 arm64}"; OUT="$(realpath -m "${2:?输出文件}")"
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
KEY=$([ "$ARCH" = amd64 ] && echo linux-x64 || echo linux-arm64)
read -r VER FILE SHA < <(node -e '
  const j=require(process.argv[1]).components.find(c=>c.name==="nerdctl-full");
  const a=j.assets[process.argv[2]];
  console.log(j.version, a.file.replaceAll("{v}", j.version), a.sha256)' "$ROOT/third-party.json" "$KEY")
CACHE="${PIA_CACHE:-/tmp/pia-wsl-cache}"; mkdir -p "$CACHE"
if ! echo "$SHA  $CACHE/$FILE" | sha256sum -c --status 2>/dev/null; then
  curl -fL --retry 3 -o "$CACHE/$FILE.part" "https://github.com/containerd/nerdctl/releases/download/v$VER/$FILE"
  echo "$SHA  $CACHE/$FILE.part" | sha256sum -c --status || { echo "nerdctl-full 校验失败" >&2; exit 1; }
  mv "$CACHE/$FILE.part" "$CACHE/$FILE"
fi
rm -rf "vendor/$ARCH" && mkdir -p "vendor/$ARCH"
tar -C "vendor/$ARCH" -xzf "$CACHE/$FILE" \
  bin/containerd bin/containerd-shim-runc-v2 bin/ctr bin/nerdctl bin/runc libexec/cni/host-local libexec/cni/loopback libexec/cni/bridge libexec/cni/portmap libexec/cni/firewall libexec/cni/tuning
TMP="$(mktemp -d)"
docker buildx build --platform "linux/$ARCH" --build-arg TARGETARCH="$ARCH" --output "type=tar,dest=$TMP/rootfs.tar" .
gzip -9 -n -c "$TMP/rootfs.tar" > "$OUT"
rm -rf "$TMP"
echo "$(sha256sum "$OUT" | cut -d' ' -f1)  $(stat -c %s "$OUT")  $OUT"
