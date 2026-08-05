// 独立回测引擎（与生产策略逻辑等价，但参数可注入）
// 用于分析对比，不部署到生产
const fs = require('fs');
const path = require('path');

// ============================================================
// 默认参数（与生产 config.cjs 完全一致）
// ============================================================
const DEFAULT_BUY_LEVELS = [
  0.3320, 0.3308, 0.3297, 0.3285, 0.3274,
  0.3262, 0.3251, 0.3239, 0.3227, 0.3216,
  0.3204, 0.3193, 0.3181, 0.3169, 0.3158,
  0.3146, 0.3135, 0.3123, 0.3112, 0.3100
];
const DEFAULT_SELL_LEVELS = [
  0.5780, 0.5849, 0.5919, 0.5988, 0.6058,
  0.6127, 0.6197, 0.6266, 0.6336, 0.6405,
  0.6475, 0.6544, 0.6614, 0.6683, 0.6753,
  0.6822, 0.6892, 0.6961, 0.7031, 0.7100
];

// ============================================================
// 信号判定（与生产 strategy.cjs 等价）
// 返回: { action, targetWeight, nTiers }
// ============================================================
function determineSignal(ratio, currentWeight, opts) {
  opts = opts || {};
  const buyLevels = opts.buyLevels || DEFAULT_BUY_LEVELS;
  const sellLevels = opts.sellLevels || DEFAULT_SELL_LEVELS;
  const buyZoneTop = opts.buyZoneTop !== undefined ? opts.buyZoneTop : buyLevels[0];
  const sellZoneBottom = opts.sellZoneBottom !== undefined ? opts.sellZoneBottom : sellLevels[0];
  const tierWeight = opts.tierWeight || 0.05;
  const w = currentWeight || 0;
  const tol = 1e-9;

  // 买入区
  if (ratio <= buyZoneTop) {
    if (w >= 1.0 - tol) return { action: 'FULL_HOLD', targetWeight: 1.0, nTiers: 0 };
    let nBuyTotal = 0;
    for (const th of buyLevels) { if (ratio <= th) nBuyTotal++; else break; }
    const target = Math.min(1.0, nBuyTotal * tierWeight);
    if (target > w + tol) {
      const nBuy = Math.round((target - w) / tierWeight);
      return { action: 'BUY', targetWeight: target, nTiers: nBuy };
    }
    return { action: 'HOLD', targetWeight: w, nTiers: 0 };
  }

  // 卖出区
  if (ratio >= sellZoneBottom) {
    if (w <= tol) return { action: 'EMPTY', targetWeight: 0, nTiers: 0 };
    let nSellTotal = 0;
    for (const th of sellLevels) { if (ratio >= th) nSellTotal++; else break; }
    const target = Math.max(0, 1 - nSellTotal * tierWeight);
    if (target < w - tol) {
      const nSell = Math.round((w - target) / tierWeight);
      return { action: 'SELL', targetWeight: target, nTiers: nSell };
    }
    return { action: 'HOLD', targetWeight: w, nTiers: 0 };
  }

  // 滞回带
  return { action: 'HOLD', targetWeight: w, nTiers: 0 };
}

