#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""quietwin —— 把 GUI 窗口停在所有显示器之外，再用 UI Automation 操作它。

设计约束（都是实测出来的，别改）：
  * 进程必须 DPI-aware，否则 175% 缩放下 PrintWindow 只截到左上角一块。
  * 窗口必须保持 visible（不是最小化、不是 SW_HIDE）：最小化后 DWM 不合成、
    UIA 子树取不到。所以做法是 "先隐藏启动 -> 摆到屏幕外 -> SW_SHOWNOACTIVATE"。
  * 屏幕外坐标取所有显示器并集之外，负方向，留 200px 余量。
  * 不要把窗口搬到别的虚拟桌面：一旦它成为前台，Windows 会把你切过去。
  * 动作前后记住/还原前台窗口，否则会把用户的键盘焦点抢到离屏窗口里。

子命令：launch / list / shot / tree / act / close / state
输出统一 JSON（--json）或人读文本。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import ctypes
import win32api
import win32con
import win32gui
import win32process

BROWSERS = ("msedge.exe", "chrome.exe", "brave.exe", "firefox.exe", "thorium.exe")
MARGIN = 200
DWMWA_CLOAKED = 14
# 浏览器的临时 profile 全放这里；每次启动顺手清掉过期的，免得 %TEMP% 越滚越大。
PROFILE_ROOT = os.path.join(tempfile.gettempdir(), "dsh-quiet-profiles")
PROFILE_MAX_AGE_HOURS = 6.0


def sweep_profiles(max_age_hours: float = PROFILE_MAX_AGE_HOURS) -> int:
    removed = 0
    try:
        if not os.path.isdir(PROFILE_ROOT):
            return 0
        cutoff = time.time() - max_age_hours * 3600
        for entry in os.scandir(PROFILE_ROOT):
            try:
                if entry.is_dir() and entry.stat().st_mtime < cutoff:
                    shutil.rmtree(entry.path, ignore_errors=True)
                    removed += 1
            except Exception:
                continue
    except Exception:
        pass
    return removed


# ---------------------------------------------------------------- win32 helpers
def dpi_aware() -> None:
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass


def monitors() -> list[tuple[int, int, int, int]]:
    """所有显示器的矩形（物理像素，调用方必须已 DPI-aware）。"""
    try:
        import win32api

        return [tuple(m[2]) for m in win32api.EnumDisplayMonitors()]
    except Exception:
        return [(
            win32gui.GetSystemMetrics(76), win32gui.GetSystemMetrics(77),
            win32gui.GetSystemMetrics(76) + win32gui.GetSystemMetrics(78),
            win32gui.GetSystemMetrics(77) + win32gui.GetSystemMetrics(79),
        )]


def offscreen_origin(width: int, height: int) -> tuple[int, int]:
    """一块完全落在所有显示器之外的矩形左上角。"""
    left = min(m[0] for m in monitors())
    top = min(m[1] for m in monitors())
    return left - width - MARGIN, top - height - MARGIN


def pids_of_image(name: str) -> set[int]:
    import ctypes.wintypes as wt

    class PROCESSENTRY32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
            ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)), ("th32ModuleID", wt.DWORD),
            ("cntThreads", wt.DWORD), ("th32ParentProcessID", wt.DWORD),
            ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
            ("szExeFile", ctypes.c_char * 260),
        ]

    snap = ctypes.windll.kernel32.CreateToolhelp32Snapshot(2, 0)
    ent = PROCESSENTRY32()
    ent.dwSize = ctypes.sizeof(PROCESSENTRY32)
    pids: set[int] = set()
    ok = ctypes.windll.kernel32.Process32First(snap, ctypes.byref(ent))
    while ok:
        if ent.szExeFile.decode(errors="ignore").lower() == name.lower():
            pids.add(ent.th32ProcessID)
        ok = ctypes.windll.kernel32.Process32Next(snap, ctypes.byref(ent))
    ctypes.windll.kernel32.CloseHandle(snap)
    return pids


def top_windows(pids: set[int] | None = None) -> list[int]:
    out: list[int] = []

    def cb(h, _):
        if not win32gui.IsWindow(h) or win32gui.GetParent(h) != 0:
            return True
        if pids is not None:
            _, pid = win32process.GetWindowThreadProcessId(h)
            if pid not in pids:
                return True
        out.append(h)
        return True

    win32gui.EnumWindows(cb, None)
    return out


