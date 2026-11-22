# 静默窗口（dsh-quiet-windows）

智能体需要打开一个图形界面才能继续任务时，最烦人的是它把窗口甩到你桌面正中。这个插件把那条路换掉：**窗口从创建起就停在你所有显示器之外**，智能体照样能读它、点它、截图看它，但你一帧也看不到。

## 它能做什么

| 工具 | 作用 |
|---|---|
| `quiet_launch` | 在屏幕外启动程序，返回窗口句柄 `hwnd`；只给 `url` 时自动挑浏览器离屏打开网页 |
| `quiet_windows` | 列出**所有**可见顶层窗口（含屏幕上开着的），附带显示器布局、系统 DPI、前台窗口 |
| `quiet_park` | 把已经在运行的窗口挪到屏幕外，不激活、不改大小 —— 用来接管用户自己开的程序 |
| `quiet_shot` | 截图（PrintWindow）：窗口在屏幕外、被完全遮挡都拿得到画面 |
| `quiet_tree` | 读 UI Automation 控件树：类型、文字、class、AutomationId、可用模式 |
| `quiet_act` | 按控件执行 invoke / set / select / toggle / expand，不依赖前台与坐标 |
| `quiet_close` | 收尾，先正常关闭再按需强杀 |

`hwnd` 不要求由 `quiet_launch` 产生，`quiet_shot` / `quiet_tree` / `quiet_act` / `quiet_close` 接受任何有效句柄。

## 典型流程

### A. 程序还没开

1. `quiet_launch` 启动程序（网址、文件路径、启动参数一起给）。
2. `quiet_shot` 看一眼当前画面，确认加载完成。
3. `quiet_tree` 找到目标控件的名字或 `AutomationId`。
4. `quiet_act` 直接操作那个控件（输入框用 `set`，按钮用 `invoke`，标签页用 `select`）。
5. `quiet_close` 关掉它。

### B. 程序已经开着（用户自己打开的，或者上一次会话留下的）

1. `quiet_windows` 拿到 `hwnd`（`windows` 里有全部可见窗口，`offscreen` 只是子集）。
2. `quiet_park` 把它挪到屏幕外——不激活、不改大小，用户的桌面不受打扰。
3. 之后同上：`quiet_shot` / `quiet_tree` / `quiet_act`。
4. 如果这个程序本来就是用户开着的、还要继续用，**别 `quiet_close`**：操作完保持原样即可（窗口留在屏幕外，用户下次从任务栏点它就回来了）。

### C. 预览本地网页

1. `quiet_launch` 只传 `url`（如 `http://127.0.0.1:4173/`、`file:///D:/x/demo.html`），自动挑 Edge/Chrome 离屏打开。
2. `quiet_shot` 截图看渲染效果。

这个场景**不要**用会弹可见窗口的浏览器通道（wincu 的 browser lane、headed puppeteer）。但反过来，需要**登录态、真实站点交互、抓 DOM** 时要用 ego-browser 这类专用浏览器工具——本插件的浏览器是独立 profile，没有登录态也没有 DOM API。

## 运行前提

- Windows 10 / 11。
- 一个装好 **pywin32、uiautomation、comtypes、Pillow** 的 Python 3。

插件不盲信 `python` 这个名字：它按 `pythonPath` 配置 → `python` → `py -3` → 常见安装目录的顺序逐个探测，并用 `import win32gui, uiautomation, comtypes, PIL` 实际验证。全部失败时，工具会直接报出一条能照做的错误，列出试过哪些解释器、各自缺什么。

**注意**：DSH 自带的运行时 Python 只有 Pillow，没有 pywin32，不能指向它。

## 为什么不是「把它放到另一个虚拟桌面」

实测过，不行：

- 窗口搬到别的虚拟桌面后，**从外部重新枚举它的 UI Automation 子树会失败**（只剩 1 个节点），智能体等于瞎了；只有搬之前抓在手里的元素还能用。
- 一旦某个操作让那个窗口成为前台，**Windows 会把你的屏幕直接切到它所在的虚拟桌面**——比占屏更打扰。
- 隐藏或最小化的窗口**搬不到虚拟桌面**（没有 AppView），想“零闪现进桌面”根本做不到。

