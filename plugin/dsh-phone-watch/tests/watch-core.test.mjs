import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDue, inPeak, inSleep, isDue, isPaused, normalizeConfig } from '../lib/watch-core.mjs';

const cfg = normalizeConfig({ awakeStart: 10, sleepStart: 3, idleMin: 20, awaitingMin: 5, peakMul: 2 });
const at = (h, m = 0, s = 0) => new Date(2026, 10, 5, h, m, s, 0); // 2026-11-05 本地时间
const fixed = (v) => () => v;

test('谷时常态间隔不翻倍', () => {
  const r = nextDue({ now: at(2), reason: 'reply', cfg, rand: fixed(0.5) });
  assert.equal(r.peak, false);
  assert.equal(r.minutes, 20);
});

test('峰时 10 点翻倍', () => {
  const r = nextDue({ now: at(10), reason: 'reply', cfg, rand: fixed(0.5) });
  assert.equal(r.peak, true);
  assert.equal(r.minutes, 40);
});

test('峰时 15 点翻倍', () => {
  const r = nextDue({ now: at(15), reason: 'no-reply', cfg, rand: fixed(0.5) });
  assert.equal(r.minutes, 40);
});

test('13 点不算峰时', () => {
  const r = nextDue({ now: at(13), reason: 'reply', cfg, rand: fixed(0.5) });
  assert.equal(r.peak, false);
  assert.equal(r.minutes, 20);
});

test('awaiting 间隔更短，峰时同样翻倍', () => {
  assert.equal(nextDue({ now: at(2), reason: 'awaiting', cfg, rand: fixed(0.5) }).minutes, 5);
  assert.equal(nextDue({ now: at(10), reason: 'awaiting', cfg, rand: fixed(0.5) }).minutes, 10);
});

test('落进睡眠区就顺延到起床点，标记 wake', () => {
  // 02:50 + 20 分 = 03:10，在 3~10 睡眠区
  const r = nextDue({ now: at(2, 50), reason: 'reply', cfg, rand: fixed(0) });
  assert.equal(r.wake, true);
  assert.equal(r.due.getHours(), 10);
  assert.equal(r.due.getMinutes(), 0);
  assert.ok(r.due.getTime() > at(2, 50).getTime());
});

test('起床轮带随机散布', () => {
  const r = nextDue({ now: at(2, 50), reason: 'reply', cfg, rand: fixed(0.5) });
  assert.equal(r.due.getHours(), 11); // 10:00 + 60min
});

test('睡眠判定跨午夜', () => {
  assert.equal(inSleep(4, 10, 3), true);
  assert.equal(inSleep(23, 10, 3), false);
  assert.equal(inSleep(10, 10, 3), false);
  // 夜班口径：22 点醒、6 点睡 → 白天 6~22 才是睡眠区
  assert.equal(inSleep(10, 22, 6), true);
  assert.equal(inSleep(23, 22, 6), false);
  assert.equal(inSleep(3, 22, 6), false);
});

test('峰时窗口边界左闭右开', () => {
  assert.equal(inPeak(9, [[9, 12]]), true);
  assert.equal(inPeak(12, [[9, 12]]), false);
});

test('到点判断含 60 秒提前容忍（必须明显小于最短间隔，否则会自喂自）', () => {
  const due = new Date(at(11).getTime()).toISOString();
  assert.equal(isDue(at(10, 59, 30), due), true);
  assert.equal(isDue(at(10, 58), due), false);
  assert.equal(isDue(at(11, 30), due), true);
  assert.equal(isDue(at(11), null), false);
});

test('暂停判定', () => {
  const until = at(13).toISOString();
  assert.equal(isPaused(at(12), until), true);
  assert.equal(isPaused(at(14), until), false);
  assert.equal(isPaused(at(14), null), false);
});

test('配置归一化兜住脏值', () => {
  const c = normalizeConfig({ idleMin: 'abc', peakMul: 99, peakWindows: 'x' });
  assert.equal(c.idleMin, 20);
  assert.equal(c.peakMul, 4);
  assert.deepEqual(c.peakWindows, [[9, 12], [14, 18]]);
});
