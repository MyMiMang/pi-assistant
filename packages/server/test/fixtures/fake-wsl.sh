#!/usr/bin/env bash
# 假 wsl.exe（集成测试用，Linux 上跑）。状态记在 $PIA_WSL_HOME/fake/。
# 两种模式：
#  - 默认：`-d PiAssistant-Desktop … --exec nerdctl …` 转给本机 docker（桌面容器、host 网络、端口、家目录卷都是真的）
#  - FAKE_WSL_CT=<容器名> + FAKE_WSL_IMAGE=<rootfs 镜像>：--import 时用我们构建的 rootfs 创建一个特权容器模拟发行版，
#    `--exec` 在里面执行（真实 containerd + nerdctl + pia-engine）；/var/lib 放在 FAKE_WSL_VARLIB（需 ext4 才能用 overlayfs）
# 行为开关：$PIA_WSL_HOME/fake/status-out（--status 的输出）+ status-rc（退出码）、fail-import
set -u
H="${PIA_WSL_HOME:?PIA_WSL_HOME 未设置}"; F="$H/fake"; mkdir -p "$F"
echo "$*" >> "$F/calls.log"
D=PiAssistant-Desktop
running() { if [ -n "${FAKE_WSL_CT:-}" ]; then [ "$(docker inspect -f '{{.State.Running}}' "$FAKE_WSL_CT" 2>/dev/null)" = true ]; else [ -f "$F/running" ]; fi; }
case "${1:-}" in
  --status) cat "$F/status-out" 2>/dev/null || echo "Default Version: 2"; exit "$(cat "$F/status-rc" 2>/dev/null || echo 0)";;
  --version) echo "WSL version: 2.6.1.0"; exit 0;;
  --list|-l)
    [ -f "$F/registered" ] || { echo "Windows Subsystem for Linux has no installed distributions."; exit 1; }
    printf '  NAME                   STATE           VERSION\n* Ubuntu                 Stopped         2\n  %s    %s         2\n' "$D" "$(running && echo Running || echo Stopped)"; exit 0;;
  --import)
    [ -f "$F/fail-import" ] && { echo "Error code: Wsl/Service/RegisterDistro/0x80370114" >&2; exit 1; }
    [ "$2" = "$D" ] || exit 9
    [ -f "$4" ] || { echo "no tarball" >&2; exit 1; }
    mkdir -p "$3" && echo vhdx > "$3/ext4.vhdx"
    if [ -n "${FAKE_WSL_CT:-}" ]; then
      docker rm -f "$FAKE_WSL_CT" >/dev/null 2>&1
      docker create --name "$FAKE_WSL_CT" --privileged --cgroupns=host --network host -v /sys/fs/cgroup:/sys/fs/cgroup -v "${FAKE_WSL_VARLIB:?}:/var/lib" "${FAKE_WSL_IMAGE:?}" sleep infinity >/dev/null || exit 1
    fi
    touch "$F/registered"; exit 0;;
  --terminate|-t)
    [ -n "${FAKE_WSL_CT:-}" ] && docker stop -t 1 "$FAKE_WSL_CT" >/dev/null 2>&1
    rm -f "$F/running"; pkill -f "fake-wsl-keeper-$$" 2>/dev/null; exit 0;;
  --unregister)
    [ -n "${FAKE_WSL_CT:-}" ] && docker rm -f "$FAKE_WSL_CT" >/dev/null 2>&1
    rm -f "$F/registered" "$F/running"; exit 0;;
  -d)
    [ "$2" = "$D" ] || exit 9
    [ -f "$F/registered" ] || { echo "There is no distribution with the supplied name." >&2; exit 1; }
    while [ "$1" != "--exec" ]; do shift; done; shift
    if [ -n "${FAKE_WSL_CT:-}" ]; then
      running || docker start "$FAKE_WSL_CT" >/dev/null
      if [ "$1" = nerdctl ] && [ "${2:-}" = ps ] && [ -n "${FAKE_WSL_PS_NAME:-}" ]; then shift 2; exec docker exec -i "$FAKE_WSL_CT" nerdctl ps --filter "name=$FAKE_WSL_PS_NAME" "$@"; fi
      exec docker exec -i "$FAKE_WSL_CT" "$@"
    fi
    touch "$F/running"
    case "$1" in
      /usr/local/bin/pia-engine) echo "pia-engine: 启动 containerd"; while [ -f "$F/running" ]; do sleep 0.5; done; exit 0;;
      nerdctl) shift
        if [ "${1:-}" = version ]; then [ -f "$F/running" ] && { echo '{"Components":[{"Name":"containerd","Version":"v2.4.1"}]}'; exit 0; }; exit 1; fi
        if [ "${1:-}" = ps ] && [ -n "${FAKE_WSL_PS_NAME:-}" ]; then shift; exec docker ps --filter "name=$FAKE_WSL_PS_NAME" "$@"; fi
        exec docker "$@";;
      *) exec "$@";;
    esac;;
  *) echo "unexpected $*" >&2; exit 2;;
esac
