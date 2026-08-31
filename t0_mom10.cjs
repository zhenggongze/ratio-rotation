// mom10 动态策略数据生成（2020年以来，做T日半仓做T / 全仓日满仓持有）
// mom10 = 收盘 / 10交易日前收盘 - 1，默认阈值 5%（可用 MOM_THRESHOLD 环境变量覆盖，如 MOM_THRESHOLD=0.04），仅上涨方向触发，T日信号 T+1 生效
// 数据源：聚宽 CSV（2019-12-20~2026-08-07，含 t0_net 做T净利）+ t0_daily.json（8-06起做T净利/日线）
// 输出：mom10_daily.json（日线+动量+模式）、mom10_signal.json（最新信号）、mom10_backtest.json（三策略回测）；非默认阈值输出带后缀文件（如 mom10_backtest_004.json）
const fs = require('fs');
const path = require('path');

const MOM_THRESHOLD = process.env.MOM_THRESHOLD ? parseFloat(process.env.MOM_THRESHOLD) : 0.05;   // mom10 > 阈值 触发（默认5%）
const PERIOD = 10;            // 10 日动量
const CAP = 500000;           // 做T现金（半仓做T时做T部分）
const TOTAL_CAP = 1000000;    // 总资金 100 万（底仓50万 + 做T现金50万）
const START = '20200101';     // 回测起点（2020 年以来）
const SUFFIX = (MOM_THRESHOLD === 0.05) ? '' : '_' + String(MOM_THRESHOLD).replace('.', '');   // 非默认阈值输出文件后缀

const CSV_FILE = path.join(__dirname, 'data', 't0', 'analysis_daily_full.csv');
const T0_DAILY = path.join(__dirname, 'data', 't0', 't0_daily.json');
const MOM_JSON = path.join(__dirname, 'data', 't0', 'mom10_daily' + SUFFIX + '.json');
const SIG_JSON = path.join(__dirname, 'data', 't0', 'mom10_signal' + SUFFIX + '.json');
const BT_JSON = path.join(__dirname, 'data', 't0', 'mom10_backtest' + SUFFIX + '.json');

// ===== 1. 读聚宽 CSV（2019-12-20 ~ 2026-08-07）=====
function loadCsv() {
  const lines = fs.readFileSync(CSV_FILE, 'utf-8').split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 24 || !c[7]) continue;
    rows.push({
      date: c[7].replace(/-/g, ''), open: +c[18], close: +c[6],
      prev_close: +c[19] || null, ret: +c[20] || 0,
      t0_net: +c[22] || 0, t0_status: (c[23] || '').trim()
    });
  }
  return rows;
}

// ===== 2. 读 t0_daily.json（8-06 起：做T净利 + 日线，含恢复/修正值）=====
function loadT0Daily() {
  try {
    const d = JSON.parse(fs.readFileSync(T0_DAILY, 'utf-8'));
    return (d.records || []).map(r => ({
      date: r.date.replace(/-/g, ''),
      open: r.open, close: r.close, prev_close: r.prev_close,
      ret: r.prev_close ? r.close / r.prev_close - 1 : 0,
      t0_net: typeof r.net === 'number' ? r.net : 0,
      t0_status: r.status || ''
    }));
  } catch (e) { return []; }
}

// ===== 3. 合并日线序列（CSV + t0_daily 增量，按日期去重）=====
function buildSeries() {
  const map = {};
  for (const r of loadCsv()) map[r.date] = r;
  for (const r of loadT0Daily()) {
    if (map[r.date]) {
      map[r.date].t0_net = r.t0_net;       // 增量/修正值优先（如 8-26）
      map[r.date].t0_status = r.t0_status;
    } else {
      map[r.date] = r;
    }
  }
  return Object.keys(map).sort().map(k => map[k]);
}

// ===== 4. 计算 mom10 与模式（T日信号 → T+1 执行）=====
function calcMom(series) {
  for (let i = 0; i < series.length; i++) {
    const r = series[i];
    if (i >= PERIOD) {
      r.mom10 = r.close / series[i - PERIOD].close - 1;
    } else {
      r.mom10 = null; // 不足 10 日，无动量
    }
    // 模式：T 日模式由 T-1 日信号决定（默认做T）；5% 策略口径下不沿用旧阈值时代实盘全仓标记
    const prev = i >= 1 ? series[i - 1] : null;
    r.mode = (prev && prev.mom10 !== null && prev.mom10 > MOM_THRESHOLD) ? '全仓' : '做T';
  }
  return series;
}

