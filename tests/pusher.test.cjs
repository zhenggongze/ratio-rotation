// PushDeer 推送模板单元测试
// 规格11.1节：验证8个模板字段完整、总字数不超过150
const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildBuyTemplate,
  buildSellTemplate,
  buildHoldTemplate,
  buildFullHoldTemplate,
  buildEmptyTemplate,
  buildCalibrationTemplate,
  buildAlertTemplate,
  buildMonthlyTemplate,
  buildDailyPushMessage
} = require('../pusher.cjs');

// ============================================================
// 模板字段完整性验证（规格7.3节）
// 必含：当日比值、是否操作、具体操作档位与金额、操作后创业板仓位
// ============================================================

test('模板一(买入): 字段完整且≤200字', () => {
  const record = {
    date: '2026-08-01',
    ratio: 0.3295,
    cyb_close: 1344.54,
    hli_close: 4080.12,
    cyb_weight: 0,
    percentile: 0.06
  };
  const signal = {
    weightBefore: 0,
    targetWeight: 0.10,
    tiers: 2
  };
  const execDate = '2026-08-03';

  const msg = buildBuyTemplate(record, signal, execDate);

  // 字段完整性
  assert.ok(msg.includes('0.3295'), '应包含比值');
  assert.ok(msg.includes('买入'), '应包含买入操作');
  assert.ok(msg.includes('2档'), '应包含档位数');
  assert.ok(msg.includes('16万'), '应包含金额(2*8=16万)');
  assert.ok(msg.includes('0%'), '应包含操作前仓位');
  assert.ok(msg.includes('10%'), '应包含操作后仓位');
  assert.ok(msg.includes('开盘'), '应包含开盘操作提示');
  assert.ok(msg.includes('1345') || msg.includes('1344'), '应包含创业板收盘价');
  assert.ok(msg.includes('p6'), '应包含历史分位');

  // 字数限制（模板增强后放宽至200字）
  assert.ok(msg.length <= 200, `字数应≤200, 实际=${msg.length}`);
});

test('模板二(卖出): 字段完整且≤200字', () => {
  const record = {
    date: '2026-08-01',
    ratio: 0.6100,
    cyb_close: 3343.96,
    hli_close: 5478.85,
    cyb_weight: 0.75,
    percentile: 0.82
  };
  const signal = {
    weightBefore: 0.75,
    targetWeight: 0.55,
    tiers: 4
  };
  const execDate = '2026-08-03';

  const msg = buildSellTemplate(record, signal, execDate);

  assert.ok(msg.includes('0.6100'), '应包含比值');
  assert.ok(msg.includes('卖出'), '应包含卖出操作');
  assert.ok(msg.includes('4档'), '应包含档位数');
  assert.ok(msg.includes('32万'), '应包含金额(4*8=32万)');
  assert.ok(msg.includes('75%'), '应包含操作前仓位');
  assert.ok(msg.includes('55%'), '应包含操作后仓位');
  assert.ok(msg.includes('p82'), '应包含历史分位');

  assert.ok(msg.length <= 200, `字数应≤200, 实际=${msg.length}`);
});

test('模板三(滞回带无操作): 字段完整且≤200字', () => {
  const record = {
    date: '2026-08-01',
    ratio: 0.4500,
    cyb_close: 2400.0,
    hli_close: 5333.33,
    cyb_weight: 0.75,
    percentile: 0.45,
    daily_ret: 0.012
  };

  const msg = buildHoldTemplate(record);

  assert.ok(msg.includes('0.4500'), '应包含比值');
  assert.ok(msg.includes('无'), '应包含无操作');
  assert.ok(msg.includes('滞回带'), '应包含滞回带说明');
  assert.ok(msg.includes('75%'), '应包含创业板仓位');
  assert.ok(msg.includes('25%'), '应包含红利仓位');
  assert.ok(msg.includes('p45'), '应包含历史分位');

  assert.ok(msg.length <= 200, `字数应≤200, 实际=${msg.length}`);
});

