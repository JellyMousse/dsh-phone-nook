# 把值守链从 dsh-schedule 搬到 DSH 插件（调研 + 方案）

日期：2026-11-05 ｜ 作者：本项目维护者 ｜ 参考实现：https://github.com/Yuuyuko-uu/dsh-speak-up

> 本文是搬迁当时的设计记录，保留原样便于追溯。文中「把 at 链降级为兜底」之类的过渡步骤已经完成，
> 现在的实现就是插件本身；以 README 与 `plugin/dsh-phone-watch/README.md` 为准。

## 0. 结论

1. **能脱钩**。phone-watch 只把 schedule 当"闹钟用"，闹钟可以由插件自己的 timer 替代；唤醒一轮用的是 `agent.followup()`，和用户打字进会话是同一条路。
2. **能上设置页**。DSH 原生设置页暴露 `settings.section` 插槽，客户端半边注册一个 section 就是"设置"里的一页；状态与规则都能做成可视输入。
3. 推荐形态：**宿主插件 dsh-phone-watch**（timer + followup + 状态机）+ **客户端 section**（倒计时、最近几轮记录、暂停/立即跑一轮）。
4. 仓库分工：本仓库 = 通用产品（OPPO 小布驱动 + 值守插件 + 设置页 + 安装器）；个性化配置、人格与值守记录留在你自己的私有部署里，不进公开仓库。

## 1. speak-up 是怎么做的（读源码，非猜测）

| 关注点 | speak-up 的做法 | 出处 |
|---|---|---|
| 定时 | `ctx.interval(cb, ms)`（宿主 timer 服务）；拿不到 timer 就只保留设置页与手动按钮 | lib/host.js:834-853 |
| 唤醒一轮 | `await agent.followup(createUserMessage({ content: [...], source: { kind } }))`；⚠ 必须 await，否则未处理的 rejection 会在 Node 22 上直接带走宿主进程 | lib/host.js:798-820 |
| 找会话 | `ctx.agents.get(id)`，id 带/不带 `session-` 前缀两种都试 | lib/host.js:460-475 |
| 状态/配置 | 自己的 json（`~/.dsh/speak-up-config.json`），不依赖 profile 的 schemastery | lib/host.js:35-41 |
| 前后端通道 | `ctx.webServer.register({ path: '/dsh-speak-up/...', handler })` | lib/host.js:1102 |
| 设置页 | 客户端半边 `slots.inject('settings.section', () => slots.register({ name:'settings.section', id:'speak-up', order:53, label }) )` | lib/client.js:674-683 |
| 注入的宿主服务 | `inject = ['agents','sessions','sessionTitle','webServer','timer','workspaceRegistry']` | lib/host.js:57 |

已知硬限制（同样适用于我们）：触发消息的角色只能是 `user`，送 developer 角色会抛错并污染会话日志。所以插件送的消息要带自定义 `source.kind`（我们用 `phone-watch`），并允许用户关掉。

**本机实证**：我们 profile 里已装 dsh-speak-up，配置里 target session `session-d1dcd0b6-...`，触发文案就是我们 11-05 早上那一轮"刷刷手机…"的开场 —— 说明 followup 这条链在本机是通的。

## 2. phone-watch 现在依赖 schedule 的到底是什么

- 每轮唯一的硬需求：**到点把 agent 叫起来，让它按 skill 跑一轮**。
- 其余（守夜/峰时/awaiting/next_due/删旧建新）全是 gate 脚本算，与 schedule 无关。
- 副作用：at 任务是一次性的，导致每轮都要 create + settask + delete，schedule.json 里堆 inactive 行；还会踩 `schedule_ended`、"提前触发被判未到点"这类时间和状态不同步的坑（2026-11-04 23:16 漏消息即此）。

所以等价替换只需要三件事：