// 状态归一：聚宽 CSV 用 双边/仅买/未触发，生产 t0_daily 用 双边成交/仅买14:50卖出/未触发买入
// 5% 策略口径：旧阈值时代实盘全仓日（t0_daily status=全仓）若未达 5% 阈值 → 归为做T未触发，保证回测与策略一致
function normStatus(st) {
  const s = (st || '').trim();
  if (s === '双边') return '双边成交';
  if (s === '仅买') return '仅买14:50卖出';
  if (s === '未触发') return '未触发买入';
  if (s === '全仓') return '未触发买入';
  return s || '做T'; // 兜底（无状态的历史日）
}

// ===== 5. 三大策略回测（2020 起）=====
function runBacktest(series) {
  const daily = [];
  const yearly = {};
  let cumMom = 0, cumT0 = 0, cumHold = 0;
  let fullDays = 0, t0Days = 0, bothDays = 0, buyOnlyDays = 0, untrigDays = 0, otherT0Days = 0;
  let prevCloseForCum = null;
  for (const r of series) {
    if (r.date < START) continue;
    const ret = r.ret || 0;
    const isFull = r.mode === '全仓';
    const momNet = isFull ? TOTAL_CAP * ret : CAP * ret + r.t0_net;   // mom10 动态
    const t0Net = CAP * ret + r.t0_net;                                // 纯做T
    const holdNet = TOTAL_CAP * ret;                                   // 纯满仓
    cumMom += momNet; cumT0 += t0Net; cumHold += holdNet;
    if (isFull) fullDays++;
    else {
      t0Days++;
      const st = normStatus(r.t0_status);
      if (st === '双边成交') bothDays++;
      else if (st === '仅买14:50卖出') buyOnlyDays++;
      else if (st === '未触发买入') untrigDays++;
      else otherT0Days++;
    }

    const holdPct = Math.round(ret * 10000) / 100;                     // 收益率%（全仓日=100万直接；做T日=底仓50万）
    const netPct = isFull ? 0 : Math.round((r.t0_net / CAP) * 10000) / 100;
    daily.push({
      date: r.date,
      status: isFull ? '全仓' : normStatus(r.t0_status),
      mom10: r.mom10 != null ? Math.round(r.mom10 * 10000) / 10000 : null,   // 该日10日动量（全仓行前端展示用）
      ret: r.ret != null ? Math.round(r.ret * 10000) / 10000 : null,         // 当日复权收益率（官方回测口径，含分红）
      prev_close: r.prev_close != null ? Math.round(r.prev_close * 1000) / 1000 : null,
      open: r.open != null ? Math.round(r.open * 1000) / 1000 : null,
      close: r.close != null ? Math.round(r.close * 1000) / 1000 : null,
      buy_p: null, sell_p: null, shares: null,
      buy_filled: null, sell_filled: null, buy_time: null, sell_time: null, recover_price: null,
      gross: 0, commission: 0, trades: 0,
      t0_net: Math.round(r.t0_net * 100) / 100,                        // 当日做T净利（原始，不论模式，重建纯做T用）
      net: isFull ? 0 : Math.round(r.t0_net * 100) / 100,              // 做T净利（金额；mom10全仓日=0）
      hold_pct: holdPct,
      net_pct: netPct,
      excess_pct: isFull ? 0 : Math.round(netPct * 100) / 100,
      cum_net: Math.round(cumMom * 100) / 100
    });

    const y = r.date.slice(0, 4);
    if (!yearly[y]) yearly[y] = { mom: 0, t0: 0, hold: 0, full: 0, t0d: 0 };
    yearly[y].mom += momNet; yearly[y].t0 += t0Net; yearly[y].hold += holdNet;
    if (isFull) yearly[y].full++; else yearly[y].t0d++;
  }
  const yearlyArr = Object.keys(yearly).sort().map(y => ({
    year: y,
    full_days: yearly[y].full, t0_days: yearly[y].t0d,
    pure_t0_net: Math.round(yearly[y].t0 * 100) / 100,
    pure_hold_net: Math.round(yearly[y].hold * 100) / 100,
    mom_net: Math.round(yearly[y].mom * 100) / 100
  }));
  return { daily, yearly: yearlyArr, cumMom, cumT0, cumHold, fullDays, t0Days, bothDays, buyOnlyDays, untrigDays, otherT0Days, start: START, end: series[series.length - 1].date };
}

