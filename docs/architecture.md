# 架构

三层，各自可以单独替换。

```
┌──────────────────────────────────────────────────────────┐
│ 节律层  plugin/dsh-phone-watch                            │
│   timer tick ─► nextDue() ─► agent.followup() ─► 设置页 UI │
└───────────────┬──────────────────────────────────────────┘
                │ 唤醒（就是一条普通 user 消息）
┌───────────────▼──────────────────────────────────────────┐
│ 决策层  agent（你的模型 + skills）                        │
│   skills/phone-watch  一轮清单                            │
│   skills/phone-ops    操作手册与红线                       │
│   skills/phone-memory 会话档案                            │
└───────┬───────────────────────────────┬──────────────────┘
        │ 便宜的先做                     │ 贵的才做
┌───────▼─────────────┐        ┌────────▼─────────────────┐
│ 本地脚本 tools/      │        │ MCP 工具                  │
│  watch_probe.py      │        │  phone_observe / action   │
│  report_round.py     │        │  opai: describe / draw    │
└───────┬─────────────┘        └────────┬─────────────────┘
        └───────────┬───────────────────┘
                ┌───▼────┐
                │  adb   │  ─► 安卓手机（真实设备）
                └────────┘
```

## 为什么这样切

**节律不该塞进 agent 的上下文。** 用 `dsh-schedule` 建 at 任务也能做到「定时提醒」，
但任务表会越滚越多，且每次唤醒都要重算下一次该几点。插件把时间算术放在 `watch-core.mjs`
（纯函数、有单测），agent 只负责「这一轮怎么干」。

**唤醒必须走 `agent.followup()`。** 那是 DSH 自己的回合：人格、历史、工具全都在。
插件自己拼一段上下文塞给模型是假唤醒，agent 会不带记忆地乱回。

**探针必须便宜。** `phone_observe` 返回的 OCR JSON 动辄两千 token。大部分轮次没有新消息，
所以先用 `watch_probe.py` 在本地解锁、截图、数角标，输出一行 JSON 就走完收尾。

## 一轮的时序

1. 插件 tick（30 秒一次）判断 `isDue`
2. 到点 → 按当前时间算下一轮，写 `phone-watch-state.json`，`followup` 一条提醒
3. agent 读 `skills/phone-watch`，跑探针
4. 没有未读 → `report_round.py idle`，退出
5. 有未读 → `phone_observe` 读内容，处理，`report_round.py reply --awaiting`
6. 插件下一拍读到 `phone-watch-round.json`，按 `reason` 重排下一轮，删掉收件文件

## 状态文件

| 文件（都在 `$DSH_HOME`） | 谁写 | 内容 |
|---|---|---|
| `phone-watch-config.json` | 设置页 / 手改 | 作息、间隔、目标会话、解耦用的路径与文案 |
| `phone-watch-state.json` | 插件 | 下一轮到点、今日轮数、最近 30 条日志 |
| `phone-watch-round.json` | agent 脚本 | 一轮的结果（reason / awaiting / note / at），插件收走后删除 |
| `phone-watch-boot.log` | 插件 | 自检：模块是否加载、apply 是否抛错 |

## 排期规则（watch-core.mjs）

- 常态 `idleMin`（默认 20 分），等回应 `awaitingMin`（默认 5 分）
- 峰时（默认 09–12、14–18）整体 ×`peakMul`
- 下一轮落进睡眠区 → 顺延到 `awakeStart` + 随机 `wakeSpreadMin`，标 `wake: true`（起床轮）
- 掐点容差 `earlyToleranceSec`（默认 60 秒）**必须远小于最短间隔**，
  否则「等回应 5 分钟」那一轮会被下一拍立刻判成到点，变成每分钟自喂自

## token 预算（实测量级）

| 环节 | 成本 |
|---|---|
| 空轮（探针 idle） | ~300 token |
| 有未读，读一次列表 | +1.5k ~ 2k |
| 进一次会话看完 / 回复 | +1k ~ 3k |
| 生图一张（小布） | ~40s，无 token 成本（不计入模型） |

所以默认 20 分钟一轮、峰时翻倍，一天约 40 轮，安静日开销可以压在 1~2 万 token。
