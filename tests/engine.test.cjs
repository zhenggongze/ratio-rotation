// V2 收益引擎单元测试
// 规格11.1节：构造3天模拟行情（含隔夜跳空与日内波动），手工验证 V2 公式数值
// 规格2.6节：当日策略收益 = (1+隔夜段) × (1-调仓成本) × (1+日内段+分红计提) - 1
const { test } = require('node:test');
const assert = require('node:assert');
const {
  calcDailyReturn,
  verifyConsistency,
  runBacktest
} = require('../engine.cjs');
const { config } = require('../config.cjs');

// ============================================================
// 1. calcDailyReturn 基本公式验证
// ============================================================
test('calcDailyReturn: 无调仓日基本计算', () => {
  // 模拟数据：创业板昨收100，今开101，今收102；红利昨收200，今开201，今收202
  // 权重0.5（无调仓）
  const prevClose = { cyb: 100, hli: 200 };
  const todayOpen = { cyb: 101, hli: 201 };
  const todayClose = { cyb: 102, hli: 202 };

  const div = { cyb: 0, hli: 0 }; // 暂不计分红，便于手工验证
  const ret = calcDailyReturn(prevClose, todayOpen, todayClose, 0.5, 0.5, false, div);

  // 隔夜段 = 0.5*(101/100-1) + 0.5*(201/200-1) = 0.5*0.01 + 0.5*0.005 = 0.0075
  assert.ok(Math.abs(ret.overnightRet - 0.0075) < 1e-9, `隔夜段应=0.0075, 实际=${ret.overnightRet}`);

  // 日内段 = 0.5*(102/101-1) + 0.5*(202/201-1) ≈ 0.5*0.00990099 + 0.5*0.00497512 ≈ 0.007438
  const expectedIntraday = 0.5 * (102 / 101 - 1) + 0.5 * (202 / 201 - 1);
  assert.ok(Math.abs(ret.intradayRet - expectedIntraday) < 1e-9, `日内段应=${expectedIntraday}, 实际=${ret.intradayRet}`);

  // 调仓成本 = 0
  assert.strictEqual(ret.tradeCost, 0);

  // 分红 = 0
  assert.strictEqual(ret.dividend, 0);

  // 当日收益 = (1+0.0075)*(1-0)*(1+expectedIntraday+0) - 1
  const expectedDaily = (1 + 0.0075) * (1 + expectedIntraday) - 1;
  assert.ok(Math.abs(ret.dailyRet - expectedDaily) < 1e-9, `当日收益应=${expectedDaily}, 实际=${ret.dailyRet}`);
});

test('calcDailyReturn: 调仓日成本扣除', () => {
  // 权重从0.3调到0.5，调仓成本 = |0.5-0.3|*0.0005 = 0.0001
  const prevClose = { cyb: 100, hli: 200 };
  const todayOpen = { cyb: 100, hli: 200 }; // 无跳空
  const todayClose = { cyb: 100, hli: 200 }; // 无波动
  const div = { cyb: 0, hli: 0 };

  const ret = calcDailyReturn(prevClose, todayOpen, todayClose, 0.3, 0.5, true, div);

  // 隔夜段=0, 日内段=0, 调仓成本=0.0001, 分红=0
  assert.strictEqual(ret.overnightRet, 0);
  assert.strictEqual(ret.intradayRet, 0);
  assert.ok(Math.abs(ret.tradeCost - 0.0001) < 1e-9, `调仓成本应=0.0001, 实际=${ret.tradeCost}`);

  // 当日收益 = (1+0)*(1-0.0001)*(1+0+0) - 1 = -0.0001
  assert.ok(Math.abs(ret.dailyRet - (-0.0001)) < 1e-9, `当日收益应=-0.0001, 实际=${ret.dailyRet}`);
});

