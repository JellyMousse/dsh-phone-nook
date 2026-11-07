#!/usr/bin/env node
// 兼容入口：老的文档/脚本还叫这个名字。真正干活的是 adb_connect.mjs——
// 它会先试已知地址，再问 mDNS，最后才扫端口。这里只是强制跳过已知地址。
//   node adb_discover.mjs [--apply] [--from 30000 --to 50000]
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? String(args[i + 1]) : dflt;
};

const env = {
  ...process.env,
  KP_FORCE_SCAN: '1',
  KP_SCAN_FROM: opt('--from', '30000'),
  KP_SCAN_TO: opt('--to', '50000'),
};

const r = spawnSync(process.execPath, [path.join(HERE, 'adb_connect.mjs'), ...(args.includes('--apply') ? ['--apply'] : [])], {
  env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status === null ? 1 : r.status);