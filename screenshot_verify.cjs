// Playwright 截图验证脚本
// 验证生产环境 https://portfolio-analysis.top/ratio-rotation/ 的显示效果
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const URL = 'https://portfolio-analysis.top/ratio-rotation/index.html';
const OUT_DIR = path.join(__dirname, 'screenshots');

(async () => {
  // 创建输出目录
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // 使用系统 Chrome（Playwright 自带 Chromium 版本不匹配）
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  });

  console.log('='.repeat(60));
  console.log('  Playwright 截图验证');
  console.log('='.repeat(60));

  // ========== 桌面端 1280x900 ==========
  console.log('\n[1] 桌面端 1280x900');
  const desktopCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
  });
  const desktopPage = await desktopCtx.newPage();

  // 收集 console 日志
  const desktopConsole = [];
  desktopPage.on('console', msg => desktopConsole.push(`[${msg.type()}] ${msg.text()}`));
  desktopPage.on('pageerror', err => desktopConsole.push(`[error] ${err.message}`));

  await desktopPage.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  // 等待 #content 显示（loading 消失）
  await desktopPage.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.style.display !== 'none' && content.children.length > 0;
  }, { timeout: 15000 });
  await desktopPage.waitForTimeout(3000); // 等待图表渲染

  // 调试：检查页面状态
  const debugInfo = await desktopPage.evaluate(() => {
    const loading = document.getElementById('loading');
    const content = document.getElementById('content');
    const metricsGrid = document.getElementById('metricsGrid');
    return {
      loadingDisplay: loading ? loading.style.display : 'not found',
      loadingText: loading ? loading.textContent.substring(0, 200) : '',
      contentDisplay: content ? content.style.display : 'not found',
      contentChildren: content ? content.children.length : 0,
      metricsGridExists: !!metricsGrid,
      metricsGridChildren: metricsGrid ? metricsGrid.children.length : 0,
      metricsGridHTML: metricsGrid ? metricsGrid.innerHTML.substring(0, 300) : ''
    };
  });
  console.log('  调试信息:');
  console.log(`    loading display: ${debugInfo.loadingDisplay}`);
  console.log(`    loading text: ${debugInfo.loadingText.substring(0, 100)}`);
  console.log(`    content display: ${debugInfo.contentDisplay}`);
  console.log(`    content children: ${debugInfo.contentChildren}`);
  console.log(`    metricsGrid exists: ${debugInfo.metricsGridExists}`);
  console.log(`    metricsGrid children: ${debugInfo.metricsGridChildren}`);
  console.log(`    metricsGrid HTML: ${debugInfo.metricsGridHTML.substring(0, 200)}`);

  await desktopPage.screenshot({
    path: path.join(OUT_DIR, 'desktop-fullpage.png'),
    fullPage: true
  });
  console.log('  ✓ 桌面端截图已保存');

  // 读取指标卡片
  const desktopMetrics = await desktopPage.evaluate(() => {
    const cards = document.querySelectorAll('#metricsGrid .metric-card');
    return Array.from(cards).map(c => ({
      label: c.querySelector('.label')?.textContent?.trim() || '',
      value: c.querySelector('.value')?.textContent?.trim() || '',
      sub: c.querySelector('.sub')?.textContent?.trim() || ''
    }));
  });
  console.log(`  指标卡片数量: ${desktopMetrics.length}`);
  desktopMetrics.forEach((m, i) => {
    console.log(`    [${i+1}] ${m.label} | ${m.value} | ${m.sub}`);
  });

  // 检查是否有"资产"字眼
  const desktopAssetCheck = await desktopPage.evaluate(() => {
    const text = document.body.innerText;
    const keywords = ['期末资产', '当前资产', '资产总额', '累计资产', 'asset'];
    return keywords.map(k => ({ keyword: k, found: text.includes(k) }));
  });
  console.log('  资产关键词检查:');
  desktopAssetCheck.forEach(c => {
    console.log(`    ${c.found ? '✗' : '✓'} ${c.keyword}: ${c.found ? '发现' : '未发现'}`);
  });

  // 检查当前状态区域
  const desktopStatus = await desktopPage.evaluate(() => {
    const statusContent = document.getElementById('statusContent');
    if (!statusContent) return { exists: false };
    const ratioValue = statusContent.querySelector('.ratio-value')?.textContent?.trim() || '';
    const ratioZone = statusContent.querySelector('.ratio-zone')?.textContent?.trim() || '';
    const nextAction = statusContent.querySelector('.next-action .value')?.textContent?.trim() || '';
    const detailItems = statusContent.querySelectorAll('.status-detail-item');
    const details = Array.from(detailItems).map(d => ({
      label: d.querySelector('.label')?.textContent?.trim() || '',
      value: d.querySelector('.value')?.textContent?.trim() || ''
    }));
    return { exists: true, ratioValue, ratioZone, nextAction, details };
  });
  console.log('  当前状态:');
  console.log(`    比值: ${desktopStatus?.ratioValue || 'N/A'}`);
  console.log(`    区域: ${desktopStatus?.ratioZone || 'N/A'}`);
  console.log(`    下步操作: ${desktopStatus?.nextAction || 'N/A'}`);
  console.log(`    详情项: ${desktopStatus?.details?.length || 0}`);
  if (desktopStatus?.details) {
    desktopStatus.details.forEach(d => {
      console.log(`      - ${d.label}: ${d.value}`);
    });
  }

  console.log(`  Console 日志: ${desktopConsole.length} 条`);
  desktopConsole.slice(0, 5).forEach(l => console.log(`    ${l}`));

  await desktopCtx.close();

  // ========== 移动端 iPhone 14 Plus 428x926 ==========
  console.log('\n[2] 移动端 iPhone 14 Plus 428x926');
  const mobileCtx = await browser.newContext({
    viewport: { width: 428, height: 926 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  });
  const mobilePage = await mobileCtx.newPage();

  const mobileConsole = [];
  mobilePage.on('console', msg => mobileConsole.push(`[${msg.type()}] ${msg.text()}`));
  mobilePage.on('pageerror', err => mobileConsole.push(`[error] ${err.message}`));

  await mobilePage.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await mobilePage.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.style.display !== 'none' && content.children.length > 0;
  }, { timeout: 15000 });
  await mobilePage.waitForTimeout(3000);

  await mobilePage.screenshot({
    path: path.join(OUT_DIR, 'mobile-iphone14plus-fullpage.png'),
    fullPage: true
  });
  console.log('  ✓ 移动端截图已保存');

  // 检查 metrics-grid 布局
  const mobileLayout = await mobilePage.evaluate(() => {
    const grid = document.getElementById('metricsGrid');
    if (!grid) return { exists: false };
    const style = window.getComputedStyle(grid);
    const cards = grid.querySelectorAll('.metric-card');
    const firstCard = cards[0];
    const firstCardRect = firstCard ? firstCard.getBoundingClientRect() : null;
    return {
      exists: true,
      gridTemplateColumns: style.gridTemplateColumns,
      cardCount: cards.length,
      firstCardWidth: firstCardRect ? Math.round(firstCardRect.width) : 0,
      firstCardHeight: firstCardRect ? Math.round(firstCardRect.height) : 0
    };
  });
  console.log(`  metrics-grid 布局: ${mobileLayout.gridTemplateColumns}`);
  console.log(`  卡片数量: ${mobileLayout.cardCount}`);
  console.log(`  首张卡片尺寸: ${mobileLayout.firstCardWidth}x${mobileLayout.firstCardHeight}px`);

  // 检查水平滚动
  const mobileScroll = await mobilePage.evaluate(() => {
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      hasHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });
  console.log(`  水平滚动: ${mobileScroll.hasHScroll ? '✗ 有' : '✓ 无'} (scrollWidth=${mobileScroll.scrollWidth}, clientWidth=${mobileScroll.clientWidth})`);

  // 检查比值显示
  const mobileRatio = await mobilePage.evaluate(() => {
    const ratioValue = document.querySelector('.ratio-display .ratio-value');
    if (!ratioValue) return { exists: false };
    const style = window.getComputedStyle(ratioValue);
    return {
      exists: true,
      text: ratioValue.textContent.trim(),
      fontSize: style.fontSize
    };
  });
  console.log(`  比值显示: ${mobileRatio.text} (font-size: ${mobileRatio.fontSize})`);

  console.log(`  Console 日志: ${mobileConsole.length} 条`);
  mobileConsole.slice(0, 5).forEach(l => console.log(`    ${l}`));

  await mobileCtx.close();

  // ========== 移动端顶部截图（首屏） ==========
  console.log('\n[3] 移动端首屏截图');
  const mobileTopCtx = await browser.newContext({
    viewport: { width: 428, height: 926 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  });
  const mobileTopPage = await mobileTopCtx.newPage();
  await mobileTopPage.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await mobileTopPage.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.style.display !== 'none' && content.children.length > 0;
  }, { timeout: 15000 });
  await mobileTopPage.waitForTimeout(3000);
  await mobileTopPage.screenshot({
    path: path.join(OUT_DIR, 'mobile-iphone14plus-viewport.png'),
    fullPage: false
  });
  console.log('  ✓ 移动端首屏截图已保存');
  await mobileTopCtx.close();

  await browser.close();

  console.log('\n' + '='.repeat(60));
  console.log('  截图验证完成');
  console.log(`  输出目录: ${OUT_DIR}`);
  console.log('='.repeat(60));
})().catch(e => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
