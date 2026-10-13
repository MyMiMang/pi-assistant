#!/usr/bin/env python3
"""
内置桌宠美术生成器（原创矢量画法，程序绘制，版权干净）。
输出 Codex 宠物格式（v1）：apps/web/public/pets/<id>/{pet.json, spritesheet.png}
  1536x1872，8 列 x 9 行，每格 192x208；行定义与帧数沿用 openai/skills hatch-pet（Apache-2.0）的 animation-rows。
用法：python3 scripts/pets/gen-presets.py [--preview 输出目录]
"""
import json, math, os, sys
from PIL import Image, ImageDraw, ImageFont

CW, CH, COLS, ROWS = 192, 208, 8, 9
S = 4  # 超采样倍数：先画大再缩小，边缘平滑
W, H = CW * S, CH * S
ROW_FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6]
ROW_NAMES = ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"]
INK = (52, 38, 48, 255)
OUT_W = 7 * S
G = 0.84  # 角色整体缩放：给跳跃 / 挥手留出格子空间  # 描边粗细

PETS = {
    "miao": dict(name="喵喵", desc="一只橘色的 Q 版小猫。", kind="cat", body=(255, 178, 102), belly=(255, 236, 214), accent=(255, 140, 150)),
    "tuanzi": dict(name="团子", desc="软乎乎的粉白团子。", kind="dango", body=(255, 244, 246), belly=(255, 214, 224), accent=(255, 150, 175)),
    "xiaotie": dict(name="小铁", desc="屏幕脸的小机器人。", kind="robot", body=(170, 196, 222), belly=(60, 72, 96), accent=(110, 235, 220)),
    "jiujiu": dict(name="啾啾", desc="圆滚滚的小黄鸡。", kind="chick", body=(255, 216, 77), belly=(255, 240, 170), accent=(255, 150, 60)),
}


def p(v):
    return int(round(v * S))


def ell(d, cx, cy, rx, ry, fill, outline=True):
    d.ellipse([p(cx - rx), p(cy - ry), p(cx + rx), p(cy + ry)], fill=fill, outline=INK if outline else None, width=OUT_W if outline else 0)


def rrect(d, x0, y0, x1, y1, r, fill, outline=True):
    d.rounded_rectangle([p(x0), p(y0), p(x1), p(y1)], radius=p(r), fill=fill, outline=INK if outline else None, width=OUT_W if outline else 0)


def poly(d, pts, fill, outline=True):
    d.polygon([(p(x), p(y)) for x, y in pts], fill=fill)
    if outline:
        d.line([(p(x), p(y)) for x, y in pts + [pts[0]]], fill=INK, width=OUT_W, joint="curve")


def arc(d, cx, cy, rx, ry, a0, a1, w=6):
    d.arc([p(cx - rx), p(cy - ry), p(cx + rx), p(cy + ry)], a0, a1, fill=INK, width=p(w / 1.6))


def eyes(d, cx, cy, gap, style, look=(0, 0), size=1.0, color=INK, glow=None):
    lx, ly = look
    for sgn in (-1, 1):
        x = cx + sgn * gap + lx
        y = cy + ly
        r = 7.5 * size
        if style == "open" or style == "look":
            if glow:
                ell(d, x, y, r * 0.9, r * 1.1, glow, outline=False)
            else:
                ell(d, x, y, r * 0.85, r * 1.1, color, outline=False)
                ell(d, x + 2.2, y - 3, r * 0.32, r * 0.36, (255, 255, 255, 255), outline=False)
        elif style == "closed":
            arc(d, x, y - 2, r, r * 0.7, 20, 160, 6)
        elif style == "happy":
            arc(d, x, y + 4, r, r * 0.9, 200, 340, 6)
        elif style == "sad":
            ell(d, x, y + 2, r * 0.75, r * 0.85, glow or color, outline=False)
            d.line([(p(x - r), p(y - r * 1.3 + (-3 if sgn < 0 else 3) * -1)), (p(x + r), p(y - r * 1.3 + (3 if sgn < 0 else -3) * -1))], fill=INK, width=p(3.4))
        elif style == "focus":
            ell(d, x, y, r * 0.8, r * 0.62, glow or color, outline=False)
            d.line([(p(x - r * 1.1), p(y - r * 1.25 - (2 if sgn > 0 else -2) * -1)), (p(x + r * 1.1), p(y - r * 1.25 + (2 if sgn > 0 else -2) * -1))], fill=INK, width=p(3.4))


