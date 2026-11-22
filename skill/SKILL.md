---
name: quiet-windows
description: "Use for ANY task that involves a Windows GUI window — opening an app, clicking a dialog, filling a form, reading a control tree, or just taking a screenshot of a window to check what it looks like — especially when the user's desktop must stay usable. Also use when you are about to hand-roll PowerShell P/Invoke, CopyFromScreen, ImageGrab, SetCursorPos, mouse_event, SendKeys or a pip-installed uiautomation script, because those are the exact things this skill replaces."
---

# 静默操作 Windows 界面

目标：把程序开起来、把界面操作完，但**用户一帧都不该看到，键盘焦点也尽量别被抢走**（插件会尽量避免并自动恢复，但不保证零干扰）。

## 先问自己：真的需要界面吗

能用命令行、API、配置文件、`--load-extension`、COM、Playwright 之类解决的，就不要开 GUI。GUI 是最后手段。

## 标准流程

### A. 程序还没开

1. `quiet_launch` —— 传 `exe`，需要的话传 `args`（网址、路径、启动参数）、`width`/`height`。返回 `hwnd`。
2. `quiet_shot` —— 看一眼画面，确认已经加载好。
3. `quiet_tree` —— 读控件树，记下目标控件的 `name` 或 `auto_id`，以及它支持的模式。
4. `quiet_act` —— 按控件操作：输入框 `set`，按钮/链接 `invoke`，标签页和列表项 `select`，勾选框 `toggle`，树节点 `expand`。
5. `quiet_close` —— 收尾，进程不退时加 `kill`。

### B. 程序已经开着（用户自己开的、上一次会话留下的，或你自己用别的办法起的）

1. `quiet_windows` —— 拿 `hwnd`。返回里的 `windows` 是**全部可见顶层窗口**（`offscreen` 只是子集），屏幕上开着的程序也在里面。
2. `quiet_park` —— 把它挪到屏幕外：不激活、不改大小、不抢焦点。用户的桌面不会被打断。
3. 之后同上：`quiet_shot` / `quiet_tree` / `quiet_act`。
4. 这个程序是用户本来就要用的，**收尾时不要 `quiet_close`**，放着就行（窗口留在屏幕外，用户点任务栏图标就回来了）。

> `hwnd` 不要求来自 `quiet_launch`：`quiet_shot` / `quiet_tree` / `quiet_act` 接受任何有效句柄。别因为"这个窗口不是我启动的"就放弃插件、回去手搓 PrintWindow / ImageGrab —— 那是 2026-11 那次 507 次调用零使用的直接原因。

## 预览本地网页（localhost / file://）

**别用会开可见窗口的浏览器通道**（wincu 的 browser lane、headed puppeteer）——它们会在用户屏幕上真的弹出一个窗口，等于把桌面占了。标准做法只有两步：

```
quiet_launch { url: "http://127.0.0.1:4173/", width: 1280, height: 860 }
quiet_shot   { hwnd }
```

`quiet_launch` 只给 `url` 时会自动挑 Edge/Chrome，用独立 profile 离屏打开，并带上 `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding` 这类开关，所以离屏渲染不会变空白。

刷新页面看改动：`quiet_tree` 找到地址栏（`auto_id` 常见是 `address-edit`）用 `quiet_act set` 写新 URL 回车；或者 `quiet_close` 掉重新 `quiet_launch`。

### 什么时候不要用本技能，改用浏览器工具（ego-browser 等）

| 要做的事 | 用什么 |
|---|---|
| 看我这页渲染对不对、截个图确认效果 | **本技能**：`quiet_launch { url }` + `quiet_shot` |
| 在自己的项目里点按钮、走流程做端到端验证 | 本技能（`quiet_tree` + `quiet_act`） |
| 需要**用户的登录态**、真实站点的数据 | **ego-browser 等专用浏览器工具**（本插件的浏览器是独立 profile，没有登录态） |
| 抓 DOM / 执行页面 JS / 填复杂表单 | **专用浏览器工具**（本插件没有 DOM API） |

一句话：**本技能负责"把窗口画出来、看得见但不上屏"；凡是需要登录态和数据抓取的，交给浏览器工具。**

## 四条硬规则（违反就会打扰用户）

