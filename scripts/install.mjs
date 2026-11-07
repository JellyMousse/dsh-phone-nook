#!/usr/bin/env node
// Install the phone skills + tools into a DeepSeek Harness home.
//
//   node scripts/install.mjs                 # render into ~/.dsh (or $DSH_HOME)
//   node scripts/install.mjs --dsh <path>    # render into another DSH home
//   node scripts/install.mjs --force         # overwrite files that differ
//   node scripts/install.mjs --dry-run       # show the plan, write nothing
//   node scripts/install.mjs --verify        # only run the environment checks
//
// What it does NOT do: it never writes your PIN anywhere except the path you
// configured, never edits your AGENTS.md, and never starts the phone.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const force = argv.includes('--force');
const dry = argv.includes('--dry-run');
const verifyOnly = argv.includes('--verify');
const DSH = path.resolve(flag('--dsh', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')));
const slash = (s) => String(s).replace(/\\/g, '/');

// ---------- 1. 配置 ----------

const cfgPath = path.join(REPO, 'config', 'device.json');
if (!fs.existsSync(cfgPath)) {
  fs.copyFileSync(path.join(REPO, 'config', 'device.example.json'), cfgPath);
  console.log('[!] config/device.json 不存在，已从 device.example.json 生成');
  console.log('    请填写 adb / serial / owner 后再跑一次（device.json 已被 .gitignore 忽略）');
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const pinFile = (cfg.unlockPinFile || '').replace(/^~/, os.homedir());
const MAP = {
  __ADB__: cfg.adb || 'adb',
  __SERIAL__: cfg.serial || '',
  __OWNER__: cfg.owner || '<owner>',
  __DSH__: slash(DSH),
  __HOME__: slash(os.homedir()),
  __MODEL__: cfg.model || 'Android phone',
  __REPO__: slash(REPO),
  __PIN__: cfg.unlockPin || '<PIN>',
  __PY__: cfg.python || 'python',
};
const render = (s) => s.replace(/__[A-Z]+__/g, (m) => (m in MAP ? MAP[m] : m));

// ---------- 2. 体检 ----------

function check() {
  const 结果 = [];
  const 试 = (名, fn) => {
    try { 结果.push([名, true, String(fn() || '').trim().slice(0, 120)]); }
    catch (e) { 结果.push([名, false, String((e && e.message) || e).slice(0, 160)]); }
  };
  试('node >= 20', () => process.version);
  试('adb 可用', () => execFileSync(MAP.__ADB__, ['version'], { encoding: 'utf8', timeout: 15000 }));
  试('手机在线 (' + (MAP.__SERIAL__ || '未配置') + ')', () => {
    if (!MAP.__SERIAL__) throw new Error('config/device.json 里 serial 是空的');
    const out = execFileSync(MAP.__ADB__, ['-s', MAP.__SERIAL__, 'get-state'], { encoding: 'utf8', timeout: 15000 });
    if (!/device/.test(out)) throw new Error('get-state 返回 ' + out);
    return 'device';
  });
  试('Python + Pillow + numpy', () => execFileSync(MAP.__PY__, ['-c', 'import PIL, numpy; print(PIL.__version__, numpy.__version__)'], { encoding: 'utf8', timeout: 30000 }));
  试('解锁 PIN 文件', () => {
    if (!pinFile) throw new Error('config 里 unlockPinFile 为空');
    if (!fs.existsSync(pinFile)) throw new Error('找不到 ' + pinFile);
    return pinFile;
  });
  console.log('\n--- 环境体检 ---');
  for (const [名, ok, 详情] of 结果) console.log((ok ? '  OK   ' : '  FAIL ') + 名 + (ok ? '' : ' → ' + 详情));
  const 全过 = 结果.every(([, ok]) => ok);
  if (!全过) console.log('\n提示：手机不在线不影响安装，但值守跑不动；解锁 PIN 文件不存在则只能跑「没锁」的手机。');
  return 全过;
}

if (verifyOnly) { check(); process.exit(0); }

// ---------- 3. 落盘 ----------

function put(src, dst) {
  const 文 = render(fs.readFileSync(src, 'utf8'));
  if (dry) { console.log('  plan + ' + dst); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst) && !force) {
    const 旧 = fs.readFileSync(dst, 'utf8');
    if (旧 === 文) { console.log('  = ' + dst); return; }
    console.log('  ! 已存在且内容不同（加 --force 覆盖）: ' + dst);
    return;
  }
  fs.writeFileSync(dst, 文);
  console.log('  + ' + dst);
}

const SKILLS = [
  ['skills/oppo-ai/SKILL.md', 'skills/oppo-ai/SKILL.md'],
  ['skills/phone-ops/SKILL.md', 'skills/phone-ops/SKILL.md'],
  ['skills/phone-watch/SKILL.md', 'skills/phone-watch/SKILL.md'],
  ['skills/phone-memory/SKILL.md', 'skills/phone-memory/SKILL.md'],
  ['skills/phone-memory/phone_memory.py', 'skills/phone-memory/phone_memory.py'],
];

// 脚本落到 skills/phone-ops/ 下：插件默认的 scriptsBase 就指向这里
const TOOLS = [
  ['tools/watch_probe.py', 'skills/phone-ops/watch_probe.py'],
  ['tools/phone_unlock.py', 'skills/phone-ops/phone_unlock.py'],
  ['tools/report_round.py', 'skills/phone-ops/report_round.py'],
  ['tools/adb_connect.mjs', 'skills/phone-ops/adb_connect.mjs'],
  ['tools/adb_discover.mjs', 'skills/phone-ops/adb_discover.mjs'],
];

console.log('\n安装到 ' + DSH + (dry ? '（dry-run）' : ''));
for (const [s, d] of [...SKILLS, ...TOOLS]) put(path.join(REPO, s), path.join(DSH, d));

// 值守状态模板
const 状态 = path.join(DSH, 'phone-watch-state.json');
if (!fs.existsSync(状态) && !dry) {
  fs.writeFileSync(状态, JSON.stringify({ next_due: null, dispatched_at: null, rounds_today: 0, day: null, log: [] }, null, 2) + '\n');
  console.log('  + ' + 状态);
}

// 插件配置（不覆盖已有），把目标会话留空等人填
const 插件配置 = path.join(DSH, 'phone-watch-config.json');
if (!fs.existsSync(插件配置) && !dry) {
  fs.writeFileSync(插件配置, JSON.stringify({
    enabled: false,
    targetSession: '',
    awakeStart: 10,
    sleepStart: 3,
    idleMin: 20,
    awaitingMin: 8,
    earlyToleranceSec: 60,
    peakMul: 2,
    peakWindows: [[9, 12], [14, 18]],
    wakeSpreadMin: 120,
  }, null, 2) + '\n');
  console.log('  + ' + 插件配置 + '（enabled=false，填好 targetSession 再打开）');
}

console.log('\n--- 还要手动做三件事 ---');
console.log('1) 注册 MCP（在 <profile>/cordis.patch.yml 的 insert: 下加一段）：');
console.log([
  '- insert:',
  '    - id: mcp-opai',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: opai',
  '        transport: stdio',
  "        command: '" + slash(MAP.__PY__) + "'",
  '        args:',
  "          - '" + slash(path.join(REPO, 'core', 'oppo-ai', 'mcp_server.py')) + "'",
  '        env:',
  "          PYTHONUTF8: '1'",
  "          PYTHONIOENCODING: 'utf-8'",
  '        toolCallTimeoutMs: 300000',
].join('\n'));
console.log('2) 装值守插件：把 plugin/dsh-phone-watch 放进 <profile>/vendor/，');
console.log('   在 <profile>/package.json 里加 "dsh-phone-watch": "file:vendor/dsh-phone-watch"，');
console.log('   再把 "dsh-phone-watch" 加进 dsh.profile.bundles，重启 dsh。');
console.log('3) 打开 设置 → 手机值守，填目标会话（session id），切换总开关。');
console.log('\n手机 MCP 工具（phone_observe / phone_action 等）不在本仓库，请用你惯用的 phone MCP 或自建一个。');
