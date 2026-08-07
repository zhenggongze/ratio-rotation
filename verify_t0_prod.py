#!/usr/bin/env python3
# 生产环境验证：portfolio-analysis.top 红利做T页签（v2 分钟级真实口径）
# 策略 v2：买0.3%（×0.997）/ 卖0.8%（×1.008），385 天分钟级真实成交（2025-01-02 ~ 2026-08-05）
# 用法: python verify_t0_prod.py [URL]   （不传 URL 默认生产环境）
import re, os, sys, time
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "https://portfolio-analysis.top/ratio-rotation/index.html"
CHROME = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screenshots", "t0-tab-prod-v2.png")

errors = []
all_pass = True

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: errors.append("console[{}]: {}".format(m.location.get("url", "?"), m.text)) if m.type == "error" else None)

    print("访问:", URL)
    t0_start = time.time()
    page.goto(URL, wait_until="networkidle", timeout=30000)
    page.wait_for_function(
        "() => { const c = document.getElementById('content'); return c && c.style.display !== 'none' && c.children.length > 0; }",
        timeout=15000)
    page.wait_for_timeout(2000)
    t0_elapsed = time.time() - t0_start

    print("默认打开页签为「红利做T」...")
    page.wait_for_function(
        "() => { const c = document.getElementById('t0Content'); return c && c.style.display === 'block' && document.getElementById('t0SignalCard').children.length > 0; }",
        timeout=10000)
    page.wait_for_function(
        "() => { const b = document.getElementById('t0HistoryDailyBody'); return b && b.children.length > 0; }",
        timeout=15000)
    page.wait_for_timeout(1500)

    # 默认页签(t0)渲染完成后的资源加载统计（t0_backtest.json 独立按需加载，未塞入 frontend_data.json）
    res_stats = page.evaluate(
        "() => performance.getEntriesByType('resource').filter(r => /frontend_data|t0_backtest/.test(r.name)).map(r => ({ name: r.name.split('/').pop(), transfer: r.transferSize, duration: Math.round(r.duration) }))")

    # ===== 通用采集 =====
    def text(id_):
        return page.evaluate("() => { const el = document.getElementById('%s'); return el ? el.textContent : null; }" % id_)

    def cards(id_):
        return page.evaluate(
            "() => Array.from(document.querySelectorAll('#%s .metric-card')).map(c => (c.innerText || '').replace(/\\n/g,' ').trim())" % id_)

    def head(id_):
        return page.evaluate(
            "() => { const t = document.getElementById('%s'); const tbl = t ? t.closest('table') : null; return tbl ? Array.from(tbl.querySelectorAll('thead th')).map(x => x.textContent.trim()) : null; }" % id_)

    def rows(id_, n=5):
        return page.evaluate(
            "() => Array.from(document.querySelectorAll('#%s tr')).slice(0, %d).map(r => (r.innerText || '').replace(/\\s+/g, ' ').trim())" % (id_, n))

    signal_text = text("t0SignalCard")
    metrics = cards("t0MetricsGrid")
    daily_cards = cards("t0DailyCards")
    daily_meta = text("t0DailyMeta")
    daily_head = head("t0DailyBody")
    history_head = head("t0HistoryDailyBody")
    daily_rows = rows("t0DailyBody", 5)
    history_first = rows("t0HistoryDailyBody", 3)
    history_rows = page.evaluate("() => { const b = document.getElementById('t0HistoryDailyBody'); return b ? b.children.length : 0; }")
    daily_stats = text("t0DailyStats")
    status_dist = text("t0StatusDist")
    # 数据口径说明面板
    caliber_items = page.evaluate("() => Array.from(document.querySelectorAll('#t0CaliberBody .caliber-item')).map(x => x.id)")
    caliber_text = page.evaluate("() => { const b = document.getElementById('t0CaliberBody'); return b ? b.textContent : ''; }")
    panel_open = page.evaluate("() => { const p = document.getElementById('t0CaliberPanel'); return p ? p.open : null; }")
    # 逐年收益表
    yearly_rows = page.evaluate(
        "() => Array.from(document.querySelectorAll('#t0YearlyTable tbody tr')).slice(0, 10).map(r => (r.innerText || '').replace(/\\s+/g, ' ').trim())")
    yearly_head = head("t0YearlyTable")
    params = text("t0Params")
    # 实际卖出价输入框采集（每日记录表首行）
    daily_input_ok = page.evaluate("""() => {
        const inp = document.querySelector('#t0DailyBody .t0-adjust-input');
        if (!inp) return { found: false };
        return { found: true, val: inp.value, date: inp.dataset.date, disabled: inp.disabled, def: inp.dataset.def };
    }""")

    print("\n=== 加载性能 ===")
    print("首页加载(首屏就绪): %.2f 秒" % t0_elapsed)
    for r in res_stats:
        print("  资源 %s: 传输 %d 字节, 耗时 %dms" % (r["name"], r["transfer"], r["duration"]))

    print("\n=== 今日做T信号 ===")
    print("信号卡:", (signal_text or "").replace("\n", " | "))
    print("\n=== 历史业绩指标卡 ===")
    for m in metrics:
        print("  -", m)
    print("\n=== 每日记录指标卡 ===")
    for m in daily_cards:
        print("  -", m)
    print("更新时间:", daily_meta)
    print("每日记录表头:", daily_head)
    print("历史明细表头:", history_head)
    print("实际卖出价输入框:", daily_input_ok if isinstance(daily_input_ok, dict) else daily_input_ok)
    print("历史明细首行:", history_first[0] if history_first else None)
    print("历史明细行数:", history_rows)
    print("每日状态分布:", (daily_stats or "").replace("\n", " | "))
    print("历史状态分布:", (status_dist or "").replace("\n", " | "))
    print("逐年收益表头:", yearly_head)
    print("逐年收益行:", yearly_rows)

    # ===== 断言（v2 分钟级真实口径） =====
    pct3 = r"-?\d+\.\d{2}%"
    checks = []

    def strip_badge(m):
        return re.sub(r"^[①②③④]", "", m).strip()

    # ① 信号卡：v2 动态系数 0.997/1.008（今日 2026-08-06 未跳过）
    checks.append(("信号卡含买入/卖出监控价",
                   bool(signal_text) and "买入监控价" in signal_text and "卖出监控价" in signal_text and
                   "开盘 × 0.997" in signal_text and "开盘 × 1.008" in signal_text))
    # ① 历史业绩指标卡：4张百分比卡
    checks.append(("历史业绩指标卡=4张且均为百分比",
                   len(metrics) == 4 and all(re.search(pct3, m) for m in metrics) and
                   strip_badge(metrics[0]).startswith("做T累计净利(扣手续费)") and
                   strip_badge(metrics[1]).startswith("持有净利(一直拿着)") and
                   strip_badge(metrics[2]).startswith("累计超额收益") and
                   strip_badge(metrics[3]).startswith("年化超额收益率")))
    # v2 分钟级真实（14:50 了结）：做T累计32.71% = 持有5.82% + 做T差价26.89%（385天真实成交，佣金万0.5双边）
    checks.append(("历史业绩做T累计32.71%/持有5.82%/超额26.89%",
                   "32.71%" in metrics[0] and "5.82%" in metrics[1] and "26.89%" in metrics[2]))
    # 年化超额收益率 = 26.89% ÷ 1.59年(2025-01-02~2026-08-05) ≈ 16.93%
    checks.append(("年化超额收益率≈16.93%(窗口1.6年)",
                   "16.93%" in metrics[3] and "年(窗口内)" in metrics[3]))
    # 每日记录指标卡：3张（今日2026-08-06未触发：持有1.29%+做T0%=做T累计1.29%）
    checks.append(("每日记录指标卡=3张且均为百分比",
                   len(daily_cards) == 3 and all(re.search(pct3, m) for m in daily_cards) and
                   strip_badge(daily_cards[0]).startswith("做T累计净利(扣手续费)") and
                   strip_badge(daily_cards[1]).startswith("持有净利(一直拿着)") and
                   strip_badge(daily_cards[2]).startswith("累计超额收益")))
    checks.append(("每日记录做T累计净利1.29%/超额0.00%",
                   "1.29%" in daily_cards[0] and bool(re.search(r"超额收益\s*0\.00%", daily_cards[2]))))
    # 每日记录 meta：日期范围~日期范围 时间，N个交易日
    checks.append(("每日记录更新时间格式(日期范围+秒级+交易日数)",
                   bool(re.search(r"\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，\d+个交易日", daily_meta or ""))))
    # 每日记录 meta 与做T卡均为①分钟级真实口径（非②理论）
    checks.append(("每日记录meta为①分钟级真实口径", "①" in (daily_meta or "")))
    checks.append(("每日记录做T卡为①分钟级真实口径",
                   len(daily_cards) == 3 and "分钟级真实成交" in daily_cards[0] and "分钟级真实成交" in daily_cards[2]))
    # 历史明细表头：12列统一维度（含买卖时间、14:50价，无折算超额列）
    checks.append(("历史明细表头=12列含买卖时间+14:50价",
                   history_head == ["日期", "状态", "买入时间", "卖出时间", "开盘", "收盘", "买入价", "卖出价", "14:50价", "成交", "当日净利(扣费)", "当日超额"]))
    # 每日记录表头：13列（历史明细12列 + 实际卖出价录入列，与历史明细维度一致并扩展）
    checks.append(("每日记录表头=13列含实际卖出价",
                   len(daily_head) == 13 and daily_head[2] == "买入时间" and daily_head[3] == "卖出时间" and
                   daily_head[8] == "14:50价" and daily_head[9].startswith("实际卖出价") and
                   daily_head[1] == "状态" and "当日净利(扣费)" in daily_head and "当日超额" in daily_head))
    # 每日记录行含实际卖出价录入框（默认=卖出价；可编辑，云端落库）
    daily_input_ok = page.evaluate("""() => {
        const inp = document.querySelector('#t0DailyBody .t0-adjust-input');
        if (!inp) return { found: false };
        return { found: true, val: inp.value, date: inp.dataset.date, disabled: inp.disabled, def: inp.dataset.def };
    }""")
    checks.append(("每日记录行含实际卖出价输入框", bool(daily_input_ok.get("found"))))
    if daily_input_ok.get("found"):
        checks.append(("实际卖出价默认=卖出价",
                       bool(re.search(r"^\d\.\d{3}$", daily_input_ok["val"] or "")) and daily_input_ok["val"] == daily_input_ok["def"]))
        checks.append(("实际卖出价输入框未禁用(已连接FC)", daily_input_ok["disabled"] is False))
    # 实际卖出价录入端到端：改值→保存→FC云端确认→恢复原值
    e2e_adj_ok = page.evaluate("""async () => {
        const inp = document.querySelector('#t0DailyBody .t0-adjust-input');
        if (!inp) return { ok: false, reason: 'no input' };
        const date = inp.dataset.date;
        const orig = inp.value;
        // T0_FC_API 为 script 顶层 let 变量，不挂到 window，从 api_config.json 读取
        let fc = null;
        try {
            const r = await fetch('api_config.json', { cache: 'no-store' });
            const c = await r.json();
            fc = (c.fc_api || '').replace(/\\/+$/, '');
        } catch (e) {}
        if (!fc) return { ok: false, reason: 'no fc api' };
        // 1) 改为一个临时的测试值（比默认值大0.002）
        const testVal = (Math.round((Number(orig) + 0.002) * 1000) / 1000).toFixed(3);
        inp.value = testVal;
        inp.dispatchEvent(new Event('change'));
        // 2) 等待保存完成（状态元素出现 ✓已保存）
        const st = document.getElementById('t0AdjSt_' + date);
        const waitOk = await new Promise(res => {
            const t0 = Date.now();
            const iv = setInterval(() => {
                const txt = st ? st.textContent : '';
                if (txt.indexOf('✓已保存') >= 0 || txt.indexOf('保存失败') >= 0 || Date.now() - t0 > 8000) {
                    clearInterval(iv); res(txt);
                }
            }, 200);
        });
        if (waitOk.indexOf('✓已保存') < 0) return { ok: false, reason: 'save not ok: ' + waitOk };
        // 3) 通过 FC load 确认已落库
        let saved = null;
        try {
            const r = await fetch(fc + '/api/t0/load', { cache: 'no-store' });
            const d = await r.json();
            saved = d.records && d.records[date] ? d.records[date].actual_sell_price : null;
        } catch (e) { return { ok: false, reason: 'load failed' }; }
        if (saved !== Number(testVal)) return { ok: false, reason: 'saved mismatch: ' + saved };
        // 4) 恢复原值（删掉测试数据，避免污染用户真实数据）
        inp.value = orig;
        inp.dispatchEvent(new Event('change'));
        const waitRestore = await new Promise(res => {
            const t0 = Date.now();
            const iv = setInterval(() => {
                const txt = st ? st.textContent : '';
                if (txt.indexOf('✓已保存') >= 0 || txt.indexOf('保存失败') >= 0 || Date.now() - t0 > 8000) {
                    clearInterval(iv); res(txt);
                }
            }, 200);
        });
        return { ok: waitRestore.indexOf('✓已保存') >= 0, reason: 'restore: ' + waitRestore, date: date, testVal: testVal };
    }""")
    checks.append(("实际卖出价录入→FC云端落库→恢复原值", bool(e2e_adj_ok.get("ok")) and (not e2e_adj_ok.get("reason") or "restore" in e2e_adj_ok.get("reason", ""))))
    if not e2e_adj_ok.get("ok"):
        print("  ⚠ 录入端到端失败:", e2e_adj_ok.get("reason"))
    # 历史明细倒序：第一行应为最新日期 2026-08-05（日期格式与每日记录对齐 2026-08-05）
    checks.append(("历史明细倒序展示(最新在上)", bool(history_first) and history_first[0].startswith("2026-08-05")))
    # 历史明细默认收起为最近20条（手机端优化），点击「查看全部」按钮展开为385行
    checks.append(("历史明细默认收起为20行(手机端优化)", history_rows == 20))
    checks.append(("历史明细展开按钮存在",
                   page.is_visible("#t0HistoryExpandBtn") and "查看全部" in (page.inner_text("#t0HistoryExpandBtn") or "")))
    if page.is_visible("#t0HistoryExpandBtn"):
        page.click("#t0HistoryExpandBtn")
        page.wait_for_timeout(1000)
        checks.append(("历史明细展开后=385行", page.locator("#t0HistoryDailyBody tr").count() == 385))
    # 历史明细首行含买卖时间（09:33 / 15:00 之类）
    checks.append(("历史明细行含精确到分钟的买卖时间",
                   bool(history_first) and bool(re.search(r"\d{2}:\d{2}", history_first[0]))))
    # 历史明细首行含百分比净利/超额
    checks.append(("历史明细行含百分比净利与超额", bool(history_first) and re.search(pct3, history_first[0])))
    # 历史明细行含 14:50 价（仅买14:50卖出日显示实际恢复卖出价）
    history_cells = (history_first[0].split() if history_first else [])
    checks.append(("历史明细行含14:50价列", len(history_cells) >= 9 and bool(re.search(r"\d\.\d{3}", history_cells[8]))))
    # 每日状态分布合计100%
    checks.append(("每日状态分布合计100%", bool(re.search(r"合计 \d+ 天 = 100%", daily_stats or ""))))
    # 每日状态分布与历史同维度：含各类型平均当日做T净利%（未触发买入均+0.00%）
    checks.append(("每日状态分布含各类型平均收益", "均+0.00%" in (daily_stats or "")))
    # 历史状态分布：单段真实口径①，合计385天=100%（仅买=14:50卖出），无理论/折算分段
    checks.append(("历史状态分布单段(仅买14:50卖出/无理论折算分段)",
                   bool(re.search(r"合计 385 天 = 100%", status_dist or "")) and
                   "仅买14:50卖出" in (status_dist or "") and "仅买收盘恢复" not in (status_dist or "") and
                   "折算口径" not in (status_dist or "") and "理论口径" not in (status_dist or "")))
    # 历史状态分布各类型含平均当日做T净利%（双边成交均+1.10%、仅买14:50卖出均-0.04%、未触发/低开跳过均0.00%，佣金万0.5双边）
    checks.append(("历史状态分布含各类型平均收益(双边+1.10%/仅买-0.04%)",
                   "均+1.10%" in (status_dist or "") and "均-0.04%" in (status_dist or "") and
                   "均+0.00%" in (status_dist or "")))
    # 每日记录含今日行
    checks.append(("每日记录含2026-08-06", any("2026-08-06" in r for r in daily_rows)))
    # 默认打开页签为红利做T：t0 按钮 active、t0Content 显示、轮动内容隐藏、头部标题为红利做T
    t0_tab_active = page.evaluate("() => { const b = document.querySelector('.tab[data-tab=\"t0\"]'); return b ? b.classList.contains('active') : null; }")
    t0_content_shown = page.evaluate("() => { const c = document.getElementById('t0Content'); return c ? c.style.display === 'block' : null; }")
    rot_content_hidden = page.evaluate("() => { const c = document.getElementById('rotationContent'); return c ? c.style.display === 'none' : null; }")
    header_title = text("headerTitle")
    # t0 页签必须为第一个（红利做T模块在3个模块之首）
    t0_first_tab = page.evaluate("() => { const ts = document.querySelectorAll('.tabs .tab'); return ts.length >= 3 && ts[0] ? ts[0].dataset.tab === 't0' : null; }")
    checks.append(("默认打开页签为红利做T且为第一个页签(t0按钮active且排第一/轮动隐藏/标题)",
                   t0_tab_active is True and t0_first_tab is True and t0_content_shown is True and rot_content_hidden is True and
                   bool(header_title) and "红利做T" in header_title))
    # 按需加载：t0_backtest.json 为独立文件，默认页签(t0)打开时加载，未塞入 frontend_data.json
    checks.append(("默认页签按需加载独立t0_backtest.json",
                   any(r["name"] == "t0_backtest.json" for r in res_stats) and
                   any(r["name"] == "frontend_data.json" for r in res_stats)))
    # 历史业绩说明面板：默认收缩、含 ① ② 两个条目（②理论③折算已全部删除）
    checks.append(("历史业绩说明面板默认收缩且含2条目(①②，无理论无折算)",
                   panel_open is False and len(caliber_items) == 2 and
                   "caliber-1" in caliber_items and "caliber-2" in caliber_items and
                   "caliber-3" not in caliber_items and "caliber-4" not in caliber_items))
    # 说明面板：真实口径①含385天/0.997/1.008；无任何 理论/折算/v1 痕迹
    checks.append(("说明面板真实口径385天+无理论折算v1痕迹",
                   "385 天" in caliber_text and "0.997" in caliber_text and "1.008" in caliber_text and
                   "v1" not in caliber_text and "折算模型" not in caliber_text and "理论" not in caliber_text))
    # 每日记录模块说明面板：默认收缩（拆分到各模块）
    daily_caliber_open = page.evaluate("() => { const p = document.getElementById('t0DailyCaliberPanel'); return p ? p.open : null; }")
    checks.append(("每日记录说明面板默认收缩(拆分到模块)", daily_caliber_open is False))
    # 逐年收益表：2行(2025/2026)，表头含做T差价净利率①/做T累计净利率①
    checks.append(("逐年收益表头含做T差价净利率①/做T累计净利率①",
                   bool(yearly_head) and "做T差价净利率①" in " ".join(yearly_head) and "做T累计净利率①" in " ".join(yearly_head)))
    checks.append(("逐年收益表=2行(2025/2026)",
                   len(yearly_rows) == 2 and yearly_rows[0].startswith("2025") and yearly_rows[1].startswith("2026")))
    checks.append(("逐年2025=持有3.78%+做T16.43%=累计20.22%",
                   any(r.startswith("2025") and "3.78%" in r and "16.43%" in r and "20.22%" in r for r in yearly_rows)))
    checks.append(("逐年2026=持有1.97%+做T10.45%=累计12.42%",
                   any(r.startswith("2026") and "1.97%" in r and "10.45%" in r and "12.42%" in r for r in yearly_rows)))
    # 参数与纪律：策略版本v2、买入×0.997、卖出×1.008
    checks.append(("参数表含策略版本v2+买0.3%/卖0.8%",
                   bool(params) and "v2" in params and "0.997" in params and "1.008" in params and "买0.3%/卖0.8%" in params))

    print("\n=== 断言 ===")
    for name, ok in checks:
        print(("✓" if ok else "✗"), name)
        if not ok:
            all_pass = False
    print("\n实际卖出价录入端到端结果:", e2e_adj_ok)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    page.screenshot(path=OUT)
    print("\n截图已保存:", OUT)

    print("\n=== 控制台错误 ===")
    print(errors if errors else "✓ 0 错误")
    if errors:
        all_pass = False

    browser.close()

print("\n" + ("✅ 验证通过" if all_pass else "❌ 存在未通过项"))
sys.exit(0 if all_pass else 1)