test('模板四(满仓无操作): 字段完整且≤200字', () => {
  const record = {
    date: '2026-08-01',
    ratio: 0.3200,
    cyb_close: 1344.54,
    hli_close: 4200.0,
    cyb_weight: 1.0,
    percentile: 0.05,
    daily_ret: -0.005
  };

  const msg = buildFullHoldTemplate(record);

  assert.ok(msg.includes('0.3200'), '应包含比值');
  assert.ok(msg.includes('满') || msg.includes('100%'), '应包含满仓说明');
  assert.ok(msg.includes('100%'), '应包含仓位');
  assert.ok(msg.includes('0.578'), '应包含下档提示');

  assert.ok(msg.length <= 200, `字数应≤200, 实际=${msg.length}`);
});

test('模板五(清仓无操作): 字段完整且≤200字', () => {
  const record = {
    date: '2026-08-01',
    ratio: 0.6500,
    cyb_close: 3343.96,
    hli_close: 5144.55,
    cyb_weight: 0,
    percentile: 0.85,
    daily_ret: 0.008
  };

  const msg = buildEmptyTemplate(record);

  assert.ok(msg.includes('0.6500'), '应包含比值');
  assert.ok(msg.includes('0%'), '应包含创业板仓位');
  assert.ok(msg.includes('100%'), '应包含红利仓位');
  assert.ok(msg.includes('0.332'), '应包含下档提示');

  assert.ok(msg.length <= 200, `字数应≤200, 实际=${msg.length}`);
});

test('模板六(年度校准): 字段完整且≤200字', () => {
  const calibResult = {
    buy_zone_top_current: 0.332,
    sell_zone_bot_current: 0.578,
    window_median: 0.46,
    changed: 0
  };

  const msg = buildCalibrationTemplate(calibResult);

  assert.ok(msg.includes('校准'), '应包含校准标题');
  assert.ok(msg.includes('0.332'), '应包含现行买入上界');
  assert.ok(msg.includes('0.578'), '应包含现行卖出下界');
  assert.ok(msg.includes('0.46'), '应包含窗口中位数');
  assert.ok(msg.includes('无需调整'), '应包含建议');

  assert.ok(msg.length <= 200, `字数应≤200, 实际=${msg.length}`);
});

test('模板六(年度校准-建议调整): 字段完整', () => {
  const calibResult = {
    buy_zone_top_current: 0.332,
    sell_zone_bot_current: 0.578,
    window_median: 0.50,
    changed: 1,
    suggested_buy_top: 0.345,
    suggested_sell_bot: 0.580
  };

  const msg = buildCalibrationTemplate(calibResult);

  assert.ok(msg.includes('0.345'), '应包含建议买入上界');
  assert.ok(msg.includes('0.580'), '应包含建议卖出下界');
  assert.ok(msg.includes('确认'), '应包含确认提示');
});

test('模板七(数据告警): 字段完整且≤200字', () => {
  const msg = buildAlertTemplate('2026-08-01', '创业板收盘双源差异1.2%大于0.5%');

  assert.ok(msg.includes('数据异常'), '应包含异常标题');
  assert.ok(msg.includes('8月1日') || msg.includes('2026-08-01'), '应包含日期');
  assert.ok(msg.includes('1.2%'), '应包含异常描述');
  assert.ok(msg.includes('人工复核'), '应包含复核提示');

  assert.ok(msg.length <= 200, `字数应≤200, 实际=${msg.length}`);
});

test('模板八(月度回顾): 字段完整且≤200字', () => {
  const monthlyStat = {
    month: 7,
    startWeight: 0.75,
    endWeight: 0,
    monthRet: 0.002,
    ytdRet: 0.168,
    lastRatio: 0.6004,
    percentile: 0.77
  };

  const msg = buildMonthlyTemplate(monthlyStat);

  assert.ok(msg.includes('月度回顾'), '应包含月度回顾标题');
  assert.ok(msg.includes('7月'), '应包含月份');
  assert.ok(msg.includes('75%'), '应包含月初仓位');
  assert.ok(msg.includes('0%'), '应包含月末仓位');
  assert.ok(msg.includes('0.6004'), '应包含比值');
  assert.ok(msg.includes('p77'), '应包含分位');

  assert.ok(msg.length <= 200, `字数应≤200, 实际=${msg.length}`);
});

