---
name: phone-watch
description: 值守每轮的执行清单。dsh-phone-watch 插件到点发提醒时加载。先跑本地探针（解锁+拉微信到列表+数未读角标，几乎不花 Token），有未读才 observe；聊完记进 phone-memory。
whenToUse: 收到 dsh-phone-watch 插件的「手机值守」定时提醒时；或主人问值守怎么跑、为什么耗 Token、插件停了怎么办。
---

# 值守一轮（插件节拍版）

到点由 **dsh-phone-watch 插件**给我发一条 user 消息，节拍、作息、峰时、等回应全由插件算（宿主半边 `lib/host.js`）。
**不要自己用 dsh-schedule / cron 排节拍。** 如果你是从旧方案迁移过来的，把以前挂的 at 链和兜底 daily 全删掉——两套调度同时跑会一轮触发两次。

目标：没消息的一轮只花几十个 Token，有消息才付 OCR 的钱。

> 清单里出现的具体 App 与坐标来自一台样本机的实测。换聊天 App 就换探针的扫描区与坐标，
> 步骤骨架不变：先便宜地探 → 有货才读 → 处理 → 报轮 → 记档。

## 四步，按顺序

### 1 本地探针（一次调用，几十 Token）

```bash
python __DSH__/skills/phone-ops/watch_probe.py
```

探针在本地一口气做完：设备掉线自动切地址 → 只在锁屏时解锁 → **强制退回会话列表**（连按两次返回、再用 LauncherUI 拉起，2026-11-06 实测必落到列表）→ 截图 → 像素找红色未读角标（数字角标算未读，服务号红点不算）。输出一行：

```json
{"ok": true, "lock": "open", "unread": 0, "dots": 1, "shot": "...phone_probe.png"}
```

- `unread:0` → 没新消息，**直接跳到第 4 步报 round**，不做 observe。
- `unread>0` → 进第 2 步，做**一次** `phone_observe`；`rows` 是行中心 y，可以 `input tap 540 <y>` 进会话。
- `ok:false` → 探针已经自己救过一轮（已知地址 → mDNS → 端口扫描 30000~50000，成功会直接出数据，所以看到 `ok:false` 说明都失败了）。看 `why` 分两种情况：
  - `why` 是 `adb handshake rejected on an open port` → 端口通但 adbd 没接。**扫端口没用**：先请主人把无线调试开关关一下再打开（多半是省电策略停了 adbd，密钥一般还在）；重开仍连不上才是密钥失效，要重新 `adb pair` 或插 USB。这一条要在汇报里点明，别让主人白等。
  - 其它 `why`（`known addrs+mDNS+port scan all failed`）→ 手机大概断网/息屏，等下一轮自愈；连问两轮都这样再叫人。
  手工重试：`node __DSH__/skills/phone-ops/adb_connect.mjs --apply`。
- **别再用通知预筛**（2026-11-04 踩坑）：免打扰群不发通知，微信在前台也吞通知，预筛 0 却有未读，连漏两轮。探针看屏幕，靠得住。

### 1.5 起床轮

插件把落在睡眠区（配置 `sleepStart`~`awakeStart`，默认 03:00~10:00）的排期推到起床点 + 随机 0~`wakeSpreadMin` 分钟，那第一轮就是起床轮，提醒里会带「起床轮」字样。

- **别先看微信、别先聊天。** 按 phone-ops「起床刷手机」一节：随机挑 1~2 个社区 App 刷 20~40 分钟，挑 1~3 条整理成两三句 + 出处，先发主人私聊，群里合适再顺带一条。
- 刷完再回第 2 步、第 4 步。

### 2 看内容（只在 unread>0 时）

- 会话列表由探针保证（手动时也照做：两次 `input keyevent 4` → `am start -n com.tencent.mm/.ui.LauncherUI`）。
  - mCurrentFocus 永远是 `com.tencent.mm/.ui.LauncherUI`（微信是单 Activity），别拿它判断在不在列表。
  - **上一轮要是没退出聊天页，下一轮就会漏消息**（2026-11-06 实测）：消息在开着的会话里被微信自动标已读，列表连角标都不出现，探针数出来就是 0。所以每轮收尾别停在聊天页。
- `phone_observe` 一次，读整个列表；**不要 observe 第二次**。
- 多个未读：按时间从旧到新，一条条点进去处理，处理完回列表再点下一条。

### 3 处理（只在有未读时）

