#!/usr/bin/env python3
"""把一轮值守的结果写到 ~/.dsh/phone-watch-round.json，由插件 tick 时收走。

为什么不用 curl POST /dsh-phone-watch/round：宿主的 connection 服务要求浏览器会话凭证，
命令行拿不到 token，一律 401。写文件是同一条路的本地实现，插件那边已经改成收件箱。

等回音有上限：连着报第 5 次 awaiting 还没等到回音，就自动回落到常态间隔，
免得一个人没回话就一直 5 分钟一跑，白烧。
"""
import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

原因们 = ["idle", "reply", "no-reply", "busy"]
# 连等多少轮还没回音就回常态（含报的这一次）
默认等待上限 = 4


def 目录() -> Path:
    return Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))


def 等回音记(目录: Path) -> Path:
    return 目录 / "phone-watch-awaiting.json"


def 读连带(路径: Path) -> int:
    try:
        体 = json.loads(路径.read_text(encoding="utf-8"))
        return max(0, int(体.get("streak", 0)))
    except (OSError, ValueError, TypeError):
        return 0


def 写连带(路径: Path, 次: int) -> None:
    try:
        路径.parent.mkdir(parents=True, exist_ok=True)
        临时 = 路径.with_suffix(".tmp")
        临时.write_text(json.dumps({"streak": 次, "at": datetime.now().astimezone().isoformat(timespec="seconds")}), encoding="utf-8")
        os.replace(临时, 路径)
    except OSError:
        pass


def main(argv=None) -> int:
    解 = argparse.ArgumentParser(prog="report_round", description="报一轮值守结果")
    解.add_argument("reason", nargs="?", default="idle", choices=原因们)
    解.add_argument("--awaiting", action="store_true", help="刚发过消息、还没等到回音")
    解.add_argument("--wait-max", type=int, default=默认等待上限, help="连等几轮还没回音就回常态")
    解.add_argument("--note", default="")
    参 = 解.parse_args(argv)

    根 = 目录()
    连带文 = 等回音记(根)
    备注 = (参.note or "")[:200]
    等 = bool(参.awaiting)
    if 等:
        次 = 读连带(连带文) + 1
        上限 = max(1, 参.wait_max)
        if 次 > 上限:
            等 = False
            次 = 0
            备注 = (备注 + " / 连等 " + str(上限) + " 轮没回音，回常态").strip(" /")
    else:
        次 = 0
    写连带(连带文, 次)

    目标 = 根 / "phone-watch-round.json"
    体 = {
        "reason": 参.reason,
        "awaiting": 等,
        "note": 备注,
        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    临时 = 目标.with_suffix(".tmp")
    try:
        目标.parent.mkdir(parents=True, exist_ok=True)
        临时.write_text(json.dumps(体, ensure_ascii=False), encoding="utf-8")
        os.replace(临时, 目标)
    except OSError as 错:
        print("写不进去：" + str(错), file=sys.stderr)
        return 1
    print("ok " + 体["reason"] + (" awaiting#" + str(次) if 等 else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
