import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// host.js 在模块加载时就读 DSH_HOME，必须先设环境再动态 import
const 家 = mkdtempSync(join(tmpdir(), 'pw-'))
process.env.DSH_HOME = 家
const { apply } = await import('../lib/host.js')

function 搭架() {
  const 路由表 = new Map()
  const 表 = []
  const 记录 = []
  const 唤醒 = []
  const 架子 = {
    agents: {
      get(id) {
        if (id !== 'session-abc' && id !== 'abc') return undefined
        return {
          session: { id: 'session-abc' },
          followup(msg) {
            唤醒.push(msg)
            return Promise.resolve()
          },
        }
      },
    },
    sessions: { flush: () => Promise.resolve() },
    webServer: {
      register(项) {
        路由表.set(项.path, 项)
        return () => 路由表.delete(项.path)
      },
    },
    interval(cb) {
      表.push(cb)
      return () => {}
    },
    effect(fn) {
      const 清 = fn()
      return typeof 清 === 'function' ? 清 : () => {}
    },
    get() {
      return undefined
    },
    logger: { info: (m) => 记录.push(m) },
  }
  return { 架子, 路由表, 表, 记录, 唤醒 }
}

const 请求 = (方法, 体) => {
  const 文 = JSON.stringify(体 || {})
  return {
    method: 方法,
    headers: { 'sec-fetch-site': 'same-origin' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(文, 'utf8')
    },
  }
}

const 响应 = () => ({
  码: 200,
  头: null,
  体: '',
  writeHead(码, 头) {
    this.码 = 码
    this.头 = 头
  },
  end(文) {
    this.体 = 文
  },
  json() {
    return JSON.parse(this.体)
  },
})

test('装起来：四条路由都在，状态文件落盘', () => {
  const { 架子, 路由表, 表 } = 搭架()
  apply(架子)
  for (const 一 of ['/state', '/config', '/action', '/round']) {
    assert.ok(路由表.has('/dsh-phone-watch' + 一), '缺路由 ' + 一)
  }
  assert.equal(表.length, 1, '应该只挂一张 30 秒的表')
  assert.ok(existsSync(join(家, 'phone-watch-state.json')), '起来后要对齐并写状态')
})

test('到点就唤醒：followup 拿到一条 user 消息，带来源标记', async () => {
  const { 架子, 表, 唤醒 } = 搭架()
  writeFileSync(join(家, 'phone-watch-config.json'), JSON.stringify({ enabled: true, targetSession: 'session-abc', idleMin: 1 }))
  const 状态路 = join(家, 'phone-watch-state.json')
  const 态 = JSON.parse(readFileSync(状态路, 'utf8'))
  态.next_due = new Date(Date.now() - 60000).toISOString()
  writeFileSync(状态路, JSON.stringify(态))

  // 装好之后把 next_due 拨到过去，手动打一拍表（不用等 30 秒）
  apply(架子)
  const 态2 = JSON.parse(readFileSync(状态路, 'utf8'))
  态2.next_due = new Date(Date.now() - 60000).toISOString()
  writeFileSync(状态路, JSON.stringify(态2))
  表[0]()
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(唤醒.length, 1, '应该叫起一轮')
  const 消息 = 唤醒[0]
  assert.equal(消息.role, 'user')
  assert.equal(消息.source.kind, 'phone-watch')
  assert.match(消息.content[0].text, /【手机值守】/)
  assert.match(消息.content[0].text, /watch_probe\.py/)
  assert.match(消息.content[0].text, /report_round\.py/)
  // 上一轮没聊过，就不带记忆那一步（省 token 的条件注入）
  assert.doesNotMatch(消息.content[0].text, /phone_memory\.py touch/)
  // 叫过之后立刻排下一轮，不会连击
  const 后 = JSON.parse(readFileSync(状态路, 'utf8'))
  assert.ok(new Date(后.next_due).getTime() > Date.now())
})