def mouth(d, cx, cy, style, w=1.0):
    if style == "smile":
        arc(d, cx, cy - 3, 6 * w, 5 * w, 20, 160, 5)
    elif style == "cat":
        arc(d, cx - 4.5, cy - 2, 4.5, 4, 0, 180, 5)
        arc(d, cx + 4.5, cy - 2, 4.5, 4, 0, 180, 5)
    elif style == "open":
        ell(d, cx, cy + 1, 6 * w, 6.5 * w, (200, 70, 90, 255))
    elif style == "sad":
        arc(d, cx, cy + 5, 6 * w, 5 * w, 200, 340, 5)
    elif style == "flat":
        d.line([(p(cx - 5), p(cy)), (p(cx + 5), p(cy))], fill=INK, width=p(3.4))
    elif style == "o":
        ell(d, cx, cy, 3.6, 4.2, (200, 70, 90, 255))


def draw_char(pet, f):
    """在 W x H 的透明画布上画一个姿势（未变形），角色脚底在 y≈196，中心 x=96"""
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    k = pet["kind"]
    body, belly, acc = pet["body"] + (255,), pet["belly"] + (255,), pet["accent"] + (255,)
    face_dx = f.get("dir", 0) * 9
    look = f.get("look", (0, 0))
    look = (look[0] + face_dx, look[1])
    es = f.get("eyes", "open")
    ms = f.get("mouth", "smile")
    ph = f.get("feet", 0.0)  # 走路相位
    armL, armR = f.get("armL", 0), f.get("armR", 0)  # 0=垂下，1=举起
    blush = (255, 140, 160, 150)

    def feet(y=192, gap=20, rx=13, ry=8, col=None):
        col = col or body
        for sgn, phase in ((-1, ph), (1, ph + math.pi)):
            lift = max(0.0, math.sin(phase)) * 7 if f.get("walking") else 0
            fx = 96 + sgn * gap + (math.cos(phase) * 5 if f.get("walking") else 0)
            ell(d, fx, y - lift, rx, ry, col)

    late = []

    def paw(side, raised, cx, cy, reach=46, col=None, r=11, now=False):
        col = col or body
        if raised > 0.3 and not now:
            late.append((side, raised, cx, cy, reach, col, r))
            return
        a = math.radians(200 if side < 0 else -20) if not raised else math.radians(150 - 40 * raised if side < 0 else 30 + 40 * raised)
        # 垂下时贴着身体两侧；举起时向上
        if not raised:
            x, y = cx + side * reach, cy + 22
        else:
            x = cx + side * (reach + 4 * raised)
            y = cy + 18 - 74 * raised
        ell(d, x, y, r, r * 0.95, col)

    if k == "cat":
        # 尾巴（身后）
        tw = math.sin(f.get("t", 0) * 2 * math.pi) * 6
        d.line([(p(128), p(170)), (p(150), p(150 + tw * 0.3)), (p(156), p(124 + tw))], fill=INK, width=p(22), joint="curve")
        d.line([(p(128), p(170)), (p(150), p(150 + tw * 0.3)), (p(156), p(124 + tw))], fill=body, width=p(12), joint="curve")
        ell(d, 156, 124 + tw, 6, 6, body, outline=False)
        feet(193, 18, 12, 8)
        ell(d, 96, 162, 40, 32, body)  # 身体
        ell(d, 96, 168, 24, 20, belly, outline=False)
        paw(-1, armL, 96, 150, 40)
        paw(1, armR, 96, 150, 40)
        # 耳朵
        for sgn in (-1, 1):
            poly(d, [(96 + sgn * 52, 76), (96 + sgn * 46, 30), (96 + sgn * 18, 58)], body)
            poly(d, [(96 + sgn * 45, 68), (96 + sgn * 42, 42), (96 + sgn * 26, 60)], acc, outline=False)
        ell(d, 96, 98, 62, 50, body)  # 头
        # 额头条纹
        for i, x in enumerate((-12, 0, 12)):
            d.line([(p(96 + x), p(52)), (p(96 + x * 0.8), p(64 - (4 if i == 1 else 0)))], fill=(230, 130, 60, 255), width=p(4))
        ell(d, 96 - 34 + face_dx, 114, 9, 5.5, blush, outline=False)
        ell(d, 96 + 34 + face_dx, 114, 9, 5.5, blush, outline=False)
        eyes(d, 96, 100, 21, es, look)
        ell(d, 96 + face_dx, 111, 4, 3, acc, outline=False)  # 鼻子
        mouth(d, 96 + face_dx, 118, "cat" if ms == "smile" else ms)
        for sgn in (-1, 1):
            for dy in (-3, 5):
                d.line([(p(96 + sgn * 46 + face_dx), p(110 + dy)), (p(96 + sgn * 66 + face_dx), p(106 + dy * 1.6))], fill=INK, width=p(2.6))
    elif k == "dango":
        feet(194, 22, 13, 7, belly)
        # 头顶小叶子
        poly(d, [(96, 70), (84, 52), (100, 46), (108, 60)], (140, 205, 120, 255))
        d.line([(p(96), p(70)), (p(100), p(52))], fill=INK, width=p(3))
        d.rounded_rectangle([p(30), p(68), p(162), p(194)], radius=p(62), fill=body, outline=INK, width=OUT_W)
        paw(-1, armL, 96, 142, 64, belly, 13)
        paw(1, armR, 96, 142, 64, belly, 13)
        ell(d, 96 - 38 + face_dx, 140, 12, 7, blush, outline=False)
        ell(d, 96 + 38 + face_dx, 140, 12, 7, blush, outline=False)
        eyes(d, 96, 124, 24, es, look, 1.05)
        mouth(d, 96 + face_dx, 142, ms)
    elif k == "robot":
        feet(194, 20, 14, 7, (120, 138, 160, 255))
        rrect(d, 58, 140, 134, 188, 16, body)  # 身体
        ell(d, 96, 162, 10, 10, pet["accent"] + (255,))
        def robot_arm(side, raised):
            # 弹簧手臂 + 圆手
            if not raised:
                hx, hy = 96 + side * 54, 172
            else:
                hx, hy = 96 + side * (54 + 4 * raised), 160 - 76 * raised
            d.line([(p(96 + side * 36), p(156)), (p(hx), p(hy))], fill=INK, width=p(9))
            d.line([(p(96 + side * 36), p(156)), (p(hx), p(hy))], fill=(120, 138, 160, 255), width=p(4))
            ell(d, hx, hy, 11, 11, body)
        for side, raised in ((-1, armL), (1, armR)):
            if raised <= 0.3:
                robot_arm(side, raised)
        # 天线
        d.line([(p(96), p(50)), (p(96), p(28))], fill=INK, width=p(5))
        blink = acc if f.get("t", 0) % 0.5 < 0.25 else (255, 220, 120, 255)
        ell(d, 96, 24, 8, 8, blink)
        rrect(d, 34, 48, 158, 142, 30, body)  # 头
        for sgn in (-1, 1):
            rrect(d, 96 + sgn * 62 - 6, 82, 96 + sgn * 62 + 6, 108, 5, (120, 138, 160, 255))
        rrect(d, 48, 62, 144, 128, 20, belly)  # 屏幕
        eyes(d, 96, 92, 22, es, look, 1.0, glow=acc)
        if ms in ("smile", "cat"):
            arc(d, 96 + face_dx, 106, 8, 6, 20, 160, 5)
            # 屏幕上的笑脸用发光色重描
            d.arc([p(96 + face_dx - 8), p(100), p(96 + face_dx + 8), p(112)], 20, 160, fill=acc, width=p(3.2))
        elif ms == "sad":
            d.arc([p(96 + face_dx - 8), p(108), p(96 + face_dx + 8), p(120)], 200, 340, fill=acc, width=p(3.2))
        elif ms in ("open", "o"):
            d.ellipse([p(96 + face_dx - 5), p(104), p(96 + face_dx + 5), p(116)], outline=acc, width=p(3.2))
        else:
            d.line([(p(96 + face_dx - 6), p(110)), (p(96 + face_dx + 6), p(110))], fill=acc, width=p(3.2))
        for side, raised in ((-1, armL), (1, armR)):
            if raised > 0.3:
                robot_arm(side, raised)
    elif k == "chick":
        for sgn, phase in ((-1, ph), (1, ph + math.pi)):  # 小爪子
            lift = max(0.0, math.sin(phase)) * 7 if f.get("walking") else 0
            fx = 96 + sgn * 18
            d.line([(p(fx), p(184 - lift)), (p(fx), p(196 - lift))], fill=INK, width=p(8))
            d.line([(p(fx), p(184 - lift)), (p(fx), p(196 - lift))], fill=acc, width=p(4))
            d.line([(p(fx - 8), p(197 - lift)), (p(fx + 8), p(197 - lift))], fill=INK, width=p(6))
        # 头顶呆毛
        d.line([(p(92), p(62)), (p(86), p(42)), (p(96), p(48)), (p(102), p(36))], fill=INK, width=p(7), joint="curve")
        d.line([(p(92), p(62)), (p(86), p(42)), (p(96), p(48)), (p(102), p(36))], fill=body, width=p(3), joint="curve")
        ell(d, 96, 126, 64, 62, body)
        ell(d, 96, 150, 36, 28, belly, outline=False)
        # 翅膀
        for side, raised in ((-1, armL), (1, armR)):
            if not raised:
                poly(d, [(96 + side * 58, 120), (96 + side * 74, 148), (96 + side * 52, 156)], body)
            else:
                poly(d, [(96 + side * 58, 124), (96 + side * (82 - 8 * raised), 124 - 46 * raised), (96 + side * 54, 106)], body)
        ell(d, 96 - 36 + face_dx, 132, 10, 6, blush, outline=False)
        ell(d, 96 + 36 + face_dx, 132, 10, 6, blush, outline=False)
        eyes(d, 96, 114, 22, es, look)
        bx = 96 + face_dx
        if ms in ("open", "o"):
            poly(d, [(bx - 9, 126), (bx + 9, 126), (bx, 134)], acc)
            poly(d, [(bx - 7, 136), (bx + 7, 136), (bx, 142)], acc)
        else:
            poly(d, [(bx - 10, 126), (bx + 10, 126), (bx, 138)], acc)
        if ms == "sad":
            arc(d, bx, 150, 5, 4, 200, 340, 4)

    for a in late:
        paw(*a, now=True)
    # 贴着身体的小效果（不能脱离轮廓，保证透明处理干净）
    if f.get("tear"):
        x = 96 + 30 + face_dx
        poly(d, [(x, 102), (x - 6, 116), (x + 6, 116)], (130, 200, 255, 255), outline=False)
        ell(d, x, 117, 6, 6, (130, 200, 255, 255), outline=False)
    if f.get("sweat"):
        x = 140
        ell(d, x, 72, 6, 8, (150, 210, 255, 255))
    return im


