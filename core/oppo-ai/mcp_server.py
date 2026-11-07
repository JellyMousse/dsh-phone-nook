#!/usr/bin/env python3
"""Minimal MCP (stdio, JSON-RPC 2.0) server exposing OPPO's built-in 「小布助手」
as tools.

Tools:
  oppo_draw      -> text-to-image on the phone, saved as a clean square PNG on this PC
  oppo_describe  -> vision: push an image to 小布, return its Chinese description

Naming is deliberately vendor-scoped: this file drives the OPPO assistant, so the
tools are oppo_*. A vivo/iOS implementation would ship its own vivo_draw /
siri_describe next to it — different vendor, different file, same MCP shape.

No API key is involved: everything goes through adb + uiautomator (see ai.py).

Protocol traffic goes to the real stdout; everything else (adb noise, our own
prints, tracebacks) is redirected to stderr so it cannot corrupt the stream.
"""
import sys, os, json, time, traceback

REAL_OUT = sys.stdout
sys.stdout = sys.stderr          # any stray print() must not break JSON-RPC
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import ai  # noqa: E402  (imports aicore + PIL)

SERVER_INFO = {"name": "opai", "version": "0.1.0"}
PROTOCOL = "2024-11-05"

TOOLS = [
    {
        "name": "oppo_draw",
        "description": (
            "Use OPPO's built-in 「小布助手」 on the phone to generate an image "
            "from a Chinese prompt, then export it, pull it to this PC and crop the chat card away, "
            "leaving a clean square PNG. Works with both the old assistant UI (a dedicated "
            "text-to-image panel, honours ratio/style) and the new one (plain chat: the prompt is sent "
            "as a normal drawing request; ratio/style are then ignored and the model picks the layout). "
            "Slow: about 90-150 seconds. The phone must be unlocked and reachable over adb."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Chinese prompt describing the image (subject, style, colours)."},
                "ratio": {"type": "string", "enum": ["1:1", "3:4", "4:3", "9:16", "16:9"], "description": "Aspect ratio, default 1:1. Only honoured by the old assistant UI; ignored on the new chat-only UI."},
                "style": {"type": "string", "enum": ["水墨风", "油画风", "羊毛毡", "像素风"], "description": "Optional style preset shown in the text-to-image panel."},
                "out_path": {"type": "string", "description": "Absolute path of the PNG to write on this PC. Defaults to <opai dir>/out.png."},
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "oppo_describe",
        "description": (
            "Vision: push a local image to the phone, ask OPPO's 「小布助手」 to describe it, and return "
            "the Chinese answer. Use this when the current model cannot see images. Slow: 60-150 seconds."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "image_path": {"type": "string", "description": "Absolute path of the image on this PC (png/jpg)."},
            },
            "required": ["image_path"],
        },
    },
]


def send(obj):
    REAL_OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    REAL_OUT.flush()


def ok(mid, text):
    return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}], "isError": False}}


def err(mid, text):
    return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}], "isError": True}}


def call_tool(name, args):
    if name == "oppo_draw":
        prompt = (args.get("prompt") or "").strip()
        if not prompt:
            return False, "prompt is required"
        out = args.get("out_path") or os.path.join(HERE, "out.png")
        path, size = ai.draw(prompt, args.get("ratio") or "1:1", args.get("style"), out)
        return True, "saved %s (%dx%d)" % (path, size[0], size[1])
    if name == "oppo_describe":
        img = (args.get("image_path") or "").strip()
        if not img or not os.path.exists(img):
            return False, "image_path not found: %r" % img
        return True, ai.describe(img)
    return False, "unknown tool: %s" % name


def handle(msg):
    method = msg.get("method")
    mid = msg.get("id")
    if method is None:                       # a response to us; ignore
        return None
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": mid,
                "result": {"protocolVersion": PROTOCOL,
                           "capabilities": {"tools": {}},
                           "serverInfo": SERVER_INFO}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        print("# tools/call %s %s" % (name, json.dumps(args, ensure_ascii=False)), file=sys.stderr)
        t0 = time.time()
        try:
            good, text = call_tool(name, args)
        except SystemExit as e:
            good, text = False, "error: %s" % e
        except Exception:
            good, text = False, "error: " + traceback.format_exc(limit=3)
        print("# done in %.1fs ok=%s" % (time.time() - t0, good), file=sys.stderr)
        return ok(mid, text) if good else err(mid, text)
    if method.startswith("notifications/"):
        return None
    return {"jsonrpc": "2.0", "id": mid,
            "error": {"code": -32601, "message": "method not found: %s" % method}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            print("# bad json: %r" % line[:200], file=sys.stderr)
            continue
        try:
            resp = handle(msg)
        except Exception:
            print("# handler crash\n" + traceback.format_exc(), file=sys.stderr)
            resp = {"jsonrpc": "2.0", "id": msg.get("id"),
                    "error": {"code": -32603, "message": "internal error"}}
        if resp is not None:
            send(resp)


if __name__ == "__main__":
    main()
