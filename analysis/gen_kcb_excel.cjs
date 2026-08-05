// 科创50/中证红利 前端数据维度 Excel 生成
// 与创业板/中证红利对比
// 输出: 科创50_红利_对比分析.xlsx
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { loadHistory, alignIndices } = require('./data_loader.cjs');
const { backtest, DEFAULT_BUY_LEVELS, DEFAULT_SELL_LEVELS } = require('./backtest.cjs');

const START = '2014-07-01';
const END = '2026-12-31';
const INIT_CAPITAL = 1600000; // 160万（与生产一致）

const KCB_BUY = [0.1460,0.1455,0.1450,0.1445,0.1440,0.1435,0.1430,0.1424,0.1419,0.1414,0.1409,0.1404,0.1399,0.1394,0.1389,0.1384,0.1379,0.1374,0.1369,0.1364];
const KCB_SELL = [0.3060,0.3097,0.3133,0.3170,0.3207,0.3244,0.3280,0.3317,0.3354,0.3390,0.3427,0.3464,0.3501,0.3537,0.3574,0.3611,0.3648,0.3684,0.3721,0.3758];

function pct(n, d) { return ((n * 100).toFixed(d === undefined ? 2 : d)) + '%'; }

// ============================================================
// 生成科创50策略的 daily_records（模拟生产数据结构）
// ============================================================
function buildDailyRecords(alignedData, opts) {
  const records = [];
  let weight = 0;
  let asset = INIT_CAPITAL;
  let lastAction = '';
  let lastActionTiers = 0;

  for (let i = 0; i < alignedData.length; i++) {
    const today = alignedData[i];
    const ratio = today.ratio;

    // 当日收益（旧仓位）
    if (i > 0) {
      const prev = alignedData[i - 1];
      const retKcb = today.close1 / prev.close1 - 1;
      const retHli = today.close2 / prev.close2 - 1;
      const dailyRet = weight * retKcb + (1 - weight) * retHli;
      asset *= (1 + dailyRet);
    }

    // 信号判定 + T+1 执行
    let action = 'HOLD';
    let actionTiers = 0;
    if (i + 1 < alignedData.length) {
      const nextDay = alignedData[i + 1];
      const signal = determineSignalKcb(ratio, weight, opts);
      if (signal.action === 'BUY') {
        action = 'BUY';
        actionTiers = signal.nTiers;
        // T+1 开盘执行
        const execPrice1 = nextDay.open1 || nextDay.close1;
        const deltaWeight = Math.abs(signal.targetWeight - weight);
        const cost = asset * deltaWeight * 0.0005 * 2;
        asset -= cost;
        weight = signal.targetWeight;
        lastAction = 'BUY';
        lastActionTiers = signal.nTiers;
      } else if (signal.action === 'SELL') {
        action = 'SELL';
        actionTiers = signal.nTiers;
        const execPrice1 = nextDay.open1 || nextDay.close1;
        const deltaWeight = Math.abs(signal.targetWeight - weight);
        const cost = asset * deltaWeight * 0.0005 * 2;
        asset -= cost;
        weight = signal.targetWeight;
        lastAction = 'SELL';
        lastActionTiers = signal.nTiers;
      }
    }

    records.push({
      date: today.date,
      ratio: Math.round(ratio * 10000) / 10000,
      kcb_close: Math.round(today.close1 * 100) / 100,
      hli_close: Math.round(today.close2 * 100) / 100,
      cyb_weight: weight,
      hli_weight: 1 - weight,
      asset_value: Math.round(asset * 100) / 100,
      action: action,
      action_tiers: actionTiers
    });
  }

  // 计算 daily_ret
  for (let i = records.length - 1; i >= 1; i--) {
    records[i].daily_ret = records[i].asset_value / records[i - 1].asset_value - 1;
  }
  records[0].daily_ret = 0;

  return records;
}