test('/round 收尾：写回原因、等回应标记、下一轮时间', async () => {
  const { 架子, 路由表 } = 搭架()
  apply(架子)
  writeFileSync(join(家, 'phone-watch-config.json'), JSON.stringify({ enabled: true, targetSession: 'session-abc', idleMin: 20, awaitingMin: 5 }))
  const 应 = 响应()
  await 路由表.get('/dsh-phone-watch/round').handler(
    请求('POST', { reason: 'no-reply', awaiting: true, note: '没啥新消息' }),
    应,
  )
  const 果 = 应.json()
  assert.equal(果.ok, true)
  // 跑测试的当下可能落在峰时窗口里，按倍率放宽
  assert.equal(果.minutes, 果.peak ? 10 : 5)
  const 态 = JSON.parse(readFileSync(join(家, 'phone-watch-state.json'), 'utf8'))
  assert.equal(态.awaiting, true)
  assert.equal(态.last_reason, 'no-reply')
  assert.equal(态.last_note, '没啥新消息')
  assert.equal(态.rounds_today, 1)
})

test('上一轮真聊过，唤醒文案才带记忆一步', async () => {
  const { 架子, 路由表, 表, 唤醒 } = 搭架()
  apply(架子)
  writeFileSync(join(家, 'phone-watch-config.json'), JSON.stringify({ enabled: true, targetSession: 'session-abc', idleMin: 1 }))
  const 应 = 响应()
  await 路由表.get('/dsh-phone-watch/round').handler(请求('POST', { reason: 'reply' }), 应)
  const 状态路 = join(家, 'phone-watch-state.json')
  const 态 = JSON.parse(readFileSync(状态路, 'utf8'))
  态.next_due = new Date(Date.now() - 60000).toISOString()
  writeFileSync(状态路, JSON.stringify(态))
  表[0]()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(唤醒.length, 1)
  // 凌晨 2 点那一轮固定推睡前 digest，其余时段才推 touch；测试别跟真实时钟打架
  const 该有 = new Date().getHours() === 2 ? /phone_memory\.py digest/ : /phone_memory\.py touch/
  assert.match(唤醒[0].content[0].text, 该有)
})

test('agent 写收件文件报轮，tick 会收走并重排', async () => {
  const { 架子, 表 } = 搭架()
  apply(架子)
  writeFileSync(join(家, 'phone-watch-config.json'), JSON.stringify({ enabled: true, targetSession: 'session-abc', idleMin: 20, awaitingMin: 5 }))
  const 状态路 = join(家, 'phone-watch-state.json')
  const 态 = JSON.parse(readFileSync(状态路, 'utf8'))
  态.next_due = new Date(Date.now() + 3600000).toISOString()
  writeFileSync(状态路, JSON.stringify(态))
  writeFileSync(join(家, 'phone-watch-round.json'), JSON.stringify({
    reason: 'no-reply', awaiting: true, note: '收件箱', at: new Date(Date.now() + 1000).toISOString(),
  }))
  表[0]()
  await new Promise((r) => setTimeout(r, 50))
  const 后 = JSON.parse(readFileSync(状态路, 'utf8'))
  assert.equal(后.last_reason, 'no-reply')
  assert.equal(后.last_note, '收件箱')
  assert.equal(existsSync(join(家, 'phone-watch-round.json')), false, '收走要删文件')
})

test('总开关关着就不叫', async () => {
  const { 架子, 路由表, 唤醒 } = 搭架()
  apply(架子)
  writeFileSync(join(家, 'phone-watch-config.json'), JSON.stringify({ enabled: false, targetSession: 'session-abc' }))
  const 应 = 响应()
  await 路由表.get('/dsh-phone-watch/action').handler(请求('POST', { action: 'run' }), 应)
  const 果 = 应.json()
  assert.equal(果.result.ok, false)
  assert.equal(果.result.why, 'disabled')
  assert.equal(唤醒.length, 0)
})