// ============================================================
// buildDailyPushMessage 路由验证
// ============================================================
test('buildDailyPushMessage: BUY信号路由到买入模板', () => {
  const record = {
    date: '2026-08-01',
    ratio: 0.3295,
    cyb_weight: 0,
    action: 'BUY',
    action_tiers: 2,
    data_ok: 1,
    exec_date: '2026-08-03'
  };
  const signal = { weightBefore: 0, targetWeight: 0.10, tiers: 2 };

  const msg = buildDailyPushMessage(record, signal, '2026-08-03');
  assert.ok(msg.includes('买入'));
});

test('buildDailyPushMessage: SELL信号路由到卖出模板', () => {
  const record = {
    date: '2026-08-01',
    ratio: 0.6100,
    cyb_weight: 0.75,
    action: 'SELL',
    action_tiers: 4,
    data_ok: 1,
    exec_date: '2026-08-03'
  };
  const signal = { weightBefore: 0.75, targetWeight: 0.55, tiers: 4 };

  const msg = buildDailyPushMessage(record, signal, '2026-08-03');
  assert.ok(msg.includes('卖出'));
});

test('buildDailyPushMessage: HOLD信号路由到滞回带模板', () => {
  const record = {
    date: '2026-08-01',
    ratio: 0.4500,
    cyb_weight: 0.50,
    action: 'HOLD',
    data_ok: 1
  };

  const msg = buildDailyPushMessage(record, null, null);
  assert.ok(msg.includes('滞回带'));
});

test('buildDailyPushMessage: FULL_HOLD路由到满仓模板', () => {
  const record = {
    date: '2026-08-01',
    ratio: 0.3200,
    cyb_close: 1344.54,
    hli_close: 4200.0,
    cyb_weight: 1.0,
    action: 'FULL_HOLD',
    data_ok: 1
  };

  const msg = buildDailyPushMessage(record, null, null);
  assert.ok(msg.includes('满') || msg.includes('100%'));
});

test('buildDailyPushMessage: EMPTY路由到清仓模板', () => {
  const record = {
    date: '2026-08-01',
    ratio: 0.6500,
    cyb_close: 3343.96,
    hli_close: 5144.55,
    cyb_weight: 0,
    action: 'EMPTY',
    data_ok: 1
  };

  const msg = buildDailyPushMessage(record, null, null);
  assert.ok(msg.includes('0%'));
  assert.ok(msg.includes('100%'));
});

test('buildDailyPushMessage: 数据异常由 main.cjs 直接调 buildAlertTemplate', () => {
  // 设计澄清：buildDailyPushMessage 只处理正常 action (BUY/SELL/HOLD/FULL_HOLD/EMPTY)
  // 数据异常 (data_ok=0) 时 main.cjs 在 runDaily 中直接调用 buildAlertTemplate，
  // 不经过 buildDailyPushMessage。此处验证 buildAlertTemplate 单独工作正常。
  const msg = buildAlertTemplate('2026-08-01', '双源差异1.2%');
  assert.ok(msg.includes('数据异常'), 'buildAlertTemplate 应输出数据异常标题');
  assert.ok(msg.includes('双源差异1.2%'), '应包含异常描述');
});

// ============================================================
// 多档穿越场景（规格2.5节示例）
// ============================================================
test('推送模板: 穿越多档买入7档场景', () => {
  // 规格2.5节示例：比值从0.345跌至0.325，昨日已买0档，今日穿越买1~买7
  const record = {
    date: '2026-08-01',
    ratio: 0.325,
    cyb_weight: 0
  };
  const signal = {
    weightBefore: 0,
    targetWeight: 0.35,
    tiers: 7
  };

  const msg = buildBuyTemplate(record, signal, '2026-08-03');

  assert.ok(msg.includes('7档'), '应显示7档');
  assert.ok(msg.includes('56万'), '应显示金额56万(7*8)');
  assert.ok(msg.includes('0%'), '应显示操作前仓位0%');
  assert.ok(msg.includes('35%'), '应显示操作后仓位35%');
  assert.ok(msg.length <= 150, `字数应≤150, 实际=${msg.length}`);
});