// 科创50信号判定（复用 backtest.cjs 逻辑）
function determineSignalKcb(ratio, weight, opts) {
  const buyLevels = opts.buyLevels;
  const sellLevels = opts.sellLevels;
  const buyZoneTop = opts.buyZoneTop;
  const sellZoneBottom = opts.sellZoneBottom;
  const tierWeight = 0.05;
  const tol = 1e-9;

  if (ratio <= buyZoneTop) {
    if (weight >= 1.0 - tol) return { action: 'FULL_HOLD', targetWeight: 1.0, nTiers: 0 };
    let nBuyTotal = 0;
    for (const th of buyLevels) { if (ratio <= th) nBuyTotal++; else break; }
    const target = Math.min(1.0, nBuyTotal * tierWeight);
    if (target > weight + tol) {
      const nBuy = Math.round((target - weight) / tierWeight);
      return { action: 'BUY', targetWeight: target, nTiers: nBuy };
    }
    return { action: 'HOLD', targetWeight: weight, nTiers: 0 };
  }

  if (ratio >= sellZoneBottom) {
    if (weight <= tol) return { action: 'EMPTY', targetWeight: 0, nTiers: 0 };
    let nSellTotal = 0;
    for (const th of sellLevels) { if (ratio >= th) nSellTotal++; else break; }
    const target = Math.max(0, 1 - nSellTotal * tierWeight);
    if (target < weight - tol) {
      const nSell = Math.round((weight - target) / tierWeight);
      return { action: 'SELL', targetWeight: target, nTiers: nSell };
    }
    return { action: 'HOLD', targetWeight: weight, nTiers: 0 };
  }

  return { action: 'HOLD', targetWeight: weight, nTiers: 0 };
}