def place(char, dy=0.0, sx=1.0, sy=1.0, rot=0.0, dx=0.0):
    """以脚底中点为锚：缩放（挤压）→ 旋转 → 平移"""
    sx, sy = sx * G, sy * G
    ax, ay = 96 * S, 197 * S
    nw, nh = max(1, int(W * sx)), max(1, int(H * sy))
    c = char.resize((nw, nh), Image.LANCZOS)
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.alpha_composite(c, (int(ax - ax * sx + dx * S), int(ay - ay * sy + dy * S)))
    if rot:
        out = out.rotate(rot, resample=Image.BICUBIC, center=(ax + dx * S, ay + dy * S))
    return out


def frames_for(pet):
    rows = []
    # 0 idle：呼吸 + 眨眼
    breath = [0, 0.015, 0.03, 0.02, 0.005, -0.01]
    rows.append([place(draw_char(pet, dict(eyes="closed" if i in (1, 2) else "open", t=i / 6)), sy=1 + b, sx=1 - b * 0.5) for i, b in enumerate(breath)])
    # 1 running-right：朝右小跑（身体前倾、上下颠）
    run = []
    for i in range(8):
        a = i / 8 * 2 * math.pi
        run.append(place(draw_char(pet, dict(dir=1, walking=True, feet=a, t=i / 8, armL=0.15 * (1 + math.sin(a)), armR=0.15 * (1 - math.sin(a)))), dy=-abs(math.sin(a)) * 6, rot=-5, sy=1 - abs(math.cos(a)) * 0.02))
    rows.append(run)
    # 2 running-left：角色左右对称，按官方允许镜像右跑（帧序不变）
    rows.append([fr.transpose(Image.FLIP_LEFT_RIGHT) for fr in run])
    # 3 waving：挥手
    wv = [0.0, 0.7, 1.0, 0.6]
    rows.append([place(draw_char(pet, dict(eyes="happy" if i else "open", mouth="open" if i in (1, 2) else "smile", armR=w, t=i / 4)), rot=(-3 if i == 2 else 0)) for i, w in enumerate(wv)])
    # 4 jumping：下蹲 → 起跳 → 最高点 → 下落 → 落地
    jp = [(0, 1.08, 0.9, "closed", 0), (-16, 0.95, 1.07, "happy", 0.8), (-28, 1.0, 1.02, "happy", 1.0), (-12, 0.97, 1.05, "open", 0.6), (0, 1.07, 0.92, "happy", 0)]
    rows.append([place(draw_char(pet, dict(eyes=e, mouth="open" if a else "smile", armL=a, armR=a, t=i / 5)), dy=dy, sx=sx, sy=sy) for i, (dy, sx, sy, e, a) in enumerate(jp)])
    # 5 failed：泄气、低头、掉眼泪
    fl = []
    for i in range(8):
        k = min(1.0, i / 4)
        fl.append(place(draw_char(pet, dict(eyes="sad" if i else "open", mouth="sad" if i > 1 else "o", tear=i >= 3, sweat=i in (1, 2), look=(0, 3 * k), t=i / 8)), sy=1 - 0.08 * k, sx=1 + 0.05 * k, rot=4 * k * (1 if i % 2 else 0.6)))
    rows.append(fl)
    # 6 waiting：等你回应——举手示意、左右张望、轻轻跳
    wt = []
    for i in range(6):
        lk = [(-5, -3), (-5, -3), (0, -4), (5, -3), (5, -3), (0, -4)][i]
        wt.append(place(draw_char(pet, dict(look=lk, mouth="o" if i in (2, 5) else "smile", armR=0.9 + 0.1 * math.sin(i), t=i / 6)), dy=-3 * abs(math.sin(i / 6 * 2 * math.pi)), rot=2 * math.sin(i / 6 * 2 * math.pi)))
    rows.append(wt)
    # 7 running（干活中）：专注、双手交替敲打
    wk = []
    for i in range(6):
        up = i % 2
        wk.append(place(draw_char(pet, dict(eyes="focus", look=(0, 3), mouth="flat", armL=0.35 if up else 0.15, armR=0.15 if up else 0.35, sweat=i in (3, 4), t=i / 6)), dy=-1.5 * up, dx=(1 if i % 3 == 0 else -1) * 0.8))
    rows.append(wk)
    # 8 review（思考 / 检查）：歪头、看向上方、托腮
    rv = []
    for i in range(6):
        tilt = math.sin(i / 6 * 2 * math.pi) * 5
        rv.append(place(draw_char(pet, dict(eyes="closed" if i == 3 else "look", look=(6, -5), mouth="o" if i in (1, 4) else "flat", armL=0.45, t=i / 6)), rot=tilt))
    rows.append(rv)
    return rows


