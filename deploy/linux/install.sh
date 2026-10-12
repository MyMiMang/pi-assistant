#!/bin/sh
# Pi Assistant Linux 服务器版安装脚本。
#   curl -fsSL https://raw.githubusercontent.com/MyMiMang/pi-assistant/main/deploy/linux/install.sh | sudo sh            # 系统服务
#   curl -fsSL https://raw.githubusercontent.com/MyMiMang/pi-assistant/main/deploy/linux/install.sh | sh -s -- --user    # 当前用户的 systemd --user 服务
# 选项：
#   --system / --user       安装方式（默认：root 运行 = 系统服务，否则 = 用户服务）
#   --version X             指定版本（默认最新的带 Linux 包的版本）
#   --file 包.tar.gz        用本地发布包安装（同目录有 .sha256 时校验；离线 / 私有仓库可用）
#   --port N                端口（默认 8787）       --host 地址   监听地址（默认 0.0.0.0）
#   --docker                把服务账号加入 docker 组（“助理电脑”功能要用 Docker；等同 root 权限，按需开启）
#   --no-start              只安装不启动           --upgrade     升级（保留配置和数据）
#   --uninstall [--purge]   卸载（--purge 同时删除数据和配置）
# 环境变量：PIA_GITHUB_TOKEN（仓库私有时下载用）、PIA_REPO（默认 MyMiMang/pi-assistant）、
#           PIA_DOWNLOAD_MIRROR（GitHub 下载镜像前缀，例如 https://ghfast.top/ ）
set -eu

REPO=${PIA_REPO:-MyMiMang/pi-assistant}
MODE=; VERSION=; FILE=; PORT=8787; HOST=0.0.0.0; DOCKER=0; START=1; ACTION=install; PURGE=0
say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
while [ $# -gt 0 ]; do
	case "$1" in
	--system) MODE=system ;;
	--user) MODE=user ;;
	--none) MODE= ;;
	--version) VERSION=${2:?}; shift ;;
	--file) FILE=${2:?}; shift ;;
	--port) PORT=${2:?}; shift ;;
	--host) HOST=${2:?}; shift ;;
	--docker) DOCKER=1 ;;
	--no-start) START=0 ;;
	--upgrade) ACTION=upgrade ;;
	--uninstall) ACTION=uninstall ;;
	--purge) PURGE=1 ;;
	-h|--help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
	*) die "未知选项 $1" ;;
	esac
	shift
done

[ "$(uname -s)" = Linux ] || die "只支持 Linux（macOS / Windows 请用桌面安装包）"
UID_=$(id -u)
[ -n "$MODE" ] || { [ "$UID_" = 0 ] && MODE=system || MODE=user; }
case "$PORT" in ''|*[!0-9]*) die "--port 必须是数字" ;; esac

if [ "$MODE" = system ]; then
	[ "$UID_" = 0 ] || die "系统服务需要 root：用 sudo 运行，或加 --user 装成当前用户的服务"
	PREFIX=/opt/pi-assistant; BIN=/usr/local/bin; ETC=/etc/pi-assistant; DATA=/var/lib/pi-assistant
	UNIT=/etc/systemd/system/pi-assistant.service; SVC_USER=pi-assistant
	sctl() { systemctl "$@"; }
else
	[ "$UID_" != 0 ] || die "--user 模式不要用 root 运行"
	: "${HOME:?}"
	PREFIX=${XDG_DATA_HOME:-$HOME/.local/share}/pi-assistant; BIN=$HOME/.local/bin; ETC=${XDG_CONFIG_HOME:-$HOME/.config}/pi-assistant
	DATA=$PREFIX/data; UNIT=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/pi-assistant.service; SVC_USER=$(id -un)
	sctl() { systemctl --user "$@"; }
fi
# sudo -iu / ssh 以外的方式进来时，systemctl --user 需要这两个变量
if [ "$(id -u)" != 0 ]; then
	: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
	[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] || [ ! -S "$XDG_RUNTIME_DIR/bus" ] || export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
HAVE_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
	if [ "$MODE" = system ] || systemctl --user show-environment >/dev/null 2>&1; then HAVE_SYSTEMD=1; fi
fi