// ============================================================
// 回测主函数
// 输入:
//   alignedData - 对齐后的日K数组 [{date, close1, close2, ratio, ...}]
//     close1 = 进攻指数（创业板/科创50）, close2 = 防守指数（红利）
//   opts - { startIdx, endIdx, execDelay, tradeCostRate, tierWeight, buyLevels, sellLevels, buyZoneTop, sellZoneBottom }
//     execDelay: 信号产生到执行的延迟天数（1=T+1, 2=T+2, 3=T+3）
//     tradeCostRate: 单边交易成本率
// 输出:
//   { finalValue, totalReturn, maxDrawdown, tradeCount, dailyReturns, yearlyReturns, metrics }
// ============================================================
function backtest(alignedData, opts) {
  opts = opts || {};
  const startIdx = opts.startIdx || 0;
  const endIdx = opts.endIdx !== undefined ? opts.endIdx : alignedData.length - 1;
  const execDelay = opts.execDelay || 1; // 默认T+1执行
  const tradeCostRate = opts.tradeCostRate !== undefined ? opts.tradeCostRate : 0.0005;
  const tierWeight = opts.tierWeight || 0.05;
  const initCapital = opts.initCapital || 1.0; // 归一化为1.0
  const initWeight = opts.initWeight || 0; // 初始仓位（分段验证时继承前段）

  let weight = initWeight; // 当前创业板/科创50权重
  let capital = initCapital;
  let peakValue = initCapital;
  let maxDrawdown = 0;
  let tradeCount = 0;

  const dailyValues = []; // 每日净值
  const tradeLog = [];
  const yearlyReturns = {};

  let prevYear = null;
  let yearStartValue = initCapital;

  for (let i = startIdx; i <= endIdx; i++) {
    const today = alignedData[i];
    const ratio = today.ratio;

    // 1) 信号判定（基于今日收盘比值）
    const signal = determineSignal(ratio, weight, opts);

    // 2) 执行调仓（在 execDelay 天后的开盘价执行）
    const execIdx = i + execDelay;
    if (signal.action === 'BUY' || signal.action === 'SELL') {
      if (execIdx <= endIdx) {
        const execDay = alignedData[execIdx];
        const execPrice1 = execDay.open1 || execDay.close1; // T+1开盘执行
        const execPrice2 = execDay.open2 || execDay.close2;
        // 用今日收盘估值，调仓金额
        const oldWeight = weight;
        const newWeight = signal.targetWeight;
        const deltaWeight = Math.abs(newWeight - oldWeight);
        // 调仓成本：变更部分 × 交易成本率 × 2（双边）
        const tradeCost = capital * deltaWeight * tradeCostRate * 2;
        capital -= tradeCost;
        weight = newWeight;
        tradeCount++;
        tradeLog.push({
          signalDate: today.date,
          execDate: execDay.date,
          action: signal.action,
          oldWeight, newWeight, tradeCost
        });
      }
    }

    // 3) 按当日收盘估值（注意：当日收益由旧仓位决定，因为T+1才执行）
    // 当日收益 = 仓位 × 进攻指数当日涨跌 + (1-仓位) × 防守指数当日涨跌
    // 但这里有个细节：如果今日才发出信号，今日仍按旧仓位持有，明日才执行
    // 所以"当日收益"用旧仓位计算
    if (i > startIdx) {
      const prev = alignedData[i - 1];
      const ret1 = today.close1 / prev.close1 - 1; // 进攻指数当日收益
      const ret2 = today.close2 / prev.close2 - 1; // 防守指数当日收益
      const dailyRet = weight * ret1 + (1 - weight) * ret2;
      capital *= (1 + dailyRet);
    }

    // 4) 记录净值
    dailyValues.push({ date: today.date, value: capital });
    if (capital > peakValue) peakValue = capital;
    const dd = (capital - peakValue) / peakValue;
    if (dd < maxDrawdown) maxDrawdown = dd;

    // 5) 年度统计
    const year = today.date.slice(0, 4);
    if (prevYear === null) { prevYear = year; yearStartValue = capital; }
    else if (year !== prevYear) {
      yearlyReturns[prevYear] = capital / yearStartValue - 1;
      prevYear = year;
      yearStartValue = capital;
    }
  }
  // 最后一年
  if (prevYear) yearlyReturns[prevYear] = capital / yearStartValue - 1;

  // 计算基准：进攻指数和防守指数的累计收益
  const startPrice1 = alignedData[startIdx].close1;
  const endPrice1 = alignedData[endIdx].close1;
  const startPrice2 = alignedData[startIdx].close2;
  const endPrice2 = alignedData[endIdx].close2;
  const ret1 = endPrice1 / startPrice1 - 1;
  const ret2 = endPrice2 / startPrice2 - 1;

  const totalReturn = capital / initCapital - 1;
  const numYears = (endIdx - startIdx + 1) / 244; // 约244交易日/年
  const annualReturn = Math.pow(capital / initCapital, 1 / numYears) - 1;

  // 等权基准
  const equalWeightReturn = (ret1 + ret2) / 2;
  const excessVsEqual = totalReturn - equalWeightReturn;

  return {
    finalValue: capital,
    totalReturn,
    annualReturn,
    maxDrawdown,
    tradeCount,
    finalWeight: weight,
    excessVsIdx1: totalReturn - ret1, // 超额vs进攻指数
    excessVsIdx2: totalReturn - ret2, // 超额vs防守指数
    excessVsEqual,
    idx1Return: ret1,
    idx2Return: ret2,
    equalWeightReturn,
    dailyValues,
    tradeLog,
    yearlyReturns
  };
}

module.exports = {
  backtest,
  determineSignal,
  DEFAULT_BUY_LEVELS,
  DEFAULT_SELL_LEVELS
};
