# dsh-quiet-windows

让 agent 在屏幕上「看不见的地方」启动并操作 Windows 图形界面。

窗口从创建起就停在所有显示器之外，agent 用 UI Automation 读控件、点控件，用 PrintWindow 截图——不吃遮挡、不怕离屏，并尽量避免抢键盘焦点。

## 工具

| 工具 | 作用 |
|---|---|
| `quiet_launch` | 屏幕外启动程序，返回 `hwnd`；只传 `url` 时自动挑浏览器离屏打开网页 |
| `quiet_windows` | 列出**所有**可见顶层窗口（含屏幕上开着的）、显示器布局与 DPI |
| `quiet_park` | 把已经开着的窗口挪到屏幕外（不激活、不改大小），接管用户自己的程序 |
| `quiet_shot` | 截图（窗口在屏幕外或完全被遮挡都拿得到） |
| `quiet_tree` | 读 UI Automation 控件树 |
| `quiet_act` | 按控件执行 invoke / set / select / toggle / expand |
| `quiet_close` | 收尾关闭；共享进程的窗口不会被强杀 |

`hwnd` 不要求来自 `quiet_launch`：`quiet_windows` 列出的任何窗口，或者你自己用别的方式找到的句柄，都可以直接交给 `quiet_shot` / `quiet_tree` / `quiet_act`。屏幕上已经开着的窗口先 `quiet_park` 挪走，再操作。

## 安装

```json
plugin_manager install_bundle  target: "<tgz 的绝对路径>"
```

装完重启 DSH，新会话即可在工具列表里看到 `quiet_*`。

## 依赖

- Windows 10/11
- Python 3，且装有 `pywin32`、`uiautomation`、`comtypes`、`Pillow`
  （插件会自动探测解释器；DSH 自带的运行时 Python 没有 pywin32，不能直接用）

## 测试

```powershell
python -m unittest discover -s tests -p "test_*.py"   # 纯逻辑，不开窗口
node --test tests/tools.test.mjs                       # 会启动离屏窗口（看不见，但真的有进程）
python tests/regress_browser.py --run                  # 会真的拉起浏览器，较慢
```

`npm test` 等价于上面第二条；`npm run test:pure` 只跑不开窗口的那部分。

## 安全边界

- **强杀只对本插件启动的进程开放。** `quiet_close` 的 `kill=true` 遇到用户自己开着的窗口（`quiet_windows` 列出来的）会直接跳过，只发正常关闭请求——那可能是他的浏览器或编辑器，里面还有没保存的东西。
- **取消/超时会补清理。** 宿主掐掉辅助进程时，启动记录（`%TEMP%\dsh-quiet-launch\*.json`）里有 pid 和 profile，宿主侧会照着它结束进程树、删临时目录。
- **临时 profile 会回收。** 正常关闭后随进程一起删除；启动失败、进程已死的记录会在下次启动时清掉；6 小时内仍活着的实例不会被误删。
- **`quiet_park` 需要 pid。** 句柄会被系统复用，没有进程 id 的句柄一律拒绝操作；`restore: true` 可以把它放回原位。

## 限制

- 只走控件模式：坐标点击在屏幕外不可用。
- 少数应用在屏幕外停止绘制，此时截图会报 `looks_blank`。
- 焦点是「尽量避免并自动恢复」，不是零干扰保证。
- 仅 Windows。

详细说明与设计取舍见 [docs/DETAIL.md](docs/DETAIL.md)。
