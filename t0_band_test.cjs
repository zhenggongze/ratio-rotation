// 评估：在"双向下取整"舍入下，做T带宽阈值（±x%）是否仍以 0.4% 最优
// 同时输出银行家舍入(现状) 下的同带宽扫描作对照
const { loadT0History, runT0Backtest } = require('./t0_engine.cjs');

const rows = loadT0History();
function floorN(v, n) { const f = 10 ** n; return Math.floor(v * f) / f; }

// 带宽扫描：0.2% ~ 1.5%
const bands = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 1.0, 1.2, 1.5];

function scan(label, mkOpts) {
  console.log(`\n===== ${label} =====`);
  console.log('带宽%'.padEnd(6), '净盈利'.padStart(11), '超额'.padStart(11), '触发天'.padStart(7),
    'both天'.padStart(7), 'buyOnly'.padStart(8), '笔数'.padStart(7), '最差日'.padStart(10), '单笔收益'.padStart(9));
  let best = null;
  for (const b of bands) {
    const opts = mkOpts(b);
    const r = runT0Backtest(rows, opts);
    const sm = r.summary;
    const perTrade = sm.total_trades ? sm.net_profit / sm.total_trades : 0;
    if (!best || sm.net_profit > best.net) best = { band: b, net: sm.net_profit, excess: sm.excess_profit };
    console.log(String(b).padEnd(6), String(sm.net_profit).padStart(11), String(sm.excess_profit).padStart(11),
      String(sm.trig_days).padStart(7), String(sm.both_days).padStart(7), String(sm.buy_only_days).padStart(8),
      String(sm.total_trades).padStart(7), String(sm.worst_day).padStart(10), String(Math.round(perTrade)).padStart(9));
  }
  console.log(`→ 净盈利最优带宽: ${best.band}% (净利 ${best.net}, 超额 ${best.excess})`);
  return best;
}

scan('双向下取整 floor', b => ({
  roundBuyFn: floorN, roundSellFn: floorN,
  tiers: [{ buyK: 1 - b / 100, sellK: 1 + b / 100, capital: 500000 }]
}));

scan('银行家舍入(现状) 对照', b => ({
  tiers: [{ buyK: 1 - b / 100, sellK: 1 + b / 100, capital: 500000 }]
}));
