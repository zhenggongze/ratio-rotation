// 做T策略引擎模块（Node.js 移植版）
// 移植自 t0-strategy 项目（TRAE Work），口径与 Python engine.py 完全一致：
// - 50万固定做T仓位，当日了结，次日恢复50万，盈亏累计不滚入
// - 佣金万1双边
// - 低开>2%当日跳过
// - 仅买入未卖出 → 当日收盘价恢复（卖出等量底仓）
// - 委托价 = round(开盘价 x 系数, 3)，三位小数与实盘一致
const fs = require('fs');
const path = require('path');

// ============================================================
// 参数（与 t0-strategy/strategy/config.py 一致）
// ============================================================
const T0_CONFIG = {
  SYMBOL: 'sh515180',       // 易方达中证红利ETF
  NAME: '红利ETF',
  BUY_K: 0.996,             // 买入监控价 = 开盘价 x 0.996（跌0.4%触发买入）
  SELL_K: 1.004,            // 卖出监控价 = 开盘价 x 1.004（涨0.4%触发卖出）
  CAPITAL: 500000,          // 每日固定做T委托仓位（元）
  COMMISSION_RATE: 0.0001,  // 佣金 万1 双边
  SKIP_DROP: 0.02,          // 低开超2%（开盘 < 昨收 x 0.98）当日跳过
  PRICE_DECIMAL: 3,         // 委托价格精度（ETF最小变动价位0.001）
  DATA_CSV: path.join(__dirname, 'data', 't0', '515180_daily_2019_2026.csv'),
  BACKTEST_JSON: path.join(__dirname, 'data', 't0', 't0_backtest.json')
};

// ============================================================
// Python round 实现（银行家舍入：恰好0.5时取偶数）
// 与 Python 内置 round 行为一致，确保回测数字与 Python 版吻合
// ============================================================
function pyRound(value, ndigits) {
  const factor = 10 ** ndigits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (diff < 0.5) return floor / factor;
  if (diff > 0.5) return (floor + 1) / factor;
  return (floor % 2 === 0 ? floor : floor + 1) / factor;
}

// ============================================================
// 加载历史日线 CSV
// 列: 日期,开盘,收盘,最高,最低,成交量,振幅,涨跌幅,涨跌额,成交额
// ============================================================
function loadT0History(csvPath) {
  const p = csvPath || T0_CONFIG.DATA_CSV;
  const raw = fs.readFileSync(p, 'utf-8');
  const lines = raw.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;
    const row = {};
    header.forEach((h, idx) => { row[h.trim()] = (cols[idx] || '').trim(); });
    rows.push({
      date: row['日期'],
      open: parseFloat(row['开盘']),
      close: parseFloat(row['收盘']),
      high: parseFloat(row['最高']),
      low: parseFloat(row['最低'])
    });
  }
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  return rows;
}

// ============================================================
// 回测主函数（单档或双档，与 Python engine.py 一致）
// tiers: [{ buyK, sellK, capital }]
// ============================================================
function runT0Backtest(rows, opts) {
  opts = opts || {};
  const tiers = opts.tiers || [{ buyK: T0_CONFIG.BUY_K, sellK: T0_CONFIG.SELL_K, capital: T0_CONFIG.CAPITAL }];
  const commissionRate = opts.commissionRate !== undefined ? opts.commissionRate : T0_CONFIG.COMMISSION_RATE;
  const skipDrop = opts.skipDrop !== undefined ? opts.skipDrop : T0_CONFIG.SKIP_DROP;
  const N = rows.length;

  let totalGross = 0, totalComm = 0, totalTrades = 0;
  let buyOnlyDays = 0, bothDays = 0, trigDays = 0, skipDays = 0;
  let cumProfit = 0, worstDay = 0, bestDay = 0;
  const yearlyAgg = {};

  for (let i = 0; i < N; i++) {
    const row = rows[i];
    const open = row.open, high = row.high, low = row.low, close = row.close;
    const prevClose = i > 0 ? rows[i - 1].close : open;
    const gap = i > 0 ? (open / prevClose - 1) * 100 : 0;
    const skip = gap <= -skipDrop * 100;

    let dayGross = 0, dayComm = 0, dayTrades = 0;
    let buyOnly = false, both = false, trig = false;

    if (!skip) {
      for (const tier of tiers) {
        const buyP = pyRound(open * tier.buyK, T0_CONFIG.PRICE_DECIMAL);
        const sellP = pyRound(open * tier.sellK, T0_CONFIG.PRICE_DECIMAL);
        let shares = Math.floor(tier.capital / open / 100) * 100;
        if (shares === 0) shares = 100;
        const buyFilled = low <= buyP;
        const sellFilled = high >= sellP;
        if (!buyFilled) continue;
        trig = true;
        dayComm += buyP * shares * commissionRate;
        dayTrades++;
        if (sellFilled) {
          dayComm += sellP * shares * commissionRate;
          dayTrades++;
          dayGross += (sellP - buyP) * shares;
          both = true;
        } else {
          // 仅买入未卖出 → 当日收盘恢复
          dayComm += close * shares * commissionRate;
          dayTrades++;
          dayGross += (close - buyP) * shares;
          buyOnly = true;
        }
      }
    } else {
      skipDays++;
    }
    const net = dayGross - dayComm;
    cumProfit += net;
    if (net < worstDay) worstDay = net;
    if (net > bestDay) bestDay = net;
    if (buyOnly) buyOnlyDays++;
    if (both) bothDays++;
    if (trig) trigDays++;
    totalGross += dayGross; totalComm += dayComm; totalTrades += dayTrades;

    // 年度聚合
    const y = row.date.slice(0, 4);
    if (!yearlyAgg[y]) yearlyAgg[y] = { year: y, net: 0, gross: 0, comm: 0, trades: 0, firstOpen: open, lastClose: close, firstIdx: i, lastIdx: i };
    const ya = yearlyAgg[y];
    ya.net += net; ya.gross += dayGross; ya.comm += dayComm; ya.trades += dayTrades;
    ya.lastClose = close; ya.lastIdx = i;
  }

  // 持有收益（50万不动）：整体 = 期末收盘 / 期初开盘 - 1
  const holdTotal = T0_CONFIG.CAPITAL * (rows[N - 1].close / rows[0].open - 1);
  const totalNet = cumProfit;

  // 逐年持有收益（该年首日开盘 → 该年末日收盘，50万基准）
  const yearly = Object.keys(yearlyAgg).sort().map(key => {
    const ya = yearlyAgg[key];
    const holdRet = ya.firstIdx === ya.lastIdx ? 0 : T0_CONFIG.CAPITAL * (ya.lastClose / ya.firstOpen - 1);
    return {
      year: ya.year,
      net: Math.round(ya.net * 100) / 100,
      gross: Math.round(ya.gross * 100) / 100,
      comm: Math.round(ya.comm * 100) / 100,
      trades: ya.trades,
      hold_ret: Math.round(holdRet * 100) / 100,
      excess: Math.round((ya.net - holdRet) * 100) / 100
    };
  });

  return {
    summary: {
      trading_days: N,
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
      trigger_rate: Math.round(trigDays / N * 1000) / 10,
      worst_day: Math.round(worstDay * 100) / 100,
      best_day: Math.round(bestDay * 100) / 100,
      start_date: rows[0].date,
      end_date: rows[N - 1].date
    },
    yearly: yearly,
    param: {
      buy_k: T0_CONFIG.BUY_K,
      sell_k: T0_CONFIG.SELL_K,
      capital: T0_CONFIG.CAPITAL,
      commission_rate: T0_CONFIG.COMMISSION_RATE,
      skip_drop: T0_CONFIG.SKIP_DROP,
      symbol: T0_CONFIG.SYMBOL,
      name: T0_CONFIG.NAME
    }
  };
}

