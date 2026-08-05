// 回测验证脚本
// 读取 data/history_data.json，运行 engine.cjs 回测
// 验证与规格3.1节验收基准的匹配度
const fs = require('fs');
const path = require('path');
const { config } = require('./config.cjs');
const { runBacktest, verifyConsistency } = require('./engine.cjs');
const { log } = require('./database.cjs');

// ============================================================
// 规格3.1验收基准
// ============================================================
const ACCEPTANCE = {
  totalRet: 13.82,        // 总收益13.82倍
  annualRet: 0.2601,      // 年化26.01%
  maxDrawdown: -0.4555,   // 最大回撤-45.55%
  finalAsset: 23711564.93, // 期末资产23,711,564.93元
  totalProfit: 22111564.93, // 累计盈利22,111,564.93元
  tradeCount: 36,         // 总调仓36次
  buyCount: 16,           // 买入16次
  sellCount: 20,          // 卖出20次
  tradingDays: 2939       // 交易日2939天
};

// 规格3.2历年收益表
const YEARLY_ACCEPTANCE = {
  2014: 0.566,  2015: 0.298,  2016: -0.043, 2017: 0.214,
  2018: -0.171, 2019: 0.476,  2020: 0.637,  2021: 0.222,
  2022: -0.005, 2023: 0.065,  2024: 0.372,  2025: 0.513,
  2026: 0.168
};

// 规格3.3关键调仓剧本
const SCRIPT_CHECKS = {
  // 剧本一：2024年V型急跌建仓（信号日2024-01-26，买5档）
  '2024-01-26': { expectedAction: 'BUY', expectedTiers: 5, desc: '4交易日0%→100% 第1天买5档' },
  // 剧本二：2026年高位清仓（信号日2026-01-12，执行日1-13，卖1档）
  '2026-01-12': { expectedAction: 'SELL', expectedTiers: 1, desc: '2026年清仓第1笔卖1档(执行日1-13)' },
};