## 为什么不是「最小化」或「压在别的窗口下面」

- 最小化后系统不再为它合成画面：截图变黑、UIA 子树消失，而且浏览器一类应用会把定时器降频，等进度会卡死。
- 压在下面只是“看不见”：`Win+D`、任务视图、你自己把窗口最小化，都会把它翻出来。

## 安全边界

这版把"能动谁"的边界写进了代码，不只是文档：

| 场景 | 行为 |
|---|---|
| `quiet_close { hwnd, kill: true }`，窗口是 `quiet_launch` 启动的 | 允许结束进程树；结束后实测进程是否真的没了（`kill_verified`） |
| 同上，但窗口是 `quiet_windows` 列出来的（用户自己的程序） | **拒绝强杀**，只发 `WM_CLOSE`；返回 `kill_skipped` 说明原因 |
| 窗口属于共享进程（没拿到独立 profile，可能寄生进用户的浏览器） | 同上，拒绝强杀 |
| 宿主超时或被取消 | Python 辅助进程会被直接掐掉，它的清理逻辑跑不到；宿主照着 `%TEMP%\dsh-quiet-launch\*.json` 里的 pid/profile 补一刀（`reap`） |
| 浏览器正常关闭 | 进程退出后删除本次的临时 profile |
| `quiet_park` 收到不认识的 hwnd | 拒绝执行——没有 pid 就无法排除句柄复用，动错窗口比不操作更糟 |

启动记录在真正启动进程**之后立刻**落盘，因为超时可能发生在任何时刻。

## 限制（都是实测结论）

- **坐标点击不可用**。窗口在虚拟屏幕之外，`SetCursorPos` 会被夹回屏幕范围。所以本插件只走控件模式；碰到处处画布的应用（游戏、远程桌面、部分自绘界面），必须短暂接管屏幕。
- **截图可能变黑**：应用若在离屏时停止绘制，`quiet_shot` 会报 `looks_blank`；如果 `PrintWindow` 本身失败，插件**不会落盘**，而是直接报错——半黑的图比“没有图”更容易骗到模型。
- **焦点是“尽量避免”，不是零干扰**。窗口显示前会被加上 `WS_EX_NOACTIVATE`，使它无法被常规激活；万一仍被抢走，插件会把前台还回去。但没有任何用户态手段能 100% 阻止所有程序的抢焦点行为。
- **仅 Windows**。

## 浏览器与进程归属

浏览器会把新窗口交给已经运行的实例，新进程随即退出——这时窗口属于旧进程，`kill` 可能把用户整个浏览器带走。所以：

- 启动 `msedge / chrome / brave / firefox` 时**默认开独立 profile**（放在 `%TEMP%\dsh-quiet-profiles`，每次启动顺手清理 6 小时前的旧目录）。
- 返回里的 `pid` 一律是**窗口所属进程**，启动器进程单独放在 `proc_pid`；两者不一致时 `process_mismatch` 为 `true`。
- 属于共享进程的窗口**不会被执行 `--kill`**，只关闭窗口本身。

## 句柄安全

Windows 会复用窗口句柄。插件为每个启动的窗口记录 `hwnd → pid`，之后每次 `shot / tree / act / close` 都带上 `--expect-pid` 交给 helper 校验：句柄失效或被复用会直接拒绝，而不是操作到别的窗口上。

## 测试

```powershell
# 不碰桌面：纯计算 + 句柄校验 + 工具层
python -m unittest discover -s tests -p "test_*.py"
node --test tests/tools.test.mjs

# 会真的拉起浏览器（独立 profile、离屏），验证进程归属与截图
python tests/regress_browser.py --run
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `quiet-windows` 这一行的 `config`：

```yaml
- id: quiet-windows
  name: 'dsh-quiet-windows'
  config:
    pythonPath: C:\Python312\python.exe
    timeoutMs: 120000
    launchTimeoutMs: 180000
```

`launchTimeoutMs` 是「等窗口出现」的总预算，helper 自身会收到比它小 8 秒的等待上限，确保超时也能返回结构化错误而不是被掐断。