# ---------------------------------------------------------------- 卸载
if [ "$ACTION" = uninstall ]; then
	if [ "$HAVE_SYSTEMD" = 1 ] && [ -f "$UNIT" ]; then sctl disable --now pi-assistant >/dev/null 2>&1 || true; fi
	rm -f "$UNIT"; [ "$HAVE_SYSTEMD" = 1 ] && sctl daemon-reload 2>/dev/null || true
	rm -f "$BIN/pi-assistant"
	# 只删我们自己的目录（有 install.conf 才认）
	[ -f "$PREFIX/install.conf" ] && rm -rf "$PREFIX/releases" "$PREFIX/current" "$PREFIX/install.conf"
	if [ "$PURGE" = 1 ]; then
		rm -rf "$DATA" "$ETC"
		[ "$MODE" = system ] && id "$SVC_USER" >/dev/null 2>&1 && userdel "$SVC_USER" 2>/dev/null || true
		say "已卸载，数据和配置已删除。"
	else
		say "已卸载。数据保留在 $DATA，配置在 $ETC（彻底删除：加 --purge）。"
	fi
	rmdir "$PREFIX" 2>/dev/null || true
	exit 0
fi

# ---------------------------------------------------------------- 依赖
command -v tar >/dev/null || die "缺少 tar"
command -v gzip >/dev/null || die "缺少 gzip"
if command -v sha256sum >/dev/null; then sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null; then sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "缺少 sha256sum"; fi
fetch() { # fetch URL 输出文件 [额外请求头]
	if command -v curl >/dev/null; then
		if [ -n "${3:-}" ]; then curl -fL --retry 3 -C - -o "$2" -H "$3" ${PIA_GITHUB_TOKEN:+-H "Authorization: Bearer $PIA_GITHUB_TOKEN"} "$1"
		else curl -fL --retry 3 -C - -o "$2" ${PIA_GITHUB_TOKEN:+-H "Authorization: Bearer $PIA_GITHUB_TOKEN"} "$1"; fi
	elif command -v wget >/dev/null; then
		wget -q --show-progress -c -O "$2" ${3:+--header="$3"} ${PIA_GITHUB_TOKEN:+--header="Authorization: Bearer $PIA_GITHUB_TOKEN"} "$1"
	else die "缺少 curl 或 wget"; fi
}
case "$(uname -m)" in
x86_64|amd64) ARCH=x64 ;;
aarch64|arm64) ARCH=arm64 ;;
*) die "不支持的 CPU 架构 $(uname -m)（支持 x86_64 / aarch64）" ;;
esac
ldd --version 2>&1 | grep -qi musl && die "暂不支持 musl 系统（Alpine）：请用 Debian/Ubuntu/RHEL 系，或用 Docker 部署（deploy/compose.yaml）"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT INT TERM

# ---------------------------------------------------------------- 取发布包
if [ -n "$FILE" ]; then
	[ -f "$FILE" ] || die "找不到 $FILE"
	PKG=$FILE
	if [ -f "$FILE.sha256" ]; then
		[ "$(sha "$FILE")" = "$(cut -d' ' -f1 "$FILE.sha256")" ] || die "SHA256 校验失败：$FILE"
		say "SHA256 校验通过"
	else say "提示：没有 $FILE.sha256，跳过校验"; fi