test('calcDailyReturn: 分红计提', () => {
  // 权重0.6，创业板分红率0.001，红利分红率0.002
  // 分红 = 0.6*0.001 + 0.4*0.002 = 0.0006 + 0.0008 = 0.0014
  const prevClose = { cyb: 100, hli: 200 };
  const todayOpen = { cyb: 100, hli: 200 };
  const todayClose = { cyb: 100, hli: 200 };
  const div = { cyb: 0.001, hli: 0.002 };

  const ret = calcDailyReturn(prevClose, todayOpen, todayClose, 0.6, 0.6, false, div);

  assert.ok(Math.abs(ret.dividend - 0.0014) < 1e-9, `分红应=0.0014, 实际=${ret.dividend}`);

  // 当日收益 = (1+0)*(1-0)*(1+0+0.0014) - 1 = 0.0014
  assert.ok(Math.abs(ret.dailyRet - 0.0014) < 1e-9, `当日收益应=0.0014, 实际=${ret.dailyRet}`);
});

test('calcDailyReturn: 隔夜跳空场景', () => {
  // 创业板昨收100，今开110（+10%跳空），今收105
  // 红利昨收200，今开204（+2%），今收206
  // 权重0.7（无调仓）
  const prevClose = { cyb: 100, hli: 200 };
  const todayOpen = { cyb: 110, hli: 204 };
  const todayClose = { cyb: 105, hli: 206 };
  const div = { cyb: 0, hli: 0 };

  const ret = calcDailyReturn(prevClose, todayOpen, todayClose, 0.7, 0.7, false, div);

  // 隔夜段 = 0.7*(110/100-1) + 0.3*(204/200-1) = 0.7*0.1 + 0.3*0.02 = 0.07 + 0.006 = 0.076
  assert.ok(Math.abs(ret.overnightRet - 0.076) < 1e-9, `隔夜段应=0.076, 实际=${ret.overnightRet}`);

  // 日内段 = 0.7*(105/110-1) + 0.3*(206/204-1) = 0.7*(-0.045454) + 0.3*0.009804
  const expectedIntraday = 0.7 * (105 / 110 - 1) + 0.3 * (206 / 204 - 1);
  assert.ok(Math.abs(ret.intradayRet - expectedIntraday) < 1e-9);
});

// ============================================================
// 2. 3天模拟行情完整验证
// ============================================================
test('calcDailyReturn: 3天模拟行情V2公式手工验证', () => {
  // 模拟3天数据
  // Day1: 创业板100/102, 红利200/201, 权重0.5
  // Day2: 创业板102/98(跳空低开95), 红利201/203, 权重0.5
  // Day3: 创业板98/105(跳空高开100), 红利203/200, 权重0.5
  const div = { cyb: 0, hli: 0 };

  // Day1
  const ret1 = calcDailyReturn(
    { cyb: 100, hli: 200 },  // 前一日收盘（首日用开盘价）
    { cyb: 100, hli: 200 },  // 今开
    { cyb: 102, hli: 201 },  // 今收
    0.5, 0.5, false, div
  );
  // 隔夜=0, 日内=0.5*(102/100-1)+0.5*(201/200-1)=0.5*0.02+0.5*0.005=0.0125
  // 收益=(1+0)*(1+0.0125+0)-1=0.0125
  assert.ok(Math.abs(ret1.dailyRet - 0.0125) < 1e-9, `Day1收益应=0.0125, 实际=${ret1.dailyRet}`);

  // Day2
  const ret2 = calcDailyReturn(
    { cyb: 102, hli: 201 },  // Day1收盘
    { cyb: 95, hli: 202 },   // Day2开盘（创业板跳空低开）
    { cyb: 98, hli: 203 },   // Day2收盘
    0.5, 0.5, false, div
  );
  // 隔夜=0.5*(95/102-1)+0.5*(202/201-1)=0.5*(-0.068627)+0.5*0.004975=-0.031826
  const expectedOvernight2 = 0.5 * (95 / 102 - 1) + 0.5 * (202 / 201 - 1);
  assert.ok(Math.abs(ret2.overnightRet - expectedOvernight2) < 1e-9);

  // Day3
  const ret3 = calcDailyReturn(
    { cyb: 98, hli: 203 },
    { cyb: 100, hli: 202 },
    { cyb: 105, hli: 200 },
    0.5, 0.5, false, div
  );
  const expectedOvernight3 = 0.5 * (100 / 98 - 1) + 0.5 * (202 / 203 - 1);
  assert.ok(Math.abs(ret3.overnightRet - expectedOvernight3) < 1e-9);
});

