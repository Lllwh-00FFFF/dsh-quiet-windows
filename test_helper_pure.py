"""不开窗口的单元测试：只覆盖纯计算与句柄校验，跑起来不碰你的桌面。

    python -m unittest discover -s tests -p "test_*.py"

需要 GUI 的回归测试在同目录 regress_browser.py，默认不跑。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "helper"))

import quietwin as q  # noqa: E402


def overlaps(rect, monitor):
    x1, y1, x2, y2 = rect
    mx1, my1, mx2, my2 = monitor
    return x2 > mx1 and x1 < mx2 and y2 > my1 and y1 < my2


class OffscreenOriginTest(unittest.TestCase):
    """屏幕外原点必须对「任意」显示器布局都落在所有显示器之外。"""

    LAYOUTS = [
        [(0, 0, 2560, 1440)],
        [(-1920, 0, 0, 1080), (0, 0, 2560, 1440)],
        [(0, -900, 1920, 1080), (1920, 0, 3840, 1440)],
    ]

    def test_origin_never_touches_any_monitor(self):
        original = q.monitors
        try:
            for layout in self.LAYOUTS:
                q.monitors = lambda layout=layout: layout
                for width, height in [(1, 1), (800, 600), (3840, 2160)]:
                    x, y = q.offscreen_origin(width, height)
                    rect = (x, y, x + width, y + height)
                    for monitor in layout:
                        self.assertFalse(
                            overlaps(rect, monitor),
                            f"{width}x{height} @ ({x},{y}) 与显示器 {monitor} 相交",
                        )
        finally:
            q.monitors = original

    def test_real_layout_is_readable(self):
        self.assertTrue(len(q.monitors()) >= 1)


class VerifyPidTest(unittest.TestCase):
    """句柄复用防护：给了期望 pid 就必须校验，不给就放行。"""

    def test_no_expectation_passes(self):
        self.assertIsNone(q.verify_pid(0, None))

    def test_wrong_process_is_rejected(self):
        result = q.verify_pid(0, 999999)
        self.assertIsNotNone(result)
        self.assertFalse(result["ok"])
        self.assertIn("复用", result["error"])


class DescribeTest(unittest.TestCase):
    """describe() 对无效句柄要返回 error 而不是抛异常。"""

    def test_invalid_handle_reports_error(self):
        info = q.describe(0)
        self.assertIn("error", info)


if __name__ == "__main__":
    unittest.main()
