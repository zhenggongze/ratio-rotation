// GitHub Actions 交易日守卫步骤：
// 非交易日（周末/节假日/调休）输出 SKIP=1，供 workflow 判断是否跳过数据流水线与推送
// 交易日输出 SKIP=0
const { isTradingDay, todayBeijing } = require('./trading_day.cjs');

const today = todayBeijing();
const isTd = isTradingDay(today);
console.log(`今日(${today}): ${isTd ? '交易日' : '非交易日'}`);
console.log(`IS_TRADING_DAY=${isTd ? 'true' : 'false'}`);
if (!isTd) console.log('SKIP=1');
