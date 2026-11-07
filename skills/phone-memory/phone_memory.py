#!/usr/bin/env python3
"""phone-memory —— 每个对话框一份记忆，睡前像写日记一样整理。

存法：
  ~/.dsh/phone-memory/index.json          所有对话框的索引（谁、多久没聊、什么调性）
  ~/.dsh/phone-memory/chats/<名字>.json   单个对话框的档案（人、话题、没闭合的呼应、梗、事件流）
  ~/.dsh/phone-memory/diary/YYYY-MM.md    每晚的日记（人看的，也是我第二天开工的入口）

命令：
  python phone_memory.py list                     看有哪些对话框、多久没动
  python phone_memory.py show "某个群"          看一份档案
  python phone_memory.py touch "某个群" --kind group \
        --summary "讲了 B+ 树和 explain" --topic "数据库面试" \
        --hook "他说一题都看不懂" --open "给对方排七天清单" --person "对方:求职者"
  python phone_memory.py close "某个群" --what "给对方排七天清单" --how done
  python phone_memory.py digest                   睡前整理：事件收进话题、写日记、剪掉过长的流水
  python phone_memory.py pick                     挑一个对话框 + 话题，给出该说什么的骨架
  python phone_memory.py diary [--days 7]         看最近几天的日记

设计上的几条死规矩：
  · 档案是给我自己看的，不是发给人看的。别把 A 对话框的事漏给 B。
  · 只记「人情」和「事实」，不记情绪化的评价，不记别人的隐私细节（病、收入、住址这类）。
  · 事件流有上限，睡前 digest 负责压进话题；不压就会越滚越大，读一次烧一次钱。
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

TZ = timezone(timedelta(hours=8))
MAX_EVENTS = 40          # 单档事件上限，超了 digest 会压
KEEP_EVENTS = 12         # digest 后留多少条最近事件
MAX_NOTES = 8            # 每个话题留几条要点
MIN_GAP_HOURS = 6        # 主动搭话最短间隔（小时）
QUIET_HOURS = (3, 10)    # 不主动打扰的时段
WORK_HOURS = (9, 19)


def 根目录() -> Path:
    """允许 PHONE_AGENT_MEMORY 指到别处（测试用）。"""
    env = os.environ.get("PHONE_AGENT_MEMORY")
    if env:
        return Path(env).expanduser()
    家 = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))
    return 家 / "phone-memory"


def 现在() -> datetime:
    return datetime.now(TZ)


def 时刻戳(dt: datetime | None = None) -> str:
    return (dt or 现在()).isoformat(timespec="seconds")


def 读json(路径: Path, 默认):
    if not 路径.exists():
        return 默认
    try:
        return json.loads(路径.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return 默认


def 写json(路径: Path, 数据) -> None:
    路径.parent.mkdir(parents=True, exist_ok=True)
    fd, 临时 = tempfile.mkstemp(dir=str(路径.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(数据, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(临时, 路径)
    finally:
        if os.path.exists(临时):
            os.unlink(临时)


def 索引路径() -> Path:
    return 根目录() / "index.json"


def 档路径(名字: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_、" else "_" for c in 名字).strip("_") or "chat"
    return 根目录() / "chats" / (safe + ".json")


def 空档(名字: str, kind: str) -> dict:
    return {
        "chat": 名字,
        "kind": kind or "chat",
        "aliases": [],
        "people": {},
        "vibe": {"tone": "", "likes": [], "taboos": []},
        "topics": [],
        "open_loops": [],
        "callbacks": [],
        "events": [],
        "stats": {"touches": 0, "my_sends": 0, "last_touch": None, "last_mine": None},
        "diary_last": None,
    }


def 载档(名字: str, kind: str = "chat") -> dict:
    路径 = 档路径(名字)
    档 = 读json(路径, None)
    if 档 is None:
        档 = 空档(名字, kind)
    return 档


def 存档(档: dict) -> None:
    写json(档路径(档["chat"]), 档)
    索引 = 读json(索引路径(), {"chats": {}})
    索引.setdefault("chats", {})[档["chat"]] = {
        "kind": 档.get("kind", "chat"),
        "last_touch": 档["stats"].get("last_touch"),
        "topics": [t.get("name") for t in 档.get("topics", []) if t.get("status") == "ongoing"],
        "open_loops": len([x for x in 档.get("open_loops", []) if x.get("status") == "open"]),
        "file": str(档路径(档["chat"]).relative_to(根目录())),
    }
    写json(索引路径(), 索引)


def 找话题(档: dict, 名称: str) -> dict:
    for 话 in 档["topics"]:
        if 话.get("name") == 名称:
            return 话
    话 = {"name": 名称, "status": "ongoing", "notes": [], "first": 时刻戳(), "last": 时刻戳()}
    档["topics"].append(话)
    return 话


def 小时差(旧: str | None) -> float | None:
    if not 旧:
        return None
    try:
        点 = datetime.fromisoformat(旧)
    except ValueError:
        return None
    if 点.tzinfo is None:
        点 = 点.replace(tzinfo=TZ)
    return (现在() - 点).total_seconds() / 3600.0


# ---------------- 命令 ----------------


def 命令touch(参数) -> int:
    档 = 载档(参数.chat, 参数.kind)
    摘要 = 参数.summary or getattr(参数, "话", "") or ""
    事件 = {"at": 时刻戳(), "kind": 参数.event, "summary": 摘要, "mine": bool(参数.mine)}
    档["events"].append(事件)
    档["stats"]["touches"] += 1
    档["stats"]["last_touch"] = 事件["at"]
    if 参数.mine:
        档["stats"]["my_sends"] += 1
        档["stats"]["last_mine"] = 事件["at"]

    if 参数.topic:
        话 = 找话题(档, 参数.topic)
        话["last"] = 事件["at"]
        话["status"] = "ongoing"
        if 摘要 and 摘要 not in 话["notes"]:
            话["notes"].append(摘要)
            话["notes"] = 话["notes"][-MAX_NOTES:]

    if 参数.hook:
        档["callbacks"].append({"hook": 参数.hook, "at": 事件["at"], "used": 0})
        档["callbacks"] = 档["callbacks"][-30:]

    if 参数.open:
        for 项 in 参数.open:
            if not any(x.get("what") == 项 and x.get("status") == "open" for x in 档["open_loops"]):
                档["open_loops"].append({"what": 项, "since": 事件["at"], "status": "open"})

    for 人 in 参数.person or []:
        if ":" in 人:
            名, 注 = 人.split(":", 1)
        else:
            名, 注 = 人, ""
        档["people"].setdefault(名, {"role": 注, "notes": []})
        if 注:
            档["people"][名]["role"] = 注
            if 注 not in 档["people"][名]["notes"]:
                档["people"][名]["notes"].append(注)

    if len(档["events"]) > MAX_EVENTS * 2:
        档["events"] = 档["events"][-MAX_EVENTS:]

    存档(档)
    # 一行就够：模型只想知道「记上了没」
    悬 = len([x for x in 档["open_loops"] if x.get("status") == "open"])
    print(f"ok {档['chat']} 事件{len(档['events'])} 悬着{悬}")
    return 0


def 命令close(参数) -> int:
    档 = 载档(参数.chat)
    命中 = False
    for 项 in 档["open_loops"]:
        if 项.get("what") == 参数.what and 项.get("status") == "open":
            项["status"] = 参数.how or "done"
            项["closed"] = 时刻戳()
            命中 = True
    if not 命中:
        档["open_loops"].append({"what": 参数.what, "since": 时刻戳(), "status": 参数.how or "done", "closed": 时刻戳()})
    存档(档)
    print(json.dumps({"ok": True, "closed": 参数.what, "how": 参数.how}, ensure_ascii=False))
    return 0


def 命令list(_参数) -> int:
    索引 = 读json(索引路径(), {"chats": {}}).get("chats", {})
    if not 索引:
        print("还没有任何对话框档案。")
        return 0
    行 = []
    for 名, 信 in sorted(索引.items(), key=lambda kv: kv[1].get("last_touch") or "", reverse=True):
        差 = 小时差(信.get("last_touch"))
        多久 = "刚聊过" if 差 is None else (f"{差:.1f} 小时前" if 差 < 48 else f"{差/24:.1f} 天前")
        行.append(f"{名}（{信.get('kind','chat')}）· {多久} · 话题 {len(信.get('topics') or [])} · 悬着 {信.get('open_loops',0)}")
    print("\n".join(行))
    return 0


def 命令show(参数) -> int:
    档 = 载档(参数.chat)
    print(json.dumps(档, ensure_ascii=False, indent=2))
    return 0


def 命令digest(参数) -> int:
    """睡前整理：把旧事件压进话题要点，清掉已闭合太久的呼应，写日记。"""
    索引 = 读json(索引路径(), {"chats": {}}).get("chats", {})
    今天 = 现在().date().isoformat()
    日记行 = [f"# {今天} 睡前整理", ""]
    动过 = 0

    for 名 in 索引:
        档 = 载档(名)
        旧 = 档["events"][:-KEEP_EVENTS] if len(档["events"]) > KEEP_EVENTS else []
        留 = 档["events"][-KEEP_EVENTS:] if len(档["events"]) > KEEP_EVENTS else 档["events"]
        if 旧:
            话 = 找话题(档, 参数.topic or "闲聊")
            收 = [e["summary"] for e in 旧 if e.get("summary")]
            for 句 in 收[-3:]:
                if 句 not in 话["notes"]:
                    话["notes"].append(句)
            话["notes"] = 话["notes"][-MAX_NOTES:]
            话["last"] = 旧[-1]["at"]
        档["events"] = 留

        # 问过没下文、两天以上没动的呼应，标注 stale（不删，等着被 callback 捡回来）
        for 项 in 档["open_loops"]:
            if 项.get("status") == "open" and (小时差(项.get("since")) or 0) > 48:
                项["stale"] = True

        if 留 or 档["open_loops"]:
            最近 = [e["summary"] for e in 留[-3:] if e.get("summary")]
            悬 = [x["what"] for x in 档["open_loops"] if x.get("status") == "open"][:2]
            片段 = f"**{名}**"
            if 最近:
                片段 += "：" + "；".join(最近)
            if 悬:
                片段 += "　（还欠着：" + "、".join(悬) + "）"
            日记行.append("- " + 片段)
            动过 += 1

        档["diary_last"] = 今天
        存档(档)

    if 动过 == 0:
        日记行.append("- 今天没跟谁说话，安静的一天。")

    日记路径 = 根目录() / "diary" / (今天[:7] + ".md")
    日记路径.parent.mkdir(parents=True, exist_ok=True)
    已有 = 日记路径.read_text(encoding="utf-8") if 日记路径.exists() else ""
    if f"# {今天} 睡前整理" in 已有:
        print(json.dumps({"ok": True, "skipped": "今天已经整理过", "chats": 动过}, ensure_ascii=False))
        return 0
    日记路径.write_text((已有.rstrip() + "\n\n" if 已有 else "") + "\n".join(日记行) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "chats": 动过, "diary": str(日记路径)}, ensure_ascii=False))
    return 0


def 命令pick(参数) -> int:
    """挑一个对话框和一个由头，给出该说什么的骨架。具体话自己写。"""
    随机 = random.Random(参数.seed if 参数.seed is not None else None)
    时 = 现在().hour
    索引 = 读json(索引路径(), {"chats": {}}).get("chats", {})
    if not 索引:
        print("没有档案，先 touch 几条")
        return 0

    候选 = []
    for 名, 信 in 索引.items():
        差 = 小时差(信.get("last_touch"))
        if 差 is not None and 差 < MIN_GAP_HOURS and not 参数.force:
            continue
        档 = 载档(名)
        分数 = 0.0
        if 差 is None:
            分数 += 2.0
        elif 差 > 72:
            分数 += 3.0
        elif 差 > 24:
            分数 += 2.0
        elif 差 > 12:
            分数 += 1.0
        悬 = [x for x in 档["open_loops"] if x.get("status") == "open"]
        分数 += 2.5 * len(悬)
        进 = [t for t in 档["topics"] if t.get("status") == "ongoing"]
        分数 += 0.6 * len(进)
        if 信.get("kind") == "group" and (时 < 8 or 时 > 23):
            分数 -= 2.0           # 深夜别在群里咋呼
        if 档["stats"].get("my_sends", 0) > 3 * (档["stats"].get("touches", 1) or 1):
            分数 -= 1.5           # 我说得比对方多，收敛点
        分数 += 随机.random() * 1.2
        候选.append((分数, 名, 档, 悬, 进))

    if not 候选:
        print("都在冷却里，等会儿再挑")
        return 0

    候选.sort(key=lambda x: -x[0])
    分数, 名, 档, 悬, 进 = 候选[0]

    由头 = []
    if 悬:
        由头.append({"type": "follow_up", "what": 悬[0]["what"],
                     "how": "上次这事还没落地，问一句进展，别催促"})
    未用梗 = [c for c in 档.get("callbacks", []) if not c.get("used")]
    if 未用梗:
        由头.append({"type": "callback", "what": 未用梗[-1]["hook"],
                     "how": "用一句只有我们俩听得懂的话把气氛接回来"})
    if 进:
        由头.append({"type": "topic", "what": 随机.choice(进)["name"],
                     "how": "顺着老话题往下聊一句，最好带上今天看到的具体东西"})
    由头.append({"type": "share", "what": "今天刷到的、跟对方喜好对得上的一条",
                 "how": "先说为什么想到他，再说内容，别贴完就跑"})

    时段 = "早上" if 时 < 11 else "下午" if 时 < 18 else "晚上"
    类 = "群" if 档.get("kind") == "group" else "私聊"
    # 三行文本，比一整块 JSON 省一半 token
    print(f"挑：{名}（{类}，{时段}）")
    for 由 in 由头[:2]:
        print(f"{由['type']}：{由['what']} —— {由['how']}")
    if 悬:
        print("还欠：" + "；".join(x["what"] for x in 悬))
    return 0


def 命令diary(参数) -> int:
    目录 = 根目录() / "diary"
    if not 目录.exists():
        print("还没有日记。")
        return 0
    文件 = sorted(目录.glob("*.md"))[-1:]
    for 文 in 文件:
        题目 = 文.read_text(encoding="utf-8").splitlines()
        块 = []
        for 行 in 题目:
            if 行.startswith("# "):
                块.append([行])
            elif 块:
                块[-1].append(行)
        for 段 in 块[-参数.days:]:
            print("\n".join(段).rstrip() + "\n")
    return 0


def main(argv=None) -> int:
    解 = argparse.ArgumentParser(prog="phone_memory", description="每个对话框一份记忆")
    子 = 解.add_subparsers(dest="命令", required=True)

    p = 子.add_parser("list", help="有哪些对话框")
    p.set_defaults(函数=命令list)

    p = 子.add_parser("show", help="看一份档案")
    p.add_argument("chat")
    p.set_defaults(函数=命令show)

    p = 子.add_parser("touch", help="记一笔：聊了什么")
    p.add_argument("chat")
    # 摘要也支持位置参数，省得每条都敲 --summary
    p.add_argument("话", nargs="?", default="")
    p.add_argument("--kind", default="chat")
    p.add_argument("--event", default="talk")
    p.add_argument("--summary", default="")
    p.add_argument("--topic", default="")
    p.add_argument("--hook", default="")
    p.add_argument("--open", action="append", default=[])
    p.add_argument("--person", action="append", default=[])
    p.add_argument("--mine", action="store_true")
    p.set_defaults(函数=命令touch)

    p = 子.add_parser("close", help="了结一件悬着的事")
    p.add_argument("chat")
    p.add_argument("--what", required=True)
    p.add_argument("--how", default="done")
    p.set_defaults(函数=命令close)

    p = 子.add_parser("digest", help="睡前整理")
    p.add_argument("--topic", default="")
    p.set_defaults(函数=命令digest)

    p = 子.add_parser("pick", help="挑一个对话框去搭话")
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--force", action="store_true")
    p.set_defaults(函数=命令pick)

    p = 子.add_parser("diary", help="看日记")
    p.add_argument("--days", type=int, default=7)
    p.set_defaults(函数=命令diary)

    参 = 解.parse_args(argv)
    return 参.函数(参)


if __name__ == "__main__":
    sys.exit(main())
