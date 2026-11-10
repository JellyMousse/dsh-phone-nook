// DSH「手机值守」· 网页半边
//
// 在 **DSH 设置** 左侧栏挂一项「手机值守」：作息、间隔、峰时、倒计时、手动动作、最近记录。
// 文案走人话，别像监控面板；逻辑一律在宿主半边（lib/host.js），这里只读 /dsh-phone-watch/*。
window.__ModuleLoader__.load({
  id: 'dsh-phone-watch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']

    const B = '/dsh-phone-watch'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    const h = React.createElement

    const 边 = '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))'
    const 边2 = '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))'
    const 底 = 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.9))'

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px 8px', fontSize: 13, lineHeight: 1.75 },
      hero: { border: 边, borderRadius: 14, padding: '16px 18px', background: 底 },
      heroTop: { display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' },
      big: { fontSize: 30, fontWeight: 700, letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 },
      lead: { fontSize: 13, opacity: 0.78 },
      chips: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 },
      chip: {
        padding: '2px 10px',
        borderRadius: 999,
        border: 边2,
        fontSize: 11.5,
        opacity: 0.9,
        whiteSpace: 'nowrap',
      },
      card: { border: 边, borderRadius: 14, padding: '4px 18px 14px', background: 底 },
      h: { fontSize: 13.5, fontWeight: 600, margin: '14px 0 2px', letterSpacing: '0.01em' },
      sub: { fontSize: 11.5, opacity: 0.55, marginBottom: 10 },
      row: { display: 'flex', gap: 14, alignItems: 'flex-start', padding: '10px 0', borderTop: '1px dashed var(--dsw-alias-border-l1, rgba(0,0,0,.07))', flexWrap: 'wrap' },
      rowFirst: { display: 'flex', gap: 14, alignItems: 'flex-start', padding: '2px 0 10px', flexWrap: 'wrap' },
      lab: { flex: '0 0 132px', minWidth: 132, paddingTop: 4, fontSize: 12.5, fontWeight: 500 },
      ctl: { flex: '1 1 280px', minWidth: 220 },
      hint: { opacity: 0.55, fontSize: 11.5, marginTop: 5, lineHeight: 1.6 },
      input: { border: 边2, borderRadius: 8, padding: '6px 10px', background: 'transparent', color: 'inherit', fontSize: 12.5, width: '100%', boxSizing: 'border-box' },
      small: { border: 边2, borderRadius: 8, padding: '6px 10px', background: 'transparent', color: 'inherit', fontSize: 12.5, width: 74, boxSizing: 'border-box' },
      inline: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      ok: { color: '#1e8e3e', fontSize: 12 },
      bad: { color: '#c0392b', fontSize: 12 },
      dim: { opacity: 0.55, fontSize: 12 },
      logline: { display: 'flex', gap: 10, fontSize: 12, padding: '3px 0' },
      logTime: { opacity: 0.42, fontVariantNumeric: 'tabular-nums', flex: '0 0 58px' },
      empty: { opacity: 0.45, fontSize: 12, padding: '6px 0' },
    }

    function 按钮(文, 点, 主, 忙) {
      return h(
        'button',
        {
          onClick: 忙 ? undefined : 点,
          disabled: Boolean(忙),
          style: {
            border: 主 ? '1px solid transparent' : 边2,
            borderRadius: 8,
            padding: '6px 14px',
            fontSize: 12.5,
            cursor: 忙 ? 'default' : 'pointer',
            opacity: 忙 ? 0.55 : 1,
            background: 主 ? 'var(--dsw-alias-brand-fill, #1a7f37)' : 'transparent',
            color: 主 ? '#fff' : 'inherit',
          },
        },
        文,
      )
    }

    const 分秒 = (秒) => {
      if (秒 === null || 秒 === undefined) return '—'
      const 负 = 秒 < 0
      const 绝对 = Math.abs(秒)
      const 时 = Math.floor(绝对 / 3600)
      const 分 = Math.floor((绝对 % 3600) / 60)
      const 秒数 = 绝对 % 60
      const 文 = 时 > 0 ? 时 + ' 小时 ' + 分 + ' 分' : 分 > 0 ? 分 + ' 分 ' + 秒数 + ' 秒' : 秒数 + ' 秒'
      return 负 ? '迟 ' + 文 : 文
    }

    const 拆名单 = (文) =>
      String(文 || '')
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean)

    const 峰窗文 = (窗) => (窗 || []).map(([a, b]) => a + '-' + b).join(', ')
    const 解峰窗 = (文) =>
      String(文 || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const m = s.split(/[-–~]/).map((x) => Number(String(x).trim()))
          if (m.length !== 2 || !Number.isFinite(m[0]) || !Number.isFinite(m[1])) return null
          return [m[0], m[1]]
        })
        .filter(Boolean)

    function Section() {
      const [态, 设态] = React.useState(null)
      const [草, 设草] = React.useState(null)
      const [忙, 设忙] = React.useState('')
      const [说, 说设] = React.useState('')
      const [错, 设错] = React.useState('')
      const [, 设滴] = React.useState(0)

      const 从配置摘草 = (c) =>
        c
          ? {
              enabled: c.enabled !== false,
              targetSession: c.targetSession || '',
              awakeStart: c.awakeStart,
              sleepStart: c.sleepStart,
              idleMin: c.idleMin,
              awaitingMin: c.awaitingMin,
              peakMul: c.peakMul,
              peakWindows: 峰窗文(c.peakWindows),
              // 回话规矩：数组在界面上是顿号隔开的一行字，存的时候再拆回数组
              policyMode: (c.policy && c.policy.mode) || 'strict',
              policyOwners: ((c.policy && c.policy.ownerNames) || []).join('、'),
              policyMentions: ((c.policy && c.policy.mentionKeywords) || []).join('、'),
              policyGroups: ((c.policy && c.policy.freeTalkGroups) || []).join('、'),
              policyIgnore: ((c.policy && c.policy.ignoreSenders) || []).join('、'),
              policyExtra: (c.policy && c.policy.extra) || '',
            }
          : null

      const 拉 = () => {
        get('/state').then((r) => {
          if (!r || !r.ok) {
            设错('还没读到值守状态，宿主那边可能没挂上。重启一次 DSH 一般就好。')
            return
          }
          设错('')
          设态(r)
          设草((旧) => 旧 || 从配置摘草(r.config))
        })
      }

      React.useEffect(() => {
        拉()
        const t1 = setInterval(拉, 5000)
        const t2 = setInterval(() => 设滴((x) => x + 1), 1000)
        return () => {
          clearInterval(t1)
          clearInterval(t2)
        }
      }, [])

      if (!草) {
        return h('div', { style: S.wrap }, 错 ? h('div', { style: S.bad }, 错) : h('div', { style: S.dim }, '正在读状态…'))
      }

      const 存 = () => {
        设忙('存')
        说设('')
        post('/config', {
          enabled: 草.enabled,
          targetSession: String(草.targetSession || '').trim(),
          awakeStart: Number(草.awakeStart),
          sleepStart: Number(草.sleepStart),
          idleMin: Number(草.idleMin),
          awaitingMin: Number(草.awaitingMin),
          peakMul: Number(草.peakMul),
          peakWindows: 解峰窗(草.peakWindows),
          policy: {
            mode: 草.policyMode,
            ownerNames: 拆名单(草.policyOwners),
            mentionKeywords: 拆名单(草.policyMentions),
            freeTalkGroups: 拆名单(草.policyGroups),
            ignoreSenders: 拆名单(草.policyIgnore),
            extra: String(草.policyExtra || '').trim(),
          },
        }).then((r) => {
          设忙('')
          if (r && r.ok) {
            说设('存好了，新节拍立刻生效。')
            设态((旧) => (旧 ? { ...旧, config: r.config } : 旧))
            拉()
          } else {
            说设('没存上，宿主日志里应该有原因。')
          }
        })
      }

      const 动 = (名, 附加) => {
        设忙(名)
        说设('')
        post('/action', { action: 名, ...(附加 || {}) }).then((r) => {
          设忙('')
          说设(r && r.ok ? '好，已经照做。' : '这一步没成：' + JSON.stringify(r && r.error ? r.error : r))
          拉()
        })
      }

      const 改 = (键) => (e) => 设草({ ...草, [键]: e.target.value })
      const d = 态 ? 态.derived : null
      const st = 态 ? 态.state : null
      const 剩余 = 态 && st && st.next_due ? Math.round((new Date(st.next_due).getTime() - Date.now()) / 1000) : null
      const 睡 = Boolean(d && d.sleep)
      const 峰 = Boolean(d && d.peak)
      const 停 = Boolean(d && d.paused)
      const 在 = Boolean(d && d.live_agent)

      const 一句话 = (() => {
        if (!草.enabled) return '总开关关着，我不吵你。'
        if (停) return '暂时按住了，等你说恢复再动。'
        if (睡) return '这个点我该睡了，醒来再瞄手机。'
        if (剩余 === null) return '还没排上，点一下重排。'
        if (剩余 <= 0) return '该去看一眼了，马上就到。'
        return '再过一会儿，我去瞄一眼手机。'
      })()

      return h(
        'div',
        { style: S.wrap },

        h(
          'div',
          { style: S.hero },
          h('div', { style: S.lead }, 一句话),
          h(
            'div',
            { style: { ...S.heroTop, marginTop: 6 } },
            h('div', { style: S.big }, 剩余 === null ? '—' : 分秒(剩余)),
            h('div', { style: S.chip }, 睡 ? '睡眠区' : 峰 ? '峰时 ×' + 草.peakMul : '谷时'),
            h('div', { style: S.chip }, st && st.rounds_today ? '今天跑了 ' + st.rounds_today + ' 轮' : '今天还没跑'),
          ),
          h(
            'div',
            { style: S.chips },
            h('div', { style: S.chip }, 草.enabled ? '叫得动' : '不叫'),
            h('div', { style: S.chip }, 停 ? '暂停中' : '在跑'),
            h('div', { style: S.chip }, 在 ? '会话找得到' : '会话找不到'),
          ),
          h(
            'div',
            { style: { ...S.hint, marginTop: 10 } },
            '到点我自己给自己发一条消息，正常走一轮：人格、聊天记录、工具都在，跟平时一样。',
          ),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.h }, '什么时候醒着'),
          h('div', { style: S.sub }, '睡着的那几个小时不排期，醒了再开始。'),
          h(
            'div',
            { style: S.rowFirst },
            h('div', { style: S.lab }, '作息'),
            h(
              'div',
              { style: S.ctl },
              h(
                'div',
                { style: S.inline },
                h('input', { style: S.small, type: 'number', min: 0, max: 23, value: 草.awakeStart, onChange: 改('awakeStart') }),
                h('span', { style: S.dim }, '点起'),
                h('span', { style: S.dim }, '·'),
                h('input', { style: S.small, type: 'number', min: 0, max: 23, value: 草.sleepStart, onChange: 改('sleepStart') }),
                h('span', { style: S.dim }, '点睡'),
              ),
              h('div', { style: S.hint }, '起床点会随机飘 0~120 分钟，不至于每天同一秒睁眼。'),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '平时多久看一次'),
            h(
              'div',
              { style: S.ctl },
              h(
                'div',
                { style: S.inline },
                h('input', { style: S.small, type: 'number', min: 1, value: 草.idleMin, onChange: 改('idleMin') }),
                h('span', { style: S.dim }, '分钟一轮'),
              ),
              h('div', { style: S.hint }, '没在等谁回话时的节奏：隔这么多分钟扫一遍微信。调大更省、反应更慢；调小更及时、也更费。'),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '等你回话时'),
            h(
              'div',
              { style: S.ctl },
              h(
                'div',
                { style: S.inline },
                h('input', { style: S.small, type: 'number', min: 1, value: 草.awaitingMin, onChange: 改('awaitingMin') }),
                h('span', { style: S.dim }, '分钟一轮'),
              ),
              h('div', { style: S.hint }, '我刚给你发完消息、你还没回，就按这个更短的间隔多看几眼；连等 4 轮还没回音，自动回到上面「平时」那个节奏，免得没人回也一直短间隔空跑。'),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '忙的时候'),
            h(
              'div',
              { style: S.ctl },
              h(
                'div',
                { style: S.inline },
                h('input', { style: S.small, type: 'number', min: 1, max: 4, step: 0.5, value: 草.peakMul, onChange: 改('peakMul') }),
                h('span', { style: S.dim }, '倍间隔，时段'),
                h('input', { style: { ...S.input, width: 150, display: 'inline-block' }, value: 草.peakWindows, onChange: 改('peakWindows') }),
              ),
              h('div', { style: S.hint }, '写成 9-12,14-18。这些时段把上面两个间隔乘上这个倍数，我少跑几趟，省点饭钱。'),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '总开关'),
            h(
              'div',
              { style: S.ctl },
              h(
                'label',
                { style: { display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: Boolean(草.enabled), onChange: (e) => 设草({ ...草, enabled: e.target.checked }) }),
                h('span', { style: S.dim }, '关掉就彻底安静，手动也不叫'),
              ),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '叫哪个会话'),
            h(
              'div',
              { style: S.ctl },
              h('input', { style: S.input, value: 草.targetSession, onChange: 改('targetSession'), placeholder: 'session-xxxxxxxx-…' }),
              h('div', { style: S.hint }, '留空就等于谁也不叫。从会话列表里复制过来，带不带 session- 前缀都认。'),
            ),
          ),
          h(
            'div',
            { style: { ...S.row, borderTop: 'none', paddingTop: 12 } },
            h('div', { style: S.lab }),
            h(
              'div',
              { style: { ...S.ctl, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              按钮('保存', 存, true, 忙 === '存'),
              按钮('恢复默认', () => {
                设草(
                  从配置摘草({
                    awakeStart: 10,
                    sleepStart: 3,
                    idleMin: 20,
                    awaitingMin: 5,
                    peakMul: 2,
                    peakWindows: [[9, 12], [14, 18]],
                    enabled: true,
                    targetSession: 草.targetSession,
                    policy: { mode: 'strict', ownerNames: [], mentionKeywords: [], freeTalkGroups: [], ignoreSenders: [], extra: '' },
                  }),
                )
                说设('例子填回来了，记得按保存。')
              }, false, 忙),
              说 ? h('span', { style: { ...S.ok } }, 说) : null,
            ),
          ),
        ),

        h(
          'div',
          { style: S.card },
        h(
          'div',
          { style: S.card },
          h('div', { style: S.h }, '回话规矩'),
          h('div', { style: S.sub }, '值守时跟谁说话、能不能主动开口，都在这里定。改完下一轮生效。'),
          h(
            'div',
            { style: { ...S.rowFirst, borderTop: 'none', paddingTop: 2 } },
            h('div', { style: S.lab }, '说话方式'),
            h(
              'div',
              { style: S.ctl },
              h(
                'select',
                { style: { ...S.input, width: 240 }, value: 草.policyMode, onChange: 改('policyMode') },
                h('option', { value: 'strict' }, '严格：只回主人和被点名的'),
                h('option', { value: 'friendly' }, '友好：指定的群可以主动接话'),
                h('option', { value: 'eager' }, '热情：没人叫也会主动聊起话题'),
                h('option', { value: 'quiet' }, '安静：只回主人私聊，群里连点名也不回'),
              ),
              h(
                'div',
                { style: S.hint },
                '「友好」是别人说话时能插一句；「热情」是没人说话也会自己起头——刷到东西、想到事就发；「安静」只在私聊里回。',
              ),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '谁是主人'),
            h(
              'div',
              { style: S.ctl },
              h('input', { style: S.input, value: 草.policyOwners, onChange: 改('policyOwners'), placeholder: '留空就按「给我下指令的那个账号」' }),
              h('div', { style: S.hint }, '多人用顿号或逗号隔开，写对方在微信里的昵称或备注。只有这些人发的话我必回。'),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '怎么算点名我'),
            h(
              'div',
              { style: S.ctl },
              h('input', { style: S.input, value: 草.policyMentions, onChange: 改('policyMentions'), placeholder: '留空就按 @我（@呆呆、@Kuma 都算）' }),
              h('div', { style: S.hint }, '消息里出现这些字就算叫我。填 @呆呆、@Kuma 之类，多个用顿号隔开。'),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '可以主动接话的群'),
            h(
              'div',
              { style: S.ctl },
              h('input', { style: S.input, value: 草.policyGroups, onChange: 改('policyGroups'), placeholder: '群名或人名，用顿号隔开；留空就谁都不主动' }),
              h(
                'div',
                { style: S.hint },
                '「友好」「热情」都用这份名单：列了，就只在这些群里主动开口，别的群仍然只回主人和被点名的；留空时「友好」不主动说话，「热情」则所有群都可能起头——怕吵就务必把群列上。',
              ),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '这些人不接'),
            h(
              'div',
              { style: S.ctl },
              h('input', { style: S.input, value: 草.policyIgnore, onChange: 改('policyIgnore'), placeholder: '想拉黑的群或人，用顿号隔开' }),
              h('div', { style: S.hint }, '名单里的群/人，就算点名叫我也不回，只记下来。'),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '另外的规矩'),
            h(
              'div',
              { style: S.ctl },
              h('textarea', {
                style: { ...S.input, minHeight: 68, resize: 'vertical', lineHeight: 1.7 },
                value: 草.policyExtra,
                onChange: 改('policyExtra'),
                placeholder: '比如：只聊技术，别聊钱；家里人发的都回；群里只接梗不打广告。',
              }),
              h('div', { style: S.hint }, '写人话就行，会原样加进每一轮的提醒里，跟上面几条一起用。'),
            ),
          ),
        ),

          h('div', { style: S.h }, '我手痒的时候'),
          h('div', { style: S.sub }, '平时别点，出问题才用。'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 4 } },
            按钮('现在就去看一眼', () => 动('run'), false, 忙),
            按钮('安静两小时', () => 动('pause', { minutes: 120 }), false, 忙),
            按钮('恢复', () => 动('resume'), false, 忙),
            按钮('重新排一下', () => 动('next'), false, 忙),
          ),
          h('div', { style: S.hint }, '「现在就去看一眼」会真的跑一轮，花 token；「重新排一下」只重算节拍，不跑。'),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.h }, '最近几轮'),
          st && st.log && st.log.length > 0
            ? h(
                'div',
                { style: { paddingTop: 2 } },
                st.log.map((条, i) =>
                  h(
                    'div',
                    { key: i, style: S.logline },
                    h('div', { style: S.logTime }, String(条.at || '').slice(11, 16)),
                    h('div', null, 条.text),
                  ),
                ),
              )
            : h('div', { style: S.empty }, '还是空的，等第一轮跑完就有记录。'),
        ),

        错 ? h('div', { style: { ...S.bad, paddingLeft: 2 } }, 错) : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'phone-watch', order: 54, label: () => '手机值守' }, Section),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