def build(pid, pet, out_dir):
    rows = frames_for(pet)
    atlas = Image.new("RGBA", (CW * COLS, CH * ROWS), (0, 0, 0, 0))
    for r, fr in enumerate(rows):
        assert len(fr) == ROW_FRAMES[r], (pid, r, len(fr))
        for c, im in enumerate(fr):
            atlas.alpha_composite(im.resize((CW, CH), Image.LANCZOS), (c * CW, r * CH))
    d = os.path.join(out_dir, pid)
    os.makedirs(d, exist_ok=True)
    atlas.save(os.path.join(d, "spritesheet.png"), optimize=True)
    with open(os.path.join(d, "pet.json"), "w", encoding="utf-8") as fp:
        json.dump({"id": pid, "displayName": pet["name"], "description": pet["desc"], "spritesheetPath": "spritesheet.png"}, fp, ensure_ascii=False, indent=2)
        fp.write("\n")
    return atlas


def validate(atlas):
    """与 hatch-pet validate_atlas 同样的检查：尺寸、透明、已用格子有内容、未用格子全透明、格子边缘不贴边"""
    errs = []
    if atlas.size != (CW * COLS, CH * ROWS):
        errs.append(f"尺寸 {atlas.size}")
    a = atlas.getchannel("A")
    for r in range(ROWS):
        for c in range(COLS):
            cell = a.crop((c * CW, r * CH, (c + 1) * CW, (r + 1) * CH))
            used = c < ROW_FRAMES[r]
            bbox = cell.getbbox()
            if used and not bbox:
                errs.append(f"行{r}列{c} 是空的")
            if not used and bbox:
                errs.append(f"行{r}列{c} 应该全透明")
            if used and bbox and (bbox[0] == 0 or bbox[1] == 0 or bbox[2] == CW or bbox[3] == CH):
                errs.append(f"行{r}列{c} 贴到格子边缘 {bbox}")
            if used and bbox:
                opaque = cell.point(lambda v: 255 if v > 250 else 0).histogram()[255] / (CW * CH)
                if opaque > 0.85:
                    errs.append(f"行{r}列{c} 几乎不透明，可能残留背景")
    return errs


