#!/usr/bin/env python3
"""Phone unlock guard.

失败过一次（2026-11-04）：手机其实没锁，脚本照样 input text PIN，
PIN 被打进微信输入框，被 Ctrl+A 没清干净，最后拼进群消息发了出去。

所以这里只有一条铁律：**确认 keyguard 真的在显示，才输入 PIN**。
没锁就直接返回，一个字都不输入。

用法：
  python phone_unlock.py            # 需要才解锁
  python phone_unlock.py --status   # 只看状态
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALLED_REPO = "__REPO__"
if os.path.isabs(INSTALLED_REPO):
    REPO = INSTALLED_REPO
else:
    REPO = os.environ.get("PHONE_AGENT_HOME") or os.path.abspath(os.path.join(HERE, ".."))
CONFIG = os.environ.get("KP_CONFIG") or os.path.join(REPO, "config", "device.json")


def cfg():
    with open(CONFIG, "r", encoding="utf-8") as f:
        return json.load(f)


def adb(c, args, timeout=20):
    cmd = [c["adb"], "-s", c["serial"], "shell"] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout


def keyguard_showing(c):
    out = adb(c, ["dumpsys", "window", "|", "grep", "isKeyguardShowing"])
    return "true" in out.lower()


def screen_on(c):
    out = adb(c, ["dumpsys", "deviceidle", "|", "grep", "mScreenOn"])
    return "true" in out.lower()


def pin(c):
    path = c["unlockPinFile"]
    line = open(path, "r", encoding="utf-8").read().splitlines()[0]
    digits = "".join(ch if ch.isdigit() else " " for ch in line).split()
    six = [d for d in digits if len(d) == 6]
    if not six:
        raise SystemExit("no 6-digit pin found")
    return six[-1]


def unlock(c):
    if not keyguard_showing(c):
        adb(c, ["svc", "power", "stayon", "false"])
        return {"locked": False, "typed": False, "why": "keyguard not showing, skipped PIN"}
    adb(c, ["svc", "power", "stayon", "true"])
    if not screen_on(c):
        adb(c, ["input", "keyevent", "224"])
        time.sleep(1)
    adb(c, ["cmd", "statusbar", "collapse"])
    adb(c, ["input", "swipe", "540", "1900", "540", "500", "400"])
    time.sleep(1)
    # 关键复查：划完、动画结束后仍然锁着，才允许输入
    if not keyguard_showing(c):
        adb(c, ["svc", "power", "stayon", "false"])
        return {"locked": False, "typed": False, "why": "unlocked by swipe, skipped PIN"}
    adb(c, ["input", "text", pin(c)])
    time.sleep(1.5)
    adb(c, ["svc", "power", "stayon", "false"])
    return {"locked": True, "typed": True, "still_locked": keyguard_showing(c)}


def main():
    c = cfg()
    if "--status" in sys.argv:
        print(json.dumps({"keyguard": keyguard_showing(c), "screenOn": screen_on(c)}))
        return
    print(json.dumps(unlock(c), ensure_ascii=False))


if __name__ == "__main__":
    main()
