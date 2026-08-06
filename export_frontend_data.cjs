// 前端数据导出模块
// 从 ratio_rotation_data.json 和 kcb_rotation_data.json 提取前端展示所需数据
// 输出 data/frontend_data.json 供前端 fetch 加载
const fs = require('fs');
const path = require('path');
const { config, getStrategyConfig, getKcbStrategyConfig } = require('./config.cjs');
const { loadData } = require('./database.cjs');
const { getCurrentStatus, calcPercentile } = require('./stats.cjs');
const { getDistanceToNextAction } = require('./strategy.cjs');
const { loadBacktestJson } = require('./t0_engine.cjs');

// ============================================================
// 分位数计算（线性插值法）
// 输入：已排序数组，p（0~1）
// 输出：对应分位数的值
// ============================================================
function quantile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return 0;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = p * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

// ============================================================
// 通用维度计算（支持双策略：创业板/红利 + 科创50/红利）
// ============================================================
function buildFrontendDims(data, cfg) {
  cfg = cfg || config;
  const initCapital = cfg.initCapital || config.initCapital;
  const tradingDaysPerYear = cfg.tradingDaysPerYear || config.tradingDaysPerYear;

  if (!data.daily_records || data.daily_records.length === 0) {
    return null;
  }

  const records = data.daily_records;
  const yearlyStats = data.yearly_stats || [];
  const tradeLog = data.trade_log || [];
  const stratConf = data.strategy_config || (cfg === config ? getStrategyConfig() : getKcbStrategyConfig());

  // 当前状态
  const status = getCurrentStatus(records);
  const allRatios = records.map(r => r.ratio);
  const percentile = status ? calcPercentile(status.ratio, allRatios) : 0;
  const distance = status ? getDistanceToNextAction(status.ratio, status.cybWeight, cfg) : null;

  // 走势图数据（月度降采样）
  const monthlyData = downsampleMonthly(records);

  // 收益率对比走势数据
  const returnComparison = buildReturnComparison(records);

  // 历年收益
  const yearlyReturns = yearlyStats.map(s => ({
    year: s.year,
    annual_ret: +(s.annual_ret * 100).toFixed(2),
    max_drawdown: +(s.max_drawdown * 100).toFixed(2),
    avg_weight: +(s.avg_weight * 100).toFixed(0),
    buy_count: s.buy_count,
    sell_count: s.sell_count,
    cyb_ret: +(s.cyb_ret * 100).toFixed(1),
    hli_ret: +(s.hli_ret * 100).toFixed(1),
    summary: s.summary
  }));

  // 最近30条调仓
  const recentTrades = tradeLog.slice(-30).map(t => ({
    signal_date: t.signal_date,
    exec_date: t.exec_date,
    direction: t.direction,
    tiers: t.tiers,
    ratio: t.ratio_at_signal,
    weight_before: +(t.weight_before * 100).toFixed(0),
    weight_after: +(t.weight_after * 100).toFixed(0)
  }));

  // 最近60交易日
  const recentDaily = records.slice(-60).map(r => ({
    date: r.date,
    ratio: +r.ratio.toFixed(4),
    cyb_close: +r.cyb_close.toFixed(2),
    hli_close: +r.hli_close.toFixed(2),
    cyb_weight: +(r.cyb_weight * 100).toFixed(0),
    action: r.action,
    action_tiers: r.action_tiers,
    daily_ret: +(r.daily_ret * 100).toFixed(2)
  }));

  // 自使用以来统计
  const USE_START_DATE = '2026-08-01';
  const sinceUseRecords = records.filter(r => r.date >= USE_START_DATE);
  const sinceUseTrades = tradeLog.filter(t => t.exec_date >= USE_START_DATE);
  let sinceUseMetrics;
  if (sinceUseRecords.length > 0) {
    const beforeUse = records.filter(r => r.date < USE_START_DATE);
    const baseAsset = beforeUse.length > 0 ? beforeUse[beforeUse.length - 1].asset_value : initCapital;
    const lastAsset = sinceUseRecords[sinceUseRecords.length - 1].asset_value;
    const sinceUseRet = (lastAsset / baseAsset - 1);
    let sincePeak = baseAsset, sinceMaxDD = 0;
    for (const r of sinceUseRecords) {
      if (r.asset_value > sincePeak) sincePeak = r.asset_value;
      const dd = (r.asset_value - sincePeak) / sincePeak;
      if (dd < sinceMaxDD) sinceMaxDD = dd;
    }
    const sinceDays = sinceUseRecords.length;
    const sinceAvgWeight = sinceDays > 0 ? sinceUseRecords.reduce((s, r) => s + (r.cyb_weight || 0), 0) / sinceDays : 0;
    sinceUseMetrics = {
      trading_days: sinceDays,
      total_ret: +(sinceUseRet * 100).toFixed(2),
      avg_weight: +(sinceAvgWeight * 100).toFixed(0),
      max_drawdown: +(sinceMaxDD * 100).toFixed(2),
      trade_count: sinceUseTrades.length,
      buy_count: sinceUseTrades.filter(t => t.direction === 'BUY').length,
      sell_count: sinceUseTrades.filter(t => t.direction === 'SELL').length,
      start_date: USE_START_DATE,
      end_date: sinceUseRecords[sinceUseRecords.length - 1].date,
      has_data: true
    };
  } else {
    sinceUseMetrics = {
      trading_days: 0, total_ret: 0, avg_weight: 0, max_drawdown: 0,
      trade_count: 0, buy_count: 0, sell_count: 0,
      start_date: USE_START_DATE, end_date: USE_START_DATE, has_data: false
    };
  }

  // 全周期业绩
  const totalRet = (records[records.length - 1].asset_value / initCapital - 1);
  const years = records.length / tradingDaysPerYear;
  const annualRet = Math.pow(records[records.length - 1].asset_value / initCapital, 1 / years) - 1;
  let peak = initCapital, maxDrawdown = 0;
  for (const r of records) {
    if (r.asset_value > peak) peak = r.asset_value;
    const dd = (r.asset_value - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }
  const totalMetrics = {
    total_ret: +totalRet.toFixed(2),
    annual_ret: +(annualRet * 100).toFixed(2),
    max_drawdown: +(maxDrawdown * 100).toFixed(2),
    trading_days: records.length,
    trade_count: tradeLog.length,
    buy_count: tradeLog.filter(t => t.direction === 'BUY').length,
    sell_count: tradeLog.filter(t => t.direction === 'SELL').length,
    start_date: records[0].date,
    end_date: records[records.length - 1].date
  };

  // 三区占比
  const buyZoneCount = allRatios.filter(r => r <= cfg.buyZoneTop).length;
  const sellZoneCount = allRatios.filter(r => r >= cfg.sellZoneBottom).length;
  const holdZoneCount = allRatios.length - buyZoneCount - sellZoneCount;
  // 计算p5/p95分位数（用于进度条深度区定义，与策略档位解耦）
  const sortedRatios = [...allRatios].sort((a, b) => a - b);
  const p5Ratio = quantile(sortedRatios, 0.05);
  const p95Ratio = quantile(sortedRatios, 0.95);
  const zoneStats = {
    buy_zone_pct: +(buyZoneCount / allRatios.length * 100).toFixed(1),
    sell_zone_pct: +(sellZoneCount / allRatios.length * 100).toFixed(1),
    hold_zone_pct: +(holdZoneCount / allRatios.length * 100).toFixed(1),
    min_ratio: +Math.min(...allRatios).toFixed(4),
    max_ratio: +Math.max(...allRatios).toFixed(4),
    p5_ratio: +p5Ratio.toFixed(4),
    p95_ratio: +p95Ratio.toFixed(4)
  };

  return {
    strategy_config: {
      param_version: stratConf.param_version,
      effective_from: stratConf.effective_from,
      buy_zone_top: stratConf.buy_zone_top,
      sell_zone_bottom: stratConf.sell_zone_bottom,
      sell_zone_top: stratConf.sell_zone_top,
      buy_levels: stratConf.buy_levels,
      sell_levels: stratConf.sell_levels
    },
    since_use_metrics: sinceUseMetrics,
    total_metrics: totalMetrics,
    zone_stats: zoneStats,
    current_status: status ? {
      date: status.date,
      ratio: +status.ratio.toFixed(4),
      percentile: +(percentile * 100).toFixed(0),
      cyb_close: +status.cybClose.toFixed(2),
      hli_close: +status.hliClose.toFixed(2),
      cyb_weight: +(status.cybWeight * 100).toFixed(0),
      hli_weight: +(status.hliWeight * 100).toFixed(0),
      next_action: distance ? distance.desc : ''
    } : null,
    monthly_chart: monthlyData,
    return_comparison: returnComparison,
    yearly_returns: yearlyReturns,
    recent_trades: recentTrades.reverse(),
    recent_daily: recentDaily.reverse()
  };
}

// ============================================================
// 主导出函数
// ============================================================
function exportFrontendData() {
  // 创业板数据
  const cybData = loadData();
  if (!cybData.daily_records || cybData.daily_records.length === 0) {
    console.log('✗ 无创业板数据，请先运行 init-history');
    return { success: false, error: '无数据' };
  }
  const cybDims = buildFrontendDims(cybData, config);

  // 科创50数据
  const kcbData = loadData(config.kcb.dataFile, getKcbStrategyConfig());
  const kcbDims = (kcbData.daily_records && kcbData.daily_records.length > 0)
    ? buildFrontendDims(kcbData, config.kcb) : null;

  // 做T策略数据（515180 红利ETF 日内做T）
  // 回测结果（静态预计算）+ 当日信号（动态）
  const t0Backtest = loadBacktestJson();
  let t0Signal = null;
  const t0SignalFile = path.join(config.dataDir, 't0', 't0_signal.json');
  if (fs.existsSync(t0SignalFile)) {
    try {
      t0Signal = JSON.parse(fs.readFileSync(t0SignalFile, 'utf-8'));
    } catch (e) {
      console.log(`  ⚠ 读取做T信号失败: ${e.message}`);
    }
  }
  let t0Daily = null;
  const t0DailyFile = path.join(config.dataDir, 't0', 't0_daily.json');
  if (fs.existsSync(t0DailyFile)) {
    try {
      t0Daily = JSON.parse(fs.readFileSync(t0DailyFile, 'utf-8'));
    } catch (e) {
      console.log(`  ⚠ 读取做T每日记录失败: ${e.message}`);
    }
  }
  const t0Dims = {
    backtest: t0Backtest,       // { summary, yearly, param }
    signal: t0Signal,           // { date, generated_at, phase, signal }
    daily: t0Daily              // { updated_at, count, records: [...] }
  };

  // 组装输出
  const output = {
    generated_at: new Date().toISOString(),
    ...cybDims,
    kcb: kcbDims,
    t0: t0Dims
  };

  // 写入文件
  const outputPath = path.join(config.dataDir, 'frontend_data.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

  // 同步到 public/
  const publicPath = path.join(__dirname, 'public', 'frontend_data.json');
  fs.copyFileSync(outputPath, publicPath);

  console.log(`✓ 前端数据已导出: ${outputPath}`);
  console.log(`  同步到 public/: ${publicPath}`);
  console.log(`  文件大小: ${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB`);
  console.log(`  创业板: 年化${cybDims.total_metrics.annual_ret}%`);
  if (kcbDims) {
    console.log(`  科创50: 年化${kcbDims.total_metrics.annual_ret}%`);
  } else {
    console.log(`  科创50: 无数据（需运行 init-history-kcb）`);
  }
  if (t0Backtest) {
    console.log(`  做T: 净盈利${(t0Backtest.summary.net_profit / 10000).toFixed(1)}万, 超额${(t0Backtest.summary.excess_profit / 10000).toFixed(1)}万`);
  }
  if (t0Signal && t0Signal.signal) {
    const s = t0Signal.signal;
    console.log(`  做T信号(${t0Signal.date}): ${s.skip ? '跳过' : `买${s.buy_p} 卖${s.sell_p} ${s.shares}股`}`);
  }

  return { success: true, outputPath, output };
}

// ============================================================
// 构建收益率对比走势数据（月度降采样）
// ============================================================
function buildReturnComparison(records) {
  if (!records || records.length === 0) return [];
  const baseAsset = records[0].asset_value || config.initCapital;
  const baseCyb = records[0].cyb_close;
  const baseHli = records[0].hli_close;
  const monthly = {};
  for (const r of records) {
    const monthKey = r.date.slice(0, 7);
    monthly[monthKey] = { date: monthKey, asset: r.asset_value, cyb: r.cyb_close, hli: r.hli_close };
  }
  const monthKeys = Object.keys(monthly).sort();
  const result = [];
  for (const key of monthKeys) {
    const m = monthly[key];
    result.push({
      date: m.date,
      strategy: +(m.asset / baseAsset).toFixed(4),
      cyb: baseCyb > 0 ? +(m.cyb / baseCyb).toFixed(4) : 1,
      hli: baseHli > 0 ? +(m.hli / baseHli).toFixed(4) : 1
    });
  }
  return result;
}

// ============================================================
// 月度降采样
// ============================================================
function downsampleMonthly(records) {
  const monthly = {};
  for (const r of records) {
    const monthKey = r.date.slice(0, 7);
    if (!monthly[monthKey]) {
      monthly[monthKey] = { date: monthKey, lastRatio: r.ratio, lastCyb: r.cyb_close, lastHli: r.hli_close, lastWeight: r.cyb_weight, count: 1 };
    } else {
      monthly[monthKey].lastRatio = r.ratio;
      monthly[monthKey].lastCyb = r.cyb_close;
      monthly[monthKey].lastHli = r.hli_close;
      monthly[monthKey].lastWeight = r.cyb_weight;
      monthly[monthKey].count++;
    }
  }
  const monthKeys = Object.keys(monthly).sort();
  const result = [];
  for (const key of monthKeys) {
    const m = monthly[key];
    result.push({
      date: m.date,
      cyb_close: +m.lastCyb.toFixed(2),
      hli_close: +m.lastHli.toFixed(2),
      cyb_weight: +(m.lastWeight * 100).toFixed(0),
      ratio: +m.lastRatio.toFixed(4)
    });
  }
  return result;
}

// ============================================================
// 命令行入口
// ============================================================
if (require.main === module) {
  exportFrontendData();
}

module.exports = { exportFrontendData, downsampleMonthly, buildFrontendDims };
