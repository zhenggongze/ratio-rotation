# -*- coding: utf-8 -*-
"""生产环境全面回归：桌面 + iPhone14Plus 手机端 + 数据核对 + console（portfolio-analysis.top）"""
from playwright.sync_api import sync_playwright

URL = 'https://portfolio-analysis.top/ratio-rotation/'
fails = []
def check(name, cond, detail=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + (('  | ' + detail) if detail and not cond else ''))
    if not cond: fails.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe")

    # ============ 桌面回归 ============
    print('========== 桌面端回归 ==========')
    page = browser.new_page(viewport={'width': 1500, 'height': 1400})
    errs = []
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(URL, wait_until='networkidle', timeout=30000)
    page.wait_for_timeout(3000)

    print('=== 页面加载 ===')
    check('页面标题', '比值轮动' in page.title(), page.title())
    tabs = page.locator('.tab').all_inner_texts()
    check('页签3个', [t.strip() for t in tabs] == ['红利做T', '创业板做T', '创业板/红利'], str(tabs))

    print('\n=== 红利做T页 ===')
    hd = page.locator('#headerDesc').inner_text()
    check('头部含做T+0/mom10', '做T+0' in hd and 'mom10' in hd and 'T+1' in hd, hd[:200])
    sig = page.locator('#t0SignalCard').inner_text()
    check('信号卡含状态+价格', ('今日全仓' in sig or '今日做T' in sig) and '买入价' in sig and '卖出价' in sig, sig[:200])
    rows = page.locator('#t0DailyBody tr').count()
    check('每日记录18行', rows == 18, str(rows))
    d828 = page.evaluate("() => { const r = Array.from(document.querySelectorAll('#t0DailyBody tr')).find(x => x.textContent.includes('2026-08-28')); return r ? r.textContent.replace(/\\s+/g,' ').trim() : '' }")
    check('8-28未触发(5%口径)', '未触发' in d828 and '全仓' not in d828, d828[:150])
    check('每日卡3张', page.locator('#t0DailyCards .metric-card').count() == 3, '')
    check('行1卡3张', page.locator('#t0CoreGrid .metric-card').count() == 3, '')
    check('行2卡3张', page.locator('#t0GridHold .metric-card').count() == 3, '')
    check('行3卡3张', page.locator('#t0GridT0 .metric-card').count() == 3, '')
    core_txt = page.locator('#t0CoreGrid').inner_text()
    check('行1含77.2%', '77.2%' in core_txt and '77.08万' not in core_txt, core_txt[:200])
    hold_txt = page.locator('#t0GridHold').inner_text()
    check('行2含6.0%超额', '相对满仓' in hold_txt and '6.0%' in hold_txt, hold_txt[:200])
    t0g_txt = page.locator('#t0GridT0').inner_text()
    check('行3含21.3%超额', '相对做T' in t0g_txt and '21.3%' in t0g_txt, t0g_txt[:200])
    hdist = page.locator('#t0StatusDist').inner_text()
    check('历史状态三态', '双边成交' in hdist and '仅买' in hdist and '未触发' in hdist, hdist[:150])
    yt = page.locator('#t0YearlyTable').inner_text()
    check('逐年表含mom10', 'mom10' in yt and '2020' in yt, yt[:200])
    params = page.locator('#t0Params').inner_text()
    check('参数含mom10阈值', 'mom10阈值' in params, params[:150])
    cal = page.evaluate("() => { const e = document.getElementById('t0CaliberPanel'); if (e) e.open = true; const b = document.getElementById('t0CaliberBody'); return b ? b.textContent : '' }")
    check('口径说明含mom10', 'mom10' in cal, cal[:100])

    print('\n=== 桌面tab切换 ===')
    try:
        page.get_by_text('创业板做T', exact=True).first.click(timeout=3000)
        page.wait_for_timeout(1200)
        check('切创业板正常', '创业板' in page.locator('body').inner_text())
    except Exception as e:
        check('切创业板', False, str(e))
    try:
        page.get_by_text('创业板/红利', exact=True).first.click(timeout=3000)
        page.wait_for_timeout(1200)
        check('切轮动页正常', '比值轮动' in page.locator('body').inner_text())
    except Exception as e:
        check('切轮动页', False, str(e))

    real_errs = [e for e in errs if 'favicon' not in e.lower()]
    check('桌面无console错误', len(real_errs) == 0, str(real_errs[:5]))
    page.close()

    # ============ iPhone 14 Plus 手机端回归 ============
    print('\n========== iPhone 14 Plus 手机端回归 ==========')
    mpage = browser.new_page(viewport={'width': 428, 'height': 926}, is_mobile=True, has_touch=True, device_scale_factor=3)
    merrs = []
    mpage.on('console', lambda m: merrs.append(m.text) if m.type == 'error' else None)
    mpage.on('pageerror', lambda e: merrs.append(str(e)))
    mpage.goto(URL, wait_until='networkidle', timeout=30000)
    mpage.wait_for_timeout(3000)

    overflow = mpage.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    check('手机无横向溢出', overflow <= 0, f'溢出{overflow}px')
    mhd = mpage.locator('#headerDesc').inner_text()
    check('手机头部两行', len(mhd.splitlines()) >= 2, mhd[:150])
    msig = mpage.locator('#t0SignalCard').inner_text()
    check('手机信号卡含状态+价格', ('今日全仓' in msig or '今日做T' in msig) and '买入价' in msig and '卖出价' in msig, msig[:200])
    mrows = mpage.locator('#t0DailyBody tr').count()
    check('手机每日记录18行', mrows == 18, str(mrows))
    check('手机行1-3卡3张', mpage.locator('#t0CoreGrid .metric-card').count() == 3
          and mpage.locator('#t0GridHold .metric-card').count() == 3
          and mpage.locator('#t0GridT0 .metric-card').count() == 3, '')
    # 关键区无溢出
    for sel, nm in [('#t0CoreGrid', '行1'), ('#t0GridHold', '行2'), ('#t0GridT0', '行3'), ('#t0DailyCards', '每日卡')]:
        ov = mpage.locator(sel).first.evaluate('e => e.scrollWidth - e.clientWidth')
        check(f'手机{nm}无溢出', ov <= 1, f'溢出{ov}px')
    # 功能点击
    try:
        mpage.get_by_text('创业板做T', exact=True).first.click(timeout=3000)
        mpage.wait_for_timeout(1200)
        check('手机切创业板正常', '创业板' in mpage.locator('body').inner_text())
        mpage.get_by_text('红利做T', exact=True).first.click(timeout=3000)
        mpage.wait_for_timeout(1200)
        check('手机切回红利正常', 'mom10' in mpage.locator('#headerDesc').inner_text())
    except Exception as e:
        check('手机tab切换', False, str(e))
    mreal = [e for e in merrs if 'favicon' not in e.lower()]
    check('手机无console错误', len(mreal) == 0, str(mreal[:5]))

    # 截图
    mpage.screenshot(path='data/backups/_prod_phone_top.png')
    mpage.locator('#t0CoreGrid').scroll_into_view_if_needed()
    mpage.wait_for_timeout(400)
    mpage.screenshot(path='data/backups/_prod_phone_history.png')
    mpage.close()

    print('\n' + '=' * 56)
    if fails:
        print(f'❌ 生产回归失败 {len(fails)} 项: {fails}')
    else:
        print('✅ 生产回归全部通过')
    browser.close()
