// 值守排期的纯函数部分。
// 这里**不碰**任何宿主对象、不发消息、不读文件 —— 只做时间算术，方便单测。
//
// 规则（2026-11-05 与主人确认过的口径）：
//   · 作息：awakeStart 点醒，sleepStart 点睡（跨午夜）。落在睡眠区的下一轮顺延到
//     当天 awakeStart + rand(0..wakeSpreadMin)，这一轮标记 wake:true（起床轮）。
//   · 常态间隔 idleMin；等回应 awaitingMin；峰时（默认 09-12、14-18）整体 ×peakMul。
//   · 掐点容忍：now 与 due 相差 ≤ earlyToleranceSec 都算到点（at 与 next_due 是两套时钟）。

export const DEFAULTS = {
  awakeStart: 10,
  sleepStart: 3,
  idleMin: 20,
  awaitingMin: 5,
  peakWindows: [[9, 12], [14, 18]],
  peakMul: 2,
  wakeSpreadMin: 120,
  // ⚠ 早期版本这里是 300，和 awaitingMin=5 分钟正好相等：等回应那轮排到 5 分钟后，
  // 下一拍立刻被判成「已到点」，于是每分钟叫醒一次（自己喂自己）。容差必须明显小于最短间隔。
  earlyToleranceSec: 60,
};

const int = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const windows = Array.isArray(r.peakWindows) && r.peakWindows.length
    ? r.peakWindows
        .filter((w) => Array.isArray(w) && w.length === 2)
        .map((w) => [int(w[0], 0, 0, 23), int(w[1], 0, 0, 24)])
    : DEFAULTS.peakWindows;
  return {
    enabled: r.enabled !== false,
    targetSession: typeof r.targetSession === 'string' ? r.targetSession.trim() : '',
    awakeStart: int(r.awakeStart, DEFAULTS.awakeStart, 0, 23),
    sleepStart: int(r.sleepStart, DEFAULTS.sleepStart, 0, 23),
    idleMin: int(r.idleMin, DEFAULTS.idleMin, 1, 1440),
    awaitingMin: int(r.awaitingMin, DEFAULTS.awaitingMin, 1, 1440),
    peakWindows: windows,
    peakMul: Math.min(4, Math.max(1, Number(r.peakMul) || DEFAULTS.peakMul)),
    wakeSpreadMin: int(r.wakeSpreadMin, DEFAULTS.wakeSpreadMin, 0, 600),
    pausedUntil: typeof r.pausedUntil === 'string' ? r.pausedUntil : null,
    // ---- 解耦用：脚本目录与唤醒文案都能改，插件不绑死某个 skill ----
    scriptsBase: typeof r.scriptsBase === 'string' ? r.scriptsBase.trim() : '',
    memoryBase: typeof r.memoryBase === 'string' ? r.memoryBase.trim() : '',
    promptTemplate: typeof r.promptTemplate === 'string' ? r.promptTemplate : '',
  };
}

/** 小时是否落在某个峰时窗口（左闭右开）。 */
export function inPeak(hour, windows = DEFAULTS.peakWindows) {
  return windows.some(([a, b]) => hour >= a && hour < b);
}

/** 是否在睡眠区（跨午夜：hour >= sleepStart 或 hour < awakeStart）。 */
export function inSleep(hour, awakeStart = DEFAULTS.awakeStart, sleepStart = DEFAULTS.sleepStart) {
  if (awakeStart === sleepStart) return false;
  if (awakeStart < sleepStart) return hour >= sleepStart || hour < awakeStart; // 例如 22 醒 6 睡
  return hour >= sleepStart && hour < awakeStart;                             // 例如 3 睡 10 醒
}

const addMin = (d, m) => new Date(d.getTime() + m * 60000);

/**
 * 算下一轮到点时间。
 * @param {object} o
 * @param {Date} o.now
 * @param {string} o.reason 收尾原因：reply | awaiting | no-reply | idle | busy | wake
 * @param {object} o.cfg normalizeConfig 的结果
 * @param {() => number} [o.rand] 0..1 随机源（测试可注入）
 * @returns {{due: Date, minutes: number, peak: boolean, wake: boolean}}
 */
export function nextDue({ now, reason, cfg, rand = Math.random }) {
  const c = cfg || normalizeConfig({});
  let base = reason === 'awaiting' ? c.awaitingMin : c.idleMin;
  const peak = inPeak(now.getHours(), c.peakWindows);
  if (peak) base = base * c.peakMul;

  let due = addMin(now, base);
  let wake = false;

  // 落在睡眠区 → 顺延到起床点 + 随机分布。
  if (inSleep(due.getHours(), c.awakeStart, c.sleepStart)) {
    const spread = Math.floor(rand() * (c.wakeSpreadMin + 1));
    const target = new Date(due);
    target.setHours(c.awakeStart, 0, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    due = addMin(target, spread);
    wake = true;
  }

  const minutes = Math.max(1, Math.round((due.getTime() - now.getTime()) / 60000));
  return { due, minutes, peak, wake };
}

/** 到点判断：now >= due 或只早了 earlyToleranceSec 以内。 */
export function isDue(now, dueISO, toleranceSec = DEFAULTS.earlyToleranceSec) {
  if (!dueISO) return false;
  const due = new Date(dueISO).getTime();
  if (!Number.isFinite(due)) return false;
  return now.getTime() + toleranceSec * 1000 >= due;
}

export function isPaused(now, pausedUntil) {
  if (!pausedUntil) return false;
  const t = new Date(pausedUntil).getTime();
  return Number.isFinite(t) && now.getTime() < t;
}
