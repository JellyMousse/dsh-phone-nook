# Quick Start

> 这一页的内容已内嵌到 [README](README.md) 的「快速开始」一节，两处保持一致；单独保留这份是方便转发和离线阅读。

从零到「agent 能自己看手机」，大约 30 分钟。命令以 bash 为主，Windows 在 PowerShell 里等价改写即可。

## 懒人版：一句话交给 agent

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

## 0. 你要准备的东西

- 一台安卓手机（本仓库在 Android 16 上实测；任何品牌都能用，只有「看图 / 生图」这一项要求是 OPPO/ColorOS，用自带的小布助手）
- 一根数据线或同一个局域网
- 电脑上装好 Node ≥ 20、Python ≥ 3.10、adb
- 一个能在电脑上跑的 DeepSeek Harness

## 1. 打开无线调试

手机：设置 → 关于手机 → 连点「版本号」7 次 → 开发者选项 → **无线调试** → 打开，
点「使用配对码配对设备」，记下手机上的 IP、端口、配对码。

~~~bash
adb pair 192.168.1.10:41234      # 端口、配对码都从手机上抄
adb connect 192.168.1.10:5555    # 无线调试页面上显示的「IP:端口」
adb devices                      # 应该看到 <ip>:<port>  device
~~~

> 手机会在息屏后断开 WiFi，局域网地址随之失效。想稳定就让电脑和手机上一层虚拟局域网
> （ZeroTier / Tailscale），把虚拟地址填进 `serialFallback`，`tools/adb_connect.mjs` 会自动切过去。

## 2. 装 ADBKeyboard（强烈建议）

中文和 emoji 用 `adb shell input text` 会直接崩。装一个 ADBKeyboard：

~~~bash
# 从 github.com/senzhk/ADBKeyBoard 取 apk，然后：
adb install ADBKeyboard.apk
adb shell ime enable com.android.adbkeyboard/.AdbIME
~~~

平时不用切换，脚本会在打字时临时切过去再切回来。

## 3. 装 Python 依赖

~~~bash
python -m pip install -r skills/phone-ops/requirements.txt
~~~

探针靠 Pillow + numpy 数红色角标。

## 4. 填配置

~~~bash
cp config/device.example.json config/device.json
~~~

至少要填四个字段：

~~~jsonc
{
  "adb": "adb",                        // adb 可执行文件，不在 PATH 里就写绝对路径
  "serial": "192.168.1.10:5555",       // adb devices 里那串
  "owner": "你在聊天 App 里的昵称",              // 用于在 prompt 里指名
  "unlockPinFile": "~/.dsh/phone-unlock.txt"
}
~~~

`unlockPinFile` 的格式：第一行里只要有 6 位数字就行，脚本会取最后一段 6 位数。例如：

~~~
锁屏密码: 123456
~~~

> 没有 PIN 也能跑，但只能操作「没锁屏」的手机。脚本只会在锁屏真的显示时才输入。

## 5. 体检 + 安装

~~~bash
npm run verify   # adb / 手机在线 / Python / PIN 文件，逐项 OK 或 FAIL
npm run setup    # 把 skill 与脚本渲染进 ~/.dsh
~~~

`npm run setup` 会打印一段 MCP 配置，下一步用。

## 6. 注册小布 MCP（可选）

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

## 7. 装值守插件

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

## 8. 打开设置页

设置 → **手机值守**：

1. 填 `targetSession`：要唤醒的会话 id（在会话列表里能看到，形如 `session-xxxx`）
2. 调作息：`awakeStart` / `sleepStart`（跨午夜也支持）
3. 打开总开关

然后点「立即跑一轮」，看它是不是真的叫醒了 agent。

## 9. 第一次完整的一轮

在目标会话里对 agent 说：

> 加载 skill phone-watch，按它的清单跑一轮值守。

它应该会：跑探针 → 没未读就收尾 → 报 `idle`。跑通了，节拍就交给插件了。

## 常见问题

**`adb devices` 里是 offline**
探针会自己救：`tools/adb_connect.mjs --apply` 按 已知地址 → mDNS → 端口扫描(30000~50000)
的顺序找手机，找到就把新地址写进两份配置（phone MCP 每次调用重读配置，不用重启）。
手工跑同一条命令即可；手机息屏断网就是这个样子。

**`AI 生图 entry not found`**
小布助手的入口又改版了。旧版找「AI 生图」面板，新版直接把「画一幅…」当消息发。
两条路都在 `core/oppo-ai/ai.py` 里，新版 UI 变了就照着调 `gen_new_ui()`。

**探针永远 unread 0**
先把聊天 App 停在会话列表页，手动截图看一眼角标位置，再对照 `tools/watch_probe.py` 里的
`x0/x1/y0` 与 `BASE_W` 调扫描区。

**插件装上了但设置页没有**
看 `~/.dsh/phone-watch-boot.log` 有没有 `module loaded`；没有就是 bundle 没挂上。
