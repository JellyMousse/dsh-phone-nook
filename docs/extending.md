# 扩展开发

本仓库故意做成「零件」而不是「应用」。你能扩展的地方有四处，按改动成本从低到高：

1. **换配置**（零代码）：作息、间隔、目标会话、脚本路径、唤醒文案
2. **加 skill**（纯 Markdown）：给 agent 新的操作手册
3. **加脚本**（几十行 Python/Node）：换一个探针、换一个 IM、换一个收尾脚本
4. **改插件**（TypeScript/JS）：只有改节拍逻辑或设置页时才需要

## 1. 配置项

`$DSH_HOME/phone-watch-config.json`：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `targetSession` | `''` | 被唤醒的会话 id，空则不叫 |
| `awakeStart` / `sleepStart` | 10 / 3 | 作息小时，支持跨午夜 |
| `idleMin` | 20 | 常态间隔 |
| `awaitingMin` | 5 | 刚发过消息等回应的间隔 |
| `peakWindows` | `[[9,12],[14,18]]` | 峰时窗口，左闭右开 |
| `peakMul` | 2 | 峰时倍率 |
| `wakeSpreadMin` | 120 | 起床轮随机散布（分钟） |
| `pausedUntil` | `null` | ISO 时间，暂停到这里 |
| `scriptsBase` | `$DSH_HOME/skills/phone-ops` | 探针与报轮脚本目录 |
| `memoryBase` | `$DSH_HOME/skills/phone-memory` | 记忆脚本目录 |
| `promptTemplate` | `''` | 整段替换唤醒文案 |

### 自定义唤醒文案

```json
{
  "promptTemplate": "【手机值守】{time}（{phase}，{interval} 分后下一轮）\n1) 跑 {scriptsBase}/watch_probe.py，unread 为 0 就收尾。\n2) 群里只回 @ 我或 owner 的消息。\n3) 收尾跑 {scriptsBase}/report_round.py reply。"
}
```

可用占位符：`{time} {phase} {interval} {next} {scriptsBase} {memoryBase}`。
注意第一行「这是插件提醒，不是主人消息」插件会自己加，不用你写——模型很容易把提醒当成对方说的话。

## 2. 加一个 skill

目录结构：

```
skills/<名字>/
  SKILL.md          # frontmatter + 正文
  可选脚本.py
```

`SKILL.md` 的 frontmatter：

```markdown
---
name: phone-gallery
description: 用一句话说清「什么时候该加载我」，这句会进 skill 目录供模型挑选
---
正文：命令、坐标、坑、红线。写给人看也写给模型看。
```

安装：`node scripts/install.mjs` 只会装本仓库登记的 skill；你自己的 skill 直接放进
`$DSH_HOME/skills/<名字>/SKILL.md` 就会出现在 skill 目录里（DSH 启动时扫描）。

写 skill 的三条经验：

- **description 决定加载率**。写清触发场景（「每轮值守开始时加载」），别写「手机相关」。
- **能测的都写实测结论**，别写「应该」。坐标、包名、版本号都要带日期。
- **红线单独一节**，用祈使句，模型更容易照做。

## 3. 换一个探针（换 IM / 换策略）

探针是**唯一**和某个具体聊天 App 绑死的地方。契约只有两条：

1. 被 agent 调用，打印**一行** JSON
2. 至少含 `ok`（布尔）与 `unread`（整数）

```json
{"ok": true, "lock": "open", "unread": 2, "dots": 1, "shot": "/tmp/probe.png"}
```

最小实现（Telegram 版示意）：

```python
import json, subprocess
def sh(*a):
    return subprocess.run(["adb", "-s", SERIAL, "shell", *a], capture_output=True, text=True).stdout

# 打开 Telegram → 截图 → 用 y=... 的角标扫描（复用 tools/watch_probe.py 的 badges()）
print(json.dumps({"ok": True, "unread": 3}))
```

然后把它放进 `$DSH_HOME/skills/phone-ops/unread_probe.py`，
要么改 `scriptsBase` 指向新目录，要么在 `promptTemplate` 里直接写新文件名。
插件完全不知道探针叫什么。

## 4. 换一个「眼睛」

`core/oppo-ai` 把手机自带 AI 包成 MCP 工具。想换成别的视觉服务（本地 Qwen-VL、你自己的 API），
有两条路：

- **换 MCP**：照 `core/oppo-ai/mcp_server.py` 的 stdio JSON-RPC 形状写一个新 server，
  在 `cordis.patch.yml` 里换掉 `serverName` 与命令。skill 里改一句「用 `vision.describe` 看图」即可。
- **只换实现**：`ai.py` 里 `describe()` / `draw()` 是唯一对外函数，保留签名换内核。

## 5. 改插件

只在两件事上值得改：节拍规则、设置页。

- **节拍**：`lib/watch-core.mjs` 是纯函数（`nextDue / isDue / inPeak / inSleep`），
  改完跑 `node --test plugin/dsh-phone-watch/tests/`。不要在里面碰宿主对象。
- **设置页**：`lib/client.js` 注册 `settings.section`，数据走 `webServer.register`
  的 `/dsh-phone-watch/state`，动作走 `/dsh-phone-watch/action`。
- **HTTP 不要用 curl 收尾**：宿主 HTTP 门要浏览器会话凭证，命令行一定 401。收尾走文件收件箱。

## 6. 本地调试

```bash
node --test plugin/dsh-phone-watch/tests/     # 单测
node scripts/install.mjs --dry-run            # 只看会写哪些文件
node scripts/install.mjs --verify             # 只体检
python tools/watch_probe.py --raw             # 带斑点明细，调阈值用
node tools/adb_connect.mjs                    # 看哪个地址活着（不写入）
```

MCP server 的离线自测（不启 dsh）：往 stdin 灌三条 JSON-RPC

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"oppo_describe","arguments":{"image_path":"x.png"}}}' \
  | python core/oppo-ai/mcp_server.py
```

> 改完 `ai.py` 记得杀掉旧的 `mcp_server.py` 进程让宿主重启它，否则你调的是旧代码。

## 7. 提交规范

- 不提交个人配置、PIN、真实 IP、聊天记录、相册截图
- 新增能力优先做成 skill/脚本；动插件核心要带单测
- 改动 UI 自动化后，在 PR 里写清实测机型和版本
