// 做T策略引擎模块（Node.js 移植版）
// 基于 t0-strategy 项目（TRAE Work）策略口径，含本地化改进：
// - 50万固定做T仓位，当日了结，次日恢复50万，盈亏累计不滚入
// - 佣金万0.5双边（2026-08-07 起，原万1）
// - 低开>2%当日跳过
// - 仅买入未卖出 → 当日 14:50 卖出（卖出等量底仓）
// - 委托价 = 开盘价 x 系数 向下取整到 3 位小数（实盘最小变动价位 0.001；
//   向下取整挂单更低一档：买入过滤虚假触发、卖出更易成交，回测验证 4 组配对全胜）
// ============================================================
// 策略版本 v2（2026-08-06 生效）：
// - 阈值从 0.4%/0.4% 调整为 买入0.3%（×0.997）/ 卖出0.8%（×1.008）
//   依据：385天真实1分钟数据回测，宽卖出阈值下真实双边占比 89.2%（0.4/0.4 仅 63.2%），
//   假双边从36.8%降到10.8%，做T净利 +16.07万（超额+32.14%，14:50了结口径）
// - 历史业绩仅计算有分钟数据的日期（2025-01-02 ~ 2026-08-05，385天），分钟级真实成交，无折算模型
// ============================================================
// 恢复卖出价（2026-08-11 更新，14:57 → 14:50）：
// - 买入后未触发卖出 → 以当日 14:50 价格卖出
//   （14:57 进入收盘集合竞价不可撤单，实盘无法操作；14:50 为连续竞价可自由挂单/撤单）
//   （分钟级回测取 14:50 那根K线 close；每日记录取当日分时 14:50 价格；缺失时回退收盘价）
// - 状态名：仅买收盘恢复 → 仅买14:50卖出，sell_time 固定为 14:50
// ============================================================
const fs = require('fs');
const path = require('path');

// ============================================================
// 参数（与 t0-strategy/strategy/config.py 一致，v2 阈值）
// ============================================================
const T0_CONFIG = {
  SYMBOL: 'sh515180',       // 易方达中证红利ETF
  NAME: '红利ETF',
  BUY_K: 0.997,             // 买入监控价 = 开盘价 x 0.997（跌0.3%触发买入）v2
  SELL_K: 1.008,            // 卖出监控价 = 开盘价 x 1.008（涨0.8%触发卖出）v2
  CAPITAL: 500000,          // 每日固定做T委托仓位（元）
  COMMISSION_RATE: 0.00005, // 佣金 万0.5 双边（2026-08-07 券商费率下调）
  SKIP_DROP: 0.02,          // 低开超2%（开盘 < 昨收 x 0.98）当日跳过
  PRICE_DECIMAL: 3,         // 委托价格精度（ETF最小变动价位0.001）
  DATA_CSV: path.join(__dirname, 'data', 't0', '515180_daily_2019_2026.csv'),
  MINUTE_JSON: path.join(__dirname, 'data', 't0', '515180_1min_2025_2026.json'),
  BACKTEST_JSON: path.join(__dirname, 'data', 't0', 't0_backtest.json')
};

// ============================================================
// v1 折算模型（已停用：历史业绩改为分钟级真实成交，不再折算估算）
// 保留定义供兼容/参考，不参与 buildBacktestJson 输出
// ============================================================
const T0_DISCOUNT = {
  pReal: 0.632,
  convAvg: -2199,
  slippage: 0.95
};

