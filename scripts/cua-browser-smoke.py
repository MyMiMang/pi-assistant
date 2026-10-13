#!/usr/bin/env python3
"""cua-driver 浏览器（CDP）工具冒烟 + 速度对比（在助理电脑容器里跑）：
  docker cp scripts/cua-browser-smoke.py <容器>:/tmp/ && docker exec <容器> python3 /tmp/cua-browser-smoke.py
流程 A（CDP）：browser_prepare(isolated) → get_browser_state 绑定 → navigate → semantic_v2 快照 → browser_type → browser_click → 再快照验证
流程 B（像素/AX）：launch_app → get_window_state → click → type_text → get_window_state 验证
流程 C（已有 profile）：用户自己开的 Chromium（无调试端口）→ browser_prepare existing_profile（unrestricted 守护进程）"""
import json, os, subprocess, sys, time, threading, http.server, socketserver, re

SOCK = os.environ.get("CUA_SOCK", "/tmp/cua-main.sock")
PAGE = b"""<!doctype html><html><head><title>PIA smoke</title></head><body>
<h1>Pi smoke</h1><label for=q>Search box</label><input id=q aria-label="Search box">
<button id=go onclick="document.getElementById('out').textContent='GOT:'+document.getElementById('q').value">Go button</button>
<p id=out>empty</p></body></html>"""

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers(); self.wfile.write(PAGE)
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", 0), H); PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/"

class Mcp:
    def __init__(s, args):
        s.p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1); s.i = 0
        s.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "pia-smoke", "version": "1"}})
        s.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
    def rpc(s, m, params):
        s.i += 1; s.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": s.i, "method": m, "params": params}) + "\n")
        while True:
            r = json.loads(s.p.stdout.readline())
            if r.get("id") == s.i: return r
    def call(s, name, args):
        t = time.time(); r = s.rpc("tools/call", {"name": name, "arguments": args}); dt = time.time() - t
        res = r.get("result", {}); txt = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        sc = res.get("structuredContent")
        ok = not res.get("isError") and "error" not in r and not txt.startswith("refused")
        print(f"  {name:22s} {dt*1000:7.0f} ms {'ok' if ok else 'ERR'}  {(txt or json.dumps(r.get('error')))[:160]!r}", flush=True)
        return ok, txt, sc, dt

def j(txt, sc):
    if isinstance(sc, dict): return sc
    try: return json.loads(txt)
    except Exception: return {}

def find_ref(state, label):
    # semantic_v2 refs: [{ref, role, name, actions}]
    snap = state.get("snapshot", state)
    for r in snap.get("refs", []) or state.get("refs", []):
        if label.lower() in json.dumps(r).lower(): return r.get("ref")
    m = re.search(r'"?(p\d+:\d+)"?[^\n]{0,120}' + re.escape(label), json.dumps(state))
    return m.group(1) if m else None

def wins(m, pid):
    ok, t, sc, _ = m.call("list_windows", {"pid": pid})
    d = j(t, sc); w = d.get("windows", [])
    return w

def cdp_flow(m, session, pid, label):
    total = 0
    for _ in range(40):
        w = wins(m, pid)
        if w: break
        time.sleep(0.5)
    if not w: print("  no window"); return None
    wid = w[0].get("window_id")
    ok, t, sc, dt = m.call("get_browser_state", {"pid": pid, "window_id": wid, "session": session}); total += dt
    b = j(t, sc); tid = b.get("target_id"); tabs = b.get("tabs") or []
    tab = (next((x for x in tabs if x.get("active")), None) or (tabs[0] if tabs else {})).get("tab_id")
    print(f"  bind: status={b.get('status')} quality={b.get('binding_quality')} mutation_allowed={b.get('mutation_allowed')} target={tid} tab={tab}")
    if not (tid and tab): return None
    steps = [("browser_navigate", {"target_id": tid, "tab_id": tab, "url": URL, "session": session})]
    for n, a in steps:
        ok, t, sc, dt = m.call(n, a); total += dt
    time.sleep(0.3)
    ok, t, sc, dt = m.call("get_browser_state", {"target_id": tid, "tab_id": tab, "session": session, "snapshot_format": "semantic_v2"}); total += dt
    st = j(t, sc); box = find_ref(st, "Search box"); go = find_ref(st, "Go button")
    print(f"  refs: search={box} go={go}")
    if not box or not go: print(t[:1500]); return None
    ok1, *_r, dt = m.call("browser_type", {"target_id": tid, "tab_id": tab, "ref": box, "text": "hello cdp", "session": session}); total += dt
    if not ok1:
        m.call("browser_click", {"target_id": tid, "tab_id": tab, "ref": box, "input_route": "dom_event", "session": session})
        ok1, *_r, dt = m.call("browser_type", {"target_id": tid, "tab_id": tab, "ref": box, "text": "hello cdp", "session": session}); total += dt
    ok2, t2, *_r, dt = m.call("browser_click", {"target_id": tid, "tab_id": tab, "ref": go, "session": session}); total += dt
    if not ok2:
        ok2, *_r, dt = m.call("browser_click", {"target_id": tid, "tab_id": tab, "ref": go, "input_route": "dom_event", "session": session}); total += dt
    ok, t, sc, dt = m.call("get_browser_state", {"target_id": tid, "tab_id": tab, "session": session, "snapshot_format": "semantic_v2"}); total += dt
    verified = "GOT:hello cdp" in t + json.dumps(sc or {})
    print(f"  [{label}] verified={verified} tool-time={total*1000:.0f} ms")
    return verified, total

