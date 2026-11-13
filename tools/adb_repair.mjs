#!/usr/bin/env node
// Refresh the wireless-debugging pairing without touching the phone by hand.
//   node adb_repair.mjs            pair again now, print JSON
//   node adb_repair.mjs --apply    ... and refresh config/device.json + phone MCP config
//   node adb_repair.mjs --keep-ui  leave the pairing dialog open (debugging)
//   PHONE_REPAIR_DEBUG=1            also print the chosen serial on stderr
//
// Why: Android only shows pairing codes on screen, and pairing needs adb shell to
// reach that screen — so this works only while some adb transport is still alive.
// If the pairing key is already gone, this cannot help; ask the owner.
//
// Verified 2026-11-13: code + port read straight out of the Settings dialog,
// "adb pair" succeeded, the connection in use stayed up.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLED_REPO = '__REPO__';
const REPO = process.env.PHONE_AGENT_HOME
  || (/^([A-Za-z]:|\/)/.test(INSTALLED_REPO) ? INSTALLED_REPO : path.resolve(HERE, '..'));
const CFG = path.join(REPO, 'config', 'device.json');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const KEEP_UI = args.includes('--keep-ui');
const SERIAL = (() => {
  const i = args.indexOf('--serial');
  return i >= 0 ? args[i + 1] : null;
})();
const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
// --dialog：配对弹窗已经开在屏幕上，只负责读码 + 配对
// --code/--addr：直接给码和地址，完全不碰界面
const DIALOG = args.includes('--dialog');
const GIVEN_CODE = val('--code');
const GIVEN_ADDR = val('--addr');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { /* 没配置也能跑，用 adb devices 自己挑 */ }
const ADB = cfg.adb || 'adb';
const DUMP = '/sdcard/kuma_ui.xml';

const out = { ok: false };
const say = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };

