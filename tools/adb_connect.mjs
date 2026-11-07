#!/usr/bin/env node
// Pick a reachable phone address and print it as JSON.
//   node adb_connect.mjs                 probe known addresses; if all dead, mDNS + port scan
//   node adb_connect.mjs --apply         also write the winner into config/device.json
//                                        (and into the phone MCP config, if configured)
//   KP_FORCE_SCAN=1 node adb_connect.mjs skip the known addresses, go straight to discovery
//
// Why: the phone drops WiFi when the screen sleeps, so the LAN address dies with it.
// ZeroTier rides mobile data and keeps working. Try LAN first (low latency), fall back.
// Why the scan: re-enabling wireless debugging hands out a NEW random port, so the
// remembered serial goes stale even though the phone is on the same IP (2026-11-06).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLED_REPO = '__REPO__';
const REPO = process.env.PHONE_AGENT_HOME
  || (/^([A-Za-z]:|\/)/.test(INSTALLED_REPO) ? INSTALLED_REPO : path.resolve(HERE, '..'));
const CFG = path.join(REPO, 'config', 'device.json');
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
} catch (e) {
  // 没跑过 install.mjs / config 缺失时也吐一行 JSON，别让调用方拿到空输出
  console.log(JSON.stringify({ ok: false, why: 'cannot read ' + CFG + ': ' + (e.message || e) }));
  process.exit(1);
}
const ADB = cfg.adb || 'adb';

// Ports wireless debugging hands out live in the ephemeral range; scan the usual band.
const SCAN_FROM = Number(process.env.KP_SCAN_FROM || 30000);
const SCAN_TO = Number(process.env.KP_SCAN_TO || 50000);
const SCAN_TIMEOUT = Number(process.env.KP_SCAN_TIMEOUT_MS || 250);
const SCAN_CONCURRENCY = Number(process.env.KP_SCAN_CONCURRENCY || 1200);

function run(args, timeout = 25000) {
  try {
    return execFileSync(ADB, args, {
      encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return e && e.stdout ? String(e.stdout) : '';
  }
}

function deviceLines() {
  return run(['devices']).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function online(addr) {
  for (const t of deviceLines()) {
    if (!t.startsWith(addr)) continue;
    return /\sdevice\b/.test(t);
  }
  return false;
}

function connect(addr) {
  if (online(addr)) return true;
  run(['disconnect', addr]);          // clear a stale offline entry before retrying
  run(['connect', addr], 15000);
  return online(addr);
}

// --- discovery -------------------------------------------------------------

function mdnsAddresses() {
  const found = [];
  for (const t of run(['mdns', 'services'], 15000).split(/\r?\n/)) {
    if (!t.includes('_adb-tls-connect._tcp')) continue;
    const last = t.trim().split(/\s+/).pop() || '';
    if (/^[0-9.]+:\d+$/.test(last)) found.push(last);
  }
  return found;
}

function mdnsTransports() {
  // adb also shows mDNS transports as usable serials: adb-XXXX._adb-tls-connect._tcp
  return deviceLines().filter((l) => l.includes('_adb-tls-connect._tcp') && /\sdevice\b/.test(l))
    .map((l) => l.split(/\s+/)[0]);
}

function tryOpenPort(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(SCAN_TIMEOUT);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function scanPorts(host) {
  const open = [];
  let port = SCAN_FROM;
  const workers = Array.from({ length: SCAN_CONCURRENCY }, async () => {
    while (port <= SCAN_TO) {
      const p = port++;
      if (await tryOpenPort(host, p)) open.push(p);
    }
  });
  await Promise.all(workers);
  return open.sort((a, b) => a - b);
}

function ipOf(serial) {
  const m = String(serial || '').match(/^([0-9.]+):\d+$/);
  return m ? m[1] : null;
}

// --- main ------------------------------------------------------------------

const candidates = [];
const push = (addr, via) => {
  if (addr && !candidates.some((c) => c.addr === addr)) candidates.push({ addr, via });
};
if (!process.env.KP_FORCE_SCAN) {
  push(cfg.serial, 'lan');
  push(cfg.serialFallback, 'fallback');
  for (const extra of cfg.serialExtra || []) push(extra, 'extra');
}

let winner = null;
const tried = [];

for (const c of candidates) {
  const ok = connect(c.addr);
  tried.push({ addr: c.addr, via: c.via, online: ok });
  if (ok && !winner) winner = { addr: c.addr, via: c.via };
}

// 1) mDNS: cheapest way to learn the new port when it changed.
if (!winner && !process.env.KP_NO_MDNS) {
  for (const addr of mdnsAddresses()) {
    if (connect(addr)) { winner = { addr, via: 'mdns' }; break; }
  }
}
if (!winner && !process.env.KP_NO_MDNS) {
  for (const serial of mdnsTransports()) {
    if (online(serial)) { winner = { addr: serial, via: 'mdns-transport' }; break; }
  }
}

// 2) Port scan on the remembered IPs. Wireless debugging rotates the port.
if (!winner) {
  const hosts = [...new Set([ipOf(cfg.serial), ipOf(cfg.serialFallback)]
    .filter(Boolean))];
  for (const host of hosts) {
    const ports = await scanPorts(host);
    tried.push({ scan: host, range: [SCAN_FROM, SCAN_TO], openPorts: ports });
    for (const p of ports) {
      const addr = host + ':' + p;
      if (connect(addr)) { winner = { addr, via: 'scan' }; break; }
    }
    if (winner) break;
  }
}

// 2b) Diagnostic: an open port that refuses the adb handshake means the wireless
// debugging session (keys) is gone — no address juggling helps, the user has to
// re-pair (toggle wireless debugging off/on) or plug USB. Seen 2026-11-06.
const rejected = tried.some((t) => t.scan && (t.openPorts || []).length);

const result = {
  ok: Boolean(winner),
  serial: winner ? winner.addr : null,
  via: winner ? winner.via : null,
  tried,
};
if (!winner && rejected) {
  result.why = 'adb handshake rejected on an open port: wireless debugging stopped '
    + 'listening (toggle the switch off/on) or the pairing key is gone (re-pair / plug USB)';
}

const apply = process.argv.includes('--apply');
if (winner && apply) {
  if (cfg.serial !== winner.addr) {
    fs.writeFileSync(CFG, JSON.stringify({ ...cfg, serial: winner.addr }, null, 2) + '\n');
    result.applied = CFG;
  }
  // The phone MCP server re-reads its own config on every call, so updating the
  // serial here takes effect without a restart.
  if (cfg.mcpConfig && fs.existsSync(cfg.mcpConfig)) {
    try {
      const mc = JSON.parse(fs.readFileSync(cfg.mcpConfig, 'utf8'));
      if (mc.serial !== winner.addr) {
        mc.serial = winner.addr;
        fs.writeFileSync(cfg.mcpConfig, JSON.stringify(mc, null, 2) + '\n');
        result.mcpSynced = cfg.mcpConfig;
      }
    } catch (e) {
      result.mcpError = String(e.message || e);
    }
  }
}

console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);