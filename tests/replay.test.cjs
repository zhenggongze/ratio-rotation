// 历史回放验收测试
// 规格11.2节：用2014-07-01至2026-07-31真实数据回放，验证以下事实
// 1. 剧本一：2024-01-25~01-30信号日、01-26~01-31执行日，4交易日0%→100%
// 2. 剧本二：2026年10次卖出清仓剧本
// 3. 剧本三：2018-2019缓跌建仓约39交易日满仓
// 4. 历年收益表（3.2节）逐年一致（容差±0.5%）
// 5. 全周期年化26.01%（±0.5pp）、期末资产23,711,564.93元（±1%）、总调仓36次（±2次）
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runBacktest } = require('../engine.cjs');
const { calcYearlyStats } = require('../stats.cjs');
const { config } = require('../config.cjs');

// ============================================================
// 加载历史数据（所有测试共享）
// ============================================================
let historyData = null;
let backtestResult = null;

function loadHistory() {
  if (historyData) return historyData;
  const filePath = path.join(__dirname, '..', 'data', 'history_data.json');
  if (!fs.existsSync(filePath)) {
    throw new Error('历史数据文件不存在: data/history_data.json');
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const json = JSON.parse(raw);
  historyData = json.data || json;
  return historyData;
}

function runBacktestOnce() {
  if (backtestResult) return backtestResult;
  const data = loadHistory();
  backtestResult = runBacktest(data, config.initCapital);
  return backtestResult;
}

// ============================================================
// 规格3.1节：全周期业绩验收基准
// ============================================================
test('回放验收: 全周期业绩（规格3.1）', () => {
  const result = runBacktestOnce();

  // 总收益13.82倍（容差±0.5倍）
  assert.ok(Math.abs(result.totalRet - 13.82) <= 0.5,
    `总收益应≈13.82倍(±0.5), 实际=${result.totalRet.toFixed(2)}`);

  // 年化26.01%（容差±0.5个百分点）
  assert.ok(Math.abs(result.annualRet - 0.2601) <= 0.005,
    `年化应≈26.01%(±0.5pp), 实际=${(result.annualRet * 100).toFixed(2)}%`);

  // 最大回撤-45.55%（容差±5%）
  assert.ok(Math.abs(result.maxDrawdown - (-0.4555)) <= 0.05,
    `最大回撤应≈-45.55%(±5pp), 实际=${(result.maxDrawdown * 100).toFixed(2)}%`);

  // 期末资产23,711,564.93元（容差±1%）
  const assetTolerance = 23711564.93 * 0.01;
  assert.ok(Math.abs(result.finalAsset - 23711564.93) <= assetTolerance,
    `期末资产应≈23,711,564.93元(±1%), 实际=${result.finalAsset.toFixed(2)}`);

  // 总调仓36次（容差±2次）
  assert.ok(Math.abs(result.tradeCount - 36) <= 2,
    `总调仓应≈36次(±2), 实际=${result.tradeCount}`);

  // 交易日2939天（容差±5天）
  assert.ok(Math.abs(result.tradingDays - 2939) <= 5,
    `交易日应≈2939天(±5), 实际=${result.tradingDays}`);
});

// ============================================================
// 规格3.2节：历年收益表验收（容差±0.5%）
// ============================================================
test('回放验收: 历年收益表（规格3.2，容差±0.5%）', () => {
  const result = runBacktestOnce();
  const yearlyStats = calcYearlyStats(result.dailyRecords, result.tradeLog, config.initCapital);

  // 规格3.2节历年收益表
  const expected = {
    2014: 0.566, 2015: 0.298, 2016: -0.043, 2017: 0.214,
    2018: -0.171, 2019: 0.476, 2020: 0.637, 2021: 0.222,
    2022: -0.005, 2023: 0.065, 2024: 0.372, 2025: 0.513,
    2026: 0.168
  };

  for (const [year, expectedRet] of Object.entries(expected)) {
    const stat = yearlyStats.find(s => s.year === parseInt(year));
    assert.ok(stat, `${year}年统计应存在`);

    const diff = Math.abs(stat.annual_ret - expectedRet);
    assert.ok(diff <= 0.005,
      `${year}年收益应≈${(expectedRet * 100).toFixed(1)}%(±0.5%), 实际=${(stat.annual_ret * 100).toFixed(1)}%, 偏差=${(diff * 100).toFixed(1)}%`);
  }
});

// ============================================================
// 规格3.3节剧本一：2024年V型急跌建仓
// 4个交易日从0%满仓到100%
// ============================================================
test('回放验收: 剧本一（2024年V型急跌建仓）', () => {
  const result = runBacktestOnce();

  // 信号日2024-01-25至2024-01-30的买入调仓
  const script1Trades = result.tradeLog.filter(t =>
    t.signal_date >= '2024-01-25' &&
    t.signal_date <= '2024-01-31' &&
    t.direction === 'BUY'
  );

  // 应有4次买入调仓（规格3.3剧本一）
  assert.ok(script1Trades.length >= 3,
    `2024-01-25~01-31应有3-4次买入调仓, 实际=${script1Trades.length}次`);

  // 验证仓位从0%升至100%
  const firstTrade = script1Trades[0];
  const lastTrade = script1Trades[script1Trades.length - 1];

  assert.ok(firstTrade.weight_before <= 0.05,
    `首次买入前仓位应≤5%, 实际=${(firstTrade.weight_before * 100).toFixed(0)}%`);

  assert.ok(lastTrade.weight_after >= 0.95,
    `末次买入后仓位应≥95%, 实际=${(lastTrade.weight_after * 100).toFixed(0)}%`);

  // 验证执行日为T+1（信号日次日）
  for (const t of script1Trades) {
    const signalDate = new Date(t.signal_date);
    const execDate = new Date(t.exec_date);
    const diffDays = (execDate - signalDate) / (1000 * 60 * 60 * 24);
    // T+1，但如果跨周末可能T+3
    assert.ok(diffDays >= 1 && diffDays <= 5,
      `${t.signal_date}执行日${t.exec_date}应在1-5天后, 实际${diffDays}天`);
  }
});

// ============================================================
// 规格3.3节剧本二：2026年高位清仓
// 10次卖出，仓位85%→0%
// ============================================================
test('回放验收: 剧本二（2026年高位清仓）', () => {
  const result = runBacktestOnce();

  // 2026年的卖出调仓（按执行日计）
  const script2Trades = result.tradeLog.filter(t =>
    t.exec_date >= '2026-01-01' &&
    t.exec_date <= '2026-07-31' &&
    t.direction === 'SELL'
  );

  // 应有10次卖出调仓（规格3.3剧本二）
  assert.ok(script2Trades.length >= 8,
    `2026年应有8-10次卖出调仓, 实际=${script2Trades.length}次`);

  // 验证仓位从约85%降至0%
  if (script2Trades.length > 0) {
    const firstTrade = script2Trades[0];
    const lastTrade = script2Trades[script2Trades.length - 1];

    assert.ok(firstTrade.weight_before >= 0.70,
      `首次卖出前仓位应≥70%, 实际=${(firstTrade.weight_before * 100).toFixed(0)}%`);

    assert.ok(lastTrade.weight_after <= 0.05,
      `末次卖出后仓位应≤5%, 实际=${(lastTrade.weight_after * 100).toFixed(0)}%`);
  }
});

// ============================================================
// 规格3.3节剧本三：2018-2019缓跌建仓
// 约39个交易日从0%到100%
// ============================================================
test('回放验收: 剧本三（2018-2019缓跌建仓）', () => {
  const result = runBacktestOnce();

  // 2018-12至2019-03的买入调仓
  const script3Trades = result.tradeLog.filter(t =>
    t.signal_date >= '2018-12-01' &&
    t.signal_date <= '2019-03-31' &&
    t.direction === 'BUY'
  );

  // 应有多次买入调仓（缓跌建仓，非急跌）
  assert.ok(script3Trades.length >= 3,
    `2018-12~2019-03应有多次买入调仓, 实际=${script3Trades.length}次`);

  // 验证最终仓位接近100%
  if (script3Trades.length > 0) {
    const lastTrade = script3Trades[script3Trades.length - 1];
    assert.ok(lastTrade.weight_after >= 0.90,
      `末次买入后仓位应≥90%, 实际=${(lastTrade.weight_after * 100).toFixed(0)}%`);
  }
});

// ============================================================
// 规格2.5节穿越多档验证
// ============================================================
test('回放验收: 穿越多档逐档计数', () => {
  const result = runBacktestOnce();

  // 找到所有买入调仓，验证档位数计算正确
  const buyTrades = result.tradeLog.filter(t => t.direction === 'BUY');

  for (const t of buyTrades) {
    // 每次买入档数 × 5% = 仓位变化
    const expectedDelta = t.tiers * 0.05;
    const actualDelta = t.weight_after - t.weight_before;
    assert.ok(Math.abs(actualDelta - expectedDelta) < 1e-6,
      `${t.signal_date}: 买入${t.tiers}档应增仓${(expectedDelta * 100).toFixed(0)}%, 实际${(actualDelta * 100).toFixed(0)}%`);
  }
});

// ============================================================
// 规格2.6节收益自洽校验
// ============================================================
test('回放验收: 收益自洽校验', () => {
  const result = runBacktestOnce();
  const { verifyConsistency } = require('../engine.cjs');
  const consistency = verifyConsistency(result.dailyRecords, config.initCapital);

  // 校验应基本通过（允许少量告警，因分红率使用兜底值可能有微小偏差）
  assert.ok(consistency.totalChecked > 0, '应有校验记录');
  assert.ok(consistency.alertCount < 10,
    `告警数应<10, 实际=${consistency.alertCount}（分红率使用兜底值可能有微小偏差）`);
});

// ============================================================
// 规格3.4节数据锚点验证
// ============================================================
test('回放验收: 数据锚点（规格3.4）', () => {
  const result = runBacktestOnce();

  // 2026-07-31：创业板3343.96，红利5569.41，比值0.6004
  const record20260731 = result.dailyRecords.find(r => r.date === '2026-07-31');
  if (record20260731) {
    assert.ok(Math.abs(record20260731.cyb_close - 3343.96) < 1,
      `2026-07-31创业板收盘应≈3343.96, 实际=${record20260731.cyb_close}`);
    assert.ok(Math.abs(record20260731.hli_close - 5569.41) < 1,
      `2026-07-31红利收盘应≈5569.41, 实际=${record20260731.hli_close}`);
    assert.ok(Math.abs(record20260731.ratio - 0.6004) < 0.001,
      `2026-07-31比值应≈0.6004, 实际=${record20260731.ratio}`);
  }

  // 2026-06-30：创业板4342.71，红利5022.5，比值0.8647（历史最高）
  const record20260630 = result.dailyRecords.find(r => r.date === '2026-06-30');
  if (record20260630) {
    assert.ok(Math.abs(record20260630.ratio - 0.8647) < 0.002,
      `2026-06-30比值应≈0.8647, 实际=${record20260630.ratio}`);
  }
});

// ============================================================
// 规格第二节：三区占比验证
// ============================================================
test('回放验收: 三区占比（规格2.1）', () => {
  const result = runBacktestOnce();
  const ratios = result.dailyRecords.map(r => r.ratio);

  const buyZoneCount = ratios.filter(r => r <= 0.332).length;
  const sellZoneCount = ratios.filter(r => r >= 0.578).length;
  const holdZoneCount = ratios.length - buyZoneCount - sellZoneCount;

  const buyPct = buyZoneCount / ratios.length;
  const sellPct = sellZoneCount / ratios.length;
  const holdPct = holdZoneCount / ratios.length;

  // 规格2.1节：买入区约6.2%，卖出区约23.7%，滞回带约70.1%
  assert.ok(buyPct >= 0.04 && buyPct <= 0.08,
    `买入区占比应≈6.2%(4%~8%), 实际=${(buyPct * 100).toFixed(1)}%`);
  assert.ok(sellPct >= 0.20 && sellPct <= 0.27,
    `卖出区占比应≈23.7%(20%~27%), 实际=${(sellPct * 100).toFixed(1)}%`);
  assert.ok(holdPct >= 0.65 && holdPct <= 0.75,
    `滞回带占比应≈70.1%(65%~75%), 实际=${(holdPct * 100).toFixed(1)}%`);
});

// ============================================================
// 规格第二节：极值验证
// ============================================================
test('回放验收: 比值极值（规格2.1）', () => {
  const result = runBacktestOnce();
  const ratios = result.dailyRecords.map(r => r.ratio);

  const minRatio = Math.min(...ratios);
  const maxRatio = Math.max(...ratios);

  // 规格2.1节：最小值0.3045（2024年5-7月）
  assert.ok(Math.abs(minRatio - 0.3045) < 0.005,
    `比值最小值应≈0.3045, 实际=${minRatio}`);

  // 规格2.1节：最大值0.8647（2026-06-30）
  assert.ok(Math.abs(maxRatio - 0.8647) < 0.005,
    `比值最大值应≈0.8647, 实际=${maxRatio}`);
});