function run(list, timeout = 20000) {
  try {
    return execFileSync(ADB, list, {
      encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return (e && e.stdout) ? String(e.stdout) : '';
  }
}

function devices() {
  return run(['devices']).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('List of'));
}

function pickSerial() {
  if (SERIAL) return SERIAL;
  const live = devices().find((l) => /\sdevice\b/.test(l));
  return live ? live.split(/\s+/)[0] : null;
}

const S = pickSerial();
if (process.env.PHONE_REPAIR_DEBUG) console.error('debug adb=', ADB, 'serial=', S);

function sh(cmd, timeout = 20000) {
  return run(['-s', S, 'shell', cmd], timeout);
}

// --- screen ----------------------------------------------------------------

const screenOn = () => /mScreenState=ON/.test(sh('dumpsys display | grep -o "mScreenState=[A-Z_]*" | head -1'));
const isLocked = () => /isKeyguardShowing=true/.test(sh('dumpsys window | grep -m1 isKeyguardShowing'));

function ensureAwake() {
  if (screenOn()) return true;
  sh('input keyevent 224; sleep 1');
  return screenOn();
}

function unlock() {
  const installed = '__DSH__/skills/phone-caretaker/phone_unlock.py';
  const inRepo = path.join(REPO, 'kuma', 'phone_unlock.py');
  const script = fs.existsSync(installed) ? installed : inRepo;
  if (!fs.existsSync(script)) return false;
  try {
    const r = execFileSync('python', [script], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    return !/still_locked": true/.test(String(r));
  } catch {
    return false;
  }
}

// --- ui --------------------------------------------------------------------

function dumpNodes() {
  // dump 偶尔静默失败，会读回上一张图；先删文件，再确认 dump 真的写了
  for (let i = 0; i < 3; i++) {
    sh('rm -f ' + DUMP);
    const said = sh('uiautomator dump ' + DUMP);
    if (/dumped to/i.test(said)) break;
    sh('sleep 0.8');
  }
  const xml = run(['-s', S, 'exec-out', 'cat', DUMP], 25000);
  const re = /<node[^>]*?text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  const nodes = [];
  let m;
  while ((m = re.exec(xml))) {
    if (!m[1].trim()) continue;
    const [, x1, y1, x2, y2] = m;
    nodes.push({
      text: m[1],
      w: Number(x2) - Number(x1),
      h: Number(y2) - Number(y1),
      cx: (Number(x1) + Number(x2)) >> 1,
      cy: (Number(y1) + Number(y2)) >> 1,
    });
  }
  return nodes;
}

const tap = (x, y) => { sh('input tap ' + x + ' ' + y); sh('sleep 1'); };
// 有些节点的 bounds 是 0×0（列表里重复渲染的标题），点它会点空；只要够大的那一块
const findText = (nodes, re) => nodes.find((n) => n.w > 200 && n.h > 40 && re.test(n.text)) || null;

// 开发者选项是一长串，目标行常在屏幕外：先往下找 6 次，再往回找 6 次
function findOnPage(re) {
  let nodes = dumpNodes();
  let hit = findText(nodes, re);
  if (hit) return { hit, nodes };
  for (let i = 0; i < 6; i++) {
    sh('input swipe 540 1800 540 800 250; sleep 1');
    nodes = dumpNodes();
    hit = findText(nodes, re);
    if (hit) return { hit, nodes };
  }
  for (let i = 0; i < 6; i++) {
    sh('input swipe 540 800 540 1800 250; sleep 1');
    nodes = dumpNodes();
    hit = findText(nodes, re);
    if (hit) return { hit, nodes };
  }
  return { hit: null, nodes };
}

// 语言可能繁中/简中/英文/日文
const WIRELESS_ROW = /無線偵錯|无线调试|Wireless debugging|無線デバッグ/i;
const PAIR_ROW = /使用(配對碼|配对码|六位數|六位数)|Pair device with pairing code|ペア設定コード/i;
const PAGE_MARK = /IP 位址和連接埠|IP 地址和端口|IP address & Port|IP アドレスとポート/i;

function openPairingDialog() {
  // 设置页会记住上次的滚动位置，先强停再开，保证从顶部开始
  sh('am force-stop com.android.settings; sleep 0.8');
  sh('am start -a android.settings.APPLICATION_DEVELOPMENT_SETTINGS');
  sh('sleep 2.2');

  let found = null;
  let nodes = [];
  for (let i = 0; i < 8; i++) {
    ensureAwake();
    nodes = dumpNodes();
    found = findText(nodes, WIRELESS_ROW);
    if (found) break;
    sh('input swipe 540 1700 540 1000 800; sleep 0.8');
  }
  if (!found) return { ok: false, why: 'developer options row not found', seen: nodes.slice(0, 12).map((n) => n.text) };
  if (process.env.PHONE_REPAIR_DEBUG) {
    console.error('found row', JSON.stringify(found), 'page head', nodes.slice(0, 3).map((n) => n.text).join('|'));
  }
  tap(found.cx, found.cy);

  // 点完确认真进了无线调试页；没进去就按最新坐标再点一次
  let page = null;
  for (let i = 0; i < 3; i++) {
    nodes = dumpNodes();
    if (process.env.PHONE_REPAIR_DEBUG) console.error('after tap:', nodes.slice(0, 5).map((n) => n.text).join('|'));
    if (PAGE_MARK.test(nodes.map((n) => n.text).join(' '))) break;
    const again = findText(nodes, WIRELESS_ROW);
    if (!again) return { ok: false, why: 'tapping the row did not open wireless debugging', seen: nodes.slice(0, 12).map((n) => n.text) };
    tap(again.cx, again.cy);
  }
  page = nodes;

  for (let i = 0; i < 5; i++) {
    const row = findText(page, PAIR_ROW);
    if (row) { tap(row.cx, row.cy); break; }
    sh('input swipe 540 1700 540 1000 800; sleep 0.8');
    page = dumpNodes();
  }
  nodes = dumpNodes();
  const pick = (ns) => ({
    six: ns.filter((n) => /^\d{6}$/.test(n.text.trim())),
    addrs: ns.filter((n) => /^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(n.text.trim())),
  });
  let { six, addrs } = pick(nodes);
  for (let i = 0; i < 2 && (!six.length || !addrs.length); i++) {
    sh('sleep 1.2');
    nodes = nodes.concat(dumpNodes());
    ({ six, addrs } = pick(nodes));
  }
  if (!six.length || !addrs.length) {
    return { ok: false, why: 'pairing code or address missing from dialog', seen: nodes.slice(0, 16).map((n) => n.text) };
  }
  // 弹窗里码就在地址上一行，取纵坐标最接近的那一对
  const addr = addrs[0];
  const code = six.sort((a, b) => Math.abs(a.cy - addr.cy) - Math.abs(b.cy - addr.cy))[0];
  return { ok: true, code: code.text.trim(), addr: addr.text.trim() };
}

// 弹窗已经开着：只读码，不导航
function scrapeDialog() {
  const pick = (ns) => ({
    six: ns.filter((n) => /^\d{6}$/.test(n.text.trim())),
    addrs: ns.filter((n) => /^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(n.text.trim())),
  });
  let nodes = dumpNodes();
  let { six, addrs } = pick(nodes);
  for (let i = 0; i < 2 && (!six.length || !addrs.length); i++) {
    sh('sleep 1.2');
    nodes = nodes.concat(dumpNodes());
    ({ six, addrs } = pick(nodes));
  }
  if (!six.length || !addrs.length) {
    return { ok: false, why: 'pairing code or address not on screen', seen: nodes.slice(0, 16).map((n) => n.text) };
  }
  const addr = addrs[0];
  const code = six.sort((a, b) => Math.abs(a.cy - addr.cy) - Math.abs(b.cy - addr.cy))[0];
  return { ok: true, code: code.text.trim(), addr: addr.text.trim() };
}

function closeUi() {
  if (KEEP_UI) return;
  sh('input keyevent 4; sleep 0.4; input keyevent 4; sleep 0.4; input keyevent 4; sleep 0.5');
}

// --- main ------------------------------------------------------------------

out.focusBefore = (() => {
  const m = /u0 ([a-zA-Z0-9_.]+)\//.exec(sh('dumpsys activity activities | grep -m1 ResumedActivity'));
  return m ? m[1] : null;
})();

if (!S) {
  say({ ...out, why: 'no adb device: pairing needs adb shell to open the dialog, so this cannot run once the link is dead' });
}

const oldTimeout = sh('settings get system screen_off_timeout').trim();
sh('settings put system screen_off_timeout 600000');
const restoreTimeout = () => {
  if (/^\d+$/.test(oldTimeout)) sh('settings put system screen_off_timeout ' + oldTimeout);
};

try {
  if (!ensureAwake()) say({ ...out, why: 'screen stays off, cannot drive settings' });
  if (isLocked() && !unlock()) say({ ...out, why: 'phone is locked and unlock failed (check phone-unlock.txt / doze)' });

  let dlg;
  if (GIVEN_CODE && GIVEN_ADDR) {
    dlg = { ok: true, code: GIVEN_CODE, addr: GIVEN_ADDR };
  } else if (DIALOG) {
    dlg = scrapeDialog();
  } else {
    dlg = openPairingDialog();
  }
  if (!dlg.ok) {
    closeUi();
    restoreTimeout();
    say({ ...out, why: dlg.why, seen: dlg.seen, nextStep: '开发者选项 → 無線偵錯 → 使用配對碼配對裝置，弹窗出来后再跑一次加 --dialog' });
  }

  out.pairing = dlg.addr;
  out.code = dlg.code;
  const pairOut = run(['pair', dlg.addr, dlg.code], 40000).trim();
  out.pairOutput = pairOut;
  out.paired = /Successfully paired/i.test(pairOut);

  closeUi();
  restoreTimeout();

  if (out.paired && APPLY) {
    const conn = path.join(HERE, 'adb_connect.mjs');
    if (fs.existsSync(conn)) {
      try {
        const raw = execFileSync(process.execPath, [conn, '--apply'], { encoding: 'utf8', timeout: 180000, windowsHide: true });
        const parsed = JSON.parse(String(raw).trim().split(/\r?\n/).pop());
        out.applied = parsed;
        out.serial = parsed.serial;
        out.ok = Boolean(parsed.ok);
      } catch (e) {
        out.applyError = String((e && (e.stdout || e.message)) || e).slice(0, 400);
      }
    }
  } else {
    out.ok = out.paired;
  }

  if (!out.ok && !out.why) out.why = 'adb pair did not report success';
  say(out);
} catch (e) {
  restoreTimeout();
  say({ ...out, why: 'crash: ' + (e && e.message ? e.message : String(e)) });
}