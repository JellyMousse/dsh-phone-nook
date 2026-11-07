# dsh-phone-watch · 手机值守

给 DSH 装一条「到点叫我看一眼手机」的节拍。

以前这条链是**一串一次性 at 任务**：每轮自己删旧建新，断了就没了，规则（作息 / 峰谷 / 等回应）只能靠 prompt 里写死的文字。现在规则搬进插件，节拍照样走 DSH 自己的一轮。

## 为什么不靠 dsh-schedule

| | at 任务链 | 这个插件 |
| --- | --- | --- |
| 节拍谁管 | agent 每轮自己 create 一条 | 宿主一张 30 秒的表 |
| 断了怎么办 | 静默死掉，靠兜底任务发现 | 起来就对齐，缺了就补 |
| 规则在哪 | prompt 里的自然语言 | watch-core.mjs 的纯函数，有单测 |
| 可视化 | 无 | DSH 设置 → 「手机值守」 |
| 每次轮休 | 一条 inactive 垃圾 | 只写一份状态文件 |

关键差别：**叫醒走的是 `agent.followup()`**，不是插件自己拼上下文塞死文字。那才是 DSH 自己的一轮 —— 人格、历史、工具、记忆全都在，跟用户打字进去是同一条路。

## 它怎么工作

```
30s tick ──► isDue(now, next_due)? ──否──► 什么都不做
                    │是
                    ▼
             发一轮(reason) ──► agent.followup(一条 user 消息)
                    │            文案=「按 skill phone-watch 跑一轮，收尾写 round」
                    ▼
           next_due = 算下一轮；写状态文件
                    │
   agent 跑完这一轮 ──► report_round.py 写 ~/.dsh/phone-watch-round.json
                    ▼
              next_due 按本轮结果重排（等回应就短间隔）
```

## 排期规则（lib/watch-core.mjs）

- 常态间隔 `idleMin`（默认 20 分钟），刚回过话等回应时用 `awaitingMin`（默认 8 分钟）；连等 4 轮还没回音就自动收回 `idleMin`（计数在 `~/.dsh/phone-watch-awaiting.json`，可用 `report_round.py --wait-max N` 调）
- 峰时窗口 `peakWindows`（默认 9-12、14-18）里间隔 ×`peakMul`（默认 2）—— 人在电脑前消息密，少叫几次省 token
- 落进睡眠区（`sleepStart` 睡着 → `awakeStart` 醒）就顺延到起床点，再加 0~`wakeSpreadMin` 分钟随机散布，免得每天同一秒醒
- 到点判断带 `earlyToleranceSec` 提前容忍（默认 60 秒；表可能被浏览器节流，早一点不算错）
  - **警告**：这个值必须远小于 `awaitingMin`。老版本两者都是 300 秒，导致每轮收尾后立刻又判到点，一分钟连发一次。
- 暂停 `pausedUntil` 期间不叫

全是无副作用的纯函数，`node --test tests/` 覆盖跨午夜、峰时边界、起床散布、容差、脏配置兜底等用例。

## 装

```bash
# 1) 放进任意能装插件的位置，或者直接在一个 profile 的 node_modules 里 link/拷
# 2) 让它进 profile 的 patch（插入一项）
#    profiles/<name>/cordis.patch.yml 里：
#      - insert:
#          - id: phone-watch
#            name: dsh-phone-watch
# 3) 重启 DSH
```

或者交给 `plugin_manager`（需要审批权限）。

装完去 **设置 → 手机值守**：填目标 session id、改作息与间隔、按「保存设置」。倒计时、今天跑了几轮、最近记录都在那一页。

## 配置与状态

都在 `DSH_HOME`（默认 `~/.dsh`）下：

- `phone-watch-config.json`：`enabled`、`targetSession`、`awakeStart`、`sleepStart`、`idleMin`、`awaitingMin`、`earlyToleranceSec`、`peakMul`、`peakWindows`、`wakeSpreadMin`、`pausedUntil`、`scriptsBase`、`memoryBase`、`promptTemplate`
  - `scriptsBase` / `memoryBase`：脚本与记忆目录（默认 `~/.dsh/skills/phone-ops`、`~/.dsh/skills/phone-memory`），换目录不用改代码
  - `promptTemplate`：唤醒文案模板，可用 `{time} {phase} {interval} {next} {scriptsBase} {memoryBase}`
- `phone-watch-state.json`：`next_due`、`dispatched_at`、`awaiting`、`rounds_today`、`log`（最多 30 条）

## 本机接口

| 路由 | 方法 | 干什么 |
| --- | --- | --- |
| `/dsh-phone-watch/state` | GET | 配置 + 状态 + 派生（倒计时、峰谷、暂停、有没有活的 agent） |
| `/dsh-phone-watch/config` | POST | 存规则 |
| `/dsh-phone-watch/action` | POST | `run` / `pause` / `resume` / `clear-awaiting` / `next` |
| `/dsh-phone-watch/round` | POST | 一轮收尾后回报，据此排下一轮 |

四条都过同一道门：有 `connection.requestRejection` 就交给它，没有就看来源，跨站一律 403 —— `run` 会真的叫起一轮（花 token），不能让任意网页拿 `<img src>` 点着玩。

## 验收清单

- [ ] 24 轮内没有漏轮（下一轮时间到了 30 秒内必叫）
- [ ] 空轮不 observe，只读本地探针（一轮 ≤ 400 token）
- [ ] 设置页倒计时与真实 `next_due` 误差 ≤ 60 秒
- [ ] 关掉 DSH 再开，节拍自己接上（不用手动补齐）
- [ ] 睡眠区里到期 → 顺延到起床点，不是半夜把人叫起来

## 已知边界

- `followup` 的消息角色只能是 `user`（DSH 硬限制），developer 角色会抛错并污染会话；来源用 `source.kind = 'phone-watch'` 标记。
- `followup` 的 Promise 必须接住。未处理的 rejection 在 Node 22 会直接带走宿主进程。
- 目标会话必须**活着**（`agents.get` 拿得到）。会话不活时插件记一笔 `no-live-agent` 并顺延，不报错、不静默死。
- 槽位名 `settings.section` 跟 dsh-speak-up / dsh-write 同一个（本机已跑通；换 DSH 版本可能要再看）。

## 测试

```bash
node --test tests/
```

`tests/watch-core.test.mjs` 纯函数用例；`tests/host.test.mjs` 用假 ctx（假的 agents / webServer / interval）跑通装、叫、收尾、暂停、跨站拦截、自定义目录与文案 —— 不连真 DSH 也能验逻辑。全量 22 条，`npm test` 一把过。