// ============================================================
// 向下取整到 n 位小数（实盘挂单最小变动价位 0.001）
// 相比四舍五入/银行家舍入：挂单价更低一档 → 买入过滤虚假触发、卖出更易成交
// ============================================================
function floorN(value, ndigits) {
  const factor = 10 ** ndigits;
  return Math.floor(value * factor) / factor;
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
// 折算一段区间（全样本或某年）的做T差价净利
// 理论双边日中仅 63.2% 真实"先买后卖"（赚双边差价），
// 38.6% 实际先涨后跌 → 实盘只能收盘恢复（日均 -847 元），双边差价再 ×0.95 滑点
// ============================================================
function calcDiscountedNet(bothDays, bothNet, buyOnlyNet) {
  if (bothDays === 0) return buyOnlyNet;
  const bothAvg = bothNet / bothDays;
  return bothDays * (T0_DISCOUNT.pReal * bothAvg * T0_DISCOUNT.slippage + (1 - T0_DISCOUNT.pReal) * T0_DISCOUNT.convAvg) + buyOnlyNet;
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
  // 舍入函数（默认向下取整，与实盘挂单口径一致；评估其他策略时可注入 floor/ceil，买卖可分别指定）
  const roundBuyFn = opts.roundBuyFn || opts.roundFn || floorN;
  const roundSellFn = opts.roundSellFn || opts.roundFn || floorN;
  const N = rows.length;
  const daily = [];

  let totalGross = 0, totalComm = 0, totalTrades = 0;
  let buyOnlyDays = 0, bothDays = 0, trigDays = 0, skipDays = 0;
  let cumProfit = 0, worstDay = 0, bestDay = 0;
  let bothNet = 0, buyOnlyNet = 0;   // 折算用：双边日净利合计、仅买日净利合计
  const yearlyAgg = {};

  for (let i = 0; i < N; i++) {
    const row = rows[i];
    const open = row.open, high = row.high, low = row.low, close = row.close;
    const prevClose = i > 0 ? rows[i - 1].close : open;
    const gap = i > 0 ? (open / prevClose - 1) * 100 : 0;
    const skip = gap <= -skipDrop * 100;

    let dayGross = 0, dayComm = 0, dayTrades = 0;
    let buyOnly = false, both = false, trig = false;
    let lastBuyP = 0, lastSellP = 0, lastShares = 0;

    if (!skip) {
      for (const tier of tiers) {
        const buyP = roundBuyFn(open * tier.buyK, T0_CONFIG.PRICE_DECIMAL);
        const sellP = roundSellFn(open * tier.sellK, T0_CONFIG.PRICE_DECIMAL);
        let shares = Math.floor(tier.capital / open / 100) * 100;
        if (shares === 0) shares = 100;
        lastBuyP = buyP; lastSellP = sellP; lastShares = shares;
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
    if (both) bothNet += net;
    if (buyOnly) buyOnlyNet += net;

    // 每日明细（与 computeT0Daily 同构，供历史业绩"每日明细"表展示）
    const holdPct = Math.round((close / prevClose - 1) * 10000) / 100;
    const netPct = Math.round(net / T0_CONFIG.CAPITAL * 10000) / 100;
    // 折算后当日超额（期望值口径，逐日累加 = 汇总折算值 38.56%，公式见 T0_DISCOUNT）：
    // 双边成交日 = 63.2%×当日双边净利×0.95滑点 + 36.8%×转换日均亏-847元（36.8%实为先涨后跌只能收盘恢复）
    // 仅买收盘恢复日 = 当日净利（收盘恢复不依赖盘中顺序，为真实值）；未触发/跳过 = 0
    const excessD = both
      ? (T0_DISCOUNT.pReal * net * T0_DISCOUNT.slippage + (1 - T0_DISCOUNT.pReal) * T0_DISCOUNT.convAvg)
      : (buyOnly ? net : 0);
    daily.push({
      date: row.date,
      status: skip ? '跳过' : (both ? '双边成交' : (buyOnly ? '仅买收盘恢复' : '未触发')),
      prev_close: Math.round(prevClose * 1000) / 1000,
      open: Math.round(open * 1000) / 1000,
      buy_p: skip ? roundBuyFn(open * tiers[0].buyK, T0_CONFIG.PRICE_DECIMAL) : lastBuyP,
      sell_p: skip ? roundSellFn(open * tiers[0].sellK, T0_CONFIG.PRICE_DECIMAL) : lastSellP,
      buy_filled: skip ? false : (trig ? low <= lastBuyP : false),
      sell_filled: both,
      close: Math.round(close * 1000) / 1000,
      gross: Math.round(dayGross * 100) / 100,
      commission: Math.round(dayComm * 100) / 100,
      trades: dayTrades,
      net: Math.round(net * 100) / 100,
      hold_pct: holdPct,
      net_pct: netPct,
      excess_pct: Math.round((netPct - holdPct) * 100) / 100,
      excess_d_pct: Math.round(excessD / T0_CONFIG.CAPITAL * 10000) / 100,
      cum_net: Math.round(cumProfit * 100) / 100
    });

    // 年度聚合
    const y = row.date.slice(0, 4);
    if (!yearlyAgg[y]) yearlyAgg[y] = { year: y, net: 0, gross: 0, comm: 0, trades: 0, firstOpen: open, lastClose: close, firstIdx: i, lastIdx: i, bothNet: 0, bothDays: 0, buyOnlyNet: 0 };
    const ya = yearlyAgg[y];
    ya.net += net; ya.gross += dayGross; ya.comm += dayComm; ya.trades += dayTrades;
    if (both) { ya.bothNet += net; ya.bothDays++; }
    if (buyOnly) { ya.buyOnlyNet += net; }
    ya.lastClose = close; ya.lastIdx = i;
  }

  // 持有收益（50万不动）：整体 = 期末收盘 / 期初开盘 - 1
  const holdTotal = T0_CONFIG.CAPITAL * (rows[N - 1].close / rows[0].open - 1);
  const totalNet = cumProfit;
  // 折算后做T差价净利（分钟级验证）
  const netProfitD = calcDiscountedNet(bothDays, bothNet, buyOnlyNet);

  // 逐年持有收益（该年首日开盘 → 该年末日收盘，50万基准）
  const yearly = Object.keys(yearlyAgg).sort().map(key => {
    const ya = yearlyAgg[key];
    const holdRet = ya.firstIdx === ya.lastIdx ? 0 : T0_CONFIG.CAPITAL * (ya.lastClose / ya.firstOpen - 1);
    const netD = calcDiscountedNet(ya.bothDays, ya.bothNet, ya.buyOnlyNet);
    return {
      year: ya.year,
      net: Math.round(ya.net * 100) / 100,
      net_d: Math.round(netD * 100) / 100,   // 折算后做T差价净利
      t0_net_d: Math.round((holdRet + netD) * 100) / 100,  // 折算后做T累计净利（底仓+做T）
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
      // 折算口径（分钟级验证，见 T0_DISCOUNT）：
      // 累计超额 = 做T累计净利 - 持有净利 = 折算后做T差价净利
      net_profit_d: Math.round(netProfitD * 100) / 100,
      excess_d: Math.round(netProfitD * 100) / 100,
      t0_net_d: Math.round((holdTotal + netProfitD) * 100) / 100,
      discount: T0_DISCOUNT,
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
    daily: daily,
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
  const buyP = floorN(openPrice * T0_CONFIG.BUY_K, T0_CONFIG.PRICE_DECIMAL);
  const sellP = floorN(openPrice * T0_CONFIG.SELL_K, T0_CONFIG.PRICE_DECIMAL);
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
// 计算单日做T记录（【每日记录】模块用，成交/盈亏口径与回测完全一致）
// 输入: { date, open, prevClose, high, low, close, recoverPrice }
//   recoverPrice: 当日 14:50 恢复卖出价（收盘后从分时取，仅买未卖出时用；缺失回退 close）
// 状态: 跳过 / 待收盘(北京时间15:30前) / 未触发 / 双边成交 / 仅买14:50卖出
// ============================================================
function computeT0Daily({ date, open, prevClose, high, low, close, recoverPrice }) {
  const base = {
    date,
    prev_close: Math.round(prevClose * 1000) / 1000,
    open: Math.round(open * 1000) / 1000,
    buy_p: floorN(open * T0_CONFIG.BUY_K, T0_CONFIG.PRICE_DECIMAL),
    sell_p: floorN(open * T0_CONFIG.SELL_K, T0_CONFIG.PRICE_DECIMAL),
    close: Math.round(close * 1000) / 1000
  };
  const gapPct = Math.round((open / prevClose - 1) * 10000) / 100;
  base.gap_pct = gapPct;

  // 低开超2%当日跳过（与回测 skipDrop 一致）
  if (open < prevClose * (1 - T0_CONFIG.SKIP_DROP)) {
    const holdPct = Math.round((close / prevClose - 1) * 10000) / 100;
    return { ...base, status: '跳过', reason: `低开${Math.abs(gapPct)}%超2%`, shares: 0, buy_filled: false, sell_filled: false, gross: 0, commission: 0, trades: 0, net: 0,
      hold_pct: holdPct, net_pct: 0, excess_pct: Math.round((0 - holdPct) * 100) / 100, buy_time: null, sell_time: null };
  }

  let shares = Math.floor(T0_CONFIG.CAPITAL / open / 100) * 100;
  if (shares === 0) shares = 100;
  base.shares = shares;
  const buyFilled = low <= base.buy_p;
  const sellFilled = high >= base.sell_p;

  // 北京时间 15:30 前为盘中，当日 K 线未定，标记待收盘
  const beijingNow = new Date(Date.now() + 8 * 3600 * 1000);
  const hm = beijingNow.getUTCHours() * 60 + beijingNow.getUTCMinutes();
  if (hm < 15 * 60 + 30) {
    return { ...base, status: '待收盘', buy_filled: null, sell_filled: null, gross: null, commission: null, trades: null, net: null,
      hold_pct: null, net_pct: null, excess_pct: null, buy_time: null, sell_time: null };
  }

  const holdPct = Math.round((close / prevClose - 1) * 10000) / 100;

  if (!buyFilled) {
    return { ...base, status: '未触发', buy_filled: false, sell_filled: false, gross: 0, commission: 0, trades: 0, net: 0,
      hold_pct: holdPct, net_pct: 0, excess_pct: Math.round((0 - holdPct) * 100) / 100, buy_time: null, sell_time: null };
  }

  let gross, commission, trades = 1;
  commission = base.buy_p * shares * T0_CONFIG.COMMISSION_RATE;
  if (sellFilled) {
    commission += base.sell_p * shares * T0_CONFIG.COMMISSION_RATE;
    trades = 2;
    gross = (base.sell_p - base.buy_p) * shares;
  } else {
    // 仅买未卖出 → 以当日 14:50 价格卖出，缺失时回退收盘价
    const rp = (recoverPrice && recoverPrice > 0) ? recoverPrice : close;
    commission += rp * shares * T0_CONFIG.COMMISSION_RATE;
    trades = 2;
    gross = (rp - base.buy_p) * shares;
  }
  const net = Math.round((gross - commission) * 100) / 100;
  const netPct = Math.round(net / T0_CONFIG.CAPITAL * 10000) / 100;
  return {
    ...base, status: sellFilled ? '双边成交' : '仅买14:50卖出',
    buy_filled: buyFilled, sell_filled: sellFilled,
    gross: Math.round(gross * 100) / 100,
    commission: Math.round(commission * 100) / 100,
    trades,
    net,
    hold_pct: holdPct,
    net_pct: netPct,
    excess_pct: Math.round((netPct - holdPct) * 100) / 100,
    buy_time: null, sell_time: sellFilled ? null : '14:50'
  };
}

// ============================================================
// 分钟级单日做T判定（v2 统一口径：历史回测与每日记录共用，全真实数据无猜测）
// bars: 当日分钟序列（回测数据 {date,open,high,low,close}；腾讯分时 {date,time,price}）
// prevClose: 昨收价（首日可为 null）
// 判定规则（先买后卖，能分辨盘中先后顺序）：
//   buyP = 开盘×BUY_K，sellP = 开盘×SELL_K
//   触发买入 = 某分钟 lowOf(b) <= buyP（分时数据无 low 时用 price）
//   触发卖出 = 买入之后某分钟 highOf(b) >= sellP（无 high 时用 price）
//   买入未卖出 → 以当日 14:50 分钟价卖出（缺失回退收盘价）
// 返回：单日记录（字段与回测 daily 一致，另含 gap_pct/shares/reason）
// ============================================================
function computeMinuteDaily(day, bars, prevClose) {
  const sorted = [...bars].sort((a, b) => a.date - b.date);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const open = first && (first.open != null ? first.open : first.price);
  const close = last && (last.close != null ? last.close : last.price);
  const gap = prevClose ? Math.round((open / prevClose - 1) * 10000) / 100 : 0;
  const buyP = floorN(open * T0_CONFIG.BUY_K, T0_CONFIG.PRICE_DECIMAL);
  const sellP = floorN(open * T0_CONFIG.SELL_K, T0_CONFIG.PRICE_DECIMAL);
  const shares = Math.floor(T0_CONFIG.CAPITAL / open / 100) * 100 || 100;
  const lowOf = b => b.low != null ? b.low : b.price;
  const highOf = b => b.high != null ? b.high : b.price;
  const hhmm = dt => { const s = String(dt); return s.slice(8, 10) + ':' + s.slice(10, 12); };
  // 恢复卖出价 = 当日 14:50 分钟价（仅买未卖出时用；缺失回退收盘价）
  const p1450 = sorted.find(b => String(b.date).slice(8, 12) === '1450' || b.time === '14:50');
  const recoverPrice = p1450 ? (p1450.close != null ? p1450.close : p1450.price) : close;

  const base = {
    date: day,
    prev_close: prevClose != null ? Math.round(prevClose * 1000) / 1000 : null,
    open: Math.round(open * 1000) / 1000,
    buy_p: buyP,
    sell_p: sellP,
    close: Math.round(close * 1000) / 1000,
    gap_pct: gap,
    shares
  };
  const holdPct = prevClose ? Math.round((close / prevClose - 1) * 10000) / 100 : 0;

  // 低开超2%当日跳过（与回测 skipDrop 一致）
  if (gap <= -T0_CONFIG.SKIP_DROP * 100) {
    return { ...base, status: '跳过', reason: `低开${Math.abs(gap)}%超2%`, buy_filled: false, sell_filled: false, gross: 0, commission: 0, trades: 0, net: 0,
      hold_pct: holdPct, net_pct: 0, excess_pct: Math.round((0 - holdPct) * 100) / 100, buy_time: null, sell_time: null };
  }

  // 分钟序列判定：先买后卖（非日线高低点猜测）
  let buyBar = null;
  for (const b of sorted) {
    if (!buyBar && lowOf(b) <= buyP) { buyBar = b; break; }
  }
  if (!buyBar) {
    return { ...base, status: '未触发', buy_filled: false, sell_filled: false, gross: 0, commission: 0, trades: 0, net: 0,
      hold_pct: holdPct, net_pct: 0, excess_pct: Math.round((0 - holdPct) * 100) / 100, buy_time: null, sell_time: null };
  }
  let sellBar = null;
  for (const b of sorted) {
    if (b.date <= buyBar.date) continue;
    // 14:50 了结纪律：卖出触发仅限 14:50 前（含 14:50 那根），
    // 14:57 起进入收盘集合竞价不可撤单，实盘无法操作
    if (String(b.date).slice(8, 12) > '1450') break;
    if (highOf(b) >= sellP) { sellBar = b; break; }
  }

  const buyTime = hhmm(buyBar.date);
  let status, sellFilled, sellTime, gross, commission, trades;
  commission = buyP * shares * T0_CONFIG.COMMISSION_RATE;
  if (sellBar) {
    status = '双边成交'; sellFilled = true; sellTime = hhmm(sellBar.date);
    trades = 2;
    commission += sellP * shares * T0_CONFIG.COMMISSION_RATE;
    gross = (sellP - buyP) * shares;
  } else {
    status = '仅买14:50卖出'; sellFilled = false; sellTime = '14:50';
    trades = 2;
    commission += recoverPrice * shares * T0_CONFIG.COMMISSION_RATE;
    gross = (recoverPrice - buyP) * shares;
  }
  const net = gross - commission;
  const netPct = Math.round(net / T0_CONFIG.CAPITAL * 10000) / 100;
  return {
    ...base, status,
    buy_filled: true, sell_filled: sellFilled,
    buy_time: buyTime, sell_time: sellTime,
    recover_price: Math.round(recoverPrice * 1000) / 1000,   // 当日14:50时点价格（仅买未卖出时的实际恢复卖出价；双边成交日为参考价）
    gross: Math.round(gross * 100) / 100,
    commission: Math.round(commission * 100) / 100,
    trades,
    net: Math.round(net * 100) / 100,
    hold_pct: holdPct,
    net_pct: netPct,
    excess_pct: Math.round((netPct - holdPct) * 100) / 100
  };
}

// ============================================================
// 分钟级真实回测（v2 主口径）
// 只用有分钟数据的日期（2025-01-02 ~ 2026-08-05，385 天），按分钟序列模拟真实成交：
//   - 买入：第一根 low<=买价 的分钟 → 记买入时间（HH:MM）
//   - 卖出：买入后第一根 high>=卖价 的分钟 → 记卖出时间；否则当日 14:50 卖出（卖出时间=14:50）
//   - 不做任何折算估算：分钟数据 = 真实成交结果
// ============================================================
function buildMinuteBacktest() {
  const minFile = T0_CONFIG.MINUTE_JSON;
  if (!fs.existsSync(minFile)) {
    console.log('⚠ 分钟数据不存在: ' + minFile);
    return null;
  }
  const mins = JSON.parse(fs.readFileSync(minFile, 'utf-8'));
  const byDay = {};
  for (const m of mins) {
    const d = String(m.date).slice(0, 8);
    (byDay[d] = byDay[d] || []).push(m);
  }
  const days = Object.keys(byDay).sort();
  if (days.length === 0) return null;

  const CAPITAL = T0_CONFIG.CAPITAL;
  const daily = [];
  const yearlyAgg = {};
  let prevClose = null;
  let totalNet = 0, totalGross = 0, totalComm = 0, totalTrades = 0;
  let bothDays = 0, buyOnlyDays = 0, trigDays = 0, skipDays = 0;
  let bothNet = 0, buyOnlyNet = 0;
  let worstDay = 0, bestDay = 0;

  for (const day of days) {
    const bars = byDay[day].sort((a, b) => a.date - b.date);
    // 统一分钟级单日判定（与每日记录同一口径，见 computeMinuteDaily）
    const rec = computeMinuteDaily(day, bars, prevClose);
    const { status, net, gross, commission, trades } = rec;
    if (status === '跳过') skipDays++;
    else if (status !== '未触发') trigDays++;
    if (status === '双边成交') { bothDays++; bothNet += net; }
    if (status === '仅买14:50卖出') { buyOnlyDays++; buyOnlyNet += net; }
    totalNet += net; totalGross += gross; totalComm += commission; totalTrades += trades;
    if (net < worstDay) worstDay = net;
    if (net > bestDay) bestDay = net;
    daily.push({ ...rec, cum_net: Math.round(totalNet * 100) / 100 });

    // 逐年汇总字段用原始开/收盘（raw），与历史口径一致
    const firstBar = bars[0], lastBar = bars[bars.length - 1];
    const rawOpen = firstBar.open != null ? firstBar.open : firstBar.price;
    const rawClose = lastBar.close != null ? lastBar.close : lastBar.price;
    const y = day.slice(0, 4);
    if (!yearlyAgg[y]) yearlyAgg[y] = { year: y, net: 0, gross: 0, comm: 0, trades: 0, firstOpen: rawOpen, lastClose: rawClose, bothNet: 0, bothDays: 0, buyOnlyNet: 0, buyOnlyDays: 0 };
    const ya = yearlyAgg[y];
    ya.net += net; ya.gross += gross; ya.comm += commission; ya.trades += trades;
    if (status === '双边成交') { ya.bothNet += net; ya.bothDays++; }
    if (status === '仅买14:50卖出') { ya.buyOnlyNet += net; ya.buyOnlyDays++; }
    ya.lastClose = rawClose;
    prevClose = rawClose;
  }

  // 持有收益（窗口内首日开盘 → 末日收盘）
  const firstOpen = byDay[days[0]].sort((a, b) => a.date - b.date)[0].open;
  const lastClose = byDay[days[days.length - 1]].sort((a, b) => a.date - b.date)[byDay[days[days.length - 1]].length - 1].close;
  const holdTotal = CAPITAL * (lastClose / firstOpen - 1);

  const yearly = Object.keys(yearlyAgg).sort().map(key => {
    const ya = yearlyAgg[key];
    const holdRet = CAPITAL * (ya.lastClose / ya.firstOpen - 1);
    return {
      year: ya.year,
      net: Math.round(ya.net * 100) / 100,              // 做T差价净利（真实）
      gross: Math.round(ya.gross * 100) / 100,
      comm: Math.round(ya.comm * 100) / 100,
      trades: ya.trades,
      hold_ret: Math.round(holdRet * 100) / 100,        // 该年持有收益（金额）
      excess: Math.round((ya.net - holdRet) * 100) / 100,
      both_days: ya.bothDays,
      buy_only_days: ya.buyOnlyDays
    };
  });

  return {
    summary: {
      basis: 'minute_real',                              // v2: 分钟级真实成交口径
      trading_days: days.length,
      start_date: days[0],
      end_date: days[days.length - 1],
      skip_days: skipDays,
      total_trades: totalTrades,
      gross_profit: Math.round(totalGross * 100) / 100,
      commission: Math.round(totalComm * 100) / 100,
      net_profit: Math.round(totalNet * 100) / 100,      // 做T差价净利（真实）
      hold_profit: Math.round(holdTotal * 100) / 100,    // 窗口持有净利
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
      buy_k: T0_CONFIG.BUY_K,
      sell_k: T0_CONFIG.SELL_K,
      capital: T0_CONFIG.CAPITAL,
      commission_rate: T0_CONFIG.COMMISSION_RATE,
      skip_drop: T0_CONFIG.SKIP_DROP,
      symbol: T0_CONFIG.SYMBOL,
      name: T0_CONFIG.NAME,
      version: 'v2'
    }
  };
}

// ============================================================
// 预计算回测结果并保存 t0_backtest.json（供前端展示）
// v2：使用分钟级真实回测（仅分钟数据日期）
// ============================================================
function buildBacktestJson() {
  const result = buildMinuteBacktest();
  if (!result) {
    console.log('✗ 分钟级回测失败（分钟数据缺失），回退到日线回测');
    const rows = loadT0History();
    return runT0Backtest(rows);
  }
  const payload = {
    generated_at: new Date().toISOString(),
    ...result
  };
  fs.mkdirSync(path.dirname(T0_CONFIG.BACKTEST_JSON), { recursive: true });
  fs.writeFileSync(T0_CONFIG.BACKTEST_JSON, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`✓ 分钟级回测结果已保存: ${T0_CONFIG.BACKTEST_JSON}`);
  console.log(`  交易日: ${payload.summary.trading_days} (${payload.summary.start_date} ~ ${payload.summary.end_date})`);
  console.log(`  做T净利: ${payload.summary.net_profit} 元, 持有: ${payload.summary.hold_profit} 元, 做T累计: ${payload.summary.hold_profit + payload.summary.net_profit} 元`);
  console.log(`  双边${payload.summary.both_days}天 / 仅买${payload.summary.buy_only_days}天 / 未触发${payload.summary.trading_days - payload.summary.skip_days - payload.summary.trig_days} / 跳过${payload.summary.skip_days}`);
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
  buildMinuteBacktest,
  computeT0Signal,
  computeT0Daily,
  computeMinuteDaily,
  buildBacktestJson,
  loadBacktestJson,
  floorN
};