// ============================================================
// 3. 资产递推验证
// ============================================================
test('runBacktest: 资产递推一致性', () => {
  // 构造3天数据
  const history = [
    { date: '2024-01-01', cyb_open: 100, cyb_close: 102, hli_open: 200, hli_close: 201 },
    { date: '2024-01-02', cyb_open: 102, cyb_close: 105, hli_open: 201, hli_close: 203 },
    { date: '2024-01-03', cyb_open: 105, cyb_close: 103, hli_open: 203, hli_close: 205 }
  ];

  const result = runBacktest(history, 1000000);

  assert.strictEqual(result.dailyRecords.length, 3);
  assert.ok(result.finalAsset > 0);

  // 验证资产递推：期末资产 = 1000000 * (1+r1) * (1+r2) * (1+r3)
  const r1 = result.dailyRecords[0].daily_ret;
  const r2 = result.dailyRecords[1].daily_ret;
  const r3 = result.dailyRecords[2].daily_ret;
  const expectedAsset = 1000000 * (1 + r1) * (1 + r2) * (1 + r3);
  assert.ok(Math.abs(result.finalAsset - expectedAsset) < 0.01, `期末资产应=${expectedAsset}, 实际=${result.finalAsset}`);
});

// ============================================================
// 4. 自洽校验
// ============================================================
test('verifyConsistency: 正常数据应通过', () => {
  const history = [
    { date: '2024-01-01', cyb_open: 100, cyb_close: 102, hli_open: 200, hli_close: 201 },
    { date: '2024-01-02', cyb_open: 102, cyb_close: 105, hli_open: 201, hli_close: 203 }
  ];

  const result = runBacktest(history, 1000000);
  const consistency = verifyConsistency(result.dailyRecords, 1000000);

  assert.strictEqual(consistency.totalChecked, 2);
  // 自洽校验应通过（无调仓日恒等式3应成立）
  assert.strictEqual(consistency.alertCount, 0);
  assert.strictEqual(consistency.passed, true);
});

test('verifyConsistency: 篡改资产后应告警', () => {
  const history = [
    { date: '2024-01-01', cyb_open: 100, cyb_close: 102, hli_open: 200, hli_close: 201 },
    { date: '2024-01-02', cyb_open: 102, cyb_close: 105, hli_open: 201, hli_close: 203 }
  ];

  const result = runBacktest(history, 1000000);
  // 篡改第二天的资产
  result.dailyRecords[1].asset_value = result.dailyRecords[1].asset_value + 100;

  const consistency = verifyConsistency(result.dailyRecords, 1000000);
  assert.ok(consistency.alertCount > 0, '篡改资产后应告警');
  assert.strictEqual(consistency.passed, false);
});

// ============================================================
// 5. 兜底分红率验证
// ============================================================
test('V2引擎: 兜底分红率正确', () => {
  // 红利4.4%/252, 创业板0.9%/252
  const expectedHli = 0.044 / 252;
  const expectedCyb = 0.009 / 252;
  assert.ok(Math.abs(config.hliDividendAnnual / config.tradingDaysPerYear - expectedHli) < 1e-9);
  assert.ok(Math.abs(config.cybDividendAnnual / config.tradingDaysPerYear - expectedCyb) < 1e-9);
});

// ============================================================
// 6. 边界情况
// ============================================================
test('calcDailyReturn: 空数据保护', () => {
  const ret = calcDailyReturn(
    { cyb: 0, hli: 0 },
    { cyb: 0, hli: 0 },
    { cyb: 0, hli: 0 },
    0, 0, false, { cyb: 0, hli: 0 }
  );
  assert.strictEqual(ret.dailyRet, 0);
});

test('runBacktest: 空数据返回空结果', () => {
  const result = runBacktest([], 1000000);
  assert.strictEqual(result.dailyRecords.length, 0);
  assert.strictEqual(result.tradeLog.length, 0);
  assert.strictEqual(result.finalAsset, 1000000);
});
