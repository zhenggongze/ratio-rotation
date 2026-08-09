// A股交易日判断共享模块（ratio-rotation）
// 数据源：data/trading_calendar.json（akshare 官方交易日历，含节假日/调休补班）
// 用法：
//   const { isTradingDay, todayBeijing } = require('./trading_day.cjs');
//   isTradingDay('2026-08-08')  // false
//   isTradingDay('2026-08-10')  // true
const fs = require('fs');
const path = require('path');

let _cal = null;

// 载入交易日历（惰性，首次调用时加载）
function loadCalendar() {
  if (_cal) return _cal;
  const file = path.join(__dirname, 'data', 'trading_calendar.json');
  try {
    _cal = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    // 文件缺失时不拦截流程：回退到周末判断（周六/周日非交易日）
    _cal = null;
  }
  return _cal;
}

// 北京时间日期字符串 YYYY-MM-DD
function todayBeijing() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

// 判断某天是否为 A 股交易日
// 优先用官方日历；无日历时回退：周末(周六/周日)非交易日，其余视为交易日
function isTradingDay(dateStr) {
  const cal = loadCalendar();
  if (cal) {
    if (dateStr in cal) return cal[dateStr] === 1;
    return false; // 超出日历范围（如更早/更晚日期）视为非交易日，宁可漏不可错
  }
  const d = new Date(dateStr + 'T00:00:00+08:00');
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

// 获取最近的前一个交易日（供"休市时展示最近状态"用）
function prevTradingDay(dateStr) {
  const cal = loadCalendar();
  const d = new Date(dateStr + 'T00:00:00+08:00');
  for (let i = 0; i < 30; i++) {
    d.setDate(d.getDate() - 1);
    const key = d.toISOString().slice(0, 10);
    if (cal) {
      if (cal[key] === 1) return key;
    } else {
      const day = d.getDay();
      if (day >= 1 && day <= 5) return key;
    }
  }
  return null;
}

module.exports = { isTradingDay, todayBeijing, prevTradingDay };