// ============================================================
// 计算前端数据维度
// ============================================================
function computeFrontendDims(records, tradeLog, kcbBuy, kcbSell) {
  const allRatios = records.map(r => r.ratio);

  // 当前状态
  const status = records[records.length - 1];
  const percentile = allRatios.filter(r => r <= status.ratio).length / allRatios.length;

  // 全周期业绩
  const totalRet = status.asset_value / INIT_CAPITAL - 1;
  const years = records.length / 244;
  const annualRet = Math.pow(status.asset_value / INIT_CAPITAL, 1 / years) - 1;
  let peak = INIT_CAPITAL, maxDD = 0;
  for (const r of records) {
    if (r.asset_value > peak) peak = r.asset_value;
    const dd = (r.asset_value - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // 年度统计
  const yearly = {};
  for (const r of records) {
    const y = r.date.slice(0, 4);
    if (!yearly[y]) yearly[y] = [];
    yearly[y].push(r);
  }
  const yearlyStats = [];
  for (const y of Object.keys(yearly).sort()) {
    const recs = yearly[y];
    const startAsset = recs[0].asset_value;
    const prevRecs = records.filter(r => r.date < recs[0].date);
    const baseAsset = prevRecs.length > 0 ? prevRecs[prevRecs.length - 1].asset_value : INIT_CAPITAL;
    const annualRetY = startAsset / baseAsset - 1;
    // 该年最大回撤
    let yPeak = startAsset, yMaxDD = 0;
    for (const r of recs) {
      if (r.asset_value > yPeak) yPeak = r.asset_value;
      const dd = (r.asset_value - yPeak) / yPeak;
      if (dd < yMaxDD) yMaxDD = dd;
    }
    // 平均仓位
    const avgWeight = recs.reduce((s, r) => s + r.cyb_weight, 0) / recs.length;
    // 该年买卖次数
    const yTrades = tradeLog.filter(t => t.exec_date.startsWith(y));
    const buyCount = yTrades.filter(t => t.direction === 'BUY').length;
    const sellCount = yTrades.filter(t => t.direction === 'SELL').length;
    // 指数收益
    const yearFirst = recs[0], yearLast = recs[recs.length - 1];
    const kcbRet = yearFirst.kcb_close > 0 ? yearLast.kcb_close / yearFirst.kcb_close - 1 : 0;
    const hliRet = yearFirst.hli_close > 0 ? yearLast.hli_close / yearFirst.hli_close - 1 : 0;

    yearlyStats.push({
      year: y,
      annual_ret: annualRetY,
      max_drawdown: yMaxDD,
      avg_weight: avgWeight,
      buy_count: buyCount,
      sell_count: sellCount,
      kcb_ret: kcbRet,
      hli_ret: hliRet,
      summary: buildYearSummary(recs, tradeLog, y)
    });
  }

  // 三区占比
  const buyZoneCount = allRatios.filter(r => r <= kcbBuy[0]).length;
  const sellZoneCount = allRatios.filter(r => r >= kcbSell[0]).length;
  const holdZoneCount = allRatios.length - buyZoneCount - sellZoneCount;

  // 月度走势图
  const monthly = {};
  for (const r of records) {
    const mk = r.date.slice(0, 7);
    monthly[mk] = {
      date: mk, ratio: r.ratio, kcb_close: r.kcb_close, hli_close: r.hli_close, weight: r.cyb_weight
    };
  }

  // 收益率对比
  const baseAsset = records[0].asset_value;
  const baseKcb = records[0].kcb_close;
  const baseHli = records[0].hli_close;
  const returnComparison = Object.keys(monthly).sort().map(mk => {
    const m = monthly[mk];
    return {
      date: mk,
      strategy: m.date ? null : null,
      kcb: baseKcb > 0 ? m.kcb_close / baseKcb : 1,
      hli: baseHli > 0 ? m.hli_close / baseHli : 1
    };
  });
  // 重新计算 strategy 净值（月度）
  const monthlyAsset = {};
  for (const r of records) {
    const mk = r.date.slice(0, 7);
    monthlyAsset[mk] = r.asset_value;
  }
  returnComparison.forEach(c => {
    c.strategy = monthlyAsset[c.date] / baseAsset;
  });

  return {
    current_status: {
      date: status.date,
      ratio: status.ratio,
      percentile: Math.round(percentile * 100),
      kcb_close: status.kcb_close,
      hli_close: status.hli_close,
      kcb_weight: Math.round(status.cyb_weight * 100),
      hli_weight: Math.round(status.hli_weight * 100),
      next_action: status.action
    },
    total_metrics: {
      total_ret: totalRet,
      annual_ret: annualRet,
      max_drawdown: maxDD,
      trading_days: records.length,
      trade_count: tradeLog.length,
      buy_count: tradeLog.filter(t => t.direction === 'BUY').length,
      sell_count: tradeLog.filter(t => t.direction === 'SELL').length,
      start_date: records[0].date,
      end_date: status.date
    },
    yearly_stats: yearlyStats,
    zone_stats: {
      buy_zone_pct: buyZoneCount / allRatios.length,
      sell_zone_pct: sellZoneCount / allRatios.length,
      hold_zone_pct: holdZoneCount / allRatios.length,
      min_ratio: Math.min(...allRatios),
      max_ratio: Math.max(...allRatios)
    },
    monthly_chart: Object.keys(monthly).sort().map(mk => monthly[mk]),
    return_comparison: returnComparison,
    recent_trades: tradeLog.slice(-30).reverse(),
    recent_daily: records.slice(-60).reverse()
  };
}

function buildYearSummary(recs, tradeLog, year) {
  const yTrades = tradeLog.filter(t => t.exec_date.startsWith(year));
  if (yTrades.length === 0) return '无调仓';
  const actions = yTrades.map(t => t.direction === 'BUY' ? `买${t.tiers}档` : `卖${t.tiers}档`);
  return actions.slice(0, 5).join(',') + (actions.length > 5 ? '...' : '');
}

// ============================================================
// Excel 生成
// ============================================================
function styleHeader(ws, row, colCount) {
  const rowH = ws.getRow(row);
  for (let c = 1; c <= colCount; c++) {
    const cell = rowH.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B579A' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF444444' } } };
  }
}

