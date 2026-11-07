// DSH「手机值守」· 宿主半边
//
// 干一件事：**到点把 agent 叫起来跑一轮手机值守**，规则（作息 / 峰谷 / 等回应 / 起床轮）
// 全在 lib/watch-core.mjs 里算，不再往 dsh-schedule 的任务表里塞一次性 at 任务。
//
// ⚠ 叫醒必须走 agent.followup()：那才是 DSH 自己的回合（人格、历史、工具全都自带）。
//   和用户打字进去走的是同一条路；插件自己拼上下文再塞死文字是假唤醒。
// ⚠ followup 的 Promise 必须接住：未处理的 rejection 在 Node 22+ 会直接带走宿主进程。
// ⚠ 送的消息只能是 user 角色（DSH 硬限制），所以带 source.kind = 'phone-watch' 做标记。
//
// 状态文件（DSH_HOME 下）：
//   phone-watch-config.json  规则与目标会话
//   phone-watch-state.json   下一轮到点时间、最近一轮记录

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeConfig, nextDue, isDue, isPaused, inPeak, inSleep, policyRules } from './watch-core.mjs'

export const name = 'phone-watch'
export const inject = ['agents', 'sessions', 'webServer', 'timer']


// ---- 自检：模块加载与 apply 失败都落一行，方便定位「宿主半边没挂上」 ----
import { appendFileSync as __记录 } from 'node:fs'
const __自检 = (line) => {
  try {
    __记录(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'phone-watch-boot.log'), new Date().toISOString() + ' ' + line + '\n')
  } catch {
    /* 连日志都写不了就算了 */
  }
}
__自检('module loaded pid=' + process.pid)

const 目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置文件 = join(目录, 'phone-watch-config.json')
const 状态文件 = join(目录, 'phone-watch-state.json')
const 收件文件 = join(目录, 'phone-watch-round.json')
const 路由 = '/dsh-phone-watch'
const 源标记 = 'phone-watch'
const 补轮宽限秒 = 300

// ---------- 读写 ----------

function 读json(路, 兜) {
  try {
    return JSON.parse(readFileSync(路, 'utf8'))
  } catch {
    return 兜
  }
}

function 写json(路, 值) {
  try {
    mkdirSync(目录, { recursive: true })
    const 临时 = 路 + '.' + randomUUID() + '.tmp'
    writeFileSync(临时, JSON.stringify(值, null, 2), 'utf8')
    renameSync(临时, 路)
    return true
  } catch (error) {
    return false
  }
}

const 今天 = (d = new Date()) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

const 时间文 = (d) =>
  String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0')

const 空状态 = () => ({
  next_due: null,
  dispatched_at: null,
  last_reason: null,
  last_round_at: null,
  last_note: null,
  awaiting: false,
  rounds_today: 0,
  day: 今天(),
  log: [],
})

function 读状态() {
  const 原 = 读json(状态文件, null)
  if (!原 || typeof 原 !== 'object') return 空状态()
  const 合 = Object.assign(空状态(), 原)
  if (合.day !== 今天()) {
    合.day = 今天()
    合.rounds_today = 0
  }
  if (!Array.isArray(合.log)) 合.log = []
  return 合
}

function 记日志(st, 行) {
  st.log.unshift({ at: new Date().toISOString(), text: 行 })
  st.log = st.log.slice(0, 30)
}

// ---------- 插件本体 ----------

export function apply(ctx) {
  try {
    __真实(ctx)
  } catch (error) {
    __自检('apply threw: ' + String((error && error.stack) || error))
  }
}

