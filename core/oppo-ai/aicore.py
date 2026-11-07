import subprocess, re, sys, time, os, json, tempfile, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_config():
    """Device settings: OPPO_CONFIG env > config/device.json > defaults.

    Keeping these out of the source means the repo can be public.
    """
    p = os.environ.get("OPPO_CONFIG") or os.path.join(HERE, "..", "..", "config", "device.json")
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


_CFG = _load_config()
ADB = os.environ.get("OPPO_ADB") or _CFG.get("adb") or "adb"
SER = os.environ.get("OPPO_SERIAL") or _CFG.get("serial") or ""
PKG = _CFG.get("pkg") or "com.heytap.speechassist"
XML = os.environ.get("OPPO_XML") or _CFG.get("xml") or os.path.join(tempfile.gettempdir(), "oppo-cur.xml")

def sh(cmd, timeout=60):
    env = dict(os.environ)
    env['MSYS_NO_PATHCONV'] = '1'
    p = subprocess.run(cmd, shell=True, capture_output=True, timeout=timeout, env=env)
    return p.stdout.decode('utf-8', 'ignore')

def adb(args, timeout=60):
    if SER:
        return sh(f'"{ADB}" -s {SER} {args}', timeout)
    return sh(f'"{ADB}" {args}', timeout)

def dump():
    adb('shell "uiautomator dump /sdcard/w.xml >/dev/null 2>&1; cat /sdcard/w.xml" > ' + XML)
    d = open(XML, encoding='utf-8', errors='ignore').read()
    i = d.find('<?xml')
    return ET.fromstring(d[i:])

def nodes(root):
    for n in root.iter('node'):
        rid = (n.get('resource-id') or '').split('/')[-1]
        yield rid, n

def bounds(n):
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', n.get('bounds') or '')
    if not m: return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1, y1, x2, y2)

def center(n):
    b = bounds(n)
    if not b: return None
    return ((b[0] + b[2]) // 2, (b[1] + b[3]) // 2)

def find(root, rid):
    for r, n in nodes(root):
        if r == rid: return n
    return None

def find_text(root, txt):
    for r, n in nodes(root):
        if (n.get('text') or '').strip() == txt: return n
    return None

def tap(x, y):
    adb(f'shell input tap {x} {y}')

def tap_rid(root, rid, wait=2.0):
    n = find(root, rid)
    if n is None: raise SystemExit(f'not found: {rid}')
    c = center(n)
    tap(*c); time.sleep(wait); return c

def tap_text(root, txt, wait=2.0):
    n = find_text(root, txt)
    if n is None: raise SystemExit(f'text not found: {txt}')
    tap(*center(n)); time.sleep(wait)

def wait_for(rid, timeout=90, interval=2.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        root = dump()
        if find(root, rid) is not None:
            return root
        time.sleep(interval)
    raise SystemExit(f'timeout waiting {rid}')

def text_of(root, rid):
    n = find(root, rid)
    return (n.get('text') or '') if n is not None else ''

ADB_IME = os.environ.get("OPPO_IME") or _CFG.get("adbIme") or "com.android.adbkeyboard/.AdbIME"


def _imes():
    # ime 是 shell 子命令，必须走 adb shell（写成 adb ime 会报 unknown command）
    return [x.strip() for x in adb('shell ime list -s').splitlines() if x.strip()]


def type_text(text, restore_ime=None):
    """Write any text (Chinese included) into the focused field via ADBKeyboard.

    adb shell input text dies with a NullPointerException on non-ASCII, and adb has
    no clipboard command, so we switch the IME for a moment, broadcast the text as
    base64, then switch back to the owner's own keyboard.
    """
    import base64
    imes = _imes()
    if ADB_IME not in imes:
        raise SystemExit(f'ADBKeyboard not enabled on device; run: adb shell ime enable {ADB_IME}')
    keep = restore_ime or os.environ.get("OPPO_IME_RESTORE") or _CFG.get("ime")
    if not keep:
        others = [i for i in imes if i != ADB_IME]
        keep = others[0] if others else None
    adb(f'shell ime set {ADB_IME}')
    time.sleep(0.8)
    b64 = base64.b64encode(text.encode('utf-8')).decode()
    adb(f'shell am broadcast -a ADB_INPUT_B64 --es msg {b64}')
    time.sleep(0.8)
    if keep:
        adb(f'shell ime set {keep}')
        time.sleep(0.6)
    return keep


def clear_text():
    adb('shell am broadcast -a ADB_CLEAR_TEXT')
    time.sleep(0.6)


def foreground():
    adb(f'shell am start -n {PKG}/.launcher.SpeechAssistMainActivity')
    time.sleep(3)

def keyguard_showing():
    out = adb('shell "dumpsys window | grep isKeyguardShowing"')
    return 'true' in (out or '').lower()


def screen_on():
    out = adb('shell "dumpsys deviceidle | grep mScreenOn"')
    return 'true' in (out or '').lower()


def _pin():
    path = _CFG.get('unlockPinFile')
    if not path or not os.path.exists(path):
        return None
    line = open(path, encoding='utf-8').read().splitlines()[0]
    digits = ''.join(ch if ch.isdigit() else ' ' for ch in line).split()
    six = [d for d in digits if len(d) == 6]
    return six[-1] if six else None


def ensure_unlocked():
    """Unlock only when the keyguard is really showing.

    Hard rule from a past incident: typing the PIN while the phone is already
    unlocked lands the digits in whatever field has focus (once it went into a
    chat box). So probe keyguard twice and never type otherwise.
    """
    if not keyguard_showing():
        return {'locked': False, 'typed': False}
    pin = _pin()
    adb('shell svc power stayon true')
    if not screen_on():
        adb('shell input keyevent 224')
        time.sleep(1)
    adb('shell cmd statusbar collapse')
    adb('shell input swipe 540 1900 540 500 400')
    time.sleep(1)
    if not keyguard_showing():
        adb('shell svc power stayon false')
        return {'locked': False, 'typed': False}
    if not pin:
        adb('shell svc power stayon false')
        raise SystemExit('device locked and no unlockPinFile configured')
    adb('shell input text ' + pin)
    time.sleep(1.5)
    adb('shell svc power stayon false')
    return {'locked': True, 'typed': True, 'still_locked': keyguard_showing()}


def ids_dump():
    root = dump()
    out = []
    for r, n in nodes(root):
        if r: out.append((r, (n.get('text') or '')[:20], bounds(n)))
    seen = set(); res = []
    for r in out:
        if r[0] in seen: continue
        seen.add(r[0]); res.append(r)
    return res
