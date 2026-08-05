// 策略引擎模块
// 比值计算、档位判定、穿越多档、状态管理、信号生成
// 规格第二部分：策略规格（不得改动）
// 支持双策略：创业板/红利（默认）+ 科创50/红利（传入 cfg）
const { config } = require('./config.cjs');

// ============================================================
// 比值计算
// ============================================================
function calcRatio(cybClose, hliClose) {
  if (!hliClose || hliClose === 0) return 0;
  return cybClose / hliClose;
}

// ============================================================
// 计算买入档位数（比值 r ≤ 的买入档位数量）
// ============================================================
function countBuyTiers(ratio, cfg) {
  cfg = cfg || config;
  let count = 0;
  for (const threshold of cfg.buyLevels) {
    if (ratio <= threshold) count++;
    else break;
  }
  return count;
}

// ============================================================
// 计算卖出档位数（比值 r ≥ 的卖出档位数量）
// ============================================================
function countSellTiers(ratio, cfg) {
  cfg = cfg || config;
  let count = 0;
  for (const threshold of cfg.sellLevels) {
    if (ratio >= threshold) count++;
    else break;
  }
  return count;
}

// ============================================================
// 信号判定（规格2.5节）
// 输入：比值、当前权重、可选策略配置 cfg
// 输出：{ action, tiers, targetWeight, amount, note }
// ============================================================
function determineSignal(ratio, currentWeight, cfg) {
  cfg = cfg || config;
  const w = currentWeight || 0;
  const tierWeight = cfg.tierWeight;
  const tolerance = 1e-9;

  // 买入区
  if (ratio <= cfg.buyZoneTop) {
    if (w >= 1.0 - tolerance) {
      return {
        action: 'FULL_HOLD',
        tiers: 0,
        targetWeight: 1.0,
        amount: 0,
        note: '买入区但已满仓'
      };
    }
    const nBuyTotal = countBuyTiers(ratio, cfg);
    const targetWeight = Math.min(1.0, nBuyTotal * tierWeight);
    if (targetWeight > w + tolerance) {
      const nBuy = Math.round((targetWeight - w) / tierWeight);
      return {
        action: 'BUY',
        tiers: nBuy,
        targetWeight: targetWeight,
        amount: nBuy * cfg.tierAmount,
        note: `买入${nBuy}档，仓位${(w * 100).toFixed(0)}%→${(targetWeight * 100).toFixed(0)}%`
      };
    }
    return {
      action: 'HOLD',
      tiers: 0,
      targetWeight: w,
      amount: 0,
      note: '买入区但无新增档位'
    };
  }

  // 卖出区
  if (ratio >= cfg.sellZoneBottom) {
    if (w <= tolerance) {
      return {
        action: 'EMPTY',
        tiers: 0,
        targetWeight: 0,
        amount: 0,
        note: '卖出区但已清仓'
      };
    }
    const nSellTotal = countSellTiers(ratio, cfg);
    const targetWeight = Math.max(0, 1 - nSellTotal * tierWeight);
    if (targetWeight < w - tolerance) {
      const nSell = Math.round((w - targetWeight) / tierWeight);
      return {
        action: 'SELL',
        tiers: nSell,
        targetWeight: targetWeight,
        amount: nSell * cfg.tierAmount,
        note: `卖出${nSell}档，仓位${(w * 100).toFixed(0)}%→${(targetWeight * 100).toFixed(0)}%`
      };
    }
    return {
      action: 'HOLD',
      tiers: 0,
      targetWeight: w,
      amount: 0,
      note: '卖出区但无新增档位'
    };
  }

  // 滞回带
  return {
    action: 'HOLD',
    tiers: 0,
    targetWeight: w,
    amount: 0,
    note: '滞回带内不操作'
  };
}

// ============================================================
// 计算下一档位（用于推送模板的"下档"提示）
// ============================================================
function getNextBuyTier(ratio, currentWeight, cfg) {
  cfg = cfg || config;
  const w = currentWeight || 0;
  const currentTiers = Math.round(w / cfg.tierWeight);
  if (currentTiers >= cfg.buyLevels.length) return null;
  return cfg.buyLevels[currentTiers];
}

function getNextSellTier(ratio, currentWeight, cfg) {
  cfg = cfg || config;
  const w = currentWeight || 0;
  const currentSellTiers = Math.round((1 - w) / cfg.tierWeight);
  if (currentSellTiers >= cfg.sellLevels.length) return null;
  return cfg.sellLevels[currentSellTiers];
}

// ============================================================
// 计算比值在历史序列中的分位数
// ============================================================
function calcPercentile(ratio, historyRatios) {
  if (!historyRatios || historyRatios.length === 0) return 0;
  let count = 0;
  for (const r of historyRatios) {
    if (r <= ratio) count++;
  }
  return count / historyRatios.length;
}

// ============================================================
// 计算距下一档位的距离
// ============================================================
function getDistanceToNextAction(ratio, currentWeight, cfg) {
  cfg = cfg || config;
  const w = currentWeight || 0;
  const tolerance = 1e-9;

  if (ratio <= cfg.buyZoneTop) {
    const nextTier = getNextBuyTier(ratio, w, cfg);
    if (nextTier === null) {
      return { direction: 'sell', threshold: cfg.sellZoneBottom, desc: `升破${cfg.sellZoneBottom}才卖出` };
    }
    return { direction: 'buy', threshold: nextTier, desc: `跌破${nextTier.toFixed(4)}再买1档` };
  }

  if (ratio >= cfg.sellZoneBottom) {
    const nextTier = getNextSellTier(ratio, w, cfg);
    if (nextTier === null) {
      return { direction: 'buy', threshold: cfg.buyZoneTop, desc: `跌破${cfg.buyZoneTop}才买入` };
    }
    return { direction: 'sell', threshold: nextTier, desc: `再升破${nextTier.toFixed(4)}卖1档` };
  }

  // 滞回带：根据当前仓位判断下一个关注方向
  // 全红利(w<=0)只能买 → 关注买入区；全指数(w>=1)只能卖 → 关注卖出区
  if (w <= tolerance) {
    return { direction: 'buy', threshold: cfg.buyZoneTop, desc: `跌破${cfg.buyZoneTop}进入买入区` };
  } else if (w >= 1 - tolerance) {
    return { direction: 'sell', threshold: cfg.sellZoneBottom, desc: `升破${cfg.sellZoneBottom}进入卖出区` };
  } else if (ratio < (cfg.buyZoneTop + cfg.sellZoneBottom) / 2) {
    return { direction: 'buy', threshold: cfg.buyZoneTop, desc: `跌破${cfg.buyZoneTop}进入买入区` };
  } else {
    return { direction: 'sell', threshold: cfg.sellZoneBottom, desc: `升破${cfg.sellZoneBottom}进入卖出区` };
  }
}

module.exports = {
  calcRatio,
  countBuyTiers,
  countSellTiers,
  determineSignal,
  getNextBuyTier,
  getNextSellTier,
  calcPercentile,
  getDistanceToNextAction
};