function __真实(ctx) {
  const 日志 = (行) => {
    try {
      ctx.logger.info('phone-watch: ' + 行)
    } catch {
      /* logger 不在就算了 */
    }
  }

  const 读配置 = () => normalizeConfig(读json(配置文件, {}))
  const 存配置 = (补丁) => {
    const 新 = normalizeConfig({ ...读json(配置文件, {}), ...(补丁 || {}) })
    写json(配置文件, 新)
    return 新
  }

  let 停表 = null

  /** 目标会话的活 agent，id 带不带 session- 前缀两种都试。 */
  function 找agent(配置) {
    const id = String(配置.targetSession || '').trim()
    if (id === '') return undefined
    const 候选 = [id]
    if (id.startsWith('session-')) 候选.push(id.slice('session-'.length))
    else 候选.push('session-' + id)
    for (const 一个 of 候选) {
      try {
        const a = ctx.agents.get(一个)
        if (a !== undefined) return a
      } catch {
        /* 查不动就当没找到 */
      }
    }
    return undefined
  }

  function 唤醒文案(配置, 算出, 现在, 状态) {
    const 段 = inSleep(现在.getHours(), 配置.awakeStart, 配置.sleepStart)
      ? '睡眠区'
      : inPeak(现在.getHours(), 配置.peakWindows)
        ? '峰时'
        : '谷时'
    const 行 = [
      // ⚠ 角色只能是 user，模型会把它读成「对方说的话」；第一行必须点明这是插件提醒，不是主人发的
      '（值守插件定时提醒，不是主人消息；照跑一轮，别回应这句。）',
      '【手机值守】' + 时间文(现在) + '（' + 段 + '，间隔 ' + 算出.minutes + ' 分，下一轮 ' + 时间文(算出.due) + '）',
      '1) 探针 python __DSH__/skills/phone-caretaker/watch_probe.py，unread:0 直接收尾。',
      '2) unread>0 才 observe；回话按下面这份规矩（设置页可改）：',
      ...policyRules(配置.policy).map((一条) => '   · ' + 一条),
      '3) 退到会话列表，顺手报一轮：python __DSH__/skills/phone-caretaker/report_round.py reply（没聊就 idle）。',
    ]
    const 上次 = 状态 && 状态.last_reason
    const 刚聊过 = 上次 === 'reply' || 上次 === 'no-reply'
    if (现在.getHours() === 2) {
      行.push('4) 睡前：python __DSH__/skills/phone-memory/phone_memory.py digest')
    } else if (刚聊过) {
      行.push('4) 刚聊过就记档案：python __DSH__/skills/phone-memory/phone_memory.py touch 会话名 "聊了啥" --topic 话题')
    }
    if (!刚聊过 || 现在.getHours() === 2) {
      行.push('5) 没在聊就别动记忆；别建 dsh-schedule at 任务，节拍归插件。')
    }
    return 行.join('\n')
  }

  function 发一轮(原因) {
    const 配置 = 读配置()
    const st = 读状态()
    const 现在 = new Date()

    if (!配置.enabled) {
      记日志(st, '跳过：总开关关着')
      写json(状态文件, st)
      return { ok: false, why: 'disabled' }
    }
    if (isPaused(现在, 配置.pausedUntil)) {
      记日志(st, '跳过：暂停中到 ' + 配置.pausedUntil)
      写json(状态文件, st)
      return { ok: false, why: 'paused' }
    }

    const 算出 = nextDue({ now: 现在, reason: 原因 || 'idle', cfg: 配置 })
    const agent = 找agent(配置)
    if (!agent) {
      st.next_due = 算出.due.toISOString()
      记日志(st, '跳过：目标会话没有活着的 agent（' + (配置.targetSession || '未设置') + '），下一轮 ' + 时间文(算出.due))
      写json(状态文件, st)
      return { ok: false, why: 'no-live-agent', next_due: st.next_due }
    }

    const 文案 = 唤醒文案(配置, 算出, 现在, st)
    st.next_due = 算出.due.toISOString()
    st.dispatched_at = 现在.toISOString()
    记日志(st, '唤醒：' + 时间文(现在) + '，下一轮 ' + 时间文(算出.due) + (算出.wake ? '（起床轮）' : ''))
    写json(状态文件, st)

    // ⚠ 必须接住 rejection，否则一只坏会话就能带走整个宿主
    Promise.resolve()
      .then(() => agent.followup({ id: 'pw-' + randomUUID(), role: 'user', content: [{ type: 'text', text: 文案 }], source: { kind: 源标记 } }))
      .then(() => {
        try {
          if (ctx.sessions && typeof ctx.sessions.flush === 'function') return ctx.sessions.flush(agent.session)
        } catch {
          /* 落盘失败不影响这一轮 */
        }
      })
      .catch((error) => 日志('followup 失败：' + String((error && error.message) || error)))

    return { ok: true, next_due: st.next_due, wake: 算出.wake, minutes: 算出.minutes }
  }

  /** 插件起来时对齐一次：没有下一轮就排上，超时太久就补一轮。 */
  function 对齐() {
    const st = 读状态()
    const 配置 = 读配置()
    const 现在 = new Date()
    if (!st.next_due) {
      const 算出 = nextDue({ now: 现在, reason: 'idle', cfg: 配置 })
      st.next_due = 算出.due.toISOString()
      写json(状态文件, st)
      日志('已排上第一轮：' + 时间文(算出.due))
    }
  }

  function tick() {
    try {
      const st = 读状态()
      const 配置 = 读配置()
      const 现在 = new Date()
      // agent 报轮走写文件：宿主 HTTP 门要浏览器凭证，curl 拿不到 token（401）
      try {
        const 报 = 读json(收件文件, null)
        if (报 && typeof 报 === 'object') {
          try { rmSync(收件文件) } catch { /* 删不掉就算了，靠时刻去重 */ }
          const 上次 = st.last_round_at ? new Date(st.last_round_at).getTime() : 0
          const 时刻 = 报.at ? new Date(报.at).getTime() : 0
          if (Number.isFinite(时刻) && 时刻 > 上次) 结算轮报(报)
        }
      } catch { /* 收件目录读不动不影响正常节拍 */ }
      if (!st.next_due) {
        对齐()
        return
      }
      if (!isDue(现在, st.next_due)) return
      // 补轮宽限：错过超过很久（比如睡了一夜）也跑到点那一轮
      const 迟到分 = Math.round((现在.getTime() - new Date(st.next_due).getTime()) / 60000)
      if (迟到分 > 补轮宽限秒 / 60) {
        日志('到点了（迟到 ' + 迟到分 + ' 分钟），照常跑')
      }
      发一轮(配置.awaitingRun ? 'awaiting' : 'reply')
    } catch (error) {
      日志('tick 出错（已忽略）：' + String((error && error.message) || error))
    }
  }

  // ---------- 路由 ----------

  const 快照 = () => {
    const 配置 = 读配置()
    const st = 读状态()
    const 现在 = new Date()
    const 剩余 = st.next_due ? Math.round((new Date(st.next_due).getTime() - 现在.getTime()) / 1000) : null
    return {
      ok: true,
      now: 现在.toISOString(),
      config: 配置,
      state: { ...st, log: st.log.slice(0, 12) },
      derived: {
        seconds_left: 剩余,
        peak: inPeak(现在.getHours(), 配置.peakWindows),
        sleep: inSleep(现在.getHours(), 配置.awakeStart, 配置.sleepStart),
        paused: isPaused(现在, 配置.pausedUntil),
        live_agent: Boolean(找agent(配置)),
      },
    }
  }

  const 读体 = async (req) => {
    const 块 = []
    for await (const c of req) 块.push(c)
    const 文 = Buffer.concat(块).toString('utf8')
    if (!文) return {}
    try {
      return JSON.parse(文)
    } catch {
      return {}
    }
  }

  const 回 = (res, 值, 码 = 200) => {
    const 文 = JSON.stringify(值)
    res.writeHead(码, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(文)
  }

  // 本机接口的门：-run 这条会真的叫起一轮（花 token），不能让任意网页拿 <img src> 点着玩
  const 本机来源 = /^(?:dsh-app:|https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$)/i
  const 拦住 = (req, res) => {
    let 拒
    try {
      const 连接 = ctx.get && ctx.get('connection')
      拒 = 连接 && typeof 连接.requestRejection === 'function' ? 连接.requestRejection(req) : undefined
    } catch {
      拒 = undefined
    }
    if (拒 !== undefined) {
      res.writeHead(拒 || 403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(拒 === 401 ? 'unauthorized' : 'forbidden')
      return true
    }
    const 头 = req.headers || {}
    const 站 = String(头['sec-fetch-site'] || '').toLowerCase()
    const 源 = String(头.origin || '').trim()
    if (站 === 'cross-site' || (源 && !本机来源.test(源))) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return true
    }
    return false
  }

  const 路线 = (路径, 方法, handler) =>
    ctx.effect(() => {
      try {
        return ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          try {
            if (拦住(req, res)) return
            if (方法 && req.method !== 方法) {
              res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 方法 })
              res.end(JSON.stringify({ ok: false, error: 方法 + ' only' }))
              return
            }
            await handler(req, res)
          } catch (error) {
            回(res, { ok: false, error: String((error && error.message) || error) }, 500)
          }
        },
      })
      } catch (error) {
        // 一条路由挂了别把其余三条一起带走
        __自检('route failed ' + 路径 + ': ' + String((error && error.message) || error))
        return () => {}
      }
    })

  // 设置页 / 外部脚本用：读状态（含倒计时、峰谷、有没有活的 agent）
  路线(路由 + '/state', 'GET', (req, res) => {
    回(res, 快照())
  })

  // 设置页保存规则
  路线(路由 + '/config', 'POST', async (req, res) => {
    const 体 = await 读体(req)
    const 新 = 存配置(体)
    日志('设置已更新：间隔 ' + 新.idleMin + '/' + 新.awaitingMin + ' 分钟，峰时 ×' + 新.peakMul)
    回(res, { ok: true, config: 新 })
  })

  // 手动：run / pause / resume / clear-awaiting / next
  路线(路由 + '/action', 'POST', async (req, res) => {
    const 体 = await 读体(req)
    const 动作 = String(体.action || '')
    if (动作 === 'run') return 回(res, { ok: true, result: 发一轮('idle') })
    if (动作 === 'pause') {
      const 分钟 = Number(体.minutes) > 0 ? Number(体.minutes) : 120
      const 到 = new Date(Date.now() + 分钟 * 60000).toISOString()
      存配置({ pausedUntil: 到 })
      return 回(res, { ok: true, pausedUntil: 到 })
    }
    if (动作 === 'resume') {
      存配置({ pausedUntil: null })
      return 回(res, { ok: true })
    }
    if (动作 === 'clear-awaiting') {
      const st = 读状态()
      st.awaiting = false
      写json(状态文件, st)
      return 回(res, { ok: true })
    }
    if (动作 === 'next') {
      const st = 读状态()
      const 算出 = nextDue({ now: new Date(), reason: 'idle', cfg: 读配置() })
      st.next_due = 算出.due.toISOString()
      写json(状态文件, st)
      return 回(res, { ok: true, next_due: st.next_due })
    }
    return 回(res, { ok: false, error: 'unknown action' }, 400)
  })

  /** 一轮跑完的结算：HTTP 路由和本地收件文件走同一套。 */
  function 结算轮报(体) {
    const 原因 = typeof 体.reason === 'string' && 体.reason ? 体.reason : 'idle'
    const 配置 = 读配置()
    const st = 读状态()
    const 现在 = new Date()
    // 等回应时用短间隔 —— 这是 awaiting 这个原因存在的唯一意义
    const 排期原因 = 体.awaiting === true ? 'awaiting' : 原因
    const 算出 = nextDue({ now: 现在, reason: 排期原因, cfg: 配置 })
    st.next_due = 算出.due.toISOString()
    st.last_reason = 原因
    st.last_round_at = 现在.toISOString()
    st.last_note = typeof 体.note === 'string' ? 体.note.slice(0, 200) : null
    st.awaiting = 体.awaiting === true
    st.rounds_today = (st.rounds_today || 0) + 1
    记日志(st, '收尾 ' + 原因 + '：下一轮 ' + 时间文(算出.due) + (算出.wake ? '（起床轮）' : ''))
    写json(状态文件, st)
    return { ok: true, next_due: st.next_due, minutes: 算出.minutes, peak: 算出.peak, wake: 算出.wake }
  }

  // 一轮跑完由 agent 回报，插件据此排下一轮（链在这里续，不靠 agent 建 at 任务）
  路线(路由 + '/round', 'POST', async (req, res) => {
    const 体 = await 读体(req)
    回(res, 结算轮报(体))
  })


  // ---------- 表 ----------

  ctx.effect(() => {
    对齐()
    if (typeof ctx.interval !== 'function') {
      __自检('no ctx.interval, timer 服务没进来')
      return () => {}
    }
    停表 = ctx.interval(tick, 30 * 1000)
    return () => {
      if (停表) 停表()
      停表 = null
    }
  })

  __自检('apply done, routes ready')
  日志('已装好 v0.1.0，状态文件 ' + 状态文件)
}