// ============================================================
// 计算每日做T信号（9:25 后开盘价确定）
// 输入: openPrice 开盘价, prevClose 昨收
// 输出: { open, prevClose, gapPct, buyP, sellP, shares, skip, skipReason, buyAmt, sellAmt }
// ============================================================
function computeT0Signal(openPrice, prevClose) {
  if (!openPrice || openPrice <= 0 || !prevClose || prevClose <= 0) {
    return { error: '行情数据无效' };
  }
  const buyP = pyRound(openPrice * T0_CONFIG.BUY_K, T0_CONFIG.PRICE_DECIMAL);
  const sellP = pyRound(openPrice * T0_CONFIG.SELL_K, T0_CONFIG.PRICE_DECIMAL);
  let shares = Math.floor(T0_CONFIG.CAPITAL / openPrice / 100) * 100;
  if (shares === 0) shares = 100;
  const gapPct = Math.round((openPrice / prevClose - 1) * 10000) / 100;
  const skip = openPrice < prevClose * (1 - T0_CONFIG.SKIP_DROP);
  return {
    open: Math.round(openPrice * 1000) / 1000,
    prev_close: Math.round(prevClose * 1000) / 1000,
    gap_pct: gapPct,
    buy_p: buyP,
    sell_p: sellP,
    shares: shares,
    buy_amt: Math.round(buyP * shares),
    sell_amt: Math.round(sellP * shares),
    skip: skip,
    skip_reason: skip ? `低开${gapPct}%超2%，按纪律今日不做T不挂单` : ''
  };
}

// ============================================================
// 预计算回测结果并保存 t0_backtest.json（供前端展示）
// ============================================================
function buildBacktestJson() {
  const rows = loadT0History();
  const result = runT0Backtest(rows);
  const payload = {
    generated_at: new Date().toISOString(),
    ...result
  };
  fs.mkdirSync(path.dirname(T0_CONFIG.BACKTEST_JSON), { recursive: true });
  fs.writeFileSync(T0_CONFIG.BACKTEST_JSON, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`✓ 回测结果已保存: ${T0_CONFIG.BACKTEST_JSON}`);
  console.log(`  净盈利: ${payload.summary.net_profit} 元, 持有: ${payload.summary.hold_profit} 元, 超额: ${payload.summary.excess_profit} 元`);
  return payload;
}

// ============================================================
// 加载回测结果 JSON（前端数据导出用）
// ============================================================
function loadBacktestJson() {
  if (!fs.existsSync(T0_CONFIG.BACKTEST_JSON)) return null;
  try {
    return JSON.parse(fs.readFileSync(T0_CONFIG.BACKTEST_JSON, 'utf-8'));
  } catch (e) {
    console.log(`  ⚠ 读取回测结果失败: ${e.message}`);
    return null;
  }
}

module.exports = {
  T0_CONFIG,
  loadT0History,
  runT0Backtest,
  computeT0Signal,
  buildBacktestJson,
  loadBacktestJson,
  pyRound
};
