#!/usr/bin/env python3
"""Phone assistant driver — vision read + image generation, adb only.

Drives whatever multimodal assistant the device ships with through its UI
(OPPO/ColorOS ships 「小布助手」; other skins have equivalents with a similar
layout: an input box, an image attachment sheet, a viewer with a save button).
Everything happens on screen via adb + uiautomator, no vendor API key.

usage:
  python ai.py ids                 # dump resource ids of current screen
  python ai.py describe <img>      # push img, ask the assistant to describe it, print answer
  python ai.py gen "<prompt>" [1:1|3:4|4:3|9:16|16:9] [ink|oil|felt|pixel]
"""
import sys, os, time, subprocess, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aicore import *
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SHOT = os.environ.get("OPPO_SHOT") or os.path.join(HERE, "shot.png")

def screencap(path=SHOT):
    adb(f'exec-out screencap -p > {path}', timeout=60)
    return Image.open(path).convert('RGB')

CELLS = [(48, 1295, 342, 1589), (366, 1295, 660, 1589), (684, 1295, 978, 1589)]

def push_image(img):
    name = 'phoneai_%d%s' % (int(time.time() * 1000), os.path.splitext(img)[1] or '.png')
    remote = '/sdcard/Pictures/' + name
    adb(f'push "{img}" {remote}')
    # adb push 会保留源文件 mtime，媒体库按时间排序会被打乱 -> 强制把远端时间改成现在
    adb(f'shell "touch {remote}"')
    # MEDIA_SCANNER_SCAN_FILE 在 Android 10+ 经常被忽略，必须轮询媒体库确认真的入库，
    # 否则相册里根本没有这张图，选图会静默选中旧图。
    name = os.path.basename(remote)
    for _ in range(6):
        adb(f'shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://{remote} >/dev/null')
        out = adb('shell "content query --uri content://media/external/images/media '
                  '--projection _data 2>/dev/null | grep -c ' + name + '"')
        if out.strip().isdigit() and int(out.strip()) > 0:
            # adb push 产生的行会被 MediaProvider 标记 is_pending=1，pending 的图在相册里完全不可见。
            # 必须逐条（不能批量，集合 update 会被拒）把它置 0，相册才认这张图。
            row = adb('shell "content query --uri content://media/external/images/media '
                      '--projection _id:_data 2>/dev/null | grep ' + name + ' | tail -1"')
            m = re.search(r'_id=(\d+)', row)
            if m:
                adb(f'shell "content update --uri content://media/external/images/media/{m.group(1)} '
                    f'--bind is_pending:i:0"')
            print('# indexed', name, 'id', m.group(1) if m else '?', file=sys.stderr)
            return remote
        time.sleep(2)
    raise SystemExit(f'media index failed: {name}')

def pick_new_cell(before, after):
    best, bestd = 1, -1
    for i, box in enumerate(CELLS):
        if i == 0: continue   # 第 0 格是「拍摄照片」相机
        a = before.crop(box); b = after.crop(box)
        if a.size != b.size: continue
        pa, pb = a.load(), b.load()
        diff = 0; n = 0
        for y in range(0, a.size[1], 8):
            for x in range(0, a.size[0], 8):
                diff += abs(pa[x, y][0] - pb[x, y][0]) + abs(pa[x, y][1] - pb[x, y][1]) + abs(pa[x, y][2] - pb[x, y][2])
                n += 1
        d = diff / max(n, 1)
        if d > bestd: best, bestd = i, d
    return best, bestd

def close_ime(root=None):
    """关闭输入法（它会把 btn_tools 顶出屏幕）"""
    if root is None: root = dump()
    if find(root, 'btn_tools') is None:
        adb('shell input keyevent 4')
        time.sleep(1.5)
        root = dump()
    return root

def home():
    foreground()
    root = dump()
    for _ in range(3):
        if find(root, 'iv_memory_container') is not None: break
        adb('shell input keyevent 4'); time.sleep(1.2)
        foreground(); root = dump()
    if find(root, 'design_bottom_sheet') is not None:
        tap(540, 600); time.sleep(1.5)
        root = dump()
    tap_rid(root, 'iv_memory_container', 3)
    return close_ime(dump())

GALLERY_RE = re.compile(r'第 (\d+) 項,圖片,,\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}')

def gallery_cells(root):
    """相册选择器里的图片格子：按内部序号（越大越新）返回 [(idx, center)]
    注意 uiautomator 原始 XML 里是 content-desc，不是 description。"""
    out = []
    for _, n in nodes(root):
        desc = n.get('content-desc') or n.get('description') or ''
        m = GALLERY_RE.search(desc)
        c = center(n)
        if m and c:
            out.append((int(m.group(1)), c))
    out.sort()
    return out