// ============================================================
// 加载历史数据
// ============================================================
function loadHistoryData() {
  const filePath = path.join(__dirname, 'data', 'history_data.json');
  if (!fs.existsSync(filePath)) {
    console.error('历史数据文件不存在: data/history_data.json');
    console.error('请先运行: python fetch_history.py');
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const json = JSON.parse(raw);
  return json.data;
}

// ============================================================
// 计算历年收益
// ============================================================
function calcYearlyReturns(dailyRecords, initCapital) {
  const yearly = {};
  let prevAsset = initCapital;

  // 按年分组
  const byYear = {};
  for (const r of dailyRecords) {
    const year = parseInt(r.date.slice(0, 4));
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(r);
  }

  for (const year of Object.keys(byYear).sort()) {
    const records = byYear[year];
    const yearStartAsset = prevAsset;
    const yearEndAsset = records[records.length - 1].asset_value;
    const yearRet = (yearEndAsset / yearStartAsset) - 1;

    // 年度最大回撤
    let peak = yearStartAsset;
    let maxDD = 0;
    for (const r of records) {
      if (r.asset_value > peak) peak = r.asset_value;
      const dd = (r.asset_value - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }

    // 平均仓位
    const avgWeight = records.reduce((s, r) => s + r.cyb_weight, 0) / records.length;

    // 买卖次数
    const buyCount = records.filter(r => r.action === 'BUY').length;
    const sellCount = records.filter(r => r.action === 'SELL').length;

    yearly[year] = {
      year: parseInt(year),
      annualRet: yearRet,
      maxDrawdown: maxDD,
      assetStart: yearStartAsset,
      assetEnd: yearEndAsset,
      avgWeight: avgWeight,
      buyCount: buyCount,
      sellCount: sellCount,
      tradingDays: records.length
    };

    prevAsset = yearEndAsset;
  }

  return yearly;
}

// ============================================================
// 主验证函数
// ============================================================
function main() {
  console.log('='.repeat(60));
  console.log('回测验证：与规格3.1节验收基准比对');
  console.log('='.repeat(60));

  // 加载数据
  const historyData = loadHistoryData();
  console.log(`历史数据: ${historyData.length} 个交易日`);
  console.log(`数据范围: ${historyData[0].date} ~ ${historyData[historyData.length-1].date}`);

  // 运行回测
  console.log('\n开始回测...');
  const result = runBacktest(historyData, config.initCapital);

  // ============================================================
  // 1. 全周期业绩验证
  // ============================================================
  console.log('\n' + '='.repeat(60));
  console.log('1. 全周期业绩验证（规格3.1）');
  console.log('='.repeat(60));

  const checks = [
    { name: '总收益(倍)', actual: result.totalRet, expected: ACCEPTANCE.totalRet, tolerance: 0.5, unit: '倍' },
    { name: '年化收益', actual: result.annualRet, expected: ACCEPTANCE.annualRet, tolerance: 0.005, unit: '' },
    { name: '最大回撤', actual: result.maxDrawdown, expected: ACCEPTANCE.maxDrawdown, tolerance: 0.05, unit: '' },
    { name: '期末资产', actual: result.finalAsset, expected: ACCEPTANCE.finalAsset, tolerance: ACCEPTANCE.finalAsset * 0.01, unit: '元' },
    { name: '总调仓次数', actual: result.tradeCount, expected: ACCEPTANCE.tradeCount, tolerance: 2, unit: '次' },
    { name: '买入次数', actual: result.buyCount, expected: ACCEPTANCE.buyCount, tolerance: 2, unit: '次' },
    { name: '卖出次数', actual: result.sellCount, expected: ACCEPTANCE.sellCount, tolerance: 2, unit: '次' },
    { name: '交易日数', actual: result.tradingDays, expected: ACCEPTANCE.tradingDays, tolerance: 5, unit: '天' },
  ];

  let allPass = true;
  for (const c of checks) {
    const diff = Math.abs(c.actual - c.expected);
    const pass = diff <= c.tolerance;
    const status = pass ? '✓ PASS' : '✗ FAIL';
    console.log(`  [${status}] ${c.name}: 实际=${typeof c.actual === 'number' ? c.actual.toFixed(4) : c.actual}${c.unit}, ` +
                `期望=${typeof c.expected === 'number' ? c.expected.toFixed(4) : c.expected}${c.unit}, ` +
                `偏差=${diff.toFixed(4)}, 容差=${c.tolerance}`);
    if (!pass) allPass = false;
  }

  console.log(`\n  累计盈利: ${(result.finalAsset - config.initCapital).toFixed(2)}元 ` +
              `(期望: ${ACCEPTANCE.totalProfit.toFixed(2)}元)`);

  // ============================================================
  // 2. 历年收益验证
  // ============================================================
  console.log('\n' + '='.repeat(60));
  console.log('2. 历年收益验证（规格3.2，容差±0.5%）');
  console.log('='.repeat(60));

  const yearlyReturns = calcYearlyReturns(result.dailyRecords, config.initCapital);

  console.log('  年份 | 实际收益 | 期望收益 | 偏差   | 状态');
  console.log('  -----|---------|---------|--------|-----');
  for (const [year, expected] of Object.entries(YEARLY_ACCEPTANCE)) {
    const actual = yearlyReturns[year] ? yearlyReturns[year].annualRet : null;
    if (actual === null) {
      console.log(`  ${year} | N/A     | ${(expected * 100).toFixed(1)}%   | N/A    | ✗ FAIL (无数据)`);
      allPass = false;
      continue;
    }
    const diff = Math.abs(actual - expected);
    const pass = diff <= 0.005;
    const status = pass ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${year} | ${(actual * 100).toFixed(1)}%  | ${(expected * 100).toFixed(1)}%   | ${(diff * 100).toFixed(1)}% | ${status}`);
    if (!pass) allPass = false;
  }

  // 历年详情
  console.log('\n  历年详情:');
  console.log('  年份 | 年度收益 | 最大回撤 | 平均仓位 | 买/卖次数 | 交易日');
  console.log('  -----|---------|---------|---------|----------|-------');
  for (const [year, s] of Object.entries(yearlyReturns)) {
    console.log(`  ${year} | ${(s.annualRet * 100).toFixed(1)}%  | ${(s.maxDrawdown * 100).toFixed(1)}%  | ` +
                `${(s.avgWeight * 100).toFixed(0)}%    | ${s.buyCount}/${s.sellCount}      | ${s.tradingDays}`);
  }

  // ============================================================
  // 3. 关键调仓剧本验证
  // ============================================================
  console.log('\n' + '='.repeat(60));
  console.log('3. 关键调仓剧本验证（规格3.3）');
  console.log('='.repeat(60));

  for (const [date, check] of Object.entries(SCRIPT_CHECKS)) {
    const record = result.dailyRecords.find(r => r.date === date);
    if (!record) {
      console.log(`  [✗ FAIL] ${date}: 数据缺失 (${check.desc})`);
      allPass = false;
      continue;
    }
    const actionMatch = record.action === check.expectedAction;
    const tiersMatch = record.action_tiers === check.expectedTiers;
    const pass = actionMatch && tiersMatch;
    console.log(`  [${pass ? '✓ PASS' : '✗ FAIL'}] ${date}: ${check.desc}`);
    console.log(`    实际: action=${record.action}, tiers=${record.action_tiers}, ` +
                `仓位=${(record.cyb_weight * 100).toFixed(0)}%, 比值=${record.ratio}`);
    console.log(`    期望: action=${check.expectedAction}, tiers=${check.expectedTiers}`);
    if (!pass) allPass = false;
  }

  // 剧本一完整序列：2024-01-25~01-31
  console.log('\n  剧本一完整序列（2024年V型急跌建仓）:');
  const script1Dates = ['2024-01-25', '2024-01-26', '2024-01-29', '2024-01-30', '2024-01-31'];
  for (const date of script1Dates) {
    const r = result.dailyRecords.find(rec => rec.date === date);
    if (r) {
      console.log(`    ${date}: ratio=${r.ratio}, action=${r.action}, tiers=${r.action_tiers}, ` +
                  `仓位=${(r.cyb_weight * 100).toFixed(0)}%, exec=${r.exec_date || 'N/A'}`);
    }
  }

  // 剧本二完整序列：2026年清仓
  console.log('\n  剧本二完整序列（2026年高位清仓）:');
  const script2Records = result.dailyRecords.filter(r =>
    r.date.startsWith('2026-') && r.action === 'SELL');
  for (const r of script2Records) {
    console.log(`    ${r.date}: ratio=${r.ratio}, SELL ${r.action_tiers}档, ` +
                `仓位=${(r.cyb_weight * 100).toFixed(0)}%, exec=${r.exec_date}`);
  }
  console.log(`    共 ${script2Records.length} 次卖出信号`);

  // ============================================================
  // 4. 收益自洽校验
  // ============================================================
  console.log('\n' + '='.repeat(60));
  console.log('4. 收益自洽校验（规格2.6节恒等式）');
  console.log('='.repeat(60));

  const consistency = verifyConsistency(result.dailyRecords, config.initCapital);
  console.log(`  检查总数: ${consistency.totalChecked}`);
  console.log(`  告警数: ${consistency.alertCount}`);
  console.log(`  状态: ${consistency.passed ? '✓ PASS' : '✗ FAIL'}`);
  if (consistency.alerts.length > 0) {
    console.log('  前10条告警:');
    for (const a of consistency.alerts.slice(0, 10)) {
      console.log(`    ${a.date} [${a.type}]: ${a.detail}`);
    }
  }
  if (!consistency.passed) allPass = false;

  // ============================================================
  // 总结
  // ============================================================
  console.log('\n' + '='.repeat(60));
  console.log('验证总结');
  console.log('='.repeat(60));
  console.log(`  整体状态: ${allPass ? '✓ 全部通过' : '✗ 存在不通过项'}`);

  if (!allPass) {
    console.log('\n  ⚠️  存在不通过项，可能原因：');
    console.log('    1. 分红率使用兜底值（4.4%/0.9%年均），与精确值有偏差');
    console.log('    2. 2014-07-01首日数据偏差（新浪前复权）');
    console.log('    3. 数据源精度差异');
    console.log('    4. 引擎逻辑需调整');
  }

  // 保存回测结果
  const outputPath = path.join(__dirname, 'data', 'backtest_result.json');
  const summary = {
    verified_at: new Date().toISOString(),
    all_pass: allPass,
    total_metrics: {
      totalRet: result.totalRet,
      annualRet: result.annualRet,
      maxDrawdown: result.maxDrawdown,
      finalAsset: result.finalAsset,
      tradeCount: result.tradeCount,
      buyCount: result.buyCount,
      sellCount: result.sellCount,
      tradingDays: result.tradingDays
    },
    yearly_returns: yearlyReturns,
    consistency: {
      totalChecked: consistency.totalChecked,
      alertCount: consistency.alertCount,
      passed: consistency.passed
    }
  };
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`\n  回测结果已保存: ${outputPath}`);

  return allPass;
}

// 运行
const passed = main();
process.exit(passed ? 0 : 1);
