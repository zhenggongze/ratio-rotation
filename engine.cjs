// V2 收益引擎模块
// 规格2.6节：隔夜段+日内段分段、调仓成本开盘扣除、分红逐日计提、资产递推
// 时序：T日收盘生成信号 → T+1日开盘执行调仓 → T+1日收益用新旧权重分段
const fs = require('fs');
const path = require('path');
const { config } = require('./config.cjs');
const { determineSignal } = require('./strategy.cjs');

// ============================================================
// 分红率计算
// 红利：H00922日收益 - 000922日收益（如有）；否则 4.4%/252 兜底
// 创业板：0.9%/252 兜底（无官方全收益指数）
// ============================================================
const HLI_DAILY_DIV = config.hliDividendAnnual / config.tradingDaysPerYear; // 0.044/252
const CYB_DAILY_DIV = config.cybDividendAnnual / config.tradingDaysPerYear; // 0.009/252

// 加载精确的红利分红率数据（如果存在）
let _hliDividendMap = null;
function loadHliDividendRates() {
  if (_hliDividendMap !== null) return _hliDividendMap;
  const filePath = path.join(__dirname, 'data', 'hli_dividend_rates.json');
  if (!fs.existsSync(filePath)) {
    _hliDividendMap = {}; // 空map，全部用兜底值
    return _hliDividendMap;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(raw);
    _hliDividendMap = {};
    for (const item of json.data) {
      _hliDividendMap[item.date] = item.hli_dividend_rate;
    }
  } catch (e) {
    _hliDividendMap = {};
  }
  return _hliDividendMap;
}

// 获取某日的红利分红率（优先用精确数据，否则兜底）
function getHliDividendRate(date) {
  const map = loadHliDividendRates();
  if (date && map[date] !== undefined) {
    return map[date];
  }
  return HLI_DAILY_DIV;
}

// ============================================================
// 计算单日收益（V2引擎核心）
// 输入：
//   prevClose: 前一日收盘 { cyb, hli }
//   todayOpen: 当日开盘 { cyb, hli }
//   todayClose: 当日收盘 { cyb, hli }
//   prevWeight: 前一日权重（旧权重）
//   todayWeight: 当日权重（新权重，如果有调仓则与prevWeight不同）
//   hasTrade: 是否有调仓
//   dividends: 分红率 { cyb, hli }（可选，默认兜底）
// 输出：
//   { dailyRet, overnightRet, intradayRet, tradeCost, dividend, detail }
// ============================================================
function calcDailyReturn(prevClose, todayOpen, todayClose, prevWeight, todayWeight, hasTrade, dividends) {
  const wPrev = prevWeight || 0;
  const wToday = todayWeight || 0;
  const div = dividends || { cyb: CYB_DAILY_DIV, hli: HLI_DAILY_DIV };

  // 隔夜段收益：旧权重 × (创业板今开/创业板昨收-1) + (1-旧权重) × (红利今开/红利昨收-1)
  const cybOvernight = prevClose.cyb > 0 ? (todayOpen.cyb / prevClose.cyb - 1) : 0;
  const hliOvernight = prevClose.hli > 0 ? (todayOpen.hli / prevClose.hli - 1) : 0;
  const overnightRet = wPrev * cybOvernight + (1 - wPrev) * hliOvernight;

  // 调仓成本：|新权重-旧权重| × 0.05%（单边），在开盘扣除
  const tradeCost = hasTrade ? Math.abs(wToday - wPrev) * config.tradeCostRate : 0;

  // 日内段收益：新权重 × (创业板今收/创业板今开-1) + (1-新权重) × (红利今收/红利今开-1)
  const cybIntraday = todayOpen.cyb > 0 ? (todayClose.cyb / todayOpen.cyb - 1) : 0;
  const hliIntraday = todayOpen.hli > 0 ? (todayClose.hli / todayOpen.hli - 1) : 0;
  const intradayRet = wToday * cybIntraday + (1 - wToday) * hliIntraday;

  // 分红计提：新权重 × 创业板分红率 + (1-新权重) × 红利分红率
  const dividend = wToday * div.cyb + (1 - wToday) * div.hli;

  // 当日策略收益 = (1+隔夜段) × (1-调仓成本) × (1+日内段+分红计提) - 1
  const dailyRet = (1 + overnightRet) * (1 - tradeCost) * (1 + intradayRet + dividend) - 1;

  return {
    dailyRet,
    overnightRet,
    intradayRet,
    tradeCost,
    dividend,
    detail: {
      cybOvernight, hliOvernight, cybIntraday, hliIntraday,
      wPrev, wToday, divCyb: div.cyb, divHli: div.hli
    }
  };
}

