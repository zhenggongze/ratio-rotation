"""
E2E测试 第1轮: 主流程冒烟测试
目标: 验证前端页面主要功能区块能正常加载和渲染
测试场景: 桌面端 (1280x900) 模拟用户首次访问页面
"""
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

# 项目根目录
PROJECT_DIR = Path(__file__).parent.parent
SCREENSHOTS_DIR = PROJECT_DIR / "screenshots"
SCREENSHOTS_DIR.mkdir(exist_ok=True)

# 测试URL
URL = "http://localhost:3001/public/index.html"

# 测试结果收集
results = []

def record(name, passed, detail=""):
    results.append({"name": name, "passed": passed, "detail": detail})
    status = "PASS" if passed else "FAIL"
    print(f"[{status}] {name}" + (f" - {detail}" if detail else ""))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1280, "height": 900},
            locale="zh-CN"
        )
        page = context.new_page()

        # 收集控制台日志和错误
        console_messages = []
        page_errors = []
        page.on("console", lambda msg: console_messages.append(f"{msg.type}: {msg.text}"))
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        print("=" * 60)
        print("E2E测试 第1轮: 主流程冒烟测试")
        print("=" * 60)

        # ============================================================
        # 测试1.1: 页面能正常打开
        # ============================================================
        try:
            response = page.goto(URL, wait_until="networkidle", timeout=15000)
            record("1.1 页面加载", response.status == 200, f"HTTP {response.status}")
        except Exception as e:
            record("1.1 页面加载", False, str(e))
            browser.close()
            return

        # ============================================================
        # 测试1.2: 标题正确
        # ============================================================
        try:
            title = page.title()
            record("1.2 页面标题正确", "比值轮动" in title, f"title='{title}'")
        except Exception as e:
            record("1.2 页面标题正确", False, str(e))

        # ============================================================
        # 测试1.3: 加载状态消失，内容显示
        # ============================================================
        try:
            loading = page.locator("#loading")
            content = page.locator("#content")
            # 等待loading隐藏
            page.wait_for_function("document.getElementById('loading').style.display === 'none'", timeout=10000)
            page.wait_for_function("document.getElementById('content').style.display !== 'none'", timeout=5000)
            record("1.3 加载完成内容显示", True)
        except Exception as e:
            record("1.3 加载完成内容显示", False, str(e))

        # ============================================================
        # 测试1.4: 头部标题渲染
        # ============================================================
        try:
            h1 = page.locator(".header h1").text_content()
            record("1.4 头部标题渲染", "创业板" in h1 and "红利" in h1, f"h1='{h1}'")
        except Exception as e:
            record("1.4 头部标题渲染", False, str(e))

        # ============================================================
        # 测试1.5: 指标卡片渲染 (metricsGrid)
        # ============================================================
        try:
            metrics = page.locator("#metricsGrid .metric-card")
            count = metrics.count()
            record("1.5 指标卡片渲染", count >= 3, f"共{count}个卡片")
        except Exception as e:
            record("1.5 指标卡片渲染", False, str(e))

        # ============================================================
        # 测试1.6: 当前状态区块渲染
        # ============================================================
        try:
            status_content = page.locator("#statusContent").inner_html()
            record("1.6 当前状态渲染", len(status_content) > 50, f"HTML长度={len(status_content)}")
        except Exception as e:
            record("1.6 当前状态渲染", False, str(e))

        # ============================================================
        # 测试1.7: 走势图Canvas渲染
        # ============================================================
        try:
            canvas = page.locator("#chart")
            record("1.7 走势图Canvas存在", canvas.count() == 1)
            # 检查Chart.js实例
            chart_exists = page.evaluate("() => typeof Chart !== 'undefined' && !!document.getElementById('chart')")
            record("1.7b Chart.js已初始化", chart_exists)
        except Exception as e:
            record("1.7 走势图Canvas存在", False, str(e))

        # ============================================================
        # 测试1.8: 历年收益表渲染
        # ============================================================
        try:
            yearly_rows = page.locator("#yearlyTable tr").count()
            record("1.8 历年收益表渲染", yearly_rows > 0, f"共{yearly_rows}行")
        except Exception as e:
            record("1.8 历年收益表渲染", False, str(e))

        # ============================================================
        # 测试1.9: 档位操作表渲染
        # ============================================================
        try:
            buy_rows = page.locator("#buyTiersTable tr").count()
            sell_rows = page.locator("#sellTiersTable tr").count()
            record("1.9 档位操作表渲染", buy_rows > 0 and sell_rows > 0, f"买入{buy_rows}行/卖出{sell_rows}行")
        except Exception as e:
            record("1.9 档位操作表渲染", False, str(e))

        # ============================================================
        # 测试1.10: 最近调仓记录渲染
        # ============================================================
        try:
            trades_rows = page.locator("#tradesTable tr").count()
            record("1.10 调仓记录渲染", trades_rows > 0, f"共{trades_rows}行")
        except Exception as e:
            record("1.10 调仓记录渲染", False, str(e))

        # ============================================================
        # 测试1.11: 最近60交易日渲染
        # ============================================================
        try:
            daily_rows = page.locator("#dailyTable tr").count()
            record("1.11 最近60交易日渲染", daily_rows > 0, f"共{daily_rows}行")
        except Exception as e:
            record("1.11 最近60交易日渲染", False, str(e))

        # ============================================================
        # 测试1.12: 页脚渲染
        # ============================================================
        try:
            footer = page.locator(".footer").text_content()
            record("1.12 页脚渲染", "数据更新时间" in footer, f"footer长度={len(footer)}")
        except Exception as e:
            record("1.12 页脚渲染", False, str(e))

        # ============================================================
        # 测试1.13: 无JS错误
        # ============================================================
        js_errors = [e for e in page_errors]
        record("1.13 无JS错误", len(js_errors) == 0, f"错误数={len(js_errors)}" + (" | " + "; ".join(js_errors[:3]) if js_errors else ""))

        # ============================================================
        # 测试1.14: 无控制台错误
        # ============================================================
        console_errors = [m for m in console_messages if m.startswith("error:")]
        record("1.14 无控制台错误", len(console_errors) == 0, f"错误数={len(console_errors)}" + (" | " + "; ".join(console_errors[:3]) if console_errors else ""))

        # ============================================================
        # 测试1.15: 截图保存
        # ============================================================
        try:
            page.screenshot(path=str(SCREENSHOTS_DIR / "e2e_round1_smoke.png"), full_page=True)
            record("1.15 截图保存", True)
        except Exception as e:
            record("1.15 截图保存", False, str(e))

        browser.close()

    # 输出汇总
    print()
    print("=" * 60)
    print("测试汇总")
    print("=" * 60)
    total = len(results)
    passed = sum(1 for r in results if r["passed"])
    failed = total - passed
    print(f"总计: {total} | 通过: {passed} | 失败: {failed}")
    print()

    if failed > 0:
        print("失败项:")
        for r in results:
            if not r["passed"]:
                print(f"  - {r['name']}: {r['detail']}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