def scroll_to_gallery_bottom():
    """相册列表是旧->新，最新在最底部。一直往下滑到最大序号不再变大为止。"""
    last = -1
    for _ in range(12):
        root = dump()
        cells = gallery_cells(root)
        if not cells: time.sleep(1.0); continue
        top = cells[-1][0]
        if top == last:
            return cells
        last = top
        adb('shell input swipe 540 1750 540 950 350')
        time.sleep(1.2)
    return gallery_cells(dump())

def pick_latest_from_gallery():
    """点「查看全部」进系统相册，选序号最大（=最新）的图，再点「新增」确认。
    不用截图差分了 —— 手机助手那个『添加图片』面板只显示自己的缓存，永远不含刚推的图。
    按内部序号选而不是盲点第一格：相册里混着主人的私人图片，顺序不可信。"""
    root = dump()
    n = find(root, 'aihome_add_panel_tv_check_all')
    if n is None:
        for _, nd in nodes(root):
            if (nd.get('text') or '') == '查看全部': n = nd; break
    if n is None: raise SystemExit('查看全部 not found')
    tap(*center(n)); time.sleep(2.5)

    cells = []
    for _ in range(6):                    # 等相册页真正起来
        time.sleep(1.5)
        root = dump()
        cells = gallery_cells(root)
        if cells: break
    if not cells: raise SystemExit('no gallery cell found')
    cells = scroll_to_gallery_bottom()
    if not cells: raise SystemExit('no gallery cell after scroll')
    idx, pt = cells[-1]
    print('# gallery cell seq', idx, 'at', pt, file=sys.stderr)
    tap(*pt); time.sleep(1.5)
    root = dump()
    n = find(root, 'btn_save')            # 「新增」
    if n is None or n.get('enabled') == 'false':
        raise SystemExit('新增 not enabled after picking image')
    tap(*center(n)); time.sleep(3)
    return True

def read_answer(timeout=120):
    """等 tv_tts_content 出答案并返回文本。"""
    root = wait_for('tv_tts_content', timeout=timeout)
    for _ in range(20):
        txt = text_of(root, 'tv_tts_content')
        if len(txt) > 40: break
        time.sleep(3); root = dump()
    return text_of(root, 'tv_tts_content')

def attach(img):
    """推图 -> 打开手机助手 -> 在系统相册里精确选中刚推的图 -> 光标留在输入框。
    只做机械动作，问题本身由调用方输入：adb input text 打中文会 NPE，
    中文必须走 phone_action 的剪贴板通道。"""
    home()          # 新对话
    root = close_ime(dump())
    for _ in range(5):
        if find(root, 'btn_tools') is not None: break
        time.sleep(2); root = close_ime(dump())
    tap_rid(root, 'btn_tools', 2)                    # 更多
    remote = push_image(img)
    print('# pushed', remote, file=sys.stderr)
    pick_latest_from_gallery()                       # 走系统相册精确选新图
    root = dump()
    if find(root, 'btn_tools') is not None:          # 面板可能还开着，关掉
        adb('shell input keyevent 4'); time.sleep(1.2); root = dump()
    et = find(root, 'et_text_input') or find(root, 'aihome_et_text_input')
    if et is not None:
        tap(*center(et)); time.sleep(0.8)
    print('# ready: type the question with phone_action, then ai.py send / read', file=sys.stderr)
    return 'ready'

def describe(img):
    """点系统自带的「描述下这张图」chip 并读回答案（全自动，无需外部输入）。"""
    attach(img)
    root = dump()
    n = find_text(root, '描述下这张图')
    if n is None: raise SystemExit('chip not found')
    tap(*center(n))
    return read_answer()

def send():
    """提交输入框里已经写好的问题。"""
    root = dump()
    tap_rid(root, 'btn_send', 3)
    return 'sent'

def gen(prompt, ratio='1:1', style=None):
    ensure_unlocked()
    adb(f'shell am force-stop {PKG}')
    time.sleep(1)
    foreground()
    root = dump()
    for _ in range(3):
        if find_text(root, 'AI 生图') is not None: break
        adb('shell input keyevent 4'); time.sleep(1.5)
        foreground(); root = dump()
    n = find_text(root, 'AI 生图')
    if n is None: raise SystemExit('AI 生图 entry not found')
    tap(*center(n)); time.sleep(2.5)
    if style:
        root = dump(); n = find_text(root, style)
        if n is not None: tap(*center(n)); time.sleep(1)
    root = dump(); n = find_text(root, ratio)
    if n is None: raise SystemExit(f'ratio {ratio} not found')
    tap(*center(n)); time.sleep(1)
    root = dump()
    et = find(root, 'et_text_input') or find(root, 'aihome_et_text_input')
    tap(*center(et)); time.sleep(1)
    # 中文不能走 adb shell input text（Android 16 上 NPE 静默失败），改由 ADBKeyboard 广播输入
    if any(ord(ch) > 127 for ch in prompt):
        type_text(prompt)
    else:
        adb(f'shell input text "{prompt}"')
    time.sleep(1)
    adb('shell input keyevent 66')
    time.sleep(1)
    root = dump(); tap_rid(root, 'btn_send', 5)
    return 'sent'

