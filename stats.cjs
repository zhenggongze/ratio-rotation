// 统计模块
// 规格7.2节：日别年别统计、自洽校验
// 生成 yearly_stats（年别统计表）
const { config } = require('./config.cjs');
const { nowBeijing } = require('./database.cjs');

// ============================================================
// 计算年别统计（从 daily_records 和 trade_log 计算）
// 规格6.2节 yearly_stats 表结构
// ============================================================
function calcYearlyStats(dailyRecords, tradeLog, initCapital) {
  if (!dailyRecords || dailyRecords.length === 0) return [];

  // 按年分组 daily_records
  const byYear = {};
  for (const r of dailyRecords) {
    const year = parseInt(r.date.slice(0, 4));
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(r);
  }

  // 按执行日年份分组 trade_log
  const tradesByYear = {};
  for (const t of (tradeLog || [])) {
    if (!t.exec_date) continue;
    const year = parseInt(t.exec_date.slice(0, 4));
    if (!tradesByYear[year]) tradesByYear[year] = [];
    tradesByYear[year].push(t);
  }

  const yearlyStats = [];
  let prevAsset = initCapital; // 上年末资产 = 本年初资产

  for (const year of Object.keys(byYear).sort()) {
    const records = byYear[year];
    const yearTrades = tradesByYear[year] || [];

    // 年初资产 = 上年末资产
    const assetStart = prevAsset;
    // 年末资产 = 当年最后一条记录的资产
    const assetEnd = records[records.length - 1].asset_value;
    // 年度收益率
    const annualRet = (assetEnd / assetStart) - 1;

    // 年度最大回撤
    let peak = assetStart;
    let maxDrawdown = 0;
    for (const r of records) {
      if (r.asset_value > peak) peak = r.asset_value;
      const dd = (r.asset_value - peak) / peak;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }

    // 平均仓位
    const avgWeight = records.reduce((s, r) => s + (r.cyb_weight || 0), 0) / records.length;

    // 买卖次数（按 exec_date 落在当年计）
    const buyCount = yearTrades.filter(t => t.direction === 'BUY').length;
    const sellCount = yearTrades.filter(t => t.direction === 'SELL').length;

    // 创业板/红利年度涨跌
    const firstCyb = records[0].cyb_close;
    const lastCyb = records[records.length - 1].cyb_close;
    const cybRet = (lastCyb / firstCyb) - 1;

    const firstHli = records[0].hli_close;
    const lastHli = records[records.length - 1].hli_close;
    const hliRet = (lastHli / firstHli) - 1;

    // 红利持有基准（同期红利买入持有收益率）
    // 假设年初买入红利，持有到年末
    const hliBhRet = hliRet;

    // 创业板持有基准（同期创业板买入持有收益率）
    const cybBhRet = cybRet;

    // 摘要
    const summary = buildYearlySummary(year, buyCount, sellCount, records);

    yearlyStats.push({
      year: parseInt(year),
      annual_ret: annualRet,
      max_drawdown: maxDrawdown,
      asset_start: assetStart,
      asset_end: assetEnd,
      avg_weight: avgWeight,
      buy_count: buyCount,
      sell_count: sellCount,
      cyb_ret: cybRet,
      hli_ret: hliRet,
      hli_bh_ret: hliBhRet,
      cyb_bh_ret: cybBhRet,
      summary: summary,
      updated_at: nowBeijing()
    });

    prevAsset = assetEnd;
  }

  return yearlyStats;
}

// ============================================================
// 生成年度摘要文字
// ============================================================
function buildYearlySummary(year, buyCount, sellCount, records) {
  const parts = [];

  if (buyCount > 0 && sellCount > 0) {
    parts.push(`${buyCount}次买入${sellCount}次卖出`);
  } else if (buyCount > 0) {
    parts.push(`${buyCount}次买入`);
  } else if (sellCount > 0) {
    parts.push(`${sellCount}次卖出`);
  } else {
    parts.push('无调仓');
  }

  // 仓位变化
  const startWeight = records[0].cyb_weight;
  const endWeight = records[records.length - 1].cyb_weight;
  if (startWeight !== endWeight) {
    parts.push(`仓位${(startWeight * 100).toFixed(0)}%→${(endWeight * 100).toFixed(0)}%`);
  } else {
    parts.push(`仓位${(endWeight * 100).toFixed(0)}%`);
  }

  return parts.join(' ');
}

