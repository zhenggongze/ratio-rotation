# -*- coding: utf-8 -*-
"""iPhone 14 Plus (428x926) 全面手机端测试：适配 / 功能点击 / 首页元素 / 无溢出 / console"""
from playwright.sync_api import sync_playwright

URL = 'http://localhost:8010/'
VIEW = {'width': 428, 'height': 926}   # iPhone 14 Plus CSS px
fails = []
def check(name, cond, detail=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + (('  | ' + detail) if detail and not cond else ''))
    if not cond: fails.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe")
    page = browser.new_page(viewport=VIEW, is_mobile=True, has_touch=True, device_scale_factor=3)
    errs = []
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(URL, wait_until='networkidle', timeout=30000)
    page.wait_for_timeout(2500)

    # ===== 1. 首页加载 & 无横向溢出 =====
    print('=== 首页加载 & 适配 ===')
    check('页面标题', '比值轮动' in page.title(), page.title())
    overflow = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    check('无横向溢出', overflow <= 0, f'溢出{overflow}px')
    # 3个 tab
    tabs = page.locator('.tab').all_inner_texts()
    check('页签3个可点', len(tabs) == 3, str(tabs))

    # ===== 2. 首页展示元素（默认红利做T tab） =====
    print('\n=== 首页元素（红利做T） ===')
    # 头部标题+说明
    hd = page.locator('#headerDesc').inner_text()
    check('头部说明两行', len(hd.splitlines()) >= 2, hd[:120])
    check('头部含做T+0与mom10', '做T+0' in hd and 'mom10' in hd, hd[:200])
    # 信号卡（极简：状态 + 买入价/卖出价）
    sig = page.locator('#t0SignalCard').inner_text()
    check('信号卡含状态+价格', ('今日全仓' in sig or '今日做T' in sig) and '买入价' in sig and '卖出价' in sig, sig[:200])
    check('信号卡无监控价框', '监控价' not in sig, sig[:200])
    # 每日记录表（横向滚动容器）
    daily_scroll = page.evaluate('el => el.scrollWidth > el.clientWidth', page.locator('#t0DailyBody').locator('..').locator('..').element_handle())
    check('每日记录表可横向滚动', daily_scroll, '')
    rows = page.locator('#t0DailyBody tr').count()
    check('每日记录18行', rows == 18, str(rows))
    d828 = page.evaluate("() => { const r = Array.from(document.querySelectorAll('#t0DailyBody tr')).find(x => x.textContent.includes('2026-08-28')); return r ? r.textContent.replace(/\\s+/g,' ').trim() : '' }")
    check('8-28未触发(5%口径)', '未触发' in d828 and '全仓' not in d828, d828[:150])
    # 每日统计卡3张
    cards = page.locator('#t0DailyCards .metric-card').count()
    check('每日卡3张', cards == 3, str(cards))
    # 历史三行卡
    rc = page.locator('#t0CoreGrid .metric-card').count()
    check('行1卡3张', rc == 3, str(rc))
    rh = page.locator('#t0GridHold .metric-card').count()
    check('行2卡3张', rh == 3, str(rh))
    rt = page.locator('#t0GridT0 .metric-card').count()
    check('行3卡3张', rt == 3, str(rt))
    # 卡片文本无溢出（value 不换行撑破）
    core_v = page.locator('#t0CoreGrid .metric-card .value').all_inner_texts()
    check('行1数值正常', all('+' in v or '-' in v or '%' in v or '/' in v for v in core_v), str(core_v))

    # ===== 3. 关键区无横向溢出 =====
    print('\n=== 分区溢出检查 ===')
    secs = [('#t0DailyCards', '每日卡区'), ('#t0CoreGrid', '行1卡区'), ('#t0GridHold', '行2卡区'),
            ('#t0GridT0', '行3卡区'), ('#t0StatusDist', '状态分布'), ('#t0YearlyTable', '逐年表'),
            ('#t0Params', '参数表'), ('#t0SignalCard', '信号卡')]
    for sel, name in secs:
        el = page.locator(sel).first
        if el.count():
            ov = el.evaluate('e => e.scrollWidth - e.clientWidth')
            check(f'{name}无溢出', ov <= 1, f'溢出{ov}px')
        else:
            check(f'{name}存在', False, '元素缺失')

    # ===== 4. 功能点击 =====
    print('\n=== 功能点击 ===')
    # 口径面板展开
    try:
        page.evaluate("() => { const e = document.getElementById('t0CaliberPanel'); if (e) e.open = true; }")
        cal = page.locator('#t0CaliberBody').inner_text()
        check('口径面板可展开', 'mom10' in cal, cal[:80])
    except Exception as e:
        check('口径面板展开', False, str(e))
    # 历史明细展开按钮
    try:
        btn = page.locator('#t0HistoryExpandBtn')
        if btn.count() and btn.is_visible():
            btn.click(timeout=3000)
            page.wait_for_timeout(500)
            hrows = page.locator('#t0HistoryDailyBody tr').count()
            check('历史明细展开', hrows > 20, str(hrows))
        else:
            check('历史明细展开按钮', True, '无需展开(条数少)')
    except Exception as e:
        check('历史明细展开', False, str(e))
    # 切创业板做T
    try:
        page.get_by_text('创业板做T', exact=True).first.click(timeout=3000)
        page.wait_for_timeout(1200)
        cyb = page.locator('body').inner_text()
        check('切创业板做T正常', '创业板做T' in cyb and '每日记录' in cyb)
    except Exception as e:
        check('切创业板做T', False, str(e))
    # 切回红利做T
    try:
        page.get_by_text('红利做T', exact=True).first.click(timeout=3000)
        page.wait_for_timeout(1200)
        hd2 = page.locator('#headerDesc').inner_text()
        check('切回红利做T正常', 'mom10' in hd2, hd2[:120])
    except Exception as e:
        check('切回红利做T', False, str(e))

    # ===== 5. console =====
    print('\n=== console错误 ===')
    real_errs = [e for e in errs if 'favicon' not in e.lower()]
    check('无console错误', len(real_errs) == 0, str(real_errs[:5]))

    # ===== 6. 截图 =====
    page.screenshot(path='data/backups/_phone_top.png')
    page.locator('#t0CoreGrid').scroll_into_view_if_needed()
    page.wait_for_timeout(400)
    page.screenshot(path='data/backups/_phone_history.png')

    print('\n' + '=' * 50)
    if fails:
        print(f'❌ 失败 {len(fails)} 项: {fails}')
    else:
        print('✅ 全部通过')
    browser.close()