test('目标会话找不到：不炸、记一笔、顺延', async () => {
  const { 架子, 路由表 } = 搭架()
  apply(架子)
  writeFileSync(join(家, 'phone-watch-config.json'), JSON.stringify({ enabled: true, targetSession: 'session-不存在' }))
  const 应 = 响应()
  await 路由表.get('/dsh-phone-watch/action').handler(请求('POST', { action: 'run' }), 应)
  const 果 = 应.json()
  assert.equal(果.result.ok, false)
  assert.equal(果.result.why, 'no-live-agent')
  assert.ok(果.result.next_due)
})

test('跨站来源的请求挡掉', async () => {
  const { 架子, 路由表, 唤醒 } = 搭架()
  apply(架子)
  writeFileSync(join(家, 'phone-watch-config.json'), JSON.stringify({ enabled: true, targetSession: 'session-abc' }))
  const 应 = 响应()
  const 坏 = 请求('POST', { action: 'run' })
  坏.headers.origin = 'https://evil.example'
  await 路由表.get('/dsh-phone-watch/action').handler(坏, 应)
  assert.equal(应.码, 403)
  assert.equal(唤醒.length, 0)
})

test('pause / resume 生效', async () => {
  const { 架子, 路由表 } = 搭架()
  apply(架子)
  writeFileSync(join(家, 'phone-watch-config.json'), JSON.stringify({ enabled: true, targetSession: 'session-abc' }))
  const 应 = 响应()
  await 路由表.get('/dsh-phone-watch/action').handler(请求('POST', { action: 'pause', minutes: 30 }), 应)
  assert.equal(应.json().ok, true)
  const 二 = 响应()
  await 路由表.get('/dsh-phone-watch/action').handler(请求('POST', { action: 'run' }), 二)
  assert.equal(二.json().result.why, 'paused')
  const 三 = 响应()
  await 路由表.get('/dsh-phone-watch/action').handler(请求('POST', { action: 'resume' }), 三)
  const 四 = 响应()
  await 路由表.get('/dsh-phone-watch/action').handler(请求('POST', { action: 'run' }), 四)
  assert.equal(四.json().result.ok, true)
})

test('回话规矩按配置注入每一轮的提醒', async () => {
  const { 架子, 表, 唤醒 } = 搭架()
  apply(架子)
  writeFileSync(
    join(家, 'phone-watch-config.json'),
    JSON.stringify({
      enabled: true,
      targetSession: 'session-abc',
      idleMin: 1,
      policy: { mode: 'friendly', ownerNames: ['主人'], mentionKeywords: ['@呆呆'], freeTalkGroups: ['恁好群'], extra: '只聊技术，别聊钱' },
    }),
  )
  const 状态路 = join(家, 'phone-watch-state.json')
  const 态 = JSON.parse(readFileSync(状态路, 'utf8'))
  态.next_due = new Date(Date.now() - 60000).toISOString()
  writeFileSync(状态路, JSON.stringify(态))
  表[0]()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(唤醒.length, 1)
  const 文 = 唤醒[0].content[0].text
  assert.match(文, /回话按下面这份规矩/)
  assert.match(文, /恁好群/)
  assert.match(文, /只聊技术，别聊钱/)
  assert.match(文, /主人/)
  // 写死的旧红线不该再出现
  assert.doesNotMatch(文, /群里只回 @ 我或主人的/)
})

test('设置页存的 policy 能落盘并回读', async () => {
  const { 架子, 路由表 } = 搭架()
  apply(架子)
  const 应 = 响应()
  await 路由表.get('/dsh-phone-watch/config').handler(
    请求('POST', { policy: { mode: 'quiet', ownerNames: ['主人'], ignoreSenders: ['广告号'] } }),
    应,
  )
  const 果 = 应.json()
  assert.equal(果.ok, true)
  assert.equal(果.config.policy.mode, 'quiet')
  assert.deepEqual(果.config.policy.ownerNames, ['主人'])
  assert.deepEqual(果.config.policy.ignoreSenders, ['广告号'])
  const 盘 = JSON.parse(readFileSync(join(家, 'phone-watch-config.json'), 'utf8'))
  assert.equal(盘.policy.mode, 'quiet')
})