def preview(pid, pet, atlas, out):
    """给人看的预览：棋盘格底 + 每行标注"""
    scale = 1
    lab = 150
    img = Image.new("RGBA", (lab + CW * COLS, 60 + CH * ROWS), (250, 250, 252, 255))
    d = ImageDraw.Draw(img)
    for y in range(0, CH * ROWS, 16):
        for x in range(0, CW * COLS, 16):
            if (x // 16 + y // 16) % 2:
                d.rectangle([lab + x, 60 + y, lab + x + 15, 60 + y + 15], fill=(232, 232, 238, 255))
    img.alpha_composite(atlas, (lab, 60))
    try:
        font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 22)
        big = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 30)
    except Exception:
        font = big = ImageFont.load_default()
    d.text((12, 12), f"{pet['name']}（{pid}）— {pet['desc']}", fill=(30, 30, 40, 255), font=big)
    zh = ["空闲", "向右走", "向左走", "挥手", "跳（完成）", "失败", "等你确认", "干活中", "思考"]
    for r in range(ROWS):
        d.text((10, 60 + r * CH + CH // 2 - 26), f"{r} {ROW_NAMES[r]}", fill=(60, 60, 80, 255), font=font)
        d.text((10, 60 + r * CH + CH // 2 + 2), zh[r], fill=(120, 120, 140, 255), font=font)
        d.line([(lab, 60 + r * CH), (lab + CW * COLS, 60 + r * CH)], fill=(210, 210, 220, 255))
    img.convert("RGB").save(os.path.join(out, f"{pid}-sheet.png"))
    # 每行一个动图
    frames = []
    for r in range(ROWS):
        for c in range(ROW_FRAMES[r]):
            fr = Image.new("RGBA", (CW * 2, CH * 2 + 40), (255, 255, 255, 255))
            cell = atlas.crop((c * CW, r * CH, (c + 1) * CW, (r + 1) * CH)).resize((CW * 2, CH * 2), Image.LANCZOS)
            fr.alpha_composite(cell, (0, 40))
            ImageDraw.Draw(fr).text((10, 6), zh[r], fill=(60, 60, 80, 255), font=font)
            frames.append(fr.convert("RGB"))
    frames[0].save(os.path.join(out, f"{pid}-anim.gif"), save_all=True, append_images=frames[1:], duration=160, loop=0)


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out_dir = os.path.join(root, "apps", "web", "public", "pets")
    prev = sys.argv[sys.argv.index("--preview") + 1] if "--preview" in sys.argv else None
    ok = True
    for pid, pet in PETS.items():
        atlas = build(pid, pet, out_dir)
        errs = validate(atlas)
        print(pid, "OK" if not errs else errs)
        ok &= not errs
        if prev:
            os.makedirs(prev, exist_ok=True)
            preview(pid, pet, atlas, prev)
    if prev:
        imgs = [Image.open(os.path.join(prev, f"{pid}-sheet.png")) for pid in PETS]
        row0 = Image.new("RGB", (192 * 4 + 40, 260), (255, 255, 255))
        dd = ImageDraw.Draw(row0)
        for i, pid in enumerate(PETS):
            a = Image.open(os.path.join(out_dir, pid, "spritesheet.png")).crop((0, 0, CW, CH))
            row0.paste(a, (10 + i * 202, 10), a)
            try:
                f = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 22)
            except Exception:
                f = ImageFont.load_default()
            dd.text((10 + i * 202 + 70, 222), PETS[pid]["name"], fill=(40, 40, 50), font=f)
        row0.save(os.path.join(prev, "all-pets.png"))
    sys.exit(0 if ok else 1)
