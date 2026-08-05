// 策略健康度监控模块
// 每年初与校准一起运行，监控比值分布漂移、信号触发频率、策略表现
// 输出健康度报告，辅助判断策略是否仍有效
const fs = require('fs');
const path = require('path');
const { config } = require('./config.cjs');
const { log, nowBeijing } = require('./database.cjs');
const { median, valueAtPercentile, percentileInWindow, getRatioSeries, getWindowRatios } = require('./calibrate.cjs');

// ============================================================
// 计算年度统计（某年的比值分布、信号触发频率）
// ============================================================
function yearlyStats(ratioSeries, year, cfg) {
  cfg = cfg || config;
  const yearRatios = ratioSeries
    .filter(r => r.date.slice(0, 4) === String(year))
    .map(r => r.ratio);

  if (yearRatios.length === 0) return null;

  const sorted = yearRatios.slice().sort((a, b) => a - b);
  const buyDays = yearRatios.filter(r => r <= cfg.buyZoneTop).length;
  const sellDays = yearRatios.filter(r => r >= cfg.sellZoneBottom).length;
  const holdDays = yearRatios.length - buyDays - sellDays;

  return {
    year,
    trading_days: yearRatios.length,
    min: sorted[0],
    p5: valueAtPercentile(sorted, 0.05),
    p10: valueAtPercentile(sorted, 0.10),
    p50: median(sorted),
    p90: valueAtPercentile(sorted, 0.90),
    p95: valueAtPercentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    buy_zone_pct: buyDays / yearRatios.length,
    sell_zone_pct: sellDays / yearRatios.length,
    hold_zone_pct: holdDays / yearRatios.length,
    buy_days: buyDays,
    sell_days: sellDays,
    hold_days: holdDays
  };
}

// ============================================================
// 计算比值分布漂移（年度中位数 vs 历史中位数）
// ============================================================
function calcDrift(ratioSeries, checkDate, cfg) {
  cfg = cfg || config;
  const checkYear = parseInt(checkDate.slice(0, 4));

  // 全历史中位数（checkDate之前）
  const allRatios = ratioSeries
    .filter(r => r.date < checkDate)
    .map(r => r.ratio);
  if (allRatios.length === 0) return null;

  const historyMedian = median(allRatios);

  // 近5年窗口中位数
  const windowRatios = getWindowRatios(ratioSeries, checkDate, cfg.calibWindowYears);
  if (windowRatios.length === 0) return null;

  const windowMedian = median(windowRatios);
  const drift = windowMedian - historyMedian;

  // 近1年中位数
  const lastYearRatios = ratioSeries
    .filter(r => r.date >= `${checkYear - 1}-01-01` && r.date < checkDate)
    .map(r => r.ratio);
  const lastYearMedian = lastYearRatios.length > 0 ? median(lastYearRatios) : windowMedian;

  return {
    history_median: historyMedian,
    window_median: windowMedian,
    last_year_median: lastYearMedian,
    drift_5y: drift,
    drift_1y: lastYearMedian - historyMedian,
    drift_pct: drift / historyMedian
  };
}

// ============================================================
// 参数有效性检验（当前参数在窗口中的分位）
// ============================================================
function paramValidity(ratioSeries, checkDate, cfg) {
  cfg = cfg || config;
  const windowRatios = getWindowRatios(ratioSeries, checkDate, cfg.calibWindowYears);
  if (windowRatios.length === 0) return null;

  const buyPct = percentileInWindow(cfg.buyZoneTop, windowRatios);
  const sellPct = percentileInWindow(cfg.sellZoneBottom, windowRatios);

  const buyValid = buyPct >= cfg.calibBuyPctMin && buyPct <= cfg.calibBuyPctMax;
  const sellValid = sellPct >= cfg.calibSellPctMin && sellPct <= cfg.calibSellPctMax;

  return {
    buy_zone_top: cfg.buyZoneTop,
    sell_zone_bottom: cfg.sellZoneBottom,
    buy_pct: buyPct,
    sell_pct: sellPct,
    buy_valid: buyValid,
    sell_valid: sellValid,
    buy_range: `${(cfg.calibBuyPctMin * 100).toFixed(0)}%~${(cfg.calibBuyPctMax * 100).toFixed(0)}%`,
    sell_range: `${(cfg.calibSellPctMin * 100).toFixed(0)}%~${(cfg.calibSellPctMax * 100).toFixed(0)}%`
  };
}