def park(hwnd: int, x: int, y: int, activate: bool = False) -> None:
    flags = win32con.SWP_NOSIZE | win32con.SWP_NOZORDER
    if not activate:
        flags |= win32con.SWP_NOACTIVATE
    win32gui.SetWindowPos(hwnd, 0, x, y, 0, 0, flags)


def is_offscreen(hwnd: int) -> bool:
    l, t, r, b = win32gui.GetWindowRect(hwnd)
    for ml, mt, mr, mb in monitors():
        if r > ml and l < mr and b > mt and t < mb:
            return False
    return True


def cloaked(hwnd: int):
    val = ctypes.c_int(0)
    hr = ctypes.windll.dwmapi.DwmGetWindowAttribute(
        hwnd, DWMWA_CLOAKED, ctypes.byref(val), ctypes.sizeof(val))
    return val.value if hr == 0 else None


def no_activate(hwnd: int) -> bool:
    """给屏幕外窗口加上 WS_EX_NOACTIVATE：它再也不会成为前台窗口。

    UIA 的 SetValue 之类动作会让控件调用 SetFocus，把离屏窗口顶上前台，抢走用户的键盘焦点。
    加上这个样式后，窗口仍能被 UIA 读写，但永不激活。
    """
    try:
        ex = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
        if ex & win32con.WS_EX_NOACTIVATE:
            return True
        win32gui.SetWindowLong(hwnd, win32con.GWL_EXSTYLE, ex | win32con.WS_EX_NOACTIVATE)
        win32gui.SetWindowPos(
            hwnd, 0, 0, 0, 0, 0,
            win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_NOZORDER
            | win32con.SWP_NOACTIVATE | win32con.SWP_FRAMECHANGED,
        )
        return bool(win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE) & win32con.WS_EX_NOACTIVATE)
    except Exception:
        return False


def force_foreground(hwnd: int) -> bool:
    """把前台还给 hwnd。

    Windows 的前台锁会让后台进程的 SetForegroundWindow 直接失败（返回 0，不抛异常）。
    绕法：把自己挂到当前前台线程和目标线程的输入队列上，再调一次。
    """
    if not hwnd or not win32gui.IsWindow(hwnd):
        return False
    try:
        if win32gui.GetForegroundWindow() == hwnd:
            return True
        cur = win32api.GetCurrentThreadId()
        fg = win32gui.GetForegroundWindow()
        fg_tid = win32process.GetWindowThreadProcessId(fg)[0] if fg else 0
        tgt_tid = win32process.GetWindowThreadProcessId(hwnd)[0]
        attached = []
        for tid in (fg_tid, tgt_tid):
            if tid and tid != cur:
                try:
                    win32process.AttachThreadInput(cur, tid, True)
                    attached.append(tid)
                except Exception:
                    pass
        try:
            win32gui.BringWindowToTop(hwnd)
            win32gui.SetForegroundWindow(hwnd)
        finally:
            for tid in attached:
                try:
                    win32process.AttachThreadInput(cur, tid, False)
                except Exception:
                    pass
        time.sleep(0.08)
        return win32gui.GetForegroundWindow() == hwnd
    except Exception:
        return False


def describe(hwnd: int) -> dict:
    try:
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        return {
            "hwnd": hwnd,
            "pid": win32process.GetWindowThreadProcessId(hwnd)[1],
            "title": win32gui.GetWindowText(hwnd),
            "class": win32gui.GetClassName(hwnd),
            "rect": [l, t, r, b],
            "visible": bool(win32gui.IsWindowVisible(hwnd)),
            "minimized": bool(win32gui.IsIconic(hwnd)),
            # 最小化窗口的矩形是 (-32000,-32000)，也在所有显示器之外 —— 那不是"安静窗口"，
            # 只是被最小化了，必须排除，否则列表里全是用户自己的程序。
            "offscreen": bool(win32gui.IsIconic(hwnd)) is False and is_offscreen(hwnd),
            "cloaked": cloaked(hwnd),
        }
    except Exception as exc:  # window died
        return {"hwnd": hwnd, "error": f"{type(exc).__name__}: {exc}"}


