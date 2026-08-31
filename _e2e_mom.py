# -*- coding: utf-8 -*-
"""mom10 融合全面端到端测试：页面元素 + 功能 + 数据核对 + console"""
from playwright.sync_api import sync_playwright
import re, json

URL = 'http://localhost:8010/'
fails = []
def check(name, cond, detail=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + (('  | ' + detail) if detail and not cond else ''))
    if not cond: fails.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe")
    page = browser.new_page(viewport={'width': 1500, 'height': 1400})
    errs = []
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(URL, wait_until='networkidle', timeout=30000)
    page.wait_for_timeout(2500)
    print('=== 页面加载 ===')
    check('页面标题', '比值轮动' in page.title(), page.title())
    tabs = page.locator('.tab').all_inner_texts()
    check('页签3个', [t.strip() for t in tabs] == ['红利做T', '创业板做T', '创业板/红利'], str([t.strip() for t in tabs]))

    # ===== 红利做T页 =====
    print('\n=== 红利做T页（默认tab） ===')
    # 信号卡（极简：状态徽标 + 买入价/卖出价 一行，无任何多余文字）
    sig = page.locator('#t0SignalCard').inner_text()
    check('信号卡含状态', '今日全仓' in sig or '今日做T' in sig or '今日跳过' in sig, sig[:100])
    check('信号卡含买入价/卖出价', '买入价' in sig and '卖出价' in sig, sig[:200])
    check('信号卡无监控价模块', '监控价' not in sig, sig[:200])
    check('信号卡无多余文字', 'mom10' not in sig and '预警' not in sig and '动量趋势' not in sig and '全仓段' not in sig, sig[:200])
    # 页面头部策略说明（headerDesc：做T+0 + mom10 整合提炼）
    hdesc = page.locator('#headerDesc').inner_text()
    check('头部含做T+0规则', '做T+0' in hdesc and '0.3%' in hdesc and '0.8%' in hdesc and '低开超2%' in hdesc, hdesc[:250])
    check('头部含mom10规则', 'mom10' in hdesc and '5%' in hdesc and '满仓' in hdesc and 'T+1' in hdesc, hdesc[:250])
    check('头部含半仓做T', '半仓做T' in hdesc, hdesc[:250])
    body = page.locator('body').inner_text()
    # 每日记录
    daily_rows = page.locator('#t0DailyBody tr').count()
    check('每日记录18行', daily_rows == 18, str(daily_rows))
    # 8-28 全仓行
    d828_html = page.evaluate("() => { const r = Array.from(document.querySelectorAll('#t0DailyBody tr')).find(x => x.textContent.includes('2026-08-28')); return r ? r.textContent.replace(/\\s+/g,' ').trim() : '' }")
    check('8-28 显示未触发(5%口径)', '未触发' in d828_html and '全仓' not in d828_html.split('2026-08-28')[1][:30], d828_html[:150])
    check('8-28 无做T时间', '09:50' not in d828_html.split('2026-08-28')[1][:40], d828_html[:150])
    check('8-28 未触发无mom10', 'mom10 3.8%' not in d828_html, d828_html[:150])
    # 历史明细 8-28 为未触发买入（5%口径）
    hf828 = page.evaluate("() => { const r = Array.from(document.querySelectorAll('#t0HistoryDailyBody tr')).find(x => x.textContent.includes('2026-08-28')); return r ? r.textContent.replace(/\\s+/g,' ').trim() : '' }")
    check('历史明细8-28未触发买入', '未触发买入' in hf828 and '全仓' not in hf828, hf828[:150])
    # 每日记录统计卡
    cards = page.locator('#t0DailyCards .metric-card .label').all_inner_texts()
    check('每日记录卡3张', len(cards) == 3, str(cards))
    check('卡含策略累计净利', any('策略累计净利' in c for c in cards), str(cards))
    # 每日状态分布含全仓
    stats = page.locator('#t0DailyStats').inner_text()
    check('每日状态分布含全仓', '全仓' in stats, stats[:100])
    # 历史业绩：三行分组（当前策略 / 对比满仓 / 对比做T）
    row_titles = page.locator('.t0-row-title').all_inner_texts()
    check('三行标题存在', len(row_titles) == 3 and '当前策略' in row_titles[0] and '满仓' in row_titles[1] and '做T' in row_titles[2], str(row_titles))
    core_cards = page.locator('#t0CoreGrid .metric-card').count()
    check('行1卡3张', core_cards == 3, str(core_cards))
    core_txt = page.locator('#t0CoreGrid').inner_text()
    check('行1含策略累计净利%', '策略累计净利' in core_txt and '77.2%' in core_txt and '77.08万' not in core_txt, core_txt[:300])
    check('行1含年化/做T差价', '累计净利年化' in core_txt and '做T差价收益' in core_txt, core_txt[:300])
    hold_cards = page.locator('#t0GridHold .metric-card').count()
    check('行2卡3张', hold_cards == 3, str(hold_cards))
    hold_txt = page.locator('#t0GridHold').inner_text()
    check('行2含纯满仓+相对满仓超额', '纯满仓累计' in hold_txt and '相对满仓' in hold_txt and '6.0%' in hold_txt, hold_txt[:300])
    t0g_cards = page.locator('#t0GridT0 .metric-card').count()
    check('行3卡3张', t0g_cards == 3, str(t0g_cards))
    t0g_txt = page.locator('#t0GridT0').inner_text()
    check('行3含纯做T+相对做T超额', '纯做T累计' in t0g_txt and '相对做T' in t0g_txt and '21.3%' in t0g_txt, t0g_txt[:300])
    # 历史状态分布（与每日记录同款三态）
    hdist = page.locator('#t0StatusDist').inner_text()
    check('历史状态分布含全仓日', '全仓日' in hdist, hdist[:120])
    check('历史状态分布含双边成交', '双边成交' in hdist, hdist[:150])
    check('历史状态分布含未触发', '未触发' in hdist, hdist[:150])
    check('历史状态分布含仅买', '仅买' in hdist, hdist[:150])
    # 历史每日明细（前20行预览）
    hrows = page.locator('#t0HistoryDailyBody tr').count()
    check('历史明细行>0', hrows > 0, str(hrows))
    # 逐年表
    yt = page.locator('#t0YearlyTable').inner_text()
    check('逐年表含全仓天数列', '全仓天数' in yt, yt[:200])
    check('逐年表含纯满仓/mom10', '纯满仓' in yt and 'mom10' in yt, yt[:250])
    check('逐年表含2020年', '2020' in yt, yt[:300])
    # 参数表含 mom10
    params = page.locator('#t0Params').inner_text()
    check('参数含mom10阈值', 'mom10阈值' in params, params[:200])
    # 口径说明
    cal = page.evaluate("() => { const e = document.getElementById('t0CaliberPanel'); if (e) e.open = true; const b = document.getElementById('t0CaliberBody'); return b ? b.textContent : '' }")
    check('口径说明含mom10', 'mom10' in cal, cal[:100])

    # ===== 数据核对：8-28 全仓净利 = 涨跌0.21% =====
    print('\n=== 数据核对 ===')
    d828_txt = page.evaluate("() => { const r = Array.from(document.querySelectorAll('#t0DailyBody tr')).find(x => x.textContent.includes('2026-08-28')); return r ? r.innerText.replace(/\\t/g,'|') : '' }")
    print('  8-28行:', d828_txt[:160])

    # ===== 切换创业板做T =====
    print('\n=== 切换tab ===')
    try:
        page.get_by_text('创业板做T', exact=True).first.click(timeout=3000)
        page.wait_for_timeout(1200)
        cyb = page.locator('body').inner_text()
        check('创业板做T页正常', '创业板' in cyb and '每日记录' in cyb)
        check('创业板无报错', not [e for e in errs if 'not a function' in e or 'undefined' in e.lower()])
    except Exception as e:
        check('创业板tab切换', False, str(e))
    try:
        page.get_by_text('创业板/红利', exact=True).first.click(timeout=3000)
        page.wait_for_timeout(1200)
        cyb2 = page.locator('body').inner_text()
        check('创业板/红利页正常', '比值轮动' in cyb2 and '中证红利' in cyb2, cyb2[:150].replace('\n', ' | '))
    except Exception as e:
        check('创业板/红利tab切换', False, str(e))

    print('\n=== console错误 ===')
    real_errs = [e for e in errs if 'favicon' not in e.lower()]
    check('无console错误', len(real_errs) == 0, str(real_errs[:5]))

    print('\n' + '=' * 50)
    if fails:
        print(f'❌ 失败 {len(fails)} 项: {fails}')
    else:
        print('✅ 全部通过')
    browser.close()
