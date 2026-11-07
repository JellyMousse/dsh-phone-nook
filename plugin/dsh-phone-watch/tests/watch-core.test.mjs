import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDue, inPeak, inSleep, isDue, isPaused, normalizeConfig, normalizePolicy, policyRules } from '../lib/watch-core.mjs';

const cfg = normalizeConfig({ awakeStart: 10, sleepStart: 3, idleMin: 20, awaitingMin: 5, peakMul: 2 });
const at = (h, m = 0) => new Date(2026, 10, 5, h, m, 0, 0); // 2026-11-05 本地时间
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

test('到点判断含 5 分钟提前容忍', () => {
  const due = new Date(at(11).getTime()).toISOString();
  assert.equal(isDue(at(10, 56), due), true);
  assert.equal(isDue(at(10, 54), due), false);
  assert.equal(isDue(at(11, 30), due), true);
  assert.equal(isDue(at(11), null), false);
});

test('暂停判定', () => {
  const until = at(13).toISOString();
  assert.equal(isPaused(at(12), until), true);
  assert.equal(isPaused(at(14), until), false);
  assert.equal(isPaused(at(14), null), false);
});

test('回话规矩默认严格：只回主人和被点名的', () => {
  const 行 = policyRules(undefined);
  assert.equal(行.length, 1);
  assert.match(行[0], /只回主人/);
  assert.match(行[0], /@我/);
});

test('回话规矩：列了主人就点名，没列就写「主人」', () => {
  assert.match(policyRules({ ownerNames: ['主人', '阿豹'] })[0], /主人、阿豹/);
  assert.doesNotMatch(policyRules({})[0], /主人、/);
  assert.match(policyRules({ mentionKeywords: ['@呆呆'] })[0], /@呆呆/);
});

test('友好方式：列出的群可以主动接话，没列就说只按上一条', () => {
  const 有 = policyRules({ mode: 'friendly', freeTalkGroups: ['群A', '群B'] });
  assert.match(有[1], /主动接话/);
  assert.match(有[1], /群A、群B/);
  const 无 = policyRules({ mode: 'friendly' });
  assert.match(无[1], /只按上一条/);
});

test('安静方式：群里连点名也不回', () => {
  const 行 = policyRules({ mode: 'quiet' });
  assert.match(行[0], /连@我 也不回|连@我也不回/);
});

test('不接名单与自定义说明都进明文', () => {
  const 行 = policyRules({ ignoreSenders: ['广告号'], extra: '只聊技术，别聊钱' });
  assert.ok(行.some((l) => l.includes('广告号')));
  assert.ok(行.some((l) => l.includes('只聊技术')));
});

test('策略归一化：未知方式回落到严格，名单去空去脏', () => {
  const p = normalizePolicy({ mode: '乱写', ownerNames: [' 主人 ', '', 3], extra: 'x'.repeat(900) });
  assert.equal(p.mode, 'strict');
  assert.deepEqual(p.ownerNames, ['主人', '3']);
  assert.equal(p.extra.length, 500);
  // 配置里带着策略一起归一化，别被 normalizeConfig 吃掉
  assert.equal(normalizeConfig({ policy: { mode: 'friendly' } }).policy.mode, 'friendly');
});

test('配置归一化兜住脏值', () => {
  const c = normalizeConfig({ idleMin: 'abc', peakMul: 99, peakWindows: 'x' });
  assert.equal(c.idleMin, 20);
  assert.equal(c.peakMul, 4);
  assert.deepEqual(c.peakWindows, [[9, 12], [14, 18]]);
});
