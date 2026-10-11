"""
一次性工具：把 docs/design/mockups/src/*.css（设计稿）移植为 App 的主题 CSS。
规则：类名加 pa- 前缀；[data-theme=light|dark] → [data-mode=…]；皮肤文件整体限定在 [data-skin=<id>] 下；
body/:root → 皮肤作用域；动画名加 pa- 前缀；去掉设计稿专用的布局/示意元素。
用法：python3 apps/web/scripts/port-mockup-css.py
"""
import re, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[3]
SRC = ROOT / "docs/design/mockups/src"
OUT = ROOT / "apps/web/src/themes"
ANIMS = ["pulse","spin","shim","fadeup","blink","cur","rip","drift","rise","orbit","breathe"]
DROP_BASE = re.compile(r"^(\*|html,body|button|kbd|\.app|\.m-only|\.style-tag|\.flex|\.desk|\.win|\.win-bar|\.win-bar i|\.win-bar span|\.win-body|\.sk|\.cols|\.col|\.col\.hl|\.price|\.taskbar|\.taskbar i|\.cursor|\.ripple|\.bg-layer|\.sk\.w60|\.w60|\.w40|\.w50)$")

def parse(css):
    out, i, n = [], 0, len(css)
    while i < n:
        j = css.find("{", i)
        if j < 0: break
        prelude = css[i:j].strip()
        depth, k = 1, j + 1
        while depth and k < n:
            if css[k] == "{": depth += 1
            elif css[k] == "}": depth -= 1
            k += 1
        out.append((prelude, css[j+1:k-1]))
        i = k
    return out

def cls(sel):
    return re.sub(r"(?<![\w-])\.([a-zA-Z][\w-]*)", r".pa-\1", sel)

def scope_sel(sel, skin):
    sel = sel.strip()
    sel = re.sub(r"\[data-theme=(light|dark)\]", r"[data-mode=\1]", sel)
    sel = cls(sel)
    if skin is None:
        if sel == "body": return ".pa-app"
        return re.sub(r"^(\[data-mode=\w+\]) body\b", r"\1 .pa-app", sel)
    if sel == ":root": return f"[data-skin={skin}]"
    if sel == "body": return f"[data-skin={skin}] .pa-app"
    m = re.match(r"^(\[data-mode=\w+\])(.*)$", sel)
    if m:
        rest = m.group(2).strip()
        if rest == "body": rest = ".pa-app"
        return f"[data-skin={skin}]{m.group(1)}" + (f" {rest}" if rest else "")
    return f"[data-skin={skin}] {sel}"

def anim(body):
    for a in ANIMS:
        body = re.sub(rf"(animation:\s*){a}\b", rf"\1pa-{a}", body)
    return body

def port(css, skin):
    res = []
    for prelude, body in parse(css):
        if prelude.startswith("@keyframes"):
            res.append(f"@keyframes pa-{prelude.split()[1]}{{{body}}}"); continue
        if prelude.startswith("@property"):
            res.append(f"{prelude}{{{body}}}"); continue
        if prelude.startswith("@media"):
            if skin is None: continue
            res.append(f"{prelude}{{{port(body, skin)}}}"); continue
        sels = [s for s in prelude.split(",") if not (skin is None and DROP_BASE.match(s.strip()))]
        if not sels: continue
        res.append(",".join(scope_sel(s, skin) for s in sels) + f"{{{anim(body)}}}")
    return "\n".join(res)

hdr = "/* 由 apps/web/scripts/port-mockup-css.py 从 docs/design/mockups/src 生成；可手工微调。 */\n"
(OUT / "base.css").write_text(hdr + port((SRC/"base.css").read_text(), None) + "\n")
for skin in ["linear","glass","warm","noir"]:
    (OUT / f"{skin}.css").write_text(hdr + port((SRC/f"{skin}.css").read_text(), skin) + "\n")
print("ok")
