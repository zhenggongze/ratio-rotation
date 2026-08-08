// 科创50做T策略引擎（588000 版本）
// 与 t0_engine.cjs（红利515180）/ t0_engine_cyb.cjs（创业板159915）同口径，参数替换为科创50最优组合：
//   - 买入 10‰（开盘 × 0.990）、卖出 14‰（开盘 × 1.014）
//   - 14:00 手动卖出了结（严格口径：14:00 前买入/双边，未卖出 14:00 强制卖，之后无操作）
//   - 高开 >3% 跳过（科创50 波动大，高开过滤需放宽）；低开 >2% 跳过
//   - 50万固定做T仓位、当日了结、佣金万0.5双边、委托价向下取整3位
// 参数来源：backtest_kcb_threshold_grid.py + backtest_kcb_threshold_grid_14.py
//   （489 组网格遍历最优解：买1.0%/卖1.4% + 14:00了结 + 高开>3%/低开>2%）
// 回测数据源：data/t0/588000_5min_pytdx.json（2024-07-18 ~ 2026-08-07，499天，pytdx）
// 运行：node t0_engine_kcb.cjs  → 生成 public/t0_backtest_kcb.json + data/t0/kcb_backtest.json
const fs = require('fs');
const path = require('path');

const KCB_CONFIG = {
  SYMBOL: 'sh588000',
  NAME: '科创50ETF',
  BUY_K: 0.990,             // 买10‰：买入监控价 = 开盘 × 0.990
  SELL_K: 1.014,            // 卖14‰：卖出监控价 = 开盘 × 1.014
  CAPITAL: 500000,
  COMMISSION_RATE: 0.00005, // 万0.5双边
  SKIP_UP: 0.03,            // 高开超3%（开盘 > 昨收 × 1.03）当日跳过
  SKIP_DROP: 0.02,          // 低开超2%（开盘 < 昨收 × 0.98）当日跳过
  SETTLE_TIME: '14:00',     // 手动卖出时刻（14:00 之前买入/双边，之后无操作）
  PRICE_DECIMAL: 3,
  MINUTE_JSON: path.join(__dirname, 'data', 't0', '588000_5min_pytdx.json')
};

function floorN(value, ndigits) {
  const factor = 10 ** ndigits;
  return Math.floor(value * factor) / factor;
}

// 加载分钟数据（date 支持 YYYY-MM-DD 或 YYYYMMDD，统一转 YYYYMMDD 与生产口径一致）
function loadMins() {
  const raw = fs.readFileSync(KCB_CONFIG.MINUTE_JSON, 'utf-8');
  const mins = JSON.parse(raw);
  return mins.map(m => ({
    date: String(m.date).replace(/-/g, ''),
    time: String(m.time).slice(0, 5),
    open: m.open, high: m.high, low: m.low, close: m.close
  }));
}

function hhmm(dt) {
  const s = String(dt);
  return s.slice(8, 10) + ':' + s.slice(10, 12);
}

