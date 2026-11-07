# oppo-ai — 借用 OPPO 小布助手识图 / 生图

agent 自己吃不了图（当前模型无图像输入）。OPPO 手机自带的小布助手能看图、能画图
（ColorOS / Android 16，包名 com.heytap.speechassist）。别的厂商会另开自己的驱动，比如 vivo-ai、siri-ai，互不影响。
于是把它当外挂：**识图外包给手机，文字答案抓回来**，省 token 也不用换模型。

> 下面所有坐标、resource-id、包名都来自那台样本机的实测结果。换机型 / 换系统版本要重新量一遍，
> 方法不变，数字会变。

## 前置

- adb：`__ADB__`，serial `__SERIAL__`，屏幕 1080x2376
- Python 用 bundled：`__DSH__/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe`（有 Pillow）
- 包名：`com.heytap.speechassist`（小布助手）
  启动：`adb shell am start -n com.heytap.speechassist/.launcher.SpeechAssistMainActivity`
- 脚本目录：`__REPO__/core/oppo-ai/`
  - `aicore.py` 底层：dump XML / 按 resource-id 找坐标点按 / 等文本
  - `ai.py` 主程序

## 文字问答（省 token 的知识通道，已实测）

简单知识/常识问题别自己推理，丢给小布，只把它的最终答案抓回来。
实测 2026-11-04 20:07 问「用一句话解释光合作用」，9 秒出答案，内容正确。

```
adb shell am force-stop com.heytap.speechassist
adb shell am start -n com.heytap.speechassist/.launcher.SpeechAssistMainActivity
sleep 3
adb shell input tap 477 2255      # 点输入框
# 用 phone_action {action:"text", text:"问题"} 写入，input text 中文会乱码
adb shell input keyevent 66        # 只提交输入法组字，不会发送
adb shell input tap 954 1350       # 点 btn_send 发送
sleep 8                            # 简单问题 8~10 秒出答案
uiautomator dump → 读 tv_tts_content
```

关键节点：
- 输入框 `id/et_text_input`（186..768 / 2184..2327），中心 (477,2255)
- 发送 `id/btn_send`（882..1026 / 1278..1422），中心 (954,1350)
- 答案 `id/tv_tts_content`；`id/reasoning_content` 是思考过程，**读答案时跳过**，能省一半以上文本
- 首页推荐问题页的输入框在同一坐标，可直接用，不必先新建对话

坑：
- `keyevent 66` 只提交组字，不会发消息；不点 btn_send 等于没问。
- 答案出现前 observe 到的是思考过程，别当答案是空。
- 「深度思考」默认勾着，简单问题可先点掉（未实测）。

## 中文输入（ADBKeyboard，已实测 2026-11-04 22:47）

人类的输入法不适合脚本。装一个 ADBKeyboard，用广播直接灌文本，中文英文都能过。

安装（一次性）：

```
curl -LO https://github.com/senzhk/ADBKeyBoard/raw/master/ADBKeyboard.apk
adb -s <serial> install -r ADBKeyboard.apk     # 包名 com.android.adbkeyboard
```

用法（`aicore.type_text`，已封装）：

```python
from aicore import type_text, clear_text
type_text("重点说配色和画风，一句话")   # 切 ADBKeyboard → 广播 ADB_INPUT_B64 → 切回原输入法
clear_text()                          # 广播 ADB_CLEAR_TEXT
```

背后就是：`adb shell ime set com.android.adbkeyboard/.AdbIME` →
`adb shell am broadcast -a ADB_INPUT_B64 --es msg <base64>` → 切回原输入法。

坑（都踩过）：
- `adb ime list` 报 `unknown command ime` —— ime 是 shell 子命令，必须 `adb shell ime list -s`。
- `ime list -s` 只列**已启用**的输入法；配置里的 adbIme 不在列表里就说明没启用，别硬发广播。
- 用 `ADB_INPUT_B64` 不用 `ADB_INPUT_TEXT`：后者过 shell 引号转义，中文和空格容易崩。
- 灌完必须切回原输入法（config 的 `ime`，本机是搜狗），不然主人拿到手机是英文键盘。
- 广播灌字不会自动提交（搜狗组字条那类问题不存在），但要发送还得自己点发送按钮或 keyevent 66。
- 文本里不要带真换行：从 shell 传参时 \n 会变成字面量「\\n」灌进输入框（实测微信气泡里直接出现 \n）。要分段就分开发多条，或改用「；」分隔。
- `ADB_CLEAR_TEXT` 在微信里无效（清了没反应）；正确的清空是 `input keycombination 113 29`（Ctrl+A）再 `input keyevent 67`，一次搞定。


## 带图的定向提问（attach + 中文输入 + send + read，已实测）

想要「只回答我关心的点」而不是一段泛泛描述时，走这三步，别用 describe（describe 只会点「描述下这张图」）：