// ============================================================
// 生成健康度报告
// ============================================================
function generateHealthReport(ratioSeries, checkDate, cfg) {
  cfg = cfg || config;
  const checkYear = parseInt(checkDate.slice(0, 4));

  // 近5年年度统计
  const yearlyStatsList = [];
  for (let y = checkYear - 5; y < checkYear; y++) {
    const ys = yearlyStats(ratioSeries, y, cfg);
    if (ys) yearlyStatsList.push(ys);
  }

  // 分布漂移
  const drift = calcDrift(ratioSeries, checkDate, cfg);

  // 参数有效性
  const paramValid = paramValidity(ratioSeries, checkDate, cfg);

  // 健康度评分（0-100，越高越健康）
  let healthScore = 100;
  const issues = [];

  // 1. 参数有效性（权重30分）
  if (paramValid) {
    if (!paramValid.buy_valid) {
      healthScore -= 15;
      issues.push(`买入上界分位${(paramValid.buy_pct * 100).toFixed(1)}%超出合理区间${paramValid.buy_range}`);
    }
    if (!paramValid.sell_valid) {
      healthScore -= 15;
      issues.push(`卖出下界分位${(paramValid.sell_pct * 100).toFixed(1)}%超出合理区间${paramValid.sell_range}`);
    }
  }

  // 2. 中位数漂移（权重30分）
  if (drift) {
    const driftPctAbs = Math.abs(drift.drift_pct);
    if (driftPctAbs > 0.10) {
      healthScore -= 30;
      issues.push(`5年中位数漂移${(drift.drift_pct * 100).toFixed(1)}%（>10%），比值分布结构性变化`);
    } else if (driftPctAbs > 0.05) {
      healthScore -= 15;
      issues.push(`5年中位数漂移${(drift.drift_pct * 100).toFixed(1)}%（5%~10%），需关注`);
    }
  }

  // 3. 信号触发频率（权重20分）
  if (yearlyStatsList.length > 0) {
    const lastYear = yearlyStatsList[yearlyStatsList.length - 1];
    if (lastYear.sell_zone_pct < 0.03) {
      healthScore -= 10;
      issues.push(`${lastYear.year}年卖出区触发仅${(lastYear.sell_zone_pct * 100).toFixed(1)}%，策略可能变为"只买不卖"`);
    }
    if (lastYear.buy_zone_pct > 0.30) {
      healthScore -= 10;
      issues.push(`${lastYear.year}年买入区触发${(lastYear.buy_zone_pct * 100).toFixed(1)}%过高，可能持续下跌中继`);
    }
  }

  // 4. 年度信号稳定性（权重20分）
  if (yearlyStatsList.length >= 2) {
    const buyPcts = yearlyStatsList.map(y => y.buy_zone_pct);
    const sellPcts = yearlyStatsList.map(y => y.sell_zone_pct);
    const buyStd = stdDev(buyPcts);
    const sellStd = stdDev(sellPcts);
    if (buyStd > 0.15 || sellStd > 0.15) {
      healthScore -= 20;
      issues.push(`信号触发频率波动大（买入σ=${(buyStd * 100).toFixed(1)}%，卖出σ=${(sellStd * 100).toFixed(1)}%）`);
    } else if (buyStd > 0.10 || sellStd > 0.10) {
      healthScore -= 10;
      issues.push(`信号触发频率有波动（买入σ=${(buyStd * 100).toFixed(1)}%，卖出σ=${(sellStd * 100).toFixed(1)}%）`);
    }
  }

  healthScore = Math.max(0, Math.min(100, healthScore));

  let level;
  if (healthScore >= 85) level = '健康';
  else if (healthScore >= 70) level = '关注';
  else if (healthScore >= 50) level = '警告';
  else level = '异常';

  return {
    check_date: checkDate,
    health_score: healthScore,
    level,
    issues,
    yearly_stats: yearlyStatsList,
    drift,
    param_validity: paramValid
  };
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// ============================================================
// 格式化健康度报告为文本
// ============================================================
function formatHealthReport(report, indexName) {
  indexName = indexName || '创业板';
  const lines = [];
  lines.push(`【${indexName}/红利·策略健康度报告】`);
  lines.push(`检查日: ${report.check_date}`);
  lines.push(`健康度: ${report.health_score}/100 (${report.level})`);
  lines.push('');

  if (report.issues.length > 0) {
    lines.push('风险项:');
    report.issues.forEach((issue, i) => lines.push(`  ${i + 1}. ${issue}`));
    lines.push('');
  } else {
    lines.push('✓ 未发现风险项');
    lines.push('');
  }

  if (report.param_validity) {
    const pv = report.param_validity;
    lines.push('参数有效性:');
    lines.push(`  买入上界${pv.buy_zone_top} → 窗口分位${(pv.buy_pct * 100).toFixed(1)}% (合理${pv.buy_range}) ${pv.buy_valid ? '✓' : '✗'}`);
    lines.push(`  卖出下界${pv.sell_zone_bottom} → 窗口分位${(pv.sell_pct * 100).toFixed(1)}% (合理${pv.sell_range}) ${pv.sell_valid ? '✓' : '✗'}`);
    lines.push('');
  }

  if (report.drift) {
    const d = report.drift;
    lines.push('分布漂移:');
    lines.push(`  历史中位数: ${d.history_median.toFixed(4)}`);
    lines.push(`  5年窗口中位数: ${d.window_median.toFixed(4)} (漂移${(d.drift_pct * 100).toFixed(1)}%)`);
    lines.push(`  近1年中位数: ${d.last_year_median.toFixed(4)} (漂移${(d.drift_1y * 100).toFixed(1)}%)`);
    lines.push('');
  }

  if (report.yearly_stats && report.yearly_stats.length > 0) {
    lines.push('近5年年度统计:');
    lines.push('  年份  | 交易日 | 中位数  | 买入区% | 卖出区% | 滞回带%');
    lines.push('  ' + '-'.repeat(55));
    for (const ys of report.yearly_stats) {
      lines.push(`  ${ys.year} | ${String(ys.trading_days).padStart(4)} | ${ys.p50.toFixed(4)} | ${(ys.buy_zone_pct * 100).toFixed(1).padStart(6)}% | ${(ys.sell_zone_pct * 100).toFixed(1).padStart(6)}% | ${(ys.hold_zone_pct * 100).toFixed(1).padStart(6)}%`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  yearlyStats,
  calcDrift,
  paramValidity,
  generateHealthReport,
  formatHealthReport
};
