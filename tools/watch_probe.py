#!/usr/bin/env python3
"""One-shot WeChat unread probe — the cheap first step of a watch round.

Why: phone_observe returns ~2k tokens of OCR JSON even when there is nothing
to do. Most rounds have nothing. This script does the whole local preamble
(unlock if needed -> WeChat to conversation list -> screenshot -> count red
unread badges with Pillow) and prints one tiny JSON line.

Cost when quiet: ~40 tokens. Cost when busy: same, then the model decides
whether to spend one phone_observe to read the content.

Usage:
  python watch_probe.py            # full probe
  python watch_probe.py --raw      # include blob detail (debug)
"""
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALLED_REPO = "__REPO__"
if os.path.isabs(INSTALLED_REPO):
    REPO = INSTALLED_REPO
else:
    REPO = os.environ.get("PHONE_AGENT_HOME") or os.path.abspath(os.path.join(HERE, ".."))
CONFIG = os.environ.get("KP_CONFIG") or os.path.join(REPO, "config", "device.json")

BASE_W = 1080  # badge geometry is tuned on this width, scaled for others


def cfg():
    with open(CONFIG, "r", encoding="utf-8") as f:
        return json.load(f)


def sh(c, args, timeout=30):
    cmd = [c["adb"], "-s", c["serial"], "shell"] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout


def alive(c):
    try:
        out = subprocess.run([c["adb"], "-s", c["serial"], "get-state"],
                             capture_output=True, text=True, timeout=10).stdout
        return "device" in out
    except Exception:
        return False


LAST_WHY = None


def reconnect(c):
    """Find the phone again: known addresses -> mDNS -> port scan, then rewrite both
    configs, via adb_connect.mjs. Wireless debugging rotates its port, so the
    remembered serial goes stale after a reconnect (2026-11-06)."""
    script = os.path.join(HERE, "adb_connect.mjs")
    if not os.path.exists(script):
        return None
    global LAST_WHY
    env = dict(os.environ, PHONE_AGENT_HOME=REPO)
    try:
        out = subprocess.run(["node", script, "--apply"], capture_output=True,
                             text=True, timeout=180, env=env).stdout
        data = json.loads(out.strip().splitlines()[-1])
        if data.get("ok"):
            return data.get("serial")
        LAST_WHY = data.get("why")
    except Exception:
        pass
    return None


def import_unlock():
    sys.path.insert(0, HERE)
    import phone_unlock
    return phone_unlock


def take_shot(c):
    path = os.path.join(tempfile.gettempdir(), "phone_probe.png")
    with open(path, "wb") as f:
        subprocess.run([c["adb"], "-s", c["serial"], "exec-out", "screencap", "-p"],
                       stdout=f, timeout=40)
    return path


def badges(path, scale_x, scale_y):
    """Find red unread badges in the avatar column of the WeChat list."""
    from PIL import Image
    import numpy as np

    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(int)
    h, w, _ = a.shape
    x0, x1 = int(20 * scale_x), int(190 * scale_x)
    # 会话行从约 140 起（2026-11-05 02:54 实测：第一行的角标在 y≈156，老的 360 会漏掉），
    # 底部导航条也扫进来，用来兜底（行角标没抓到但导航栏有数字，说明确实有未读）
    y0, y1 = int(140 * scale_y), int(h - int(20 * scale_y))
    strip = a[y0:y1, x0:x1]
    r, g, b = strip[:, :, 0], strip[:, :, 1], strip[:, :, 2]
    red = (r > 190) & (g < 105) & (b < 105)
    rows = red.sum(axis=1)
    spots = []
    y = 0
    while y < len(rows):
        if rows[y] > 12:
            start = y
            while y < len(rows) and rows[y] > 12:
                y += 1
            seg = red[start:y]
            cols = seg.sum(axis=0)
            xs = np.where(cols > 0)[0]
            width = int(xs[-1] - xs[0] + 1) if len(xs) else 0
            height = y - start
            if 18 <= height <= 70 and 18 <= width <= 70:
                sub = a[y0 + start:y0 + y, x0 + xs[0]:x0 + xs[-1] + 1]
                # 只看内圈：外圈是红圈和白色背景的过渡，会误判出白点
                inner = sub[4:-4, 4:-4] if sub.shape[0] > 10 and sub.shape[1] > 10 else sub
                white = ((inner[:, :, 0] > 215) & (inner[:, :, 1] > 215) &
                         (inner[:, :, 2] > 215)).sum()
                # 数字角标是红底白字；纯红小圆点（服务号/公众号提示）没有白字
                kind = "num" if (white >= 5 and width >= 26) else "dot"
                spots.append({
                    "y": int((y0 + (start + y) / 2) / scale_y),
                    "w": width,
                    "h": height,
                    "kind": kind,
                })
        else:
            y += 1
    return spots


def main():
    c = cfg()
    out = {"ok": True}
    if not alive(c):
        new = reconnect(c)
        if not new:
            why = LAST_WHY or "adb offline: known addrs+mDNS+port scan all failed"
            print(json.dumps({"ok": False, "why": why}))
            return
        c = cfg()
        out["via"] = new

    pu = import_unlock()
    u = pu.unlock(c)
    out["lock"] = "unlocked" if u.get("typed") else "open"

    # 微信是单 Activity：聊天页和会话列表都报 com.tencent.mm/.ui.LauncherUI，
    # 焦点分不出来。2026-11-06 实测：连按两次返回（聊天页→列表→退出微信），
    # 再用 LauncherUI 拉起，一定落在会话列表。必须这么做——上一轮若没退出聊天页，
    # 新消息会在开着的会话里被微信自动标成已读，列表角标根本不出现（16:34 那条就这么漏的）。
    for _ in range(2):
        sh(c, ["input", "keyevent", "4"])
        time.sleep(0.5)
    sh(c, ["am", "start", "-n", "com.tencent.mm/.ui.LauncherUI"])
    time.sleep(1.5)
    focus = sh(c, ["dumpsys", "window", "|", "grep", "mCurrentFocus"])
    if "com.tencent.mm" not in focus:
        sh(c, ["monkey", "-p", "com.tencent.mm", "-c",
               "android.intent.category.LAUNCHER", "1"])
        time.sleep(2.0)
    time.sleep(0.8)

    path = take_shot(c)
    from PIL import Image
    im = Image.open(path)
    scale_x = im.width / float(BASE_W)
    scale_y = im.height / 2376.0
    spots = badges(path, scale_x, scale_y)

    # 底部导航栏（微信 tab）的角标只是镜像，不算一行未读
    tab_line = int(im.height - 200 * scale_y)
    rows_num = [s for s in spots if s["kind"] == "num" and s["y"] < tab_line]
    tab_num = [s for s in spots if s["kind"] == "num" and s["y"] >= tab_line]
    dots = [s for s in spots if s["kind"] == "dot"]
    out["unread"] = len(rows_num)
    if rows_num:
        out["rows"] = [s["y"] for s in rows_num]
    elif tab_num:
        # 抓不到行角标但导航栏有数：按 1 条算，交给 observe 看
        out["unread"] = 1
        out["tab_only"] = True
    if dots:
        out["dots"] = len(dots)  # 服务号/公众号提示，不用处理
    if "--raw" in sys.argv:
        out["spots"] = spots
    out["shot"] = path
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    # 出错也要吐一行 JSON，别让值守链拿到空输出（2026-11-05 02:31 实测出现过 exit 1 + 空 stdout）
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "why": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