// 分钟级单日判定（严格14:00口径，与回测/每日记录共用）
function computeMinuteDailyKcb(day, bars, prevClose) {
  const sorted = [...bars].sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const open = first.open;
  const close = last.close;
  const gap = prevClose ? (open / prevClose - 1) * 100 : 0;
  const buyP = floorN(open * KCB_CONFIG.BUY_K, KCB_CONFIG.PRICE_DECIMAL);
  const sellP = floorN(open * KCB_CONFIG.SELL_K, KCB_CONFIG.PRICE_DECIMAL);
  const shares = Math.floor(KCB_CONFIG.CAPITAL / open / 100) * 100 || 100;
  const t = b => b.time || hhmm(b.date);
  // 高开>3% / 低开>2% 跳过
  const skipReason = gap > KCB_CONFIG.SKIP_UP * 100 ? `高开${gap.toFixed(2)}%超3%`
    : (gap <= -KCB_CONFIG.SKIP_DROP * 100 ? `低开${Math.abs(gap).toFixed(2)}%超2%` : '');
  const base = {
    date: day,
    prev_close: prevClose != null ? Math.round(prevClose * 1000) / 1000 : null,
    open: Math.round(open * 1000) / 1000,
    buy_p: buyP,
    sell_p: sellP,
    close: Math.round(close * 1000) / 1000,
    gap_pct: Math.round(gap * 100) / 100,
    shares
  };
  const holdPct = prevClose ? (close / prevClose - 1) * 100 : 0;
  if (skipReason) {
    return { ...base, status: '跳过', reason: skipReason, buy_filled: false, sell_filled: false,
      gross: 0, commission: 0, trades: 0, net: 0, hold_pct: Math.round(holdPct * 100) / 100,
      net_pct: 0, excess_pct: Math.round((0 - holdPct) * 100) / 100, buy_time: null, sell_time: null };
  }
  // 买入：仅限 14:00 前（time < SETTLE_TIME）
  let buyBar = null;
  for (const b of sorted) {
    if (t(b) >= KCB_CONFIG.SETTLE_TIME) break;
    if (!buyBar && b.low <= buyP) { buyBar = b; break; }
  }
  if (!buyBar) {
    return { ...base, status: '未触发', buy_filled: false, sell_filled: false, gross: 0, commission: 0, trades: 0,
      net: 0, hold_pct: Math.round(holdPct * 100) / 100, net_pct: 0,
      excess_pct: Math.round((0 - holdPct) * 100) / 100, buy_time: null, sell_time: null };
  }
  // 卖出：14:00 前触发卖价 → 双边；否则 14:00 强制卖出
  let sellBar = null;
  for (const b of sorted) {
    if (t(b) >= KCB_CONFIG.SETTLE_TIME) break;
    if (b.date <= buyBar.date && t(b) <= t(buyBar)) continue;
    if (t(b) > t(buyBar) && b.high >= sellP) { sellBar = b; break; }
  }
  const buyTime = t(buyBar);
  let status, sellFilled, sellTime, gross, commission, trades;
  commission = buyP * shares * KCB_CONFIG.COMMISSION_RATE;
  if (sellBar) {
    status = '双边成交'; sellFilled = true; sellTime = t(sellBar);
    trades = 2;
    commission += sellP * shares * KCB_CONFIG.COMMISSION_RATE;
    gross = (sellP - buyP) * shares;
  } else {
    // 14:00 手动卖出价 = time>=14:00 第一根K线 close
    let rp = null;
    for (const b of sorted) {
      if (t(b) >= KCB_CONFIG.SETTLE_TIME) { rp = b.close; break; }
    }
    if (rp == null) rp = close;
    status = '仅买14:00卖出'; sellFilled = false; sellTime = KCB_CONFIG.SETTLE_TIME;
    trades = 2;
    commission += rp * shares * KCB_CONFIG.COMMISSION_RATE;
    gross = (rp - buyP) * shares;
  }
  const net = gross - commission;
  const netPct = net / KCB_CONFIG.CAPITAL * 100;
  return { ...base, status, buy_filled: true, sell_filled: sellFilled, buy_time: buyTime, sell_time: sellTime,
    recover_price: Math.round((sellBar ? sellP : (() => {
      let rp = null;
      for (const b of sorted) { if (t(b) >= KCB_CONFIG.SETTLE_TIME) { rp = b.close; break; } }
      return rp == null ? close : rp;
    })()) * 1000) / 1000,
    gross: Math.round(gross * 100) / 100, commission: Math.round(commission * 100) / 100, trades,
    net: Math.round(net * 100) / 100,
    hold_pct: Math.round(holdPct * 100) / 100,
    net_pct: Math.round(netPct * 100) / 100,
    excess_pct: Math.round((netPct - holdPct) * 100) / 100 };
}

