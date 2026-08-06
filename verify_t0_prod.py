#!/usr/bin/env python3
# 生产环境验证：portfolio-analysis.top 红利做T页签（方案B：向下取整）
import re, os, sys
from playwright.sync_api import sync_playwright

URL = "https://portfolio-analysis.top/ratio-rotation/index.html"
CHROME = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screenshots", "t0-tab-prod.png")

errors = []
all_pass = True

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: errors.append("console[{}]: {}".format(m.location.get("url", "?"), m.text)) if m.type == "error" else None)

    print("访问生产环境:", URL)
    page.goto(URL, wait_until="networkidle", timeout=30000)
    page.wait_for_function(
        "() => { const c = document.getElementById('content'); return c && c.style.display !== 'none' && c.children.length > 0; }",
        timeout=15000)
    page.wait_for_timeout(2000)

    print("点击「红利做T」页签...")
    page.click('.tab[data-tab="t0"]')
    page.wait_for_function(
        "() => { const c = document.getElementById('t0Content'); return c && c.style.display === 'block' && document.getElementById('t0SignalCard').children.length > 0; }",
        timeout=10000)
    page.wait_for_timeout(1500)

    sig = page.evaluate("() => document.getElementById('t0SignalCard').innerText")
    print("\n=== 今日信号卡 ===")
    print(sig.replace("\n", " | "))

    metrics = page.evaluate(
        "() => Array.from(document.querySelectorAll('#t0MetricsGrid .metric-card')).map(c => (c.innerText || '').replace(/\\n/g,' ').trim())")
    print("\n=== 业绩指标卡 ===")
    for m in metrics:
        print("  -", m)

    range_ = page.evaluate("() => document.getElementById('t0BacktestRange').textContent")
    print("\n回测区间:", range_)

    full = sig + " " + " ".join(metrics)
    checks = [
        ("卖出监控价 1.403（向下取整）", "1.403" in sig),
        ("买入监控价 1.392", "1.392" in sig),
        ("净盈利 127.6万（新口径）", bool(re.search(r"127[.,]6|1,276,477|1276477", full))),
        ("超额 73.1万", bool(re.search(r"73[.,]1|731,022|731022", full))),
    ]
    print("\n=== 断言 ===")
    for name, ok in checks:
        print(("✓" if ok else "✗"), name)
        if not ok:
            global all_pass_holder
            all_pass = False

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    page.screenshot(path=OUT)
    print("\n截图已保存:", OUT)

    print("\n=== 控制台错误 ===")
    print(errors if errors else "✓ 0 错误")
    if errors:
        all_pass = False

    browser.close()

print("\n" + ("✅ 生产验证通过" if all_pass else "❌ 存在未通过项"))
sys.exit(0 if all_pass else 1)