def main():
    S = f"smoke{int(time.time())}"
    m = Mcp(["cua-driver", "mcp", "--socket", SOCK])
    tools = [t["name"] for t in m.rpc("tools/list", {})["result"]["tools"]]
    print("browser tools:", [t for t in tools if t.startswith("browser_") or t == "get_browser_state"])
    m.call("start_session", {"session": S})
    print("== A: CDP, driver-owned isolated Chromium")
    ok, t, sc, _ = m.call("browser_prepare", {"session": S, "allow_launch": True, "profile": {"mode": "isolated_new"}})
    pid = j(t, sc).get("prepared_pid")
    a = cdp_flow(m, S, pid, "A isolated") if pid else None

    print("== C: existing profile = the assistant computer's shared Chromium (production flags, own debug port)")
    flags = ["--user-data-dir=/tmp/pia-userprof", "--remote-debugging-port=9333", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-dev-shm-usage", "--force-renderer-accessibility", URL]
    subprocess.Popen(["chromium", *flags], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    bpid = None
    for _ in range(40):
        time.sleep(0.5)
        out = subprocess.run(["pgrep", "-f", "pia-userprof"], capture_output=True, text=True).stdout.split()
        for x in out:
            cmd = open(f"/proc/{x}/cmdline").read()
            if "--type=" not in cmd and "/chromium" in cmd.split("\0")[0]: bpid = int(x)
        if bpid and wins(m, bpid): break
    time.sleep(2)
    w = wins(m, bpid); wid = w[0]["window_id"]
    print(f"  browser pid={bpid} window={wid}")
    ok, t, sc, _ = m.call("get_browser_state", {"pid": bpid, "window_id": wid, "session": S})
    ok, t, sc, _ = m.call("browser_prepare", {"pid": bpid, "window_id": wid, "session": S, "strategy": {"kind": "existing_profile"}})
    print("  prepare result:", t[:700])
    c = cdp_flow(m, S, bpid, "C existing") if ok and "refused" not in t else None

    print("== B: pixel/AX flow on the same window (get_window_state + click + type_text)")
    total = 0
    ok, t, sc, dt = m.call("browser_navigate", {}) if False else (True, "", None, 0)
    ok, md, sc, dt = m.call("get_window_state", {"pid": bpid, "window_id": wid}); total += dt
    def tok(label, sc):
        for e in (sc or {}).get("elements", []):
            if label in json.dumps(e, ensure_ascii=False): return e.get("element_token") or e.get("token")
        return None
    if sc and not tok("Search box", sc): print("  element keys:", list((sc.get("elements") or [{}])[0].keys()))
    sb, gb = tok("Search box", sc), tok("Go button", sc)
    print(f"  AX tokens: search={sb} go={gb}  (AX snapshot {len(md)} chars)")
    b_ok = False
    if sb is not None and gb is not None:
        _, _, _, dt = m.call("click", {"pid": bpid, "window_id": wid, "element_token": sb, "delivery_mode": "foreground"}); total += dt
        _, _, _, dt = m.call("type_text", {"pid": bpid, "window_id": wid, "text": "hello px", "delivery_mode": "foreground"}); total += dt
        ok, md2, sc2, dt = m.call("get_window_state", {"pid": bpid, "window_id": wid}); total += dt
        gb = tok("Go button", sc2) or gb
        _, _, _, dt = m.call("click", {"pid": bpid, "window_id": wid, "element_token": gb, "delivery_mode": "foreground"}); total += dt
        time.sleep(0.3)
        ok, t, sc, dt = m.call("get_window_state", {"pid": bpid, "window_id": wid}); total += dt
        b_ok = "GOT:" in t and "hello px" in t
    print(f"  [B pixel/AX] verified={b_ok} tool-time={total*1000:.0f} ms")
    m.call("end_session", {"session": S})
    print(json.dumps({"A_isolated": a, "B_pixel": b_ok, "C_existing": c}))

main()