// ============================================================
// 更新 yearly_stats（增量更新当年）
// ============================================================
function updateYearlyStats(data, dailyRecords, tradeLog, initCapital) {
  const newStats = calcYearlyStats(dailyRecords, tradeLog, initCapital);

  for (const stat of newStats) {
    const idx = data.yearly_stats.findIndex(s => s.year === stat.year);
    if (idx >= 0) {
      data.yearly_stats[idx] = stat;
    } else {
      data.yearly_stats.push(stat);
    }
  }

  // 按年份排序
  data.yearly_stats.sort((a, b) => a.year - b.year);
}

// ============================================================
// 计算月度统计（用于月度回顾推送）
// ============================================================
function calcMonthlyStats(dailyRecords, year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const records = dailyRecords.filter(r => r.date.startsWith(prefix));

  if (records.length === 0) return null;

  const startWeight = records[0].cyb_weight;
  const endWeight = records[records.length - 1].cyb_weight;
  const startAsset = records[0].asset_value;
  const endAsset = records[records.length - 1].asset_value;

  // 当月收益率 = 月末资产 / 月初资产 - 1
  // 注意：月初资产应该是上月末资产，即 records[0] 的前一条
  // 但 records[0] 的 asset_value 是当日收盘后资产，已经包含当日收益
  // 所以月度收益 = endAsset / (records[0] 的前一日资产) - 1
  // 简化：用 records[0] 的 asset_value / (1 + records[0].daily_ret) 作为月初资产
  const monthStartAsset = startAsset / (1 + (records[0].daily_ret || 0));
  const monthRet = (endAsset / monthStartAsset) - 1;

  // 年内累计收益
  const yearRecords = dailyRecords.filter(r => r.date.startsWith(String(year)));
  const yearStartAsset = yearRecords.length > 0
    ? yearRecords[0].asset_value / (1 + (yearRecords[0].daily_ret || 0))
    : startAsset;
  const ytdRet = (endAsset / yearStartAsset) - 1;

  // 月末比值及分位
  const lastRatio = records[records.length - 1].ratio;
  const allRatios = dailyRecords.map(r => r.ratio);
  const percentile = calcPercentile(lastRatio, allRatios);

  return {
    year,
    month,
    startWeight,
    endWeight,
    monthRet,
    ytdRet,
    lastRatio,
    percentile,
    tradingDays: records.length
  };
}

// ============================================================
// 计算分位数
// ============================================================
function calcPercentile(value, sortedArray) {
  if (!sortedArray || sortedArray.length === 0) return 0;
  let count = 0;
  for (const v of sortedArray) {
    if (v <= value) count++;
  }
  return count / sortedArray.length;
}

// ============================================================
// 获取最近 N 个月的月度统计
// ============================================================
function getRecentMonthlyStats(dailyRecords, count) {
  count = count || 3;
  const results = [];
  if (dailyRecords.length === 0) return results;

  const lastDate = dailyRecords[dailyRecords.length - 1].date;
  let year = parseInt(lastDate.slice(0, 4));
  let month = parseInt(lastDate.slice(5, 7));

  for (let i = 0; i < count; i++) {
    const stat = calcMonthlyStats(dailyRecords, year, month);
    if (stat) results.unshift(stat);

    month--;
    if (month === 0) {
      month = 12;
      year--;
    }
  }

  return results;
}

// ============================================================
// 计算当前状态摘要（用于推送和展示）
// ============================================================
function getCurrentStatus(dailyRecords, allRatios) {
  if (!dailyRecords || dailyRecords.length === 0) return null;

  const latest = dailyRecords[dailyRecords.length - 1];
  const ratios = allRatios || dailyRecords.map(r => r.ratio);

  const percentile = calcPercentile(latest.ratio, ratios);

  // 距买入区/卖出区的距离
  let distanceToBuy = null;
  let distanceToSell = null;
  if (latest.ratio > config.buyZoneTop) {
    distanceToBuy = ((latest.ratio - config.buyZoneTop) / latest.ratio * 100);
  }
  if (latest.ratio < config.sellZoneBottom) {
    distanceToSell = ((config.sellZoneBottom - latest.ratio) / latest.ratio * 100);
  }

  return {
    date: latest.date,
    ratio: latest.ratio,
    cybClose: latest.cyb_close,
    hliClose: latest.hli_close,
    cybWeight: latest.cyb_weight,
    hliWeight: latest.hli_weight,
    action: latest.action,
    assetValue: latest.asset_value,
    percentile: percentile,
    distanceToBuy: distanceToBuy,
    distanceToSell: distanceToSell
  };
}

module.exports = {
  calcYearlyStats,
  updateYearlyStats,
  calcMonthlyStats,
  getRecentMonthlyStats,
  calcPercentile,
  getCurrentStatus,
  buildYearlySummary
};