// ============================================================
// 全周期回测（核心回放引擎）
// 输入：历史数据数组（按日期升序），每条含 date, cyb_open, cyb_close, hli_open, hli_close
// 输出：{ dailyRecords, tradeLog, finalAsset, totalRet, stats }
// ============================================================
function runBacktest(historyData, initCapital, cfg) {
  cfg = cfg || config;
  const capital = initCapital || config.initCapital;
  if (!historyData || historyData.length === 0) {
    return { dailyRecords: [], tradeLog: [], finalAsset: capital, totalRet: 0 };
  }

  const dailyRecords = [];
  const tradeLog = [];
  let asset = capital;
  let currentWeight = 0; // 当前生效权重
  let pendingSignal = null; // 待执行信号（T日生成，T+1日执行）

  // 计算历史比值序列（用于分位数计算）
  const allRatios = historyData.map(d => d.cyb_close / d.hli_close);

  for (let i = 0; i < historyData.length; i++) {
    const day = historyData[i];
    const ratio = day.cyb_close / day.hli_close;

    // 前一日收盘价
    const prevClose = i > 0 ? {
      cyb: historyData[i - 1].cyb_close,
      hli: historyData[i - 1].hli_close
    } : { cyb: day.cyb_open, hli: day.hli_open }; // 首日无前收盘，用开盘价

    // 当日开盘/收盘
    const todayOpen = { cyb: day.cyb_open, hli: day.hli_open };
    const todayClose = { cyb: day.cyb_close, hli: day.hli_close };

    // 判断是否为执行日（有pendingSignal）
    let todayWeight = currentWeight;
    let hasTrade = false;
    let executedSignal = null;

    if (pendingSignal) {
      todayWeight = pendingSignal.targetWeight;
      hasTrade = true;
      executedSignal = pendingSignal;
      pendingSignal = null;
    }

    // 计算当日收益（V2引擎）
    // 使用精确的红利分红率（如有），创业板用兜底值
    const dividends = {
      cyb: CYB_DAILY_DIV,
      hli: getHliDividendRate(day.date)
    };
    const ret = calcDailyReturn(prevClose, todayOpen, todayClose, currentWeight, todayWeight, hasTrade, dividends);

    // 递推资产
    const prevAsset = asset;
    asset = asset * (1 + ret.dailyRet);

    // 更新当前权重
    const prevWeight = currentWeight;
    currentWeight = todayWeight;

    // 生成当日信号（用收盘比值和当前权重）
    const signal = determineSignal(ratio, currentWeight, cfg);

    // 设置pendingSignal（如果BUY/SELL）
    let execDate = null;
    if (signal.action === 'BUY' || signal.action === 'SELL') {
      // 执行日 = 下一个交易日
      execDate = i + 1 < historyData.length ? historyData[i + 1].date : null;
      pendingSignal = {
        action: signal.action,
        tiers: signal.tiers,
        targetWeight: signal.targetWeight,
        amount: signal.amount,
        signalDate: day.date,
        execDate: execDate,
        ratioAtSignal: ratio,
        weightBefore: currentWeight,
        weightAfter: signal.targetWeight
      };

      // 写入trade_log
      tradeLog.push({
        signal_date: day.date,
        exec_date: execDate,
        direction: signal.action,
        tiers: signal.tiers,
        amount: signal.amount,
        ratio_at_signal: Math.round(ratio * 10000) / 10000,
        weight_before: currentWeight,
        weight_after: signal.targetWeight,
        confirmed: 0,
        actual_weight_after: null,
        created_at: new Date().toISOString()
      });
    }

    // 计算创业板/红利当日涨跌
    const cybRet = prevClose.cyb > 0 ? (day.cyb_close / prevClose.cyb - 1) : 0;
    const hliRet = prevClose.hli > 0 ? (day.hli_close / prevClose.hli - 1) : 0;

    // 写入daily_record
    dailyRecords.push({
      date: day.date,
      ratio: Math.round(ratio * 10000) / 10000,
      cyb_open: day.cyb_open,
      cyb_close: day.cyb_close,
      hli_open: day.hli_open,
      hli_close: day.hli_close,
      cyb_weight: currentWeight,
      hli_weight: 1 - currentWeight,
      action: signal.action,
      action_tiers: signal.tiers,
      action_amount: signal.amount,
      exec_date: execDate,
      daily_ret: ret.dailyRet,
      cyb_ret: cybRet,
      hli_ret: hliRet,
      asset_value: asset,
      signal_note: signal.note,
      data_ok: 1,
      created_at: new Date().toISOString()
    });
  }

  const finalAsset = asset;
  const totalRet = (asset / capital) - 1;

  // 计算年化收益
  const years = historyData.length / config.tradingDaysPerYear;
  const annualRet = Math.pow(asset / capital, 1 / years) - 1;

  // 计算最大回撤
  let peak = capital;
  let maxDrawdown = 0;
  for (const r of dailyRecords) {
    if (r.asset_value > peak) peak = r.asset_value;
    const dd = (r.asset_value - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  return {
    dailyRecords,
    tradeLog,
    finalAsset,
    totalRet,
    annualRet,
    maxDrawdown,
    tradeCount: tradeLog.length,
    buyCount: tradeLog.filter(t => t.direction === 'BUY').length,
    sellCount: tradeLog.filter(t => t.direction === 'SELL').length,
    tradingDays: historyData.length
  };
}

// ============================================================
// 收益自洽校验（规格2.6节，恒等式1/2/3）
// ============================================================
function verifyConsistency(dailyRecords, initCapital) {
  const results = [];

  for (let i = 0; i < dailyRecords.length; i++) {
    const r = dailyRecords[i];
    const prevAsset = i === 0 ? initCapital : dailyRecords[i - 1].asset_value;

    // 恒等式1：期末总资产 ≈ 上期末总资产 × (1 + 当日收益率)
    const expectedAsset = prevAsset * (1 + r.daily_ret);
    const diff1 = Math.abs(expectedAsset - r.asset_value);
    if (diff1 > config.assetCheckTolerance) {
      results.push({
        date: r.date,
        type: 'daily_asset',
        result: 1,
        detail: `恒等式1偏差 ${diff1.toFixed(4)}元 > ${config.assetCheckTolerance}元`
      });
    }

    // 恒等式2：当日盈利 = 期末总资产 - 上期末总资产
    const profit = r.asset_value - prevAsset;
    const expectedProfit = prevAsset * r.daily_ret;
    const diff2 = Math.abs(profit - expectedProfit);
    if (diff2 > config.assetCheckTolerance) {
      results.push({
        date: r.date,
        type: 'daily_asset',
        result: 1,
        detail: `恒等式2偏差 ${diff2.toFixed(4)}元`
      });
    }

    // 恒等式3：(1+隔夜段)(1+日内段)-1 ≈ 收盘/前收盘-1（仅无调仓日验证）
    if (i > 0 && r.cyb_weight === dailyRecords[i - 1].cyb_weight) {
      const prevClose = {
        cyb: dailyRecords[i - 1].cyb_close,
        hli: dailyRecords[i - 1].hli_close
      };
      const w = r.cyb_weight;
      const overnight = w * (r.cyb_open / prevClose.cyb - 1) + (1 - w) * (r.hli_open / prevClose.hli - 1);
      const intraday = w * (r.cyb_close / r.cyb_open - 1) + (1 - w) * (r.hli_close / r.hli_open - 1);
      const segmented = (1 + overnight) * (1 + intraday) - 1;
      const fullDay = w * (r.cyb_close / prevClose.cyb - 1) + (1 - w) * (r.hli_close / prevClose.hli - 1);
      const diff3 = Math.abs(segmented - fullDay);
      if (diff3 > config.identity3Tolerance) {
        results.push({
          date: r.date,
          type: 'identity3',
          result: 1,
          detail: `恒等式3偏差 ${diff3.toFixed(6)} > ${config.identity3Tolerance}`
        });
      }
    }
  }

  return {
    totalChecked: dailyRecords.length,
    alerts: results,
    alertCount: results.length,
    passed: results.length === 0
  };
}

// ============================================================
// 朴素重算（月度/季度全面校验，从头逐日循环不复用增量状态）
// ============================================================
function naiveReplay(historyData, initCapital) {
  // 朴素重算 = 重新跑一遍回测，对比结果
  const result = runBacktest(historyData, initCapital);
  return {
    finalAsset: result.finalAsset,
    totalRet: result.totalRet,
    dailyRecords: result.dailyRecords
  };
}

module.exports = {
  calcDailyReturn,
  runBacktest,
  verifyConsistency,
  naiveReplay,
  getHliDividendRate,
  loadHliDividendRates,
  HLI_DAILY_DIV,
  CYB_DAILY_DIV
};
