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
  earlyToleranceSec: 300,
};

// ── 回话策略 ────────────────────────────────────────────────────────────────
// 值守怎么跟人打交道，不写死在提示词里：租户（部署者）在设置页按自己的社交规矩改。
//   strict   只回主人 + 被点名（默认，最保守）
//   friendly 额外允许在指定群/人里主动接话
//   quiet    只回主人私聊，群里连点名也不回
export const POLICY_MODES = ['strict', 'friendly', 'quiet'];

export const POLICY_DEFAULTS = {
  mode: 'strict',
  ownerNames: [],
  mentionKeywords: [],
  freeTalkGroups: [],
  ignoreSenders: [],
  extra: '',
};

const 名单 = (v, 上限 = 20) =>
  Array.isArray(v)
    ? v
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 上限)
    : [];

export function normalizePolicy(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: POLICY_MODES.includes(r.mode) ? r.mode : POLICY_DEFAULTS.mode,
    ownerNames: 名单(r.ownerNames),
    mentionKeywords: 名单(r.mentionKeywords),
    freeTalkGroups: 名单(r.freeTalkGroups),
    ignoreSenders: 名单(r.ignoreSenders),
    extra: typeof r.extra === 'string' ? r.extra.trim().slice(0, 500) : '',
  };
}

/**
 * 把策略翻成人话，每轮拼进唤醒提示词。返回若干行，宿主侧原样注入。
 * @param {object} raw 配置里的 policy（未归一化也行）
 * @returns {string[]}
 */
export function policyRules(raw) {
  const p = normalizePolicy(raw);
  const 主人 = p.ownerNames.length ? p.ownerNames.join('、') : '主人（给我下指令的那个账号）';
  const 点名 = p.mentionKeywords.length ? p.mentionKeywords.join('、') : '@我';
  const 行 = [];

  if (p.mode === 'quiet') {
    行.push('谁都不主动开口：只回' + 主人 + '的私聊；群里连' + 点名 + '也不回，看到先记下来。');
  } else if (p.mode === 'friendly') {
    行.push('回' + 主人 + '的消息，以及消息里带' + 点名 + '的。');
    行.push(
      p.freeTalkGroups.length
        ? '这些群或人可以主动接话，不必等人点名：' + p.freeTalkGroups.join('、') + '。'
        : '没列可以主动接话的群，就只按上一条。',
    );
  } else {
    行.push('只回' + 主人 + '的消息，以及消息里带' + 点名 + '的；其余只记录、不接话。');
  }

  if (p.ignoreSenders.length) 行.push('这些人一律不接：' + p.ignoreSenders.join('、') + '。');
  if (p.extra) 行.push(p.extra);
  return 行;
}

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
    policy: normalizePolicy(r.policy),
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