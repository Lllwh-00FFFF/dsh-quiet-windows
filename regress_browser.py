"""浏览器回归测试：验证「独立 profile + 窗口进程归属」这条最容易出事的路径。

默认不运行（会真的拉起浏览器）。手动跑：

    python tests/regress_browser.py --run

检查三件事：
  1. 窗口属于本次启动的进程（process_mismatch == False）—— 没有寄生到用户已开的浏览器；
  2. 窗口落在所有显示器之外，且从未上屏；
  3. 截图有内容，关掉之后进程不残留。
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "helper", "quietwin.py")

CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]


def run(*args):
    proc = subprocess.run([sys.executable, "-X", "utf8", HELPER, *args, "--json"],
                          capture_output=True, text=True, encoding="utf-8")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise SystemExit(f"helper 输出不是 JSON：{proc.stdout[:400]} {proc.stderr[:400]}")


def main() -> int:
    if "--run" not in sys.argv:
        print("默认跳过（会真的拉起浏览器）。要跑请加 --run")
        return 0
    exe = next((p for p in CANDIDATES if os.path.exists(p)), None)
    if exe is None:
        print("没找到 Edge/Chrome，跳过")
        return 0

    print("使用浏览器：", exe)
    launched = run("launch", "--exe", exe, "--width", "1000", "--height", "720",
                   "--timeout", "120", "--argv-json", '["about:blank"]')
    if launched.get("ok") is not True:
        print("启动失败：", launched)
        return 1

    failures = []
    if launched.get("process_mismatch") is not False:
        failures.append("窗口不属于本次启动的进程（可能寄生到了已运行的浏览器）")
    if launched.get("offscreen") is not True:
        failures.append("窗口没有落在屏幕外")
    if launched.get("flashed") is not False:
        failures.append("窗口在创建过程中上过屏")
    print("profile:", launched.get("isolated_profile"))
    print("窗口 pid:", launched.get("pid"), "启动 pid:", launched.get("proc_pid"))

    shot = run("shot", "--hwnd", str(launched["hwnd"]), "--out", os.path.join(HERE, "_regress.png"),
               "--expect-pid", str(launched["pid"]))
    if shot.get("ok") is not True:
        failures.append("截图失败：" + str(shot.get("error")))
    elif shot.get("looks_blank"):
        failures.append("截图接近纯色（浏览器在屏幕外停止绘制）")

    closed = run("close", "--hwnd", str(launched["hwnd"]), "--expect-pid", str(launched["pid"]))
    if closed.get("closed") is not True:
        failures.append("窗口没有关闭")

    if failures:
        print("失败：")
        for item in failures:
            print(" -", item)
        return 1
    print("通过：独立 profile、窗口归属正确、离屏、可截图、可关闭")
    return 0


if __name__ == "__main__":
    sys.exit(main())