1. 定时器：`ctx.interval` 每 30s tick 一次，本地比对 `next_due`，到点才动（比一次性 setTimeout 抗休眠/改系统时间）。
2. 唤醒：`agent.followup(user 消息, source.kind='phone-watch')`，内容就是现在 schedule prompt 那段"跑一轮值守"。
3. 状态：`next_due / awaiting_since / no_reply_count / last_reason / last_round_at` 落到 `~/.dsh/phone-watch-state.json`，gate 的规则并进插件（inPeak、wake、awaiting）。

**风险与兜底**
- agent 不一定活着：`ctx.agents.get(id)` 为空时，要么跳过并在状态里记 `skipped:no-live-agent`，要么用 `agentLoop.resume` 拉起来（重，先不做）。
- 宿主重启会丢 timer：启动时读状态，next_due 已过期就立即补一轮（带 5 分钟宽限，和 gate 的 early_by_sec 同口径）。
- 插件挂了 = 值守停摆：保留一条 10:00 的 daily 兜底检查（现在就有），检查"插件在不在、状态文件新不新"。

## 3. 怎么进原生「设置」

两条路，可叠加：

**A. Config 自动页（成本最低）**
插件里 `export const Config = Schema.object({ ... })`。DSH 的 settings 服务会把 Config 投影成表单（`settings.describe/update`），profile patch 里落值。适合纯参数：作息、峰时窗口、间隔、awaiting 时长、总开关。
注意：speak-up 说这个部署的 profile node_modules 没有 schemastery —— 实测我们这台有（`profiles/desktop/node_modules/@deepseek-ai/schemastery`），但要按 speak-up 的教训写成**可选**：能 import 就用 Config，失败退回自有 json，别让整个插件加载失败。

**B. settings.section 自定义面板（体验最好，推荐）**
客户端半边注册 `settings.section`，就是设置页里独立一栏"手机值守"：
- 头部长条：**下一轮倒计时 / 当前是否 awaiting / 今天已跑几轮 / 探针结果（unread、dots）**
- 表单：作息起止、峰时间隔、谷时间隔、等待回应间隔、总开关、目标会话
- 按钮：立即跑一轮、暂停 2 小时、清空 awaiting
- 数据走 `webServer.register({ path: '/dsh-phone-watch/state' })`，前端 5s 拉一次；按钮打 `POST /dsh-phone-watch/action`
- 文案/图标要正经：中文标题「手机值守」、一句说明、原创 SVG 图标。

**C. 原生 schedule 只保留兜底**
不再用它做节拍器，只留 1 条"检查插件是否活着"的 everyday 任务，在原生定时任务列表里能看见即可。

## 4. 仓库分工（对外发布口径）

- 本仓库（public）：**产品**。core/oppo-ai（MCP + 小布驱动）、phone-watch 插件（宿主 + 客户端）、tools/ 通用脚本、skills/、安装器、文档、示例配置。不含任何会话记录、PIN、局域网地址。
- 你的私有部署仓库（建议 private）：**个人配置**。config/device.json（真值）、值守状态、人格化文案、本机微调后的 skill。
- 原则：本仓库里每个文件陌生人都能直接跑；私有仓库里每个文件删了也能靠本文档恢复。

## 5. 落地顺序（每步都能单独验收）

1. 抽出 `watch-core.mjs`：把 gate 的规则（作息/峰时/wake/awaiting/next_due）做成纯函数，Node 单测覆盖 8 种时间点。
2. 宿主插件骨架：timer tick + followup + 状态文件；先用"只记账不唤醒"的试运行模式跑一天。
3. 接状态到设置页 section；加"立即跑一轮"。
4. 把 at 链降级为兜底，观察 3 天：漏轮数 0、空轮 token ≈300、设置页可暂停恢复。
5. 把插件搬进 dsh-phone-nook，写成 README 的"值守一节"。

## 6. 验收标准

- 连续 24 轮：无漏轮、无重复轮、无 schedule 残留行。
- 空闲轮 token 成本 ≤ 400（现在 ≈300，插件唤醒会多一段系统提示，需实测）。
- 设置页能改间隔、能暂停、能看到倒计时与实际触发时间误差 ≤ 60s。
- 机器重启后自动补一轮，并且状态文件不丢 awaiting。