// 全仓连续段统计（辅助判断"是不是快调整了"）
function fullSegStats(daily) {
  let count = 0, total = 0, max = 0, cur = 0;
  for (let i = 0; i < daily.length; i++) {
    if (daily[i].status === '全仓') { cur++; }
    else if (cur > 0) { count++; total += cur; max = Math.max(max, cur); cur = 0; }
  }
  if (cur > 0) { count++; total += cur; max = Math.max(max, cur); }
  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].status === '全仓') streak++; else break;
  }
  return { seg_count: count, avg_days: count ? Math.round(total / count * 10) / 10 : 0, max_days: max, streak_now: streak };
}

function main() {
  console.log('='.repeat(56));
  console.log(`  mom10 动态策略数据生成（阈值 ${(MOM_THRESHOLD * 100).toFixed(0)}%，T+1 生效）`);
  console.log('='.repeat(56));
  const series = calcMom(buildSeries());
  const valid = series.filter(r => r.date >= START);
  const bt = runBacktest(series);

  // mom10_daily.json
  const momDaily = {
    updated_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '),
    threshold: MOM_THRESHOLD,
    period: PERIOD,
    count: valid.length,
    records: valid.map(r => ({
      date: r.date, open: r.open, close: r.close, prev_close: r.prev_close,
      ret: r.ret, mom10: r.mom10 !== null ? Math.round(r.mom10 * 10000) / 10000 : null,
      mode: r.mode, t0_net: r.t0_net
    }))
  };
  fs.writeFileSync(MOM_JSON, JSON.stringify(momDaily, null, 2), 'utf-8');

  // mom10_signal.json（最新：最新收盘 mom10 → 下一交易日模式 T+1 生效 + 详细决策指标）
  const last = valid[valid.length - 1];
  const lastMom = last ? last.mom10 : null;
  // 注意：mode 必须由「最新收盘 mom10」与阈值比较得出（T+1 生效），不能取 last.mode
  // （last.mode 是昨日信号决定的当日实盘模式，含实盘全仓强制，不代表下一交易日）
  const todayMode = (lastMom !== null && lastMom > MOM_THRESHOLD) ? '全仓' : '做T';
  const sig = {
    date: last ? last.date : null,
    generated_at: new Date().toISOString(),
    signal: {
      mom10: lastMom !== null ? Math.round(lastMom * 10000) / 10000 : null,
      mom10_pct: lastMom !== null ? +(lastMom * 100).toFixed(2) : null,
      trigger: lastMom !== null && lastMom > MOM_THRESHOLD,
      mode: todayMode,
      note: todayMode === '全仓' ? `昨日 mom10 超${(MOM_THRESHOLD * 100).toFixed(0)}%，今日满仓持有，不做T` : `昨日 mom10 未超${(MOM_THRESHOLD * 100).toFixed(0)}%，今日半仓做T`
    }
  };
  // 详细指标：证据链（10日前收盘→最新收盘）、距阈值、安全边际、动量趋势、全仓段（辅助选择 + 调整预警）
  const lastIdx = series.length - 1;                     // 最新收盘日在全序列索引
  const tenAgo = series[lastIdx - PERIOD];               // mom10(last) 的分母（10 交易日前收盘）
  const nextBase = series[lastIdx + 1 - PERIOD];         // 下一交易日 mom10 的分母（窗口滑动 1 格）
  const nextFloor = nextBase ? +(nextBase.close * (1 + MOM_THRESHOLD)).toFixed(3) : null;
  const dropPct = (last && nextFloor) ? +(((last.close - nextFloor) / last.close) * 100).toFixed(2) : null;
  const trend = valid.filter(r => r.mom10 !== null).slice(-10).map(r => ({ date: r.date, mom10_pct: +(r.mom10 * 100).toFixed(2) }));
  sig.detail = {
    signal_date: last ? last.date : null,
    close_now: last ? last.close : null,
    close_10ago: tenAgo ? tenAgo.close : null,
    mom10_pct: sig.signal.mom10_pct,
    threshold_pct: +(MOM_THRESHOLD * 100).toFixed(0),
    gap_pct: sig.signal.mom10_pct != null ? +(sig.signal.mom10_pct - MOM_THRESHOLD * 100).toFixed(2) : null,
    next_mode: todayMode,
    next_floor_price: nextFloor,
    drop_to_switch_pct: dropPct,
    trend: trend
  };
  fs.writeFileSync(SIG_JSON, JSON.stringify(sig, null, 2), 'utf-8');

  // mom10_backtest.json（兼容现有回测结构）
  const segs = fullSegStats(bt.daily);
  const btNetProfit = Math.round(bt.daily.reduce((s, d) => s + (d.status !== '全仓' ? d.net : 0), 0) * 100) / 100; // 做T差价净利（三态之和）
  const btPayload = {
    generated_at: new Date().toISOString(),
    summary: {
      basis: 'mom10_dynamic',
      threshold: MOM_THRESHOLD,
      period: PERIOD,
      trading_days: bt.daily.length,
      start_date: bt.start, end_date: bt.end,
      full_days: bt.fullDays, t0_days: bt.t0Days,
      pure_t0_net: Math.round(bt.cumT0 * 100) / 100,
      pure_hold_net: Math.round(bt.cumHold * 100) / 100,
      mom_net: Math.round(bt.cumMom * 100) / 100,
      hold_profit: Math.round((bt.cumMom - btNetProfit) * 100) / 100,
      net_profit: btNetProfit,
      both_days: bt.bothDays, buy_only_days: bt.buyOnlyDays, untrig_days: bt.untrigDays,
      skip_days: 0, trig_days: bt.t0Days,
      full_seg_count: segs.seg_count, full_seg_avg_days: segs.avg_days, full_seg_max_days: segs.max_days, full_streak_now: segs.streak_now
    },
    yearly: bt.yearly,
    param: {
      buy_k: 0.997, sell_k: 1.008, capital: CAP, commission_rate: 0.00005, skip_drop: 0.02,
      symbol: 'sh515180', name: '红利ETF', version: 'mom10-v1',
      mom_threshold: MOM_THRESHOLD, mom_period: PERIOD
    },
    daily: bt.daily
  };
  fs.writeFileSync(BT_JSON, JSON.stringify(btPayload, null, 2), 'utf-8');

  // 打印摘要
  const fmt = v => (v / 10000).toFixed(2) + '万';
  console.log(`区间: ${bt.start} ~ ${bt.end}（${bt.daily.length} 交易日）`);
  console.log(`全仓日: ${bt.fullDays} 天 | 做T日: ${bt.t0Days} 天（双边成交 ${bt.bothDays} / 仅买14:50卖出 ${bt.buyOnlyDays} / 未触发买入 ${bt.untrigDays} / 其他 ${bt.otherT0Days}）`);
  console.log(`纯做T净利 : ${fmt(bt.cumT0)}`);
  console.log(`纯满仓净利: ${fmt(bt.cumHold)}`);
  console.log(`mom10动态 : ${fmt(bt.cumMom)}  (相对纯做T ${bt.cumMom >= bt.cumT0 ? '+' : ''}${fmt(bt.cumMom - bt.cumT0)}, 相对纯满仓 ${bt.cumMom >= bt.cumHold ? '+' : ''}${fmt(bt.cumMom - bt.cumHold)})`);
  console.log(`最新信号(${last ? last.date : '-'}): mom10=${lastMom !== null ? (lastMom * 100).toFixed(2) + '%' : '无'}, 今日模式=${todayMode}`);
  console.log('\n年度对比:');
  for (const y of bt.yearly) console.log(`  ${y.year}: 纯做T ${(y.pure_t0_net / 10000).toFixed(1)}万 | 纯满仓 ${(y.pure_hold_net / 10000).toFixed(1)}万 | mom10 ${(y.mom_net / 10000).toFixed(1)}万 | 全仓${y.full_days}天`);
  console.log('\n✅ 已输出: mom10_daily.json / mom10_signal.json / mom10_backtest.json');
}

main();