DL = '/sdcard/Download'
OUT = os.environ.get("OPPO_OUT") or os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

def snapshot_downloads():
    out = adb('shell "ls ' + DL + '/img*.png 2>/dev/null"')
    return set(x.strip() for x in out.splitlines() if x.strip())

def new_download(before):
    out = adb('shell "ls -t ' + DL + '/img*.png 2>/dev/null"')
    for line in out.splitlines():
        line = line.strip()
        if line and line not in before:
            return line
    return None

def pick_any(root, names, wait=2.5):
    for nm in names:
        for r, nd in nodes(root):
            t = (nd.get('text') or '').strip()
            if t == nm or (t and t.startswith(nm)):
                tap(*center(nd)); time.sleep(wait); return nm
    return None

def crop_card(src, dst):
    from collections import Counter
    im = Image.open(src).convert('RGB')
    W, H = im.size
    px = im.load()
    c = Counter()
    for y in range(0, H, 7):
        for x in range(0, W, 7):
            c[px[x, y]] += 1
    bg = c.most_common(1)[0][0]
    def bands(counts, thresh=0.35, minlen=80):
        out = []; start = None
        for i, v in enumerate(counts):
            ok = v < thresh
            if ok and start is None: start = i
            elif not ok and start is not None:
                if i - start >= minlen: out.append((start, i))
                start = None
        if start is not None and len(counts) - start >= minlen: out.append((start, len(counts)))
        return out
    rowbg = [sum(1 for x in range(W) if px[x, y] == bg) / W for y in range(H)]
    rb = bands(rowbg)
    if not rb: raise SystemExit('crop failed: no row band')
    y0, y1 = max(rb, key=lambda b: b[1] - b[0])
    colbg = [sum(1 for y in range(y0, y1) if px[x, y] == bg) / (y1 - y0) for x in range(W)]
    cb = bands(colbg)
    x0, x1 = max(cb, key=lambda b: b[1] - b[0]) if cb else (0, W)
    left, right = x0 + 3, x1 - 3
    top, bottom = y0 + 3, y1 - 3
    side = min(right - left, bottom - top)
    im.crop((left, top, left + side, top + side)).save(dst)
    return (side, side)

PIC = '/sdcard/Pictures'

def snapshot_pictures():
    out = adb('shell "ls -t ' + PIC + ' 2>/dev/null"')
    return set(x.strip() for x in out.splitlines() if x.strip())

def new_picture(before):
    out = adb('shell "ls -t ' + PIC + ' 2>/dev/null"')
    for line in out.splitlines():
        line = line.strip()
        if line and line not in before and line.lower().endswith(('.jpg', '.jpeg', '.png')):
            return PIC + '/' + line
    return None

def first(root, rids):
    """Return the first existing node among resource ids (order matters)."""
    for rid in rids:
        n = find(root, rid)
        if n is not None:
            return n
    return None


def _centers(root, rids):
    out = []
    for rid in rids:
        for r, n in nodes(root):
            if r == rid:
                c = center(n)
                if c and c not in out:
                    out.append(c)
    return out


def open_image_viewer():
    """出图后进全屏看图页，返回「保存」按钮节点。

    新版界面里 iv_pic 可能被裁到屏幕顶部（bounds 高度只有 277），点它的中心会点到工具栏；
    真正的大图挂在 holder_layout 里。所以按几个候选容器依次试，谁能点出保存按钮就用谁。
    """
    for _ in range(4):
        root = dump()
        cand = _centers(root, ['iv_pic', 'holder_layout', 'card_view_layout', 'square_frame_layout'])
        for pt in cand:
            tap(*pt)
            for _ in range(5):
                time.sleep(1.2)
                r = dump()
                btn = first(r, ['ll_save_local'])
                if btn is None:
                    btn = find_text(r, '保存')
                if btn is not None and center(btn) is not None:
                    print('# new UI: fullscreen via', pt, file=sys.stderr)
                    return btn
        adb('shell input swipe 540 1500 540 950 300'); time.sleep(1.5)
    raise SystemExit('new UI: save button not found after tapping image')


