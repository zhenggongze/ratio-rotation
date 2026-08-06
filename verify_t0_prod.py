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

    # ===== 每日记录模块 =====
    daily_meta = page.evaluate("() => { const el = document.getElementById('t0DailyMeta'); return el ? el.textContent : null; }")
    daily_rows = page.evaluate("() => Array.from(document.querySelectorAll('#t0DailyBody tr')).map(r => (r.innerText || '').replace(/\\s+/g, ' ').trim())")
    daily_stats = page.evaluate("() => { const el = document.getElementById('t0DailyStats'); return el ? el.innerText : null; }")
    daily_cards = page.evaluate("() => Array.from(document.querySelectorAll('#t0DailyCards .metric-card')).map(c => (c.innerText || '').replace(/\\s+/g, ' ').trim())")
    history_rows = page.evaluate("() => { const b = document.getElementById('t0HistoryDailyBody'); return b ? b.children.length : 0; }")
    history_meta = page.evaluate("() => { const el = document.getElementById('t0HistoryDailyMeta'); return el ? el.textContent : null; }")
    print("\n=== 每日记录 ===")
    print("更新时间:", daily_meta)
    print("行数:", len(daily_rows))
    for r in daily_rows[:3]:
        print("  -", r)
    print("统计卡:", daily_cards)
    print("统计行:", daily_stats)
    print("历史明细行数:", history_rows)
    print("历史明细标题:", history_meta)
    daily_check = bool(re.search(r"更新于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", daily_meta or ""))
    print("更新时间含秒级:", daily_check)

    # 历史业绩"双边成交"占比（sub 文本）
    both_card = next((m for m in metrics if "双边成交" in m), "")
    print("\n双边成交卡:", both_card)
    both_pct_ok = bool(re.search(r"双边成交\s*577天.*占\d+\.\d%", both_card.replace("\u00a0", "")))
    print("双边成交占比标注:", both_pct_ok)
    daily_stats_ok = bool(re.search(r"累计 \d+ 个交易日.*双边成交 \d+ 天（\d+\.\d%）", daily_stats or ""))
    print("每日记录统计占比:", daily_stats_ok)

    full = sig + " " + " ".join(metrics) + " " + (daily_meta or "") + " " + " ".join(daily_rows)
    checks = [
        ("卖出监控价 1.403（向下取整）", "1.403" in sig),
        ("买入监控价 1.392", "1.392" in sig),
        ("净盈利 127.6万（新口径）", bool(re.search(r"127[.,]6|1,276,477|1276477", full))),
        ("超额 73.1万", bool(re.search(r"73[.,]1|731,022|731022", full))),
        ("每日记录更新时间（秒级）", daily_check),
        ("每日记录含今日行", any("2026-08-06" in r for r in daily_rows)),
        ("历史业绩双边成交占比", both_pct_ok),
        ("每日记录统计占比", daily_stats_ok),
        ("每日记录统计卡", len(daily_cards) >= 4),
        ("历史业绩每日明细表", history_rows >= 1600),
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