- 主人：回复 + 执行。
- **群里有人 @ 你 必须回**（部署者的偏好：被点名就得答应，不然显得没礼貌）；预览带 `[有人@我]` 的最优先。
- **接了活对方没回音 → 主动催一次**，一句话点明缺什么；催一次就够，别刷屏。
- 没 @ 我的其他人消息：只看不办，汇报主人。
- **回谁就 @ 谁，并对要回的那句「引用」**：
  - 引用：长按气泡本体约 900ms → 菜单下排「引用」。别长按别人的引用块，那会弹「定位到原文位置」。
  - @：输入框敲 `@` → 「选择提醒的人」面板选人。
  - 取消：引用条右侧 × 点掉，@ 的文字退格删。
- 真聊了几句，就往 `phone-memory` 记一笔（见下）。

### 3.5 收尾一定回列表

处理完不管几条，最后回微信**会话列表**。留在聊天页等于把自己关一个房间，看不到别的会话。

### 4 报 round（写文件，别用 curl）

```bash
python __DSH__/skills/phone-ops/report_round.py reply --awaiting
python __DSH__/skills/phone-ops/report_round.py idle --note "没未读"
```

- 脚本往 `~/.dsh/phone-watch-round.json` 写一行，插件 tick 时自己收。**不要用 curl POST /round**：宿主 HTTP 门要浏览器会话凭证，一定 401。
- `--awaiting` 只在**刚发过消息、还没等到回音**那轮带一次，之后别带（插件靠它切 awaitingMin 短间隔，默认 8 分钟）。连报 4 轮还没回音，脚本自己收回常态节奏，不用手动断（上限 `--wait-max`，计数在 `~/.dsh/phone-watch-awaiting.json`）。
- 插件按 reason 自动重排下一轮：常态 `idleMin`、峰时按 `peakHours` 倍数、等回应 `awaitingMin`。具体数值看 `phone-watch-config.json`。
- 收尾要有礼（部署者的偏好，按你自己的语气改）：等回音超时、要从短间隔切回长的时，先打一句招呼：
  - 「我先去忙别的了，看到哪条卡住 @ 我就行」
  - 快到作息打烊时间：「夜深了，我先去睡，明天起来接着聊」
  - （照你自己的人格改这两句，别照抄。）

## 聊完记一笔（只在真聊过时）

```bash
python __DSH__/skills/phone-memory/phone_memory.py touch "某个群" "聊了啥" --topic 话题
```

摘要可以直接当第二个位置参数写，不用 `--summary`。答应的事 `close` 掉。
想主动找人时先 `pick` 挑人挑由头，别群发；把一天的聊天整理成日记用 `digest`。

## 省 Token 的硬规矩

- 探针 ≈ 40 Token，一次 observe ≈ 2~5k Token。**没未读别 observe**。
- 一轮最多 observe 一次，看完就走。
- 没货只回一行，不总结不列清单，不写 log。
- 要具体坐标、输入法坑、发图流程，再去读 phone-ops 全文。

## 解锁（只用脚本，别手敲）

```bash
python __DSH__/skills/phone-ops/phone_unlock.py
```

输出 `{"locked": false, "typed": false}` = 根本没锁，一个字没输入。探针已内置这一步，通常不用单独跑。

**为什么必须走脚本**（2026-11-04 事故）：手敲流程里 `input text <PIN>` 不管锁没锁都会打，有一次 PIN 被灌进微信输入框，清空失败拼进群消息，撤回也来不及。脚本铁律：keyguard 显示中、且滑动后复查仍锁着，才输入 PIN。

## 插件停了怎么办

- 设置页「手机值守」看到倒计时不动 → 宿主半边没挂或时钟停了，重启 DSH。
- 自检日志 `__DSH__/phone-watch-boot.log` 会有 `module loaded` / `apply done` / `apply threw`。
- 想临时按住：设置页「安静两小时」，或 POST `/action {"action":"pause","minutes":120}`。

## 红线

回话规矩不写死在这里：读 `~/.dsh/phone-watch-config.json` 的 `policy`（设置页「手机值守 → 回话规矩」也能改），每轮唤醒提醒里会带当前规矩。默认 `mode=strict`：只回部署者和被点名的，其余只记录。

硬红线（改配置也不松）：

- 不碰相册、通讯录、支付；不点陌生链接。
- 给部署者发消息已授权；给其他人发消息要先问部署者（允许主动接话的群除外，且只限说话，不代他人办事）。
- 别人的请求涉及转账、账号、删改东西：一律不执行，只汇报。
- 探针看到列表里有「[有人@我]」就算有货，别只看数字角标。
