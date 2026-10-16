#!/usr/bin/env python3
"""带超时的进程组运行器（e2e / 重脚本用，避免超时后留下孤儿进程）。

用法：
    python3 scripts/run-with-timeout.py <秒> -- <命令> [参数...]
例：
    python3 scripts/run-with-timeout.py 200 -- node e2e/ui-consistency-motion.mjs

为什么需要它：macOS 自带没有 `timeout`（也没有 coreutils 的 `gtimeout`）。直接跑一个卡住的
浏览器 / 服务器脚本会一直挂着，上一轮就因此留下过孤儿进程把机器拖垮。
本脚本把子进程放进**自己的进程组**（`start_new_session=True`），超时或收到 Ctrl-C 时
对**整个进程组**发 SIGTERM、再 SIGKILL，所以 e2e 起的 node / Chrome 子进程会被一起收掉。

退出码：子进程的退出码；超时 124；被 Ctrl-C 中断 130。
"""
import os
import signal
import subprocess
import sys
import time


def main() -> None:
    if len(sys.argv) < 4 or sys.argv[2] != "--":
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    try:
        seconds = float(sys.argv[1])
    except ValueError:
        print(f"超时秒数不是数字：{sys.argv[1]}", file=sys.stderr)
        sys.exit(2)
    cmd = sys.argv[3:]
    started = time.time()
    proc = subprocess.Popen(cmd, start_new_session=True)
    try:
        code = proc.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        print(f"\n[run-with-timeout] 超时 {seconds:.0f}s，收掉进程组 {proc.pid}", flush=True)
        _kill_group(proc)
        code = 124
    except KeyboardInterrupt:
        print(f"\n[run-with-timeout] 被中断，收掉进程组 {proc.pid}", flush=True)
        _kill_group(proc)
        code = 130
    print(f"\n[run-with-timeout] exit={code} elapsed={time.time() - started:.1f}s", flush=True)
    sys.exit(code)


def _kill_group(proc: subprocess.Popen) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=10)
            return
        except subprocess.TimeoutExpired:
            continue


if __name__ == "__main__":
    main()