// 分钟级回测（588000 全量 499 天）
function buildMinuteBacktestKcb() {
  const mins = loadMins();
  const byDay = {};
  for (const m of mins) (byDay[m.date] = byDay[m.date] || []).push(m);
  const days = Object.keys(byDay).sort();
  const daily = [];
  const yearlyAgg = {};
  let prevClose = null;
  let totalNet = 0, totalGross = 0, totalComm = 0, totalTrades = 0;
  let bothDays = 0, buyOnlyDays = 0, trigDays = 0, skipDays = 0;
  let worstDay = 0, bestDay = 0;

  for (const day of days) {
    const bars = byDay[day].sort((a, b) => a.date - b.date);
    const rec = computeMinuteDailyKcb(day, bars, prevClose);
    const { status, net, gross, commission, trades } = rec;
    if (status === '跳过') skipDays++;
    else if (status !== '未触发') trigDays++;
    if (status === '双边成交') bothDays++;
    if (status === '仅买14:00卖出') buyOnlyDays++;
    totalNet += net; totalGross += gross; totalComm += commission; totalTrades += trades;
    if (net < worstDay) worstDay = net;
    if (net > bestDay) bestDay = net;
    daily.push({ ...rec, cum_net: Math.round(totalNet * 100) / 100 });

    const y = day.slice(0, 4);
    if (!yearlyAgg[y]) yearlyAgg[y] = { year: y, net: 0, gross: 0, comm: 0, trades: 0, firstOpen: 0, lastClose: 0, bothDays: 0, buyOnlyDays: 0 };
    const ya = yearlyAgg[y];
    ya.net += net; ya.gross += gross; ya.comm += commission; ya.trades += trades;
    if (status === '双边成交') ya.bothDays++;
    if (status === '仅买14:00卖出') ya.buyOnlyDays++;
    ya.lastClose = rec.close;
    if (!ya.firstOpen) ya.firstOpen = rec.open;
    prevClose = rec.close;
  }

  const firstOpen = byDay[days[0]].sort((a, b) => a.date - b.date)[0].open;
  const lastClose = byDay[days[days.length - 1]].sort((a, b) => a.date - b.date)[byDay[days[days.length - 1]].length - 1].close;
  const holdTotal = KCB_CONFIG.CAPITAL * (lastClose / firstOpen - 1);

  const yearly = Object.keys(yearlyAgg).sort().map(key => {
    const ya = yearlyAgg[key];
    const holdRet = KCB_CONFIG.CAPITAL * (ya.lastClose / ya.firstOpen - 1);
    return {
      year: ya.year,
      net: Math.round(ya.net * 100) / 100,
      gross: Math.round(ya.gross * 100) / 100,
      comm: Math.round(ya.comm * 100) / 100,
      trades: ya.trades,
      hold_ret: Math.round(holdRet * 100) / 100,
      excess: Math.round((ya.net - holdRet) * 100) / 100,
      both_days: ya.bothDays,
      buy_only_days: ya.buyOnlyDays
    };
  });

  return {
    summary: {
      basis: 'minute_real',
      trading_days: days.length,
      start_date: days[0],
      end_date: days[days.length - 1],
      skip_days: skipDays,
      total_trades: totalTrades,
      gross_profit: Math.round(totalGross * 100) / 100,
      commission: Math.round(totalComm * 100) / 100,
      net_profit: Math.round(totalNet * 100) / 100,
      hold_profit: Math.round(holdTotal * 100) / 100,
      excess_profit: Math.round((totalNet - holdTotal) * 100) / 100,
      both_days: bothDays,
      buy_only_days: buyOnlyDays,
      trig_days: trigDays,
      trigger_rate: Math.round(trigDays / days.length * 1000) / 10,
      worst_day: Math.round(worstDay * 100) / 100,
      best_day: Math.round(bestDay * 100) / 100
    },
    yearly: yearly,
    daily: daily,
    param: {
      buy_k: KCB_CONFIG.BUY_K,
      sell_k: KCB_CONFIG.SELL_K,
      capital: KCB_CONFIG.CAPITAL,
      commission_rate: KCB_CONFIG.COMMISSION_RATE,
      skip_up: KCB_CONFIG.SKIP_UP,
      skip_drop: KCB_CONFIG.SKIP_DROP,
      settle_time: KCB_CONFIG.SETTLE_TIME,
      symbol: KCB_CONFIG.SYMBOL,
      name: KCB_CONFIG.NAME,
      version: 'kcb-v1'
    }
  };
}

// 主入口：生成回测文件
function main() {
  console.log('='.repeat(60));
  console.log('  科创50(588000) 做T回测生成');
  console.log('='.repeat(60));
  const result = buildMinuteBacktestKcb();
  const s = result.summary;
  console.log(`  数据: ${s.start_date} ~ ${s.end_date}，${s.trading_days} 个交易日`);
  console.log(`  做T净利: ${s.net_profit} 元 (超额 ${(s.net_profit / KCB_CONFIG.CAPITAL * 100).toFixed(2)}%)`);
  console.log(`  持有: ${s.hold_profit} 元 | 做T累计(持有+做T): ${s.hold_profit + s.net_profit} 元`);
  console.log(`  双边${s.both_days}天 / 仅买14:00${s.buy_only_days}天 / 未触发${s.trading_days - s.skip_days - s.trig_days} / 跳过${s.skip_days}`);
  console.log('  分年度:');
  result.yearly.forEach(y => console.log(`    ${y.year}: 做T${y.net}元(${(y.net / KCB_CONFIG.CAPITAL * 100).toFixed(2)}%) 持有${(y.hold_ret / KCB_CONFIG.CAPITAL * 100).toFixed(2)}%`));

  // slim 版（public，前端按需加载）
  const slim = {
    summary: result.summary,
    yearly: result.yearly,
    param: result.param,
    daily: result.daily.map(r => ({
      date: r.date, status: r.status, buy_time: r.buy_time, sell_time: r.sell_time,
      open: r.open, close: r.close, buy_p: r.buy_p, sell_p: r.sell_p,
      recover_price: r.recover_price, shares: r.shares, gross: r.gross, commission: r.commission,
      net: r.net, net_pct: r.net_pct, hold_pct: r.hold_pct, excess_pct: r.excess_pct,
      buy_filled: r.buy_filled, sell_filled: r.sell_filled
    }))
  };
  fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'public', 't0_backtest_kcb.json'), JSON.stringify(slim), 'utf-8');
  fs.mkdirSync(path.join(__dirname, 'data', 't0'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 't0', 'kcb_backtest.json'), JSON.stringify(result), 'utf-8');
  console.log('\n✓ 已保存 public/t0_backtest_kcb.json (slim) + data/t0/kcb_backtest.json (full)');
}

if (require.main === module) main();

module.exports = { KCB_CONFIG, computeMinuteDailyKcb, buildMinuteBacktestKcb };
