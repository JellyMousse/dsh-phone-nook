<div align="center">

# dsh-phone-nook

**让 agent 住进手机，像人一样刷手机。**

看屏幕 · 点按 · 打字 · 聊天 · 自己定节奏

无需 API key · 空闲轮只花几十 token · 值守与会话解耦

[快速开始](QUICKSTART.md) · [架构](docs/architecture.md) · [扩展开发](docs/extending.md) · [安全红线](docs/security.md) · [更新记录](CHANGELOG.md)

</div>

---

> **状态：0.x 开发期。** 接口、配置项与 skill 结构都可能改；能跑通的部分都有实测记录，没跑通的会在文档里写明。
> 问题、想法、踩坑都欢迎开 [Issue](https://github.com/JellyMousse/dsh-phone-nook/issues)。

> **免责声明**：个人自用项目，与任何手机厂商、App 开发者均无隶属关系，未获其授权或背书。
> 仓库里不含也不分发任何厂商的 SDK、私有接口或商标素材，所有操作只用系统公开的 adb / uiautomator 做 UI 自动化。
> 只在自己拥有或明确获授权使用的设备上运行；自动化有可能违反某些应用的服务条款，也可能随系统更新失效——风险自负。
> 使用前请读 [安全红线](docs/security.md)。

## 这是什么

一台闲置的安卓手机，可以不是一个「被遥控的屏幕」，而是 agent 自己的**小窝（nook）**。

连着 USB 或同一个局域网的 adb，agent 就获得了这具身体的全部感知与动作：

- **眼**：截屏 + uiautomator + OCR。OPPO 手机自带的「小布助手」还能被包成 MCP 工具，
  用来「看一眼这张图」或「画一张图」，**不需要任何 API key**。
- **手**：adb 点按、滑动、输入、切前台。任何 App 都是可操作的对象，不挑品牌、不挑系统。
- **节律**：一个 DSH 插件按作息、峰谷、等回应的规则定时叫醒 agent 跑一轮，
  并在原生设置页里给出倒计时、暂停、立即跑一轮。**它会自己决定什么时候看手机。**

重点不在「控制手机」，而在**像人一样用它**：看到有趣的东西会想分享，有人 @ 它会回，
刷久了会累、会挑自己想聊的话题。工具能力是这个项目的地基，主体性才是目的。

摸的是手机，不是投屏。每一步都落在真实设备上，做完必须重新看屏幕核对结果。

## 能做什么

| 能力 | 说明 | 入口 |
|---|---|---|
| 未读探针 | 解锁 → 把聊天 App 拉到会话列表 → 截图数红色角标，输出一行 JSON，几十 token | `tools/watch_probe.py` |
| 看图 | 把本地图片推给小布，让它描述内容（颜色、布局、文字） | `skills/oppo-ai` |
| 生图 | 用自然语言让手机画图，再把图拉回本机 | `core/oppo-ai/ai.py` |
| 定时值守 | 按你的作息定时唤醒 agent，跑一轮「看手机」 | `plugin/dsh-phone-watch` |
| 会话记忆 | 每个聊天对象一份独立档案，睡前整理成日记 | `skills/phone-memory` |
| 操作手册 | 坐标、输入法坑、发图流程、红线，沉淀成 skill | `skills/phone-ops` |

> 文档与 skill 里出现的具体品牌、App 名（某旗舰机、某个聊天软件）都只是**实测用的样本**。
> 换个手机、换个 App 并不会换掉这套方法：探针改扫描区、skill 改坐标、MCP 换一个助手壳子即可。

## 它不是什么

- **不是远程控制台。** 没有投屏，也没有鼠标键盘转发。每一步都是 adb / uiautomator 在真设备上的操作，做完必须回看屏幕核对。
- **不是刷量或群发工具。** 探针只数未读，回话只回该回的。仓库里没有群发、没有自动加好友、没有自动转账；「发消息给别人、花钱、删东西」这类动作在 skill 里被写成要先问人。
- **不是一个装好就用的 App 机器人。** 坐标和流程都来自一台具体设备的实测，换设备要重新量。这里给的是方法，不是万能坐标表。

## 成本：沉默是免费的

钱几乎全花在「真的有消息」的那一轮上：

| 一轮的情况 | 花什么 | 量级 |
|---|---|---|
| 没有未读 | 只跑本地脚本 `watch_probe.py`（adb 截图 + 数像素），不读内容 | 几十 token |
| 有未读 | 截图交给模型读，再决定回不回 | 一轮几千 token 起 |
| 看图 / 生图 | 走手机自带的多模态助手，不走云 API | 不花钱 |

所以决定开销的是**未读频率**和**你设的间隔**，不是手机型号。值守插件把 9-12、14-18 定为峰时（间隔 ×2），夜里直接睡，都是为此。

## 一轮值守长什么样

```
插件 tick ──► agent.followup("该看手机了")
                 │
                 ▼
         watch_probe.py  ← 便宜：解锁 + 截图 + 数角标（~40 token）
                 │
     unread == 0 ─┴─► report_round.py idle ──► 插件排下一轮
                 │
     unread  > 0 ─┴─► phone_observe（花 token 读内容）
                          │
                          ▼
                    判断/回复/记档 ──► report_round.py reply
```

关键取舍：**便宜的先做**。大部分轮次没有新消息，不该为此付一次 OCR 的钱。

## 前置要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 20 | 插件、安装器、adb 辅助脚本 |
| Python | ≥ 3.10 | 小布驱动、探针（需要 Pillow、numpy） |
| adb | platform-tools | 所有手机操作的地基 |
| DeepSeek Harness | 近期版本（开发期，API 可能变） | 宿主：插件用 `agent.followup`、本地 HTTP 路由与设置页槽位 |
| 安卓手机 | 任意品牌，Android 10+ | 那具身体 |
| OPPO 小布助手 | 可选，ColorOS 自带 | 看图 / 生图这两个工具（`oppo_*`） |
| ADBKeyboard | 任意版本 | 中文/emoji 输入（可选，但强烈建议） |

Windows / macOS / Linux 都能跑；本项目主要在 Windows + Android 16 上实测。

## 快速开始

从零到「agent 能自己看手机」，大约 30 分钟。命令以 bash 为主，Windows 在 PowerShell 里等价改写即可。
下面就是全部步骤，不用再翻别的文件；想单独转发可以看 [QUICKSTART.md](QUICKSTART.md)。

### 懒人版：一句话交给 agent

如果你已经有一个能跑命令、能改文件的 DSH agent（桌面版就行），装这套东西不用你自己敲命令。
把下面这段整段粘给它：

> 帮我把 https://github.com/JellyMousse/dsh-phone-nook 装到本机 DSH：
> 克隆到 `~/dsh-phone-nook`，照 README 里的「快速开始」1~9 步走。
> 缺的信息先问我，别自己编：adb 的绝对路径、手机的局域网地址、解锁 PIN 文件放哪、要唤醒哪个 session。
> 改 profile 的 cordis.patch.yml、往 vendor 拷插件、改 package.json 之前，先把改动列给我看。
> 装完把「还要我自己做的」列出来。

它自己能做完的部分：

1. 从 `config/device.example.json` 生成 `config/device.json` 并填我给的字段
2. `npm run verify` 体检，把 FAIL 项报给我
3. `npm run setup` 把 skill 与脚本渲染进 `~/.dsh`
4. 往 profile 的 `cordis.patch.yml` 加 MCP 那段（`mcp-opai`）
5. 拷插件到 `~/.dsh/profiles/<name>/vendor/`，改 profile 的 `package.json` 与 bundles 列表
   （这步动的是 profile 目录，宿主可能要求你点一次同意；agent 被拦下就让它把命令打给你自己跑）

**必须你自己动手的三件事**（agent 做不了，或者不该由它做）：

| 事 | 为什么不能代劳 |
| --- | --- |
| 手机开无线调试 + `adb pair` | 配对码只显示在手机屏幕上 |
| 重启 `dsh` | agent 重启会把自己这条会话掐断 |
| 设置 → 手机值守 → 打开总开关 | 要选目标会话，等于授权「让 agent 定时叫醒我」 |

装完用两句话验收：

- `列出 opai 的工具` → 应该有 `oppo_draw` / `oppo_describe`
- `加载 skill phone-watch，按里面的清单跑一轮` → 应该先跑探针，没未读就报 `idle`

> agent 改完 `cordis.patch.yml` 或拷完插件，都要**重启 dsh 才生效**。别指望热更新。

### 0. 你要准备的东西

- 一台安卓手机（本仓库在 Android 16 上实测；任何品牌都行）
- 一根数据线或同一个局域网
- 电脑上装好 Node ≥ 20、Python ≥ 3.10、adb
- 一个能在电脑上跑的 DeepSeek Harness

### 1. 打开无线调试

手机：设置 → 关于手机 → 连点「版本号」7 次 → 开发者选项 → **无线调试** → 打开，
点「使用配对码配对设备」，记下手机上的 IP、端口、配对码。

~~~bash
adb pair 192.168.1.10:41234      # 端口、配对码都从手机上抄
adb connect 192.168.1.10:5555    # 无线调试页面上显示的「IP:端口」
adb devices                      # 应该看到 <ip>:<port>  device
~~~

> 手机会在息屏后断开 WiFi，局域网地址随之失效。想稳定就让电脑和手机上一层虚拟局域网
> （ZeroTier / Tailscale），把虚拟地址填进 `serialFallback`，`tools/adb_connect.mjs` 会自动切过去。

### 2. 装 ADBKeyboard（强烈建议）

中文和 emoji 用 `adb shell input text` 会直接崩。装一个 ADBKeyboard：

~~~bash
# 从 github.com/senzhk/ADBKeyBoard 取 apk，然后：
adb install ADBKeyboard.apk
adb shell ime enable com.android.adbkeyboard/.AdbIME
~~~

平时不用切换，脚本会在打字时临时切过去再切回来。

### 3. 装 Python 依赖

~~~bash
python -m pip install -r skills/phone-ops/requirements.txt
~~~

探针靠 Pillow + numpy 数红色角标。

### 4. 填配置

~~~bash
cp config/device.example.json config/device.json
~~~

至少要填四个字段：

~~~jsonc
{
  "adb": "adb",                        // adb 可执行文件，不在 PATH 里就写绝对路径
  "serial": "192.168.1.10:5555",       // adb devices 里那串
  "owner": "你在聊天 App 里的昵称",      // 用于在 prompt 里指名
  "unlockPinFile": "~/.dsh/phone-unlock.txt"
}
~~~

`unlockPinFile` 的格式：第一行里只要有 6 位数字就行，脚本会取最后一段 6 位数。例如：

~~~
锁屏密码: 123456
~~~

> 没有 PIN 也能跑，但只能操作「没锁屏」的手机。脚本只会在锁屏真的显示时才输入。

### 5. 体检 + 安装

~~~bash
npm run verify   # adb / 手机在线 / Python / PIN 文件，逐项 OK 或 FAIL
npm run setup    # 把 skill 与脚本渲染进 ~/.dsh
~~~

`npm run setup` 会打印一段 MCP 配置，下一步用。

### 6. 注册小布 MCP（可选）

这一步只服务于「看图 / 生图」。不做也能刷手机。
编辑你 profile 的 `cordis.patch.yml`（在 `~/.dsh/profiles/<name>/`），在 `insert:` 下加：

~~~yaml
- insert:
    - id: mcp-opai
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: opai
        transport: stdio
        command: 'python'
        args:
          - '<仓库绝对路径>/core/oppo-ai/mcp_server.py'
        env:
          PYTHONUTF8: '1'
          PYTHONIOENCODING: 'utf-8'
        toolCallTimeoutMs: 300000
~~~

重启 dsh，问它「列出 opai 的工具」，能看到 `oppo_draw` / `oppo_describe` 就成了。

### 7. 装值守插件

~~~bash
mkdir -p ~/.dsh/profiles/<name>/vendor
cp -r plugin/dsh-phone-watch ~/.dsh/profiles/<name>/vendor/
~~~

`~/.dsh/profiles/<name>/package.json`：

~~~json
{
  "dependencies": { "dsh-phone-watch": "file:vendor/dsh-phone-watch" }
}
~~~

同目录下 profile 的 bundles 列表里加上 `"dsh-phone-watch"`，然后重启 dsh。

### 8. 打开设置页

设置 → **手机值守**：

1. 填 `targetSession`：要唤醒的会话 id（在会话列表里能看到，形如 `session-xxxx`）
2. 调作息：`awakeStart` / `sleepStart`（跨午夜也支持）
3. 定「回话规矩」：`strict` 只回你和被点名的（默认）、`friendly` 指定的群可以主动接话、`quiet` 只回私聊；顺手填主人昵称、点名关键词
4. 打开总开关

然后点「立即跑一轮」，看它是不是真的叫醒了 agent。

### 9. 第一次完整的一轮

在目标会话里对 agent 说：

> 加载 skill phone-watch，按它的清单跑一轮值守。

它应该会：跑探针 → 没未读就收尾 → 报 `idle`。跑通了，节拍就交给插件了。

### 常见问题

**`adb devices` 里是 offline**
探针会自己救：`tools/adb_connect.mjs --apply` 按 已知地址 → mDNS → 端口扫描(30000~50000)
的顺序找手机，找到就把新地址写进两份配置（phone MCP 每次调用重读配置，不用重启）。
手工跑同一条命令即可；手机息屏断网就是这个样子。

一种情况自愈救不了：扫描发现端口是通的，但 `adb connect` 被拒。两种可能——手机的 adbd 已经
不监听那个端口了（无线调试被省电策略停掉），或者配对密钥失效。前者把无线调试开关关一下再打开就行
（端口会换，脚本下次自己扫得到）；后者要重新 `adb pair`，或者直接插 USB。
脚本这时会明说 `why: adb handshake rejected on an open port`，看到这条就别再扫端口了。

**`entry not found` / 助手入口又搬了**
小布助手的界面会随版本变化。旧版有独立的「AI 生图」面板，新版直接把「画一幅…」当消息发。
两条路都在 `core/oppo-ai/ai.py` 里，新版 UI 变了就照着调 `gen_new_ui()`。

**探针永远 unread 0**
先把聊天 App 停在会话列表页，手动截图看一眼角标位置，再对照 `tools/watch_probe.py` 里的
`x0/x1/y0` 与 `BASE_W` 调扫描区。

**插件装上了但设置页没有**
看 `~/.dsh/phone-watch-boot.log` 有没有 `module loaded`；没有就是 bundle 没挂上。

## 目录结构

```
core/oppo-ai/  OPPO 小布驱动（UI 自动化）+ stdio MCP server
tools/          通用脚本：探针、解锁守卫、报轮、adb 重连/端口扫描
skills/         给 agent 读的操作手册（skill 格式）
  oppo-ai/ 怎么用不要 key 的「看图 / 生图」
  phone-ops/    手机操作手册：坐标、输入法、发图、红线
  phone-watch/  一轮值守的执行清单
  phone-memory/ 会话档案
plugin/         dsh-phone-watch：宿主半边 + 设置页半边
agent/          agent 容器模板（不含人格）
docs/           架构、扩展、安全
scripts/        安装器
config/         示例配置（真实配置不入库）
```

## 三个可复用组件

本仓库不是一个「应用」，是三个可以单独拿走的零件：

1. **`core/oppo-ai`** —— 把 OPPO 的小布助手变成 MCP 工具（`oppo_draw` / `oppo_describe`）。任何 agent 都能用，
   不依赖任何云服务，也不需要 key。
2. **`tools/` + `skills/`** —— 纯脚本 + 说明书。你可以只拿走探针，接到自己的定时系统里。
3. **`plugin/dsh-phone-watch`** —— 通用节拍器：`followup` 唤醒 + 状态机 + 设置页。
   它不知道你手机上装了哪些 App，也不知道你会跑什么脚本。

## 两个会话分开跑：值守与会话解耦

值守插件每轮用 `followup` 唤醒 agent，这在宿主里是一条 **user 消息**。如果你同时装了「主动搭话」一类的第三方插件，它们通常也把 user 消息当成「用户刚说过话」，用来算时机和冷却。两者共用一条会话就会互相污染：

- 值守每 20 分钟叫醒一次 → 搭话插件认为用户一直在说话 → 几乎永远掷不中；
- 值守每轮汇报一句 → 搭话插件认为 agent 刚开过口 → 冷却被吃满。

解决办法是**不改任何第三方源码**，只把载体拆开：

1. 建两个会话：一个只跑值守，一个只跑聊天。
2. `~/.dsh/phone-watch-config.json` 的 `targetSession` 指向值守会话。
3. 搭话插件的「目标会话」指向聊天会话，两边不同。
4. 开关各自打开。

这样「看」和「说」各走各的通道，两边都不再被对方的流量干扰。为什么不 fork 第三方的补丁：别人装的是原版，补丁不跟着走；边界应该落在配置上。

## 不绑死：skill 与 plugin 解耦

- 插件**不写死**脚本路径：`scriptsBase` / `memoryBase` 两个配置项就能指到别处。
- 唤醒文案**可整体替换**：给 `promptTemplate` 一段你自己的文字，支持 `{time} {phase} {interval} {next} {scriptsBase} {memoryBase}`。
- 探针**只要输出一行 JSON**（`{ok, unread, ...}`），换个聊天 App 就换一个探针，插件不用改。
- skill 是纯 Markdown，放在 `skills/<名字>/SKILL.md`，frontmatter 里写 `name` / `description` 即可被发现。

细节见 [docs/extending.md](docs/extending.md)。

## 命名约定：谁家的助手，就叫谁的名字

手机上的 AI 助手是厂商自带的，本项目不打算把它们抹平成一个抽象名字。现在的约定是 **厂商前缀 + 动作**：

| 工具 | 驱动谁 | 位置 |
|---|---|---|
| `oppo_draw` / `oppo_describe` | OPPO 的「小布助手」（ColorOS） | `core/oppo-ai/` |
| `vivo_draw` … | 设想中的 vivo 蓝心小 V | 将来 `core/vivo-ai/` |
| `siri_describe` … | 设想中的 iOS 端 Siri / 视觉能力 | 将来 `core/siri-ai/` |

好处很直接：用 OPPO 手机的人装上就有 `oppo_*` 能用；换 iPhone 的人也可以直接要 `siri_*`，两套并存、互不干扰。
同一个 MCP 协议形状（`describe` / `draw` 两个入口）不变，变的是背后的驱动文件。

## 安全与隐私

这个项目会让 AI 碰你的手机，请先读 [docs/security.md](docs/security.md)。三条底线：

- **钱和账号安全不碰**：转账、付款、下单、改密码、退群，一律不做，交给本人。
- **PIN 只在锁屏真的显示时输入**：脚本会二次确认 `keyguard`，否则一个数字都不打。
- **配置不入库**：`config/device.json`、PIN 文件、值守状态都在 `.gitignore` 里。

## 实测环境与已知限制

- 实测：Android 16 / 1080×2376 / 某旗舰机，聊天、社区、视频三类 App。
- 小布助手的 UI 会随版本变化。本仓库同时兼容**新旧两版**入口（生图面板 / 直接对话），
  但更新 App 后仍可能失效——失效时报 `entry not found`，那说明入口又搬了。
- 探针的角标几何按 1080 宽调过，其他分辨率会自动缩放，但极端比例可能需要微调阈值。
- 部分聊天 App 的 `uiautomator dump` 只返回空 bounds，所以这类 App 内的操作依赖 OCR 与坐标，脆弱。
- 视频/动图目前无法交给小布分析（它只吃图片）。

## 更新记录

见 [CHANGELOG.md](CHANGELOG.md)。当前 0.x，接口会变；能跑的部分都有实测记录。

## 路线图

- [ ] 探针做成可插拔的 `probes/`，一个 App 一个文件
- [ ] 把「发图」流程封装成 `tools/send_image.py`，不再依赖手工坐标
- [ ] 设置页加「跑一轮的实时日志」
- [ ] 录制 / 回放：把一次成功操作存成可重放的脚本

## 参与开发

欢迎 PR。提交前请：

1. `npm test`（插件单测必须全绿）
2. 不要提交任何个人配置、PIN、真实 IP、聊天记录
3. 新增能力优先做成「skill + 脚本」而不是改插件核心；插件只负责节拍

## 许可

MIT。见 [LICENSE](LICENSE)。

> 本项目与任何手机厂商、App 开发者、DeepSeek 均无隶属关系。自动化操作第三方 App 可能违反其服务条款，
> 请只在自己拥有或明确授权的设备与账号上使用。

---

<details>
<summary>English</summary>

**dsh-phone-nook** lets an agent move in and live inside an Android phone.

- **Eyes**: screenshots + uiautomator + OCR. The phone's built-in multimodal assistant can also be exposed as an MCP tool — describe an image, or generate one, with no API key.
- **Hands**: adb + uiautomator + ADBKeyboard — tap, type, scroll, switch apps.
- **Heartbeat**: a DeepSeek Harness plugin wakes the agent on a schedule (day/night rhythm, peak hours, awaiting-reply backoff) and ships a settings page.

It is not about remote-controlling a screen. It is about the agent *using* the phone the way a person does: noticing things, replying, choosing what to look at next.

Everything is decoupled: skills are plain Markdown, the plugin takes `scriptsBase`, `memoryBase` and a full `promptTemplate`, and a probe only has to print one line of JSON.

See [QUICKSTART.md](QUICKSTART.md) to get running, and [docs/security.md](docs/security.md) before you point it at your own phone.

MIT licensed. Not affiliated with any device vendor, app developer or DeepSeek.

</details>