- **不要用坐标点击，不要 SendKeys。** 窗口在虚拟屏幕之外，光标会被夹回屏幕内，坐标点击必然落空；而键盘输入会进到用户当前的窗口里。
- **不要最小化，不要 `SW_HIDE`。** 最小化后系统不再合成画面：截图变黑、UI Automation 子树消失，浏览器类应用还会把定时器降频。
- **不要把窗口搬到另一个虚拟桌面。** 实测：搬过去之后从外部重新枚举 UIA 只剩 1 个节点（等于瞎了）；只要那个窗口成为前台，Windows 会把用户的屏幕直接切过去。
- **不要靠"压在别的窗口下面"隐藏。** `Win+D`、任务视图、用户自己最小化窗口，都会把它翻出来。

## 出事时怎么判断

| 现象 | 原因 | 处理 |
|---|---|---|
| `quiet_shot` 报 `looks_blank` | 应用在屏幕外停止绘制 | 换虚拟显示器方案，或短暂接管屏幕；先试 `quiet_tree`，控件模式常常仍然可用 |
| `quiet_shot` 直接报错（没有图片路径） | `PrintWindow` 返回失败，插件不落半黑的图 | 换 `quiet_tree` 走控件模式；确实要画面就短暂接管 |
| `quiet_act` 报"句柄已失效或被复用" | 窗口关了，句柄被系统复用 | 重新 `quiet_windows` 拿新 hwnd，别复用旧值 |
| `quiet_act` 报"控件没找到" | 名字变了或树太深 | 重新 `quiet_tree`，用 `auto_id` 或 `type` 精确定位；必要时调 `depth` |
| 控件有名字但 `invoke` 失败 | 该控件不支持这个模式 | 看树里的模式列表，换 `select`/`toggle`，或改成 `set` 值 |
| 启动返回 `process_mismatch: true` | 窗口属于已运行的进程（浏览器寄生） | 别对这类窗口用 `kill`；开 `isolateProfile`（默认开）或先关掉旧实例 |
| 启动返回 `flashed: true` | 程序不接受启动位置 | 窗口已被立刻挪走；看 `focus_stolen` 判断有没有影响到用户 |
| 启动报"进程立即退出且没有新进程" | 程序把活交给了已有实例 | 浏览器用独立 `--user-data-dir`（默认已开），或先结束旧实例 |

## 文件夹选择框（最常见的卡点）

标题形如「选择扩展程序目录。」的对话框，class 是 `#32770`。它是**独立的顶层窗口**，而且常常由应用的另一个进程创建——按主窗口 PID 或主窗口标题去找，一定找不到。正确的三步：

1. 按 class `#32770` + 标题找到对话框本身，不要按进程过滤。
2. 找它里面的控件：`Edit`（AutomationId 常见是 `1152`，就是"文件夹:"输入框）和标题为「选择文件夹」的按钮（AutomationId 常见是 `1`）。
3. 先 `quiet_act --op set` 把完整路径写进那个 Edit，再 `quiet_act --op invoke` 点「选择文件夹」。**不要双击列表里的文件夹**——那是 shell 的自绘视图，常常没有可用的控件模式。

顺带：如果这个框是"加载已解压的扩展程序"弹出来的，多半可以直接改用 `--load-extension=<目录>` 启动参数，根本不用点。

## 别手搓 P/Invoke（真实踩坑记录）

2026-11 有一个会话，明明 6 个 `quiet_*` 工具和这个技能都在，却在 507 次工具调用里**一次都没用**。它自己的推理里写着「capture the window via quiet_shot」，下一句又变成「Simplest: get the window rect via ctypes and capture that region」，然后手写了这些：

- `SetCursorPos` + `mouse_event` 点屏幕坐标（窗口一被遮住就点错）
- `user32.ShowWindow(h, 9)` + `SetForegroundWindow` 抢前台，再 `ImageGrab.grab(bbox)` 抓屏（把用户的桌面打断了）
- `pip install uiautomation` 再写脚本读控件树（插件里已经有了）
- `SendKeys` 发按键（焦点不在就发到别处）

这些正是本技能要替代的。判断标准很简单：**只要你在写 `DllImport`、`mouse_event`、`ImageGrab`、`CopyFromScreen`、`SendKeys` 或 `pip install uiautomation`，先停一下——你要的东西 `quiet_*` 里都有。**

## 收尾

用完 `quiet_close`。屏幕外的窗口用户看不见，忘了关就会留下一串隐形进程。