else
	if [ -n "$VERSION" ]; then API="https://api.github.com/repos/$REPO/releases/tags/v${VERSION#v}"; else API="https://api.github.com/repos/$REPO/releases?per_page=30"; fi
	fetch "$API" "$TMP/release.json" "Accept: application/vnd.github+json" >/dev/null 2>&1 || {
		[ -n "${PIA_GITHUB_TOKEN:-}" ] && die "查不到发布版本（$API）：确认版本号和 PIA_GITHUB_TOKEN 的权限"
		die "查不到发布版本（$API）：检查网络，或下载发布包后用 --file 安装"
	}
	# 发布资产：按 GitHub API 的格式逐行取 "url"（资产 API 地址）和 "name"
	pick() { # pick 资产名 → 资产 API 地址
		awk -v want="$1" '/"url": *"https:\/\/api\.github\.com\/repos\/.*\/releases\/assets\/[0-9]+"/ { match($0, /https:[^"]+/); u = substr($0, RSTART, RLENGTH) }
			/"name": *"/ { n = $0; sub(/.*"name": *"/, "", n); sub(/".*/, "", n); if (n == want && u != "") { print u; exit } }' "$TMP/release.json"
	}
	if [ -n "$VERSION" ]; then
		V=${VERSION#v}
	else
		# 版本列表按发布时间倒序：取第一个带本架构 Linux 包的版本（测试版也算）
		V=$(sed -n "s/.*\"name\": *\"pi-assistant-\([^\"]*\)-linux-$ARCH\.tar\.gz\".*/\1/p" "$TMP/release.json" | head -n1)
		[ -n "$V" ] || die "还没有发布过 Linux $ARCH 版本（$REPO 的 Releases 里没有 pi-assistant-*-linux-$ARCH.tar.gz）"
	fi
	TAG=v$V
	NAME="pi-assistant-$V-linux-$ARCH.tar.gz"
	AU=$(pick "$NAME"); SU=$(pick "$NAME.sha256")
	[ -n "$AU" ] && [ -n "$SU" ] || die "发布 $TAG 里没有 $NAME（这个版本可能还没有 Linux 包）"
	say "下载 $NAME …"
	if [ -n "${PIA_GITHUB_TOKEN:-}" ]; then
		fetch "$SU" "$TMP/$NAME.sha256" "Accept: application/octet-stream"
		fetch "$AU" "$TMP/$NAME" "Accept: application/octet-stream"
	else
		DL="https://github.com/$REPO/releases/download/$TAG"
		fetch "${PIA_DOWNLOAD_MIRROR:-}$DL/$NAME.sha256" "$TMP/$NAME.sha256" || fetch "$DL/$NAME.sha256" "$TMP/$NAME.sha256"
		fetch "${PIA_DOWNLOAD_MIRROR:-}$DL/$NAME" "$TMP/$NAME" || fetch "$DL/$NAME" "$TMP/$NAME"
	fi
	[ "$(sha "$TMP/$NAME")" = "$(cut -d' ' -f1 "$TMP/$NAME.sha256")" ] || die "SHA256 校验失败（下载损坏或被篡改），请重试"
	say "SHA256 校验通过"
	PKG=$TMP/$NAME
fi

# ---------------------------------------------------------------- 解压到 releases/<版本>，切换 current
TOP=$(tar -tzf "$PKG" | head -n1 | cut -d/ -f1)
case "$TOP" in pi-assistant-*-linux-*) ;; *) die "不是 Pi Assistant Linux 发布包：$PKG" ;; esac
case "$TOP" in *-linux-"$ARCH") ;; *) die "发布包架构不对：$TOP（本机 $ARCH）" ;; esac
V=${TOP#pi-assistant-}; V=${V%-linux-*}
mkdir -p "$PREFIX/releases" "$BIN" "$ETC" "$DATA"
rm -rf "$PREFIX/releases/$V.tmp"; mkdir "$PREFIX/releases/$V.tmp"
tar -xzf "$PKG" -C "$PREFIX/releases/$V.tmp" --strip-components=1 --no-same-owner
"$PREFIX/releases/$V.tmp/node" --version >/dev/null 2>&1 || die "内置 Node 无法运行（glibc 太旧？需要 glibc 2.28+）"
rm -rf "$PREFIX/releases/$V"; mv "$PREFIX/releases/$V.tmp" "$PREFIX/releases/$V"
ln -sfn "releases/$V" "$PREFIX/current.new" && mv -T "$PREFIX/current.new" "$PREFIX/current"
cat > "$PREFIX/install.conf" <<CONF
MODE=$MODE
ENV_FILE=$ETC/env
SERVICE_USER=$SVC_USER
CONF
ln -sfn "$PREFIX/current/pi-assistant" "$BIN/pi-assistant"
# 只保留最近 2 个版本
ls -1dt "$PREFIX"/releases/*/ 2>/dev/null | tail -n +3 | while read -r old; do [ "$(readlink -f "$old")" = "$(readlink -f "$PREFIX/current")" ] || rm -rf "$old"; done

# ---------------------------------------------------------------- 账号、配置、数据
if [ "$MODE" = system ] && ! id "$SVC_USER" >/dev/null 2>&1; then
	NOLOGIN=$(command -v nologin || echo /bin/false)
	useradd --system --home-dir "$DATA" --no-create-home --shell "$NOLOGIN" "$SVC_USER" 2>/dev/null \
		|| adduser --system --home "$DATA" --no-create-home --group "$SVC_USER" >/dev/null \
		|| die "创建服务账号 $SVC_USER 失败"
fi
if [ "$DOCKER" = 1 ] && [ "$MODE" = system ]; then
	getent group docker >/dev/null || die "--docker：没有 docker 组（先安装 Docker）"
	usermod -aG docker "$SVC_USER"; say "已把 $SVC_USER 加入 docker 组"
fi
if [ ! -f "$ETC/env" ]; then
	umask 077
	cat > "$ETC/env" <<ENV
# Pi Assistant 服务配置（改完执行 pi-assistant restart）
PIA_HOST=$HOST
PIA_PORT=$PORT
PIA_DATA_DIR=$DATA
# 服务器模式：网页需要先用设置码登录（主人设备），本机回环也不免登录
PIA_HEADLESS=1
PIA_CLI_HINT="$( [ "$MODE" = system ] && echo "sudo pi-assistant setup-code" || echo "pi-assistant setup-code" )"
# 放在反向代理（nginx / Caddy）后面时，可改成 PIA_HOST=127.0.0.1 只让代理访问
ENV
	umask 022
fi
if [ "$MODE" = system ]; then
	chown -R "$SVC_USER:" "$DATA"; chmod 750 "$DATA"
	chown root:"$SVC_USER" "$ETC/env" 2>/dev/null || chown root "$ETC/env"; chmod 640 "$ETC/env"
fi
PORT_NOW=$(sed -n 's/^PIA_PORT=//p' "$ETC/env" | tail -n1); PORT_NOW=${PORT_NOW:-$PORT}

# ---------------------------------------------------------------- systemd
if [ "$HAVE_SYSTEMD" != 1 ]; then
	say ""
	say "没有检测到可用的 systemd（容器里？），已安装但没有注册服务。前台运行："
	say "  set -a; . $ETC/env; set +a; $BIN/pi-assistant run"
	exit 0
fi
mkdir -p "$(dirname "$UNIT")"
if [ "$MODE" = system ]; then
	cat > "$UNIT" <<UNITF
[Unit]
Description=Pi Assistant（服务器版）
Documentation=https://github.com/$REPO/blob/main/docs/INSTALL.md
After=network-online.target docker.service podman.socket
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$ETC/env
Environment=HOME=$DATA
WorkingDirectory=$DATA
ExecStart=$PREFIX/current/pi-assistant run
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
LimitNOFILE=65536
# 加固：只有数据目录可写
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$DATA
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictNamespaces=no

[Install]
WantedBy=multi-user.target
UNITF
else
	cat > "$UNIT" <<UNITF
[Unit]
Description=Pi Assistant（服务器版，用户服务）
After=network-online.target

[Service]
Type=simple
EnvironmentFile=$ETC/env
ExecStart=$PREFIX/current/pi-assistant run
Restart=on-failure
RestartSec=3
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNITF
	# 退出登录后服务也继续运行
	loginctl enable-linger "$SVC_USER" 2>/dev/null || say "提示：执行 sudo loginctl enable-linger $SVC_USER，退出登录后服务才会继续运行"
fi
sctl daemon-reload
if [ "$START" = 1 ]; then
	sctl enable pi-assistant >/dev/null 2>&1
	sctl restart pi-assistant
else
	sctl enable pi-assistant >/dev/null 2>&1 || true
	say "已安装（未启动）：pi-assistant start"; exit 0
fi

# ---------------------------------------------------------------- 等服务起来，显示设置码
say "等待服务启动 …"
i=0; CODE=
while [ $i -lt 60 ]; do
	if [ -f "$DATA/setup-code.txt" ]; then CODE=$(cat "$DATA/setup-code.txt"); break; fi
	if [ $((i % 5)) = 4 ] && "$BIN/pi-assistant" setup-code 2>/dev/null | grep -q "已经设置过"; then break; fi
	sctl is-failed --quiet pi-assistant && { sctl status pi-assistant --no-pager || true; die "服务启动失败，查看日志：pi-assistant logs"; }
	sleep 1; i=$((i + 1))
done
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
say ""
say "✅ Pi Assistant $V 已安装并启动（$MODE 服务）"
say "   网页地址：http://${IP:-<服务器IP>}:$PORT_NOW"
if [ -n "$CODE" ]; then
	say "   一次性设置码：$CODE"
	say "   用浏览器打开网页、输入设置码，这台设备就成为“主人设备”，之后在网页上批准其他设备、修改全部设置。"
else
	say "   已有主人设备（升级保留了原来的数据）。主人设备丢了：pi-assistant reset-owner"
fi
say "   常用命令：pi-assistant status | logs | setup-code | upgrade | uninstall"
say "   公网访问建议放在 HTTPS 反向代理后面（见 docs/INSTALL.md），或用设置里的“远程访问”隧道。"