def gen_new_ui(prompt, style=None):
    """新版手机助手（2026-11 起）没有「AI 生图」入口了：直接输入「画一幅…」当普通对话发出去，
    出图后点图进全屏 → 底部「保存」→ 落盘到 /sdcard/Pictures。"""
    ensure_unlocked()
    adb(f'shell am force-stop {PKG}')
    time.sleep(1)
    foreground()
    root = dump()
    et = find(root, 'et_text_input')
    if et is None:
        et = find(root, 'aihome_et_text_input')
    for _ in range(3):
        if et is not None: break
        adb('shell input keyevent 4'); time.sleep(1.2)
        foreground(); root = dump()
        et = find(root, 'et_text_input')
        if et is None:
            et = find(root, 'aihome_et_text_input')
    if et is None:
        raise SystemExit('new UI: input box not found')
    tap(*center(et)); time.sleep(1)
    text = prompt if not style else (prompt.rstrip('。') + '，' + style)
    if any(ord(ch) > 127 for ch in text):
        type_text(text)
    else:
        adb(f'shell input text "{text}"')
    time.sleep(1)
    adb('shell input keyevent 66')
    time.sleep(1)
    root = dump()
    n = find(root, 'btn_send')
    if n is None or center(n) is None:
        raise SystemExit('new UI: send button not found')
    tap(*center(n))
    print('# new UI: prompt sent, waiting for image', file=sys.stderr)
    t0 = time.time()
    while time.time() - t0 < 180:
        root = dump()
        n = find(root, 'iv_pic')
        if n is not None and center(n) is not None:
            break
        time.sleep(3)
    else:
        raise SystemExit('new UI: image not generated in 180s')
    btn = open_image_viewer()
    tap(*center(btn)); time.sleep(4)
    print('# new UI: saved to Pictures', file=sys.stderr)
    return True

def draw(prompt, ratio='1:1', style=None, out=None):
    """生成 -> 导出 -> pull -> 裁成方图，返回 (本地路径, 尺寸)。
    新旧两版手机助手 UI 都兼容：先试旧版「AI 生图」面板，找不到就退回新版直接对话出图。"""
    before = snapshot_downloads()
    before_pics = snapshot_pictures()
    try:
        gen(prompt, ratio, style)
    except SystemExit as e:
        if 'AI 生图' not in str(e):
            raise
        print('# fallback: no "AI 生图" entry (new 手机助手 UI)', file=sys.stderr)
        gen_new_ui(prompt, style)
        remote = new_picture(before_pics)
        if not remote:
            raise SystemExit('new UI: saved file not found in ' + PIC)
        print('# remote', remote, file=sys.stderr)
        if out is None:
            out = os.path.join(OUT, 'out.png')
        tmp = os.path.splitext(out)[0] + '.raw.jpg'
        adb('pull "' + remote + '" "' + tmp + '"')
        if not os.path.exists(tmp):
            raise SystemExit('pull failed')
        im = Image.open(tmp).convert('RGB')
        im.save(out)
        try:
            os.remove(tmp)
        except OSError:
            pass
        return (out, im.size)
    t0 = time.time()
    while time.time() - t0 < 150:
        root = dump()
        if find(root, 'iv_forward') is not None: break
        time.sleep(3)
    else:
        raise SystemExit('generate timeout: iv_forward not found')
    time.sleep(2.5)
    tap_rid(dump(), 'iv_forward', 3)
    print('# share panel', pick_any(dump(), ['其他']), file=sys.stderr)
    time.sleep(1.5)
    print('# resolver', pick_any(dump(), ['儲存到檔案管理員', '檔案管理員', '存到檔案管理員', 'Files']), file=sys.stderr)
    time.sleep(2)
    root = dump()
    btn = find(root, 'select_button')
    if btn is not None:
        tap(*center(btn)); time.sleep(3)
        print('# save btn select_button', file=sys.stderr)
    else:
        print('# save btn', pick_any(root, ['儲存', '保存'], 3), file=sys.stderr)
    remote = new_download(before)
    if not remote: raise SystemExit('save failed: no new file in Download')
    print('# remote', remote, file=sys.stderr)
    if out is None: out = os.path.join(OUT, 'out.png')
    card = os.path.splitext(out)[0] + '.card.jpg'
    adb('pull "' + remote + '" "' + card + '"')
    if not os.path.exists(card): raise SystemExit('pull failed')
    size = crop_card(card, out)
    return (out, size)

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'ids'
    if cmd == 'ids':
        for r in ids_dump(): print(r[0], '|', r[1], '|', r[2])
    elif cmd == 'describe':
        print(describe(sys.argv[2]))
    elif cmd == 'attach':
        print(attach(sys.argv[2]))
    elif cmd == 'send':
        print(send())
    elif cmd == 'read':
        print(read_answer())
    elif cmd == 'gen':
        print(gen(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else '1:1'))
    elif cmd == 'draw':
        print(draw(sys.argv[2],
                   sys.argv[3] if len(sys.argv) > 3 else '1:1',
                   None,
                   sys.argv[4] if len(sys.argv) > 4 else None))
    else:
        print(__doc__)