def verify_pid(hwnd: int, expect: int | None) -> dict | None:
    """句柄会被系统复用：动手前确认它还是当初那个进程的窗口。"""
    if not expect:
        return None
    try:
        actual = win32process.GetWindowThreadProcessId(hwnd)[1]
    except Exception as exc:
        return {"ok": False, "hwnd": hwnd, "error": f"窗口已不存在：{type(exc).__name__}: {exc}"}
    if actual != expect:
        return {"ok": False, "hwnd": hwnd,
                "error": f"句柄已失效或被复用（期望 pid {expect}，实际 {actual}）；"
                         f"请重新 quiet_windows 拿一个新的 hwnd"}
    return None


def park_existing(hwnd: int, allow_activate: bool = False) -> dict:
    """把一个已经在运行的窗口挪到所有显示器之外，不激活、不改大小。

    这是「接管用户自己开的程序」的入口：先 park 到屏幕外，再 shot / tree / act，
    全程不需要把窗口搬到屏幕内，也不会把用户的桌面顶掉。
    """
    if not win32gui.IsWindow(hwnd):
        return {"ok": False, "hwnd": hwnd, "error": "窗口不存在（hwnd 已失效）"}
    before_fg = win32gui.GetForegroundWindow()
    before = describe(hwnd)
    if before.get("error"):
        return {"ok": False, "hwnd": hwnd, "error": before["error"]}

    if win32gui.IsIconic(hwnd):
        # 最小化窗口的矩形是 (-32000,-32000)，先就地恢复但不激活，否则挪动没有意义。
        win32gui.ShowWindow(hwnd, win32con.SW_SHOWNOACTIVATE)
        time.sleep(0.35)

    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    width, height = max(1, right - left), max(1, bottom - top)
    x, y = offscreen_origin(width, height)
    park(hwnd, x, y, activate=allow_activate)
    time.sleep(0.25)

    after = describe(hwnd)
    return {
        "ok": True,
        "hwnd": hwnd,
        "before": before.get("rect"),
        "after": after.get("rect"),
        "offscreen": after.get("offscreen"),
        "focus_stolen": bool(before_fg != win32gui.GetForegroundWindow()),
        "note": "窗口现在在所有显示器之外；用 shot / tree / act 操作它，收尾用 close。",
    }


# ------------------------------------------------------------------- capture
def shot(hwnd: int, out: str) -> dict:
    """截窗口画面。PrintWindow 失败就不落盘 —— 半黑的图比"没有图"更容易骗到模型。"""
    import win32ui
    from PIL import Image

    l, t, r, b = win32gui.GetWindowRect(hwnd)
    w, h = r - l, b - t
    if w <= 0 or h <= 0:
        return {"ok": False, "error": "窗口没有可截取区域（可能已最小化）", "rect": [l, t, r, b]}

    hdc = win32gui.GetWindowDC(hwnd)
    src = mem = bmp = None
    try:
        src = win32ui.CreateDCFromHandle(hdc)
        mem = src.CreateCompatibleDC()
        bmp = win32ui.CreateBitmap()
        bmp.CreateCompatibleBitmap(src, w, h)
        mem.SelectObject(bmp)
        ok = ctypes.windll.user32.PrintWindow(hwnd, mem.GetSafeHdc(), 2)  # PW_RENDERFULLCONTENT
        if not ok:
            return {"ok": False, "hwnd": hwnd,
                    "error": "PrintWindow 返回失败；这个窗口可能不响应 WM_PRINT（硬件合成/受保护内容）",
                    "rect": [l, t, r, b]}
        info = bmp.GetInfo()
        img = Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]),
                               bmp.GetBitmapBits(True), "raw", "BGRX", 0, 1)
        gray = img.convert("L")
        uniq = len(gray.getcolors(maxcolors=1 << 18) or [])
        extrema = gray.getextrema()
        os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
        img.save(out)
        return {
            "ok": True, "path": os.path.abspath(out), "hwnd": hwnd,
            "width": img.width, "height": img.height,
            "unique_gray": uniq, "range": list(extrema),
            # 纯色/黑图 => 这个应用在屏幕外不画，应降级
            "looks_blank": uniq <= 3 or (extrema[1] - extrema[0] < 8),
        }
    finally:
        try:
            if bmp is not None:
                win32gui.DeleteObject(bmp.GetHandle())
        except Exception:
            pass
        try:
            if mem is not None:
                mem.DeleteDC()
        except Exception:
            pass
        try:
            if src is not None:
                src.DeleteDC()
        except Exception:
            pass
        try:
            win32gui.ReleaseDC(hwnd, hdc)
        except Exception:
            pass


# ---------------------------------------------------------------- uia helpers
def uia_root(hwnd: int):
    import uiautomation as auto

    return auto.ControlFromHandle(hwnd)


def walk(ctrl, depth: int, out: list, path: str = "0") -> None:
    if depth < 0:
        return
    try:
        kids = ctrl.GetChildren()
    except Exception:
        return
    for i, k in enumerate(kids):
        p = f"{path}.{i}"
        try:
            rect = k.BoundingRectangle
            item = {
                "path": p,
                "type": k.ControlTypeName,
                "name": k.Name,
                "class": k.ClassName,
                "auto_id": getattr(k, "AutomationId", "") or "",
                "rect": [rect.left, rect.top, rect.right, rect.bottom],
            }
            pats = []
            for name in ("InvokePattern", "ValuePattern", "SelectionItemPattern",
                         "TogglePattern", "ExpandCollapsePattern", "TextPattern"):
                try:
                    if name == "ValuePattern" and k.ControlTypeName not in ("EditControl", "ComboBoxControl"):
                        continue
                    if getattr(k, f"Get{name}")().__class__ and True:
                        pats.append(name[:-7].lower())
                except Exception:
                    continue
            item["patterns"] = sorted(set(pats))
            out.append(item)
        except Exception:
            continue
        walk(k, depth - 1, out, p)


def find(ctrl, budget: int = 6000, max_depth: int = 14, **want):
    """在树里按 name/class/auto_id/type 找一个控件，返回 (control, path)。

    遍历**所有**子节点（不再限定几种容器类型）——按钮、CustomControl 底下也常挂着内容，
    只钻"容器白名单"会漏。规模靠 budget（节点预算）与 max_depth 兜住。
    """
    if not any(want.get(k) for k in ("name", "exact_name", "class", "auto_id", "type")):
        return None, None
    queue = [(ctrl, "0", 0)]
    seen = 0
    while queue and seen < budget:
        cur, path, depth = queue.pop(0)
        seen += 1
        try:
            kids = cur.GetChildren()
        except Exception:
            continue
        for i, k in enumerate(kids):
            p = f"{path}.{i}"
            try:
                match = True
                if want.get("name") and want["name"] not in k.Name:
                    match = False
                if want.get("exact_name") and want["exact_name"] != k.Name:
                    match = False
                if want.get("class") and want["class"] not in k.ClassName:
                    match = False
                if want.get("auto_id") and want["auto_id"] != getattr(k, "AutomationId", ""):
                    match = False
                if want.get("type") and want["type"] != k.ControlTypeName:
                    match = False
            except Exception:
                continue
            if match:
                return k, p
            if depth + 1 < max_depth:
                queue.append((k, p, depth + 1))
    return None, None


def act(hwnd: int, op: str, value: str | None, selector: dict) -> dict:
    import uiautomation as auto  # noqa: F401

    fg_before = win32gui.GetForegroundWindow()
    root = uia_root(hwnd)
    target, path = find(root, **selector)
    if target is None:
        return {"ok": False, "error": "control not found", "selector": selector,
                "foreground_restored": False}
    try:
        if op == "invoke":
            target.GetInvokePattern().Invoke()
        elif op == "set":
            target.GetValuePattern().SetValue(value or "")
        elif op == "select":
            target.GetSelectionItemPattern().Select()
        elif op == "toggle":
            target.GetTogglePattern().Toggle()
        elif op == "expand":
            target.GetExpandCollapsePattern().Expand()
        elif op == "collapse":
            target.GetExpandCollapsePattern().Collapse()
        elif op == "focus":
            target.SetFocus()
        else:
            return {"ok": False, "error": f"unknown op {op}"}
        res = {"ok": True, "op": op, "path": path, "target": target.Name,
               "type": target.ControlTypeName}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "path": path}

    time.sleep(0.25)
    # 焦点护栏：把前台还给用户
    restored = False
    fg_after = win32gui.GetForegroundWindow()
    if fg_after != fg_before and fg_before:
        restored = force_foreground(fg_before)
    res["foreground_before"] = fg_before
    res["foreground_after"] = fg_after
    res["foreground_restored"] = restored
    return res


# --------------------------------------------------------------------- launch
def launch(exe: str, args: list[str], width: int, height: int, timeout: float,
           title_re: str | None, keep_hidden: bool, allow_activate: bool = False,
           isolate: bool = True, keep_on_failure: bool = False) -> dict:
    name = os.path.basename(exe).lower()
    fg0 = win32gui.GetForegroundWindow()
    ox, oy = offscreen_origin(width, height)
    before = pids_of_image(name)

    extra = list(args)
    isolated_profile = None
    # 浏览器默认开独立 profile：否则已运行的浏览器会把新窗口收进旧进程，新进程立刻退出。
    # 那时我们既不知道窗口属于谁，close --kill 还可能把用户整个浏览器带走。
    if name in BROWSERS and isolate and not any(
            a.lower().startswith("--user-data-dir") for a in extra):
        sweep_profiles()
        isolated_profile = os.path.join(
            PROFILE_ROOT, f"{name.replace('.exe', '')}-{time.time_ns()}")
        extra = [f"--user-data-dir={isolated_profile}", "--no-first-run",
                 "--no-default-browser-check", *extra]

    if name in BROWSERS:
        # Chromium 支持在创建时就定位置，能真正做到零闪现
        cmd = [exe, f"--window-position={ox},{oy}", f"--window-size={width},{height}",
               "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
               "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling", *extra]
    else:
        cmd = [exe, *extra]

    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = win32con.SW_HIDE
    proc = subprocess.Popen(cmd, startupinfo=si, close_fds=True)

    def cleanup(reason: str) -> dict:
        """启动失败时收拾现场：不留下看不见的进程和临时 profile。"""
        killed = False
        if not keep_on_failure:
            try:
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                               capture_output=True)
                killed = True
            except Exception:
                killed = False
        if isolated_profile:
            shutil.rmtree(isolated_profile, ignore_errors=True)
        return {"ok": False, "error": reason, "proc_pid": proc.pid,
                "cleaned": killed, "isolated_profile": isolated_profile,
                "launched": cmd}

    deadline = time.time() + timeout
    hwnd = None
    flashed = False
    while time.time() < deadline:
        fresh = pids_of_image(name) - before
        if proc.poll() is not None and not fresh:
            return cleanup(
                "启动的进程立即退出且没有新进程出现：该程序很可能把窗口交给了已运行的实例。"
                "浏览器请使用独立 --user-data-dir（本插件默认已开），或先关掉旧实例再试。")
        new = fresh | {proc.pid}
        cands = [h for h in top_windows(new)
                 if win32gui.GetWindowText(h) and win32gui.GetClassName(h) != "IME"]
        if title_re:
            cands = [h for h in cands if re.search(title_re, win32gui.GetWindowText(h))]
        if cands:
            hwnd = max(cands, key=lambda h: len(win32gui.GetWindowText(h)))
            if win32gui.IsWindowVisible(hwnd) and not is_offscreen(hwnd):
                flashed = True        # 真的出现在用户屏幕上了，立刻挪走
                l2, t2, r2, b2 = win32gui.GetWindowRect(hwnd)
                park(hwnd, *offscreen_origin(max(r2 - l2, 1), max(b2 - t2, 1)))
            break
        time.sleep(0.15)

    if hwnd is None:
        return cleanup(f"等待窗口超时（{timeout:.0f} 秒）")

    # 摆好位置再显示；期间反复检查，绝不让它停在屏幕内。
    # 注意：必须按窗口"真实尺寸"重算屏幕外原点 —— 有些程序不理会请求的宽高
    # （charmap 固定 1051x875），只挪位置会有一角露在屏幕里。
    for _ in range(20):
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        w, h = max(r - l, 1), max(b - t, 1)
        ox, oy = offscreen_origin(w, h)
        if not is_offscreen(hwnd) or (r - l) != width or (b - t) != height:
            if win32gui.IsWindowVisible(hwnd) and not is_offscreen(hwnd):
                flashed = True
            win32gui.SetWindowPos(
                hwnd, 0, ox, oy, width, height,
                win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE)
        if not keep_hidden:
            # 先上 NOACTIVATE 再显示，连"首帧抢一下前台"都不给它。
            if not allow_activate:
                no_activate(hwnd)
            win32gui.ShowWindow(hwnd, win32con.SW_SHOWNOACTIVATE)
        time.sleep(0.15)

    info = describe(hwnd)
    window_pid = info.get("pid")
    mismatch = window_pid != proc.pid
    # 永不激活：否则 UIA 的 SetFocus / 控件刷新会把离屏窗口顶上前台，抢走键盘焦点。
    info["no_activate"] = False if allow_activate else no_activate(hwnd)
    # 焦点护栏：首次 ShowWindow 仍可能把新窗口顶上前台；发现就还回去。
    focus_stolen = False
    try:
        focus_stolen = bool(fg0) and win32gui.GetForegroundWindow() != fg0
        if focus_stolen and win32gui.IsWindow(fg0):
            force_foreground(fg0)
    except Exception:
        pass
    info.update({
        "ok": True,
        # pid 一律是「窗口所属进程」，启动器进程单独放 proc_pid —— 两者可能不同。
        "pid": window_pid,
        "window_pid": window_pid,
        "proc_pid": proc.pid,
        "process_mismatch": mismatch,
        "shared_process": mismatch,
        "isolated_profile": isolated_profile,
        "flashed": flashed,
        "focus_stolen": focus_stolen,
        "park_origin": [ox, oy],
        "launched": cmd,
    })
    return info


# ----------------------------------------------------------------------- main
def main() -> int:
    dpi_aware()
    # --json 允许出现在任意位置（subparser 之前或之后），先摘掉再解析。
    raw = sys.argv[1:]
    want_json = "--json" in raw
    raw = [x for x in raw if x != "--json"]

    ap = argparse.ArgumentParser(prog="quietwin")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("launch")
    p.add_argument("--exe", required=True)
    p.add_argument("--arg", action="append", default=[])
    # 参数里常带 '-' 开头（Chromium 开关就是），逐项 --arg 会被 argparse 当成选项，
    # 所以再给一个 JSON 数组入口。
    p.add_argument("--argv-json", default=None)
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=860)
    p.add_argument("--timeout", type=float, default=25.0)
    p.add_argument("--title", default=None)
    p.add_argument("--keep-hidden", action="store_true")
    p.add_argument("--allow-activate", action="store_true")
    p.add_argument("--no-isolate", action="store_true",
                   help="浏览器不启用独立 profile（默认启用；关掉后可能寄生到已运行的浏览器里）")
    p.add_argument("--keep-on-failure", action="store_true",
                   help="启动失败时不结束已拉起的进程，留给你自己排查")

    sub.add_parser("list")

    p = sub.add_parser("park")
    p.add_argument("--hwnd", type=int, required=True)
    p.add_argument("--expect-pid", type=int, default=None)
    p.add_argument("--allow-activate", action="store_true")

    p = sub.add_parser("shot")
    p.add_argument("--hwnd", type=int, required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--expect-pid", type=int, default=None)

    p = sub.add_parser("tree")
    p.add_argument("--hwnd", type=int, required=True)
    p.add_argument("--depth", type=int, default=4)
    p.add_argument("--expect-pid", type=int, default=None)

    p = sub.add_parser("act")
    p.add_argument("--hwnd", type=int, required=True)
    p.add_argument("--op", required=True,
                   choices=["invoke", "set", "select", "toggle", "expand", "collapse", "focus"])
    p.add_argument("--value", default=None)
    p.add_argument("--name", default=None)
    p.add_argument("--exact-name", default=None)
    p.add_argument("--class", dest="class_", default=None)
    p.add_argument("--auto-id", default=None)
    p.add_argument("--type", dest="type_", default=None)
    p.add_argument("--expect-pid", type=int, default=None)

    p = sub.add_parser("close")
    p.add_argument("--hwnd", type=int, required=True)
    p.add_argument("--kill", action="store_true")
    p.add_argument("--expect-pid", type=int, default=None)

    sub.add_parser("state")

    a = ap.parse_args(raw)

    if a.cmd == "launch":
        extra = list(a.arg or [])
        if a.argv_json:
            try:
                decoded = json.loads(a.argv_json)
                if isinstance(decoded, list):
                    extra.extend(str(x) for x in decoded)
            except Exception as exc:
                print(json.dumps({"ok": False, "error": f"--argv-json 不是合法 JSON 数组: {exc}"},
                                 ensure_ascii=False))
                return 2
        res = launch(a.exe, extra, a.width, a.height, a.timeout, a.title,
                     a.keep_hidden, a.allow_activate, not a.no_isolate, a.keep_on_failure)
    elif a.cmd == "list":
        wins = [describe(h) for h in top_windows()
                if win32gui.GetWindowText(h) and win32gui.IsWindowVisible(h)]
        # windows 是全部可见顶层窗口（含屏幕上的），offscreen 只是它的子集。
        # 用户自己开着的程序从这里拿 hwnd，就能接着 park / shot / tree / act。
        res = {"ok": True, "monitors": monitors(),
               "dpi": ctypes.windll.user32.GetDpiForSystem(),
               "foreground": describe(win32gui.GetForegroundWindow()),
               "windows": wins[:200],
               "offscreen": [w for w in wins if w.get("offscreen")],
               "count": len(wins)}
    elif a.cmd == "park":
        res = verify_pid(a.hwnd, a.expect_pid) or park_existing(a.hwnd, a.allow_activate)
    elif a.cmd == "shot":
        res = verify_pid(a.hwnd, a.expect_pid) or shot(a.hwnd, a.out)
    elif a.cmd == "tree":
        res = verify_pid(a.hwnd, a.expect_pid)
        if res is None:
            root = uia_root(a.hwnd)
            if root is None:
                res = {"ok": False, "error": "no UIA element for hwnd"}
            else:
                items: list = []
                walk(root, a.depth, items)
                res = {"ok": True, "hwnd": a.hwnd, "root": {"name": root.Name,
                       "class": root.ClassName, "type": root.ControlTypeName},
                       "count": len(items), "items": items}
    elif a.cmd == "act":
        res = verify_pid(a.hwnd, a.expect_pid)
        if res is None:
            selector = {"name": a.name, "exact_name": a.exact_name, "class": a.class_,
                        "auto_id": a.auto_id, "type": a.type_}
            res = act(a.hwnd, a.op, a.value, {k: v for k, v in selector.items() if v})
    elif a.cmd == "close":
        res = verify_pid(a.hwnd, a.expect_pid)
        if res is None:
            info = describe(a.hwnd)
            try:
                win32gui.PostMessage(a.hwnd, win32con.WM_CLOSE, 0, 0)
                time.sleep(1.0)
                alive = win32gui.IsWindow(a.hwnd)
                killed = False
                # 只按「窗口所属进程」杀，而且必须是我们确认过的那一个；
                # 共享进程（寄生到用户已开的浏览器）默认不动进程，只关窗口。
                if alive and a.kill and info.get("pid"):
                    subprocess.run(["taskkill", "/T", "/F", "/PID", str(info["pid"])],
                                   capture_output=True)
                    killed = True
                    time.sleep(0.5)
                    alive = win32gui.IsWindow(a.hwnd)
                res = {"ok": True, "closed": not alive, "killed": killed,
                       "window": info,
                       "hint": None if not alive else "窗口仍在；可加 kill=true，或手动处理该进程"}
            except Exception as exc:
                res = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    else:  # state
        res = {
            "ok": True,
            "monitors": monitors(),
            "foreground": describe(win32gui.GetForegroundWindow()),
            "cursor": list(win32gui.GetCursorPos()),
            "offscreen_windows": [describe(h) for h in top_windows()
                                  if win32gui.IsWindowVisible(h) and win32gui.GetWindowText(h)
                                  and is_offscreen(h)],
            "dpi": ctypes.windll.user32.GetDpiForSystem(),
        }

    if want_json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(res)
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
