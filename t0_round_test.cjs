// 评估不同挂单价格舍入策略对做T回测结果的影响
// 背景：ETF 挂单只能按 0.001（三位小数），信号价计算后必须舍入
// 对比：银行家舍入(现状) / 向下 / 向上 / 买上卖下 / 买下卖上 / 普通四舍五入
const { loadT0History, runT0Backtest } = require('./t0_engine.cjs');

const rows = loadT0History();
const P = 3; // 精度

function roundN(v, n) { const f = 10 ** n; return Math.round(v * f) / f; } // 普通四舍五入
function floorN(v, n) { const f = 10 ** n; return Math.floor(v * f) / f; } // 向下
function ceilN(v, n)  { const f = 10 ** n; return Math.ceil(v * f) / f; }  // 向上

const strategies = [
  { name: '银行家舍入(现状)',      opts: {} },
  { name: '双向下取整 floor',     opts: { roundBuyFn: floorN, roundSellFn: floorN } },
  { name: '双向上取整 ceil',      opts: { roundBuyFn: ceilN,  roundSellFn: ceilN  } },
  { name: '买向上卖向下(激进)',   opts: { roundBuyFn: ceilN,  roundSellFn: floorN } },
  { name: '买向下卖向上(保守)',   opts: { roundBuyFn: floorN, roundSellFn: ceilN  } },
  { name: '普通四舍五入 round',   opts: { roundBuyFn: roundN, roundSellFn: roundN } },
];

console.log('数据区间:', rows[0].date, '~', rows[rows.length - 1].date, '共', rows.length, '天');
console.log('='.repeat(150));
console.log('策略'.padEnd(22), '净盈利'.padStart(10), '超额'.padStart(10), '笔数'.padStart(8),
  '触发天'.padStart(7), 'both天'.padStart(7), 'buyOnly天'.padStart(9), '触发率%'.padStart(8), '最差日'.padStart(10));
console.log('-'.repeat(150));

const results = [];
for (const s of strategies) {
  const r = runT0Backtest(rows, s.opts);
  const sm = r.summary;
  results.push({ name: s.name, sm });
  console.log(s.name.padEnd(22), String(sm.net_profit).padStart(10), String(sm.excess_profit).padStart(10),
    String(sm.total_trades).padStart(8), String(sm.trig_days).padStart(7), String(sm.both_days).padStart(7),
    String(sm.buy_only_days).padStart(9), String(sm.trigger_rate).padStart(8), String(sm.worst_day).padStart(10));
}

// 相对现状的差异
const base = results[0].sm;
console.log('\n相对「银行家舍入(现状)」的差异:');
console.log('策略'.padEnd(22), 'Δ净盈利'.padStart(10), 'Δ超额'.padStart(10), 'Δ笔数'.padStart(8), 'Δ触发天'.padStart(8));
for (const r of results.slice(1)) {
  const dNet = r.sm.net_profit - base.net_profit;
  const dExc = r.sm.excess_profit - base.excess_profit;
  console.log(r.name.padEnd(22), String((dNet >= 0 ? '+' : '') + dNet).padStart(10),
    String((dExc >= 0 ? '+' : '') + dExc).padStart(10),
    String((r.sm.total_trades - base.total_trades >= 0 ? '+' : '') + (r.sm.total_trades - base.total_trades)).padStart(8),
    String((r.sm.trig_days - base.trig_days >= 0 ? '+' : '') + (r.sm.trig_days - base.trig_days)).padStart(8));
}

// 年度稳健性：现状 vs 双向下取整
console.log('\n年度净利对比: 银行家舍入(现状) vs 双向下取整(floor)');
const rCur = runT0Backtest(rows, {});
const rFlo = runT0Backtest(rows, { roundBuyFn: floorN, roundSellFn: floorN });
const mapCur = {}, mapFlo = {};
for (const y of rCur.yearly) mapCur[y.year] = y.net;
for (const y of rFlo.yearly) mapFlo[y.year] = y.net;
console.log('年份'.padEnd(8), '现状净利'.padStart(12), 'floor净利'.padStart(12), 'Δ'.padStart(10), 'floor占优?');
let win = 0, lose = 0;
for (const y of Object.keys(mapCur).sort()) {
  const d = mapFlo[y] - mapCur[y];
  if (d > 0) win++; else if (d < 0) lose++;
  console.log(y.padEnd(8), String(Math.round(mapCur[y])).padStart(12), String(Math.round(mapFlo[y])).padStart(12),
    String((d >= 0 ? '+' : '') + Math.round(d)).padStart(10), (d >= 0 ? '✓' : '✗').padStart(4));
}
console.log(`floor 占优年份: ${win} / ${win + lose}`);