function setColWidths(ws, widths) {
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

async function main() {
  const [cybData, hliData, kcbData] = await Promise.all([
    loadHistory('sz399006', START, END, '创业板'),
    loadHistory('sh000922', START, END, '中证红利'),
    loadHistory('sh000688', START, END, '科创50')
  ]);

  const kcbStartIdx = kcbData.findIndex(d => d.date >= '2020-08-01');
  const kcbHli = alignIndices(kcbData.slice(kcbStartIdx), hliData, '科创50', '红利');
  const cybHli = alignIndices(cybData, hliData, '创业板', '红利');

  // ============ 科创50策略回测 ============
  const kcbOpts = { buyLevels: KCB_BUY, sellLevels: KCB_SELL, buyZoneTop: 0.146, sellZoneBottom: 0.306 };
  const kcbRecords = buildDailyRecords(kcbHli, kcbOpts);

  // 科创50调仓记录（从 backtest 拿 tradeLog）
  const kcbBacktest = backtest(kcbHli, { ...kcbOpts, execDelay: 1, tradeCostRate: 0.0005 });
  const kcbTradeLog = kcbBacktest.tradeLog.map(t => ({
    signal_date: t.signalDate,
    exec_date: t.execDate,
    direction: t.action,
    tiers: Math.round(Math.abs(t.newWeight - t.oldWeight) / 0.05),
    ratio_at_signal: kcbHli.find(d => d.date === t.signalDate)?.ratio || 0,
    weight_before: t.oldWeight,
    weight_after: t.newWeight
  }));

  // ============ 创业板策略同期回测 ============
  const sameStart = cybHli.findIndex(d => d.date >= '2020-08-01');
  const cybRecords = buildDailyRecords(cybHli.slice(sameStart), {
    buyLevels: DEFAULT_BUY_LEVELS, sellLevels: DEFAULT_SELL_LEVELS, buyZoneTop: 0.332, sellZoneBottom: 0.578
  });
  const cybBacktest = backtest(cybHli, { startIdx: sameStart, execDelay: 1, tradeCostRate: 0.0005,
    buyLevels: DEFAULT_BUY_LEVELS, sellLevels: DEFAULT_SELL_LEVELS, buyZoneTop: 0.332, sellZoneBottom: 0.578 });
  const cybTradeLog = cybBacktest.tradeLog.map(t => ({
    signal_date: t.signalDate,
    exec_date: t.execDate,
    direction: t.action,
    tiers: Math.round(Math.abs(t.newWeight - t.oldWeight) / 0.05),
    ratio_at_signal: cybHli.find(d => d.date === t.signalDate)?.ratio || 0,
    weight_before: t.oldWeight,
    weight_after: t.newWeight
  }));

  // ============ 计算维度 ============
  const kcbDims = computeFrontendDims(kcbRecords, kcbTradeLog, KCB_BUY, KCB_SELL);
  const cybDims = computeFrontendDims(cybRecords, cybTradeLog, DEFAULT_BUY_LEVELS, DEFAULT_SELL_LEVELS);

  // ============ 生成 Excel ============
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  wb.creator = '比值轮动分析';

  // ---------- Sheet1: 总览对比 ----------
  const ws1 = wb.addWorksheet('总览对比');
  setColWidths(ws1, [24, 18, 18, 18, 40]);
  ws1.getCell('A1').value = '科创50/中证红利 vs 创业板/中证红利 — 策略对比';
  ws1.getCell('A1').font = { bold: true, size: 14 };
  ws1.mergeCells('A1:E1');

  const overview = [
    ['指标', '科创50策略', '创业板策略', '差异', '说明'],
    ['对比周期', kcbDims.total_metrics.start_date + ' ~ ' + kcbDims.total_metrics.end_date,
     cybDims.total_metrics.start_date + ' ~ ' + cybDims.total_metrics.end_date, '', '同期对比'],
    ['累计收益', pct(kcbDims.total_metrics.total_ret), pct(cybDims.total_metrics.total_ret),
     pct(kcbDims.total_metrics.total_ret - cybDims.total_metrics.total_ret), ''],
    ['年化收益', pct(kcbDims.total_metrics.annual_ret), pct(cybDims.total_metrics.annual_ret),
     pct(kcbDims.total_metrics.annual_ret - cybDims.total_metrics.annual_ret), ''],
    ['最大回撤', pct(kcbDims.total_metrics.max_drawdown), pct(cybDims.total_metrics.max_drawdown),
     pct(kcbDims.total_metrics.max_drawdown - cybDims.total_metrics.max_drawdown), ''],
    ['交易天数', kcbDims.total_metrics.trading_days, cybDims.total_metrics.trading_days, '', ''],
    ['调仓次数', kcbDims.total_metrics.trade_count, cybDims.total_metrics.trade_count, '', ''],
    ['买入次数', kcbDims.total_metrics.buy_count, cybDims.total_metrics.buy_count, '', ''],
    ['卖出次数', kcbDims.total_metrics.sell_count, cybDims.total_metrics.sell_count, '', ''],
    ['买入区顶端', KCB_BUY[0], 0.332, '', ''],
    ['卖出区底端', KCB_SELL[0], 0.578, '', ''],
    ['当前比值', kcbDims.current_status.ratio, cybDims.current_status.ratio, '', ''],
    ['当前分位', kcbDims.current_status.percentile + '%', cybDims.current_status.percentile + '%', '', ''],
    ['当前仓位', '科创' + kcbDims.current_status.kcb_weight + '%/红利' + kcbDims.current_status.hli_weight + '%',
     '创业' + cybDims.current_status.kcb_weight + '%/红利' + cybDims.current_status.hli_weight + '%', '', ''],
    ['进攻指数同期', pct(kcbBacktest.idx1Return), pct(cybBacktest.idx1Return), '', '科创50 vs 创业板'],
    ['防守指数同期', pct(kcbBacktest.idx2Return), pct(cybBacktest.idx2Return), '', '均为中证红利'],
    ['超额vs进攻指数', pct(kcbBacktest.excessVsIdx1), pct(cybBacktest.excessVsIdx1), '', ''],
    ['超额vs红利', pct(kcbBacktest.excessVsIdx2), pct(cybBacktest.excessVsIdx2), '', '']
  ];
  overview.forEach((row, i) => {
    ws1.addRow(row);
    if (i === 0) styleHeader(ws1, 2, 5);
  });

  // ---------- Sheet2: 当前状态 ----------
  const ws2 = wb.addWorksheet('当前状态');
  setColWidths(ws2, [20, 18, 18, 18, 40]);
  ws2.getCell('A1').value = '当前状态';
  ws2.getCell('A1').font = { bold: true, size: 14 };
  ws2.mergeCells('A1:E1');

  const statusRows = [
    ['维度', '科创50策略', '创业板策略', '对比', '说明'],
    ['数据日期', kcbDims.current_status.date, cybDims.current_status.date, '', ''],
    ['比值', kcbDims.current_status.ratio, cybDims.current_status.ratio, '', '科创50/红利 vs 创业板/红利'],
    ['历史分位', kcbDims.current_status.percentile + '%', cybDims.current_status.percentile + '%', '', '该比值在全部历史中的分位'],
    ['进攻指数收盘', kcbDims.current_status.kcb_close, cybDims.current_status.kcb_close, '', '科创50 vs 创业板'],
    ['红利收盘', kcbDims.current_status.hli_close, cybDims.current_status.hli_close, '', '均为中证红利'],
    ['进攻仓位', kcbDims.current_status.kcb_weight + '%', cybDims.current_status.kcb_weight + '%', '', ''],
    ['红利仓位', kcbDims.current_status.hli_weight + '%', cybDims.current_status.hli_weight + '%', '', ''],
    ['当日动作', kcbDims.current_status.next_action, cybDims.current_status.next_action, '', '']
  ];
  statusRows.forEach((row, i) => {
    ws2.addRow(row);
    if (i === 0) styleHeader(ws2, 2, 5);
  });

  // ---------- Sheet3: 年度对比 ----------
  const ws3 = wb.addWorksheet('年度收益对比');
  setColWidths(ws3, [10, 14, 14, 14, 14, 14, 14, 14, 14, 30]);
  ws3.getCell('A1').value = '历年收益对比（科创50策略 vs 创业板策略）';
  ws3.getCell('A1').font = { bold: true, size: 14 };
  ws3.mergeCells('A1:J1');

  const yearRows = [
    ['年份', '科创策略收益', '科创策略回撤', '科创均仓', '科创买入', '科创卖出',
     '创业板策略收益', '创业板回撤', '创业板均仓', '主要动作'],
    ...kcbDims.yearly_stats.map((k, i) => {
      const c = cybDims.yearly_stats[i];
      return [
        k.year,
        pct(k.annual_ret), pct(k.max_drawdown), (k.avg_weight * 100).toFixed(0) + '%', k.buy_count, k.sell_count,
        c ? pct(c.annual_ret) : '', c ? pct(c.max_drawdown) : '', c ? (c.avg_weight * 100).toFixed(0) + '%' : '',
        k.summary
      ];
    })
  ];
  yearRows.forEach((row, i) => {
    ws3.addRow(row);
    if (i === 0) styleHeader(ws3, 2, 10);
  });

  // ---------- Sheet4: 档位表 ----------
  const ws4 = wb.addWorksheet('档位表(科创50)');
  setColWidths(ws4, [12, 12, 30, 12, 12, 30]);
  ws4.getCell('A1').value = '科创50/中证红利 档位表';
  ws4.getCell('A1').font = { bold: true, size: 14 };
  ws4.mergeCells('A1:F1');
  ws4.getRow(2).values = ['档位', '买入阈值(比值≤)', '对应价格说明', '档位', '卖出阈值(比值≥)', '对应价格说明'];
  styleHeader(ws4, 2, 6);

  for (let i = 0; i < 20; i++) {
    const buyDesc = `科创50收盘 ≤ 红利收盘 × ${KCB_BUY[i].toFixed(4)} 时买入${i + 1}档`;
    const sellDesc = `科创50收盘 ≥ 红利收盘 × ${KCB_SELL[i].toFixed(4)} 时卖出${i + 1}档`;
    ws4.addRow([i + 1, KCB_BUY[i].toFixed(4), buyDesc, i + 1, KCB_SELL[i].toFixed(4), sellDesc]);
  }

  // ---------- Sheet5: 月度走势 ----------
  const ws5 = wb.addWorksheet('月度走势');
  setColWidths(ws5, [12, 12, 14, 14, 10, 14, 14, 10]);
  ws5.getCell('A1').value = '科创50/中证红利 月度走势（近24个月）';
  ws5.getCell('A1').font = { bold: true, size: 14 };
  ws5.mergeCells('A1:H1');
  ws5.getRow(2).values = ['月份', '比值', '科创50收盘', '红利收盘', '科创仓位', '月份', '比值', '红利收盘'];
  styleHeader(ws5, 2, 8);

  const last24 = kcbDims.monthly_chart.slice(-24);
  // 双列并排：左=科创50策略，右=创业板策略（同月份对齐）
  const cybMonthly = cybDims.monthly_chart;
  const cybMap = {};
  cybMonthly.forEach(m => cybMap[m.date] = m);

  last24.forEach((m, i) => {
    const cm = cybMap[m.date];
    if (cm) {
      ws5.addRow([m.date, m.ratio.toFixed(4), m.kcb_close, m.hli_close, (m.weight * 100).toFixed(0) + '%',
        cm.date, cm.ratio.toFixed(4), cm.hli_close]);
    } else {
      ws5.addRow([m.date, m.ratio.toFixed(4), m.kcb_close, m.hli_close, (m.weight * 100).toFixed(0) + '%',
        '', '', '']);
    }
  });

  // ---------- Sheet6: 收益率对比走势 ----------
  const ws6 = wb.addWorksheet('收益率对比');
  setColWidths(ws6, [12, 12, 12, 12, 14]);
  ws6.getCell('A1').value = '收益率走势对比（起点=1.0，月度）';
  ws6.getCell('A1').font = { bold: true, size: 14 };
  ws6.mergeCells('A1:E1');
  ws6.getRow(2).values = ['月份', '科创50策略', '科创50指数', '中证红利', '收益率%'];
  styleHeader(ws6, 2, 5);

  kcbDims.return_comparison.forEach(c => {
    ws6.addRow([c.date, +c.strategy.toFixed(4), +c.kcb.toFixed(4), +c.hli.toFixed(4),
      pct(c.strategy - 1)]);
  });

  // ---------- Sheet7: 最近调仓 ----------
  const ws7 = wb.addWorksheet('最近调仓记录');
  setColWidths(ws7, [14, 14, 10, 10, 12, 12, 12, 40]);
  ws7.getCell('A1').value = '最近调仓记录（科创50策略）';
  ws7.getCell('A1').font = { bold: true, size: 14 };
  ws7.mergeCells('A1:H1');
  ws7.getRow(2).values = ['信号日期', '执行日期', '方向', '档数', '比值', '调仓前', '调仓后', '说明'];
  styleHeader(ws7, 2, 8);

  kcbDims.recent_trades.forEach(t => {
    ws7.addRow([
      t.signal_date, t.exec_date, t.direction === 'BUY' ? '买入' : '卖出', t.tiers,
      +t.ratio_at_signal.toFixed(4),
      (t.weight_before * 100).toFixed(0) + '%', (t.weight_after * 100).toFixed(0) + '%',
      `${t.signal_date}比值${+t.ratio_at_signal.toFixed(4)}触发，${t.exec_date}执行`
    ]);
  });

  // ---------- Sheet8: 最近60交易日 ----------
  const ws8 = wb.addWorksheet('最近60交易日');
  setColWidths(ws8, [12, 12, 12, 12, 10, 10, 10]);
  ws8.getCell('A1').value = '最近60个交易日（科创50策略）';
  ws8.getCell('A1').font = { bold: true, size: 14 };
  ws8.mergeCells('A1:G1');
  ws8.getRow(2).values = ['日期', '比值', '科创50收盘', '红利收盘', '科创仓位', '动作', '当日收益'];
  styleHeader(ws8, 2, 7);

  kcbDims.recent_daily.forEach(r => {
    ws8.addRow([
      r.date, r.ratio.toFixed(4), r.kcb_close.toFixed(2), r.hli_close.toFixed(2),
      (r.cyb_weight * 100).toFixed(0) + '%',
      r.action === 'HOLD' ? '持有' : r.action === 'BUY' ? `买入${r.action_tiers}档` : `卖出${r.action_tiers}档`,
      pct(r.daily_ret || 0)
    ]);
  });

  // ---------- Sheet9: 区间统计 ----------
  const ws9 = wb.addWorksheet('区间统计');
  setColWidths(ws9, [20, 18, 18, 40]);
  ws9.getCell('A1').value = '三区占比统计';
  ws9.getCell('A1').font = { bold: true, size: 14 };
  ws9.mergeCells('A1:D1');

  const zoneRows = [
    ['指标', '科创50策略', '创业板策略', '说明'],
    ['买入区占比', pct(kcbDims.zone_stats.buy_zone_pct, 1), pct(cybDims.zone_stats.buy_zone_pct, 1), '比值≤买入区顶端'],
    ['滞回带占比', pct(kcbDims.zone_stats.hold_zone_pct, 1), pct(cybDims.zone_stats.hold_zone_pct, 1), '买入区~卖出区之间'],
    ['卖出区占比', pct(kcbDims.zone_stats.sell_zone_pct, 1), pct(cybDims.zone_stats.sell_zone_pct, 1), '比值≥卖出区底端'],
    ['最小比值', kcbDims.zone_stats.min_ratio, cybDims.zone_stats.min_ratio, ''],
    ['最大比值', kcbDims.zone_stats.max_ratio, cybDims.zone_stats.max_ratio, '']
  ];
  zoneRows.forEach((row, i) => {
    ws9.addRow(row);
    if (i === 0) styleHeader(ws9, 2, 4);
  });

  // 保存
  const outPath = path.join(__dirname, 'kcb_vs_cyb_analysis.xlsx');
  await wb.xlsx.writeFile(outPath);
  console.log('✓ Excel 已生成: ' + outPath);

  // 同进程自验证（防止外部程序篡改导致交付损坏文件）
  const wbCheck = new ExcelJS.Workbook();
  await wbCheck.xlsx.readFile(outPath);
  console.log('✓ 同进程自验证通过: ' + wbCheck.worksheets.length + ' 个 Sheet, ' +
    wbCheck.worksheets.map(w => w.name).join(', '));

  // 打印总览对比关键数据
  console.log('\n=== 总览对比 ===');
  const wsOverview = wbCheck.getWorksheet('总览对比');
  for (let r = 2; r <= wsOverview.rowCount; r++) {
    const row = wsOverview.getRow(r);
    const vals = [];
    for (let c = 1; c <= 5; c++) {
      const v = row.getCell(c).value;
      if (v !== null && v !== undefined) vals.push(String(v.value ?? v));
    }
    console.log('  ' + vals.join(' | '));
  }
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
