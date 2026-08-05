// 策略模块单元测试
// 规格11.1节：比值计算、档位判定、穿越多档、状态管理
const { test } = require('node:test');
const assert = require('node:assert');
const {
  calcRatio,
  countBuyTiers,
  countSellTiers,
  determineSignal,
  getNextBuyTier,
  getNextSellTier,
  getDistanceToNextAction
} = require('../strategy.cjs');
const { config } = require('../config.cjs');

// ============================================================
// 1. 比值计算
// ============================================================
test('calcRatio: 基本比值计算', () => {
  assert.strictEqual(calcRatio(3343.96, 5569.41).toFixed(4), '0.6004');
  assert.strictEqual(calcRatio(1344.54, 2450).toFixed(4), (1344.54 / 2450).toFixed(4));
});

test('calcRatio: 边界值处理', () => {
  assert.strictEqual(calcRatio(0, 100), 0);
  assert.strictEqual(calcRatio(100, 0), 0); // 除零保护
  assert.strictEqual(calcRatio(100, null), 0);
});

test('calcRatio: 已知数据锚点验证', () => {
  // 规格3.4节锚点：2026-07-31 创业板3343.96，红利5569.41，比值0.6004
  assert.strictEqual(calcRatio(3343.96, 5569.41).toFixed(4), '0.6004');
  // 2026-06-30：创业板4342.71，红利5022.5，比值0.8647（历史最高）
  assert.strictEqual(calcRatio(4342.71, 5022.5).toFixed(4), '0.8647');
});

// ============================================================
// 2. 买入档位判定
// ============================================================
test('countBuyTiers: 比值0.325应触发7档', () => {
  // 规格11.1节穿越多档测试：0.332/0.3308/0.3297/0.3285/0.3274/0.3262/0.3251 均 ≥ 0.325
  assert.strictEqual(countBuyTiers(0.325), 7);
});

test('countBuyTiers: 边界值', () => {
  // 恰等于0.332（买入上界）
  assert.strictEqual(countBuyTiers(0.332), 1);
  // 恰等于0.310（满仓档）
  assert.strictEqual(countBuyTiers(0.310), 20);
  // 比值大于0.332（不触发）
  assert.strictEqual(countBuyTiers(0.345), 0);
  // 比值小于0.310
  assert.strictEqual(countBuyTiers(0.300), 20);
});

test('countBuyTiers: 各档位精确触发', () => {
  // 第5档阈值0.3274
  assert.strictEqual(countBuyTiers(0.3274), 5);
  // 第10档阈值0.3216
  assert.strictEqual(countBuyTiers(0.3216), 10);
  // 第15档阈值0.3158
  assert.strictEqual(countBuyTiers(0.3158), 15);
  // 第20档阈值0.3100
  assert.strictEqual(countBuyTiers(0.3100), 20);
});

// ============================================================
// 3. 卖出档位判定
// ============================================================
test('countSellTiers: 比值0.62应触发7档', () => {
  // 规格11.1节原文"0.578至0.6127共6档"系笔误
  // 实际 SELL_LEVELS: 0.5780/0.5849/0.5919/0.5988/0.6058/0.6127/0.6197 均 ≤ 0.62，共7档
  assert.strictEqual(countSellTiers(0.62), 7);
});

test('countSellTiers: 边界值', () => {
  // 恰等于0.578（卖出下界）
  assert.strictEqual(countSellTiers(0.578), 1);
  // 恰等于0.710（清仓档）
  assert.strictEqual(countSellTiers(0.710), 20);
  // 比值小于0.578（不触发）
  assert.strictEqual(countSellTiers(0.450), 0);
  // 比值大于0.710
  assert.strictEqual(countSellTiers(0.850), 20);
});

test('countSellTiers: 各档位精确触发', () => {
  // 第5档阈值0.6058
  assert.strictEqual(countSellTiers(0.6058), 5);
  // 第10档阈值0.6405
  assert.strictEqual(countSellTiers(0.6405), 10);
  // 第15档阈值0.6753
  assert.strictEqual(countSellTiers(0.6753), 15);
});

// ============================================================
// 4. 信号判定 — 买入区
// ============================================================
test('determineSignal: 买入区触发买入', () => {
  // 比值0.325，当前权重0，应买7档
  const sig = determineSignal(0.325, 0);
  assert.strictEqual(sig.action, 'BUY');
  assert.strictEqual(sig.tiers, 7);
  // 浮点数容差比较：7 * 0.05 = 0.35000000000000003
  assert.ok(Math.abs(sig.targetWeight - 0.35) < 1e-9, `targetWeight应≈0.35, 实际=${sig.targetWeight}`);
  assert.strictEqual(sig.amount, 7 * config.tierAmount);
});

