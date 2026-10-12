#!/usr/bin/env bash
# 假 limactl（集成测试用）：在 $LIMA_HOME/pia-desktop 里记状态；`shell pia-desktop sudo nerdctl …` 转给本机 docker。
# 行为开关：$LIMA_HOME/fail-start（start 失败）、$LIMA_HOME/unhealthy-once（下一次 nerdctl version 失败）
set -u
H="${LIMA_HOME:?LIMA_HOME 未设置}"
D="$H/pia-desktop"
echo "$*" >> "$H/calls.log"
sub="$1"; shift
case "$sub" in
  --version) echo "limactl version 2.2.1-fake";;
  list)
    [ -d "$D" ] && printf '{"name":"pia-desktop","status":"%s","vmType":"vz"}\n' "$(cat "$D/status" 2>/dev/null || echo Stopped)"
    exit 0;;
  create)
    name=""; file=""
    for a in "$@"; do case "$a" in --name=*) name="${a#--name=}";; -*) ;; *) file="$a";; esac; done
    [ "$name" = "pia-desktop" ] || { echo "bad name $name" >&2; exit 1; }
    mkdir -p "$D" && cp "$file" "$D/lima.yaml" && echo Stopped > "$D/status";;
  start)
    [ -f "$H/fail-start" ] && { echo 'level=fatal msg="VZErrorDomain Code=2"' >&2; exit 1; }
    [ -d "$D" ] || { echo "no instance" >&2; exit 1; }
    echo Running > "$D/status";;
  stop) [ -d "$D" ] && echo Stopped > "$D/status";;
  delete) rm -rf "$D";;
  shell)
    [ "$(cat "$D/status" 2>/dev/null)" = Running ] || { echo "instance not running" >&2; exit 1; }
    while [ "$1" != "pia-desktop" ]; do shift; done; shift
    [ "$1" = sudo ] && shift; [ "$1" = nerdctl ] && shift
    if [ "${1:-}" = version ] && [ -f "$H/unhealthy-once" ]; then rm -f "$H/unhealthy-once"; exit 1; fi
    # 测试机的 Docker 是共用的：ps 只看本测试的容器（真虚拟机里只有我们自己的容器）
    if [ "${1:-}" = ps ] && [ -n "${FAKE_LIMA_PS_NAME:-}" ]; then shift; exec docker ps --filter "name=$FAKE_LIMA_PS_NAME" "$@"; fi
    exec docker "$@";;
  *) echo "unexpected $sub" >&2; exit 2;;
esac