```
python ai.py attach <图片路径>    # 新对话 → 挂图 → 聚焦输入框，输出 ready
# 用 phone_action {observationId, action:"text", text:"重点说配色和画风，一句话"}
python ai.py send                 # 点 btn_send，输出 sent
python ai.py read                 # 轮询 tv_tts_content，返回答案正文
```

实测 2026-11-04 22:36：喂 sample.png，问「重点说配色和画风，一句话」，
约 10 秒出答案，内容按奶白主体 / 低饱和马卡龙配色 / 无描边平涂 Q 版画风逐条说清，
比通用 describe 有用得多（通用描述会先说一堆构图和背景）。

坑（都踩过）：
- **中文别用 `adb shell input text`**：Android 16 上会报
  `NullPointerException ... InputShellCommand.sendText`，静默失败。用 `type_text()`（下节）或 phone_action。
- `adb shell cmd clipboard set-text` 返回 `No shell command implementation.`，也没有其它 shell 剪贴板命令，别找。
- 输入框聚焦状态可从 dump 的 `et_text_input.focused=true` 确认；attach 已负责聚焦。
- send 之后别立刻 read，先 sleep 8~10 秒；read 自己会轮询，但太早会读到空。
- 小布会忽略「一句话」这类长度要求，照样分小节写，答案偏长，抓重点自己截。


## 识图（全自动，已实测）

```
python ai.py describe <图片路径>
```

**已实测跑通一次（12:28，喂 sample.png，25s 出完整描述）。**

流程：force-stop 非必需 → 新对话 → 「更多」→ push 图到 /sdcard/Pictures + MEDIA_SCANNER_SCAN_FILE 广播 →
重开面板 → 点最新缩略图（第 1 格 x=513,y=1442；第 0 格是相机）→ 确认 → 点 chip「描述下这张图」→
轮询 `uiautomator dump` 里的 `tv_tts_content`，拿到整段中文描述。

读答案靠节点，不看图：
- `tv_tts_content` 正式回答
- `reasoning_content` 思考过程、`reasoning_result`「已思考 25s」
- 深度思考开着时约 20~25s 出答案

## 生图（全自动，一条命令出干净方图）

```
python ai.py draw "<prompt>" [1:1|3:4|4:3|9:16] <输出路径>
```

实测 2026-11-04 14:52 跑通：生成 → 分享 → 其他 → 儲存到檔案管理員 → 儲存 → pull → 裁方图，
一条命令约 90 秒，输出 884x884 无卡片的纯图。

内部关键点（改脚本时别踩）：
- 启动前先 `am force-stop com.heytap.speechassist` 再 `am start`，否则可能停在会话页找不到「AI 生图」入口。
- 「AI 生图」是首页输入栏上方那排 chip 的第三个，用 `find_text('AI 生图')` 定位。
- 文件管理器的「儲存」必须按 resource-id `com.coloros.filemanager:id/select_button`，
  **不能按文字**：页面标题「儲存位置」也以「儲存」开头，按文字会点到标题，静默失败（本次踩过）。
- 判断是否存成功：跑之前先 snapshot `/sdcard/Download/img*.png` 文件集合，跑完取差集里的新文件；
  按 mtime 取最新会拿到旧图（不报错但内容错）。
- 导出文件后缀 .png 实为 JPEG，pull 下来改名 .jpg 再喂 Pillow。

### 旧记录：手动链路（留档）

界面入口：输入栏上方那排 `新对话模式 Beta | 深度思考 | AI 生图`，点「AI 生图」弹面板：
风格（水墨风/油画风/羊毛毡/像素风，可横滑）、比例（1:1 / 3:4 / 4:3 / 9:16 / 16:9）、底部输入 prompt。
发送后小布把 prompt 包成「帮我生成图片，主题是…，生成比例是 1:1」。

图生图：会话里已有图片时，生图会参考那张图（本次生成的二次元头像与主人给的图高度相似）。

导出（实测链路）：
1. 生成图上「分享」`iv_forward`(120,1872)
2. 小布分享面板底部「其他」@(924,2260)
3. 系统选择器 `com.android.intentresolver`「分享 1 張圖片」→「檔案管理員 / 儲存到檔案管理員」@(660,2288)
4. `com.coloros.filemanager` 儲存位置（默认 全部檔案 > Download）→ 底部「儲存」@(540,2250)
5. 文件落在 `/sdcard/Download/img<epochms>.png`
6. `MSYS_NO_PATHCONV=1 adb pull /sdcard/Download/imgXXX.png <本地>`
7. **导出的是分享卡片不是纯图**：后缀 .png 实为 JPEG（magic ffd8ffe0），改名 .jpg 才能读；
   卡片 984x1673，上方 prompt 气泡、下方「小布助手」页脚，需裁出中间方图。
   裁剪法：取众数背景色 (241,242,244)，逐行找背景占比<0.35 的连续带（高>80）得 prompt 带与图片带，
   再在图片带内逐列同法得左右边界 → 本次得 884x884。
   脚本：`probe2.py`（行带）/`probe3.py`（列带）/`crop.py`（裁剪）。