test('determineSignal: 已买5档后比值0.325只新增2档', () => {
  // 规格11.1节状态管理：已买5档（权重0.25），比值0.325对应7档，新增2档
  const sig = determineSignal(0.325, 0.25);
  assert.strictEqual(sig.action, 'BUY');
  assert.strictEqual(sig.tiers, 2);
  assert.ok(Math.abs(sig.targetWeight - 0.35) < 1e-9, `targetWeight应≈0.35, 实际=${sig.targetWeight}`);
});

test('determineSignal: 已满仓时FULL_HOLD', () => {
  // 权重1.0时，即使比值很低也不重复买入
  const sig = determineSignal(0.310, 1.0);
  assert.strictEqual(sig.action, 'FULL_HOLD');
  assert.strictEqual(sig.tiers, 0);
  assert.strictEqual(sig.targetWeight, 1.0);
});

test('determineSignal: 买入区无新增档位HOLD', () => {
  // 已买7档（权重0.35），比值0.325仍对应7档，无新增
  const sig = determineSignal(0.325, 0.35);
  assert.strictEqual(sig.action, 'HOLD');
  assert.strictEqual(sig.tiers, 0);
});

// ============================================================
// 5. 信号判定 — 卖出区
// ============================================================
test('determineSignal: 卖出区触发卖出', () => {
  // 比值0.62，当前权重1.0，应卖7档（0.62触发7档卖出，详见countSellTiers测试）
  const sig = determineSignal(0.62, 1.0);
  assert.strictEqual(sig.action, 'SELL');
  assert.strictEqual(sig.tiers, 7);
  assert.ok(Math.abs(sig.targetWeight - 0.65) < 1e-9, `targetWeight应≈0.65, 实际=${sig.targetWeight}`);
  assert.strictEqual(sig.amount, 7 * config.tierAmount);
});

test('determineSignal: 已清仓时EMPTY', () => {
  const sig = determineSignal(0.85, 0);
  assert.strictEqual(sig.action, 'EMPTY');
  assert.strictEqual(sig.tiers, 0);
  assert.strictEqual(sig.targetWeight, 0);
});

test('determineSignal: 卖出区无新增档位HOLD', () => {
  // 已卖7档（权重0.65），比值0.62仍对应7档，targetWeight=0.65，无新增
  const sig = determineSignal(0.62, 0.65);
  assert.strictEqual(sig.action, 'HOLD');
  assert.strictEqual(sig.tiers, 0);
});

// ============================================================
// 6. 信号判定 — 滞回带
// ============================================================
test('determineSignal: 滞回带HOLD', () => {
  const sig = determineSignal(0.450, 0.50);
  assert.strictEqual(sig.action, 'HOLD');
  assert.strictEqual(sig.tiers, 0);
  assert.strictEqual(sig.targetWeight, 0.50);
});

test('determineSignal: 滞回带边界0.332之上', () => {
  // 比值0.333在滞回带内
  const sig = determineSignal(0.333, 0);
  assert.strictEqual(sig.action, 'HOLD');
});

test('determineSignal: 滞回带边界0.578之下', () => {
  // 比值0.577在滞回带内
  const sig = determineSignal(0.577, 0.5);
  assert.strictEqual(sig.action, 'HOLD');
});

// ============================================================
// 7. 下一档位提示
// ============================================================
test('getNextBuyTier: 已买0档时下一档为买1档', () => {
  const next = getNextBuyTier(0.325, 0);
  assert.strictEqual(next, config.buyLevels[0]); // 0.332
});

test('getNextBuyTier: 已满仓时返回null', () => {
  const next = getNextBuyTier(0.310, 1.0);
  assert.strictEqual(next, null);
});

test('getNextSellTier: 已卖0档时下一档为卖1档', () => {
  const next = getNextSellTier(0.62, 1.0);
  assert.strictEqual(next, config.sellLevels[0]); // 0.578
});

test('getNextSellTier: 已清仓时返回null', () => {
  const next = getNextSellTier(0.85, 0);
  assert.strictEqual(next, null);
});

// ============================================================
// 8. 距下一档位的距离
// ============================================================
test('getDistanceToNextAction: 买入区提示下一买入档', () => {
  const d = getDistanceToNextAction(0.325, 0.35); // 已买7档
  assert.ok(d.desc.includes('跌破'));
});

test('getDistanceToNextAction: 卖出区提示下一卖出档', () => {
  const d = getDistanceToNextAction(0.62, 0.70); // 已卖6档
  assert.ok(d.desc.includes('升破'));
});

test('getDistanceToNextAction: 滞回带提示进入买入区', () => {
  const d = getDistanceToNextAction(0.400, 0.50);
  assert.ok(d.desc.includes('0.332'));
});

test('getDistanceToNextAction: 滞回带提示进入卖出区', () => {
  const d = getDistanceToNextAction(0.500, 0.50);
  assert.ok(d.desc.includes('0.578'));
});