### 新版小布（2026-11 起）没有「AI 生图」入口

- 直接当普通对话发「画一幅……」，出图后**点图进全屏 → 底部「保存」**，落盘到 `/sdcard/Pictures/<epoch>.jpg`。
- 这条路上 `ratio` / `style` 无效，比例由模型自己定；想固定比例只能回旧版面板。
- `draw()` 的兼容写法：先试旧面板，捕获 `SystemExit`（消息里含「AI 生图」）再走新路；
  判断新图用 `/sdcard/Pictures` 跑前跑后的文件集合差集，**别按 mtime 取最新**。
- 点图进全屏这一步：新界面里 `iv_pic` 可能被裁到屏幕顶部（bounds 高度只剩 277），点它中心会点到工具栏。
  依次试 `iv_pic` / `holder_layout` / `card_view_layout` / `square_frame_layout`，谁能点出「保存」按钮就用谁。
- 出图后手机停在全屏预览：要回微信先 `am force-stop com.heytap.speechassist`，再 monkey 拉起目标 App。

### 手机端相册「裁剪」别指望自动化

2026-11-06 实测：编辑页里裁剪框钉死就是整张画面，单指拖是**平移**不是缩框，拖四角同理；
缩小取景只能用双指，而 `adb shell sendevent` 写入被 SELinux 拒。
scrcpy 的 Ctrl+左键拖拽（pinch）在查看器里生效，在裁剪页连拖三次都无效，且编辑页截图返回旧帧。
要精确裁图就 pull 回 PC 用 Pillow，别在手机上折腾。

## 坑（血泪）

- **输入法会把 `btn_tools` 顶出屏幕**：任何要点「更多」的地方，先确认 dump 里有 `btn_tools`，没有就 `input keyevent 4` 收键盘。
- **返回键有毒**：在小布页面按 keyevent 4 可能跳到系统设置「個人化資訊與服務」页，不是回上一页。用完记得 `am force-stop`。
- **相册里有支付宝收款码**：微信换头像/选图时点缩略图前必须先 OCR 认图，别手滑（已发生过一次）。
- adb 碰 /sdcard 一律加 `MSYS_NO_PATHCONV=1`，否则路径被 Git-Bash 改写。
- 「添加图片」面板第 0 格是相机；最近图从第 1 格开始，新 push 的排最前。
- uiautomator 在微信里只给空 bounds，小布没问题；微信仍靠 OCR。

## 还可挖的（没做完）

- 小布「识屏」`小布识别屏幕`、AI 翻译、AI 写作 未实测
- 识图`describe` 只喂过两次，还没做过批量/长图/中文小字的稳定性测试
- 小布「识屏」/AI 翻译 / AI 写作 仍未实测

## MCP 工具接入（已完成配置，待重启生效）

把两个能力包成 MCP 工具，任何会话直接调 `mcp__opai__oppo_draw` / `mcp__opai__oppo_describe`，
不用再走 shell。

- server：`__REPO__/core/oppo-ai/mcp_server.py`（纯标准库，stdio JSON-RPC 2.0，
  `initialize` / `tools/list` / `tools/call`；启动即把 `sys.stdout` 换到 stderr，避免 adb 噪声污染协议）
- 工具：
  - `oppo_draw(prompt, ratio?, style?, out_path?)` → `saved <路径> (884x884)`，约 90~150 秒
  - `oppo_describe(image_path)` → 中文描述文本，约 60~150 秒
- 注册位置：`__DSH__/profiles/desktop/cordis.patch.yml` 的 `- insert:` 列表，
  id `mcp-opai`，`serverName: opai`，`transport: stdio`，`toolCallTimeoutMs: 300000`
  （跟已有的 `mcp-phone-control` 一个写法）。备份在 `cordis.patch.yml.bak-opai-<时间戳>`。
- **踩过的坑**：`plugin_manager install_bundle` 走不通 —— 它会跑 pnpm install 整个 profile，
  而 profile 里 `dsh-speak-up` 指向 GitHub tarball，网络 ETIMEDOUT 导致整次安装卡死超时（120s），
  自己那个 config-only bundle 根本没装上。所以改成直接往 profile patch 插一行 mcp-client 条目，
  mcp-client 是 dsh 自带的包，不需要装依赖。
- 生效条件：改 profile patch 要**重启 dsh web** 才合成；重启前 `cordis_inspect_query(Tool/listTools)`
  里看不到 opai 工具属于正常。没设 `failOnStartupError`，所以就算 python 路径错也不会拖累启动。