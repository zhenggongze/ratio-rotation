// 同期对比：生产策略(创业板/红利) vs 科创50新策略
const { loadHistory, alignIndices } = require('./data_loader.cjs');
const { backtest, DEFAULT_BUY_LEVELS, DEFAULT_SELL_LEVELS } = require('./backtest.cjs');

const START = '2014-07-01';
const END = '2026-12-31';

function pct(n) { return (n * 100).toFixed(2) + '%'; }

async function main() {
  const [cybData, hliData, kcbData] = await Promise.all([
    loadHistory('sz399006', START, END, '创业板'),
    loadHistory('sh000922', START, END, '中证红利'),
    loadHistory('sh000688', START, END, '科创50')
  ]);

  const cybHli = alignIndices(cybData, hliData, '创业板', '红利');
  const kcbStartIdx = kcbData.findIndex(d => d.date >= '2020-08-01');
  const kcbHli = alignIndices(kcbData.slice(kcbStartIdx), hliData, '科创50', '红利');

  // 生产策略参数（创业板）
  const cybOpts = {
    execDelay: 1, tradeCostRate: 0.0005,
    buyLevels: DEFAULT_BUY_LEVELS, sellLevels: DEFAULT_SELL_LEVELS,
    buyZoneTop: 0.332, sellZoneBottom: 0.578
  };

  // 科创50新参数
  const KCB_BUY = [0.1460,0.1455,0.1450,0.1445,0.1440,0.1435,0.1430,0.1424,0.1419,0.1414,0.1409,0.1404,0.1399,0.1394,0.1389,0.1384,0.1379,0.1374,0.1369,0.1364];
  const KCB_SELL = [0.3060,0.3097,0.3133,0.3170,0.3207,0.3244,0.3280,0.3317,0.3354,0.3390,0.3427,0.3464,0.3501,0.3537,0.3574,0.3611,0.3648,0.3684,0.3721,0.3758];
  const kcbOpts = {
    execDelay: 1, tradeCostRate: 0.0005,
    buyLevels: KCB_BUY, sellLevels: KCB_SELL,
    buyZoneTop: 0.146, sellZoneBottom: 0.306
  };

  // 同期（2020-08 ~ 2026-07）
  const sameStart = cybHli.findIndex(d => d.date >= '2020-08-01');

  const cybResult = backtest(cybHli, { ...cybOpts, startIdx: sameStart });
  const kcbResult = backtest(kcbHli, kcbOpts);

  console.log(`同期: ${kcbHli[0].date} ~ ${kcbHli[kcbHli.length-1].date} (${(kcbHli.length/244).toFixed(2)}年)\n`);

  console.log('=== 策略对比 ===');
  console.log(`| 指标 | 生产策略(创业板) | 科创50新策略 | 差异 |`);
  console.log(`|---|---|---|---|`);
  console.log(`| 累计收益 | ${pct(cybResult.totalReturn)} | ${pct(kcbResult.totalReturn)} | ${pct(kcbResult.totalReturn - cybResult.totalReturn)} |`);
  console.log(`| 年化 | ${pct(cybResult.annualReturn)} | ${pct(kcbResult.annualReturn)} | ${pct(kcbResult.annualReturn - cybResult.annualReturn)} |`);
  console.log(`| 最大回撤 | ${pct(cybResult.maxDrawdown)} | ${pct(kcbResult.maxDrawdown)} | ${pct(kcbResult.maxDrawdown - cybResult.maxDrawdown)} |`);
  console.log(`| 调仓次数 | ${cybResult.tradeCount} | ${kcbResult.tradeCount} | |`);

  console.log('\n=== 基准指数同期 ===');
  console.log(`| 指数 | 收益 |`);
  console.log(`|---|---|`);
  console.log(`| 创业板指 | ${pct(cybResult.idx1Return)} |`);
  console.log(`| 科创50 | ${pct(kcbResult.idx1Return)} |`);
  console.log(`| 中证红利 | ${pct(kcbResult.idx2Return)} |`);

  console.log('\n=== 超额对比 ===');
  console.log(`生产策略(创业板) 超额vs红利: ${pct(cybResult.excessVsIdx2)}`);
  console.log(`科创50新策略 超额vs红利: ${pct(kcbResult.excessVsIdx2)}`);
  console.log(`生产策略(创业板) 超额vs创业板: ${pct(cybResult.excessVsIdx1)}`);
  console.log(`科创50新策略 超额vs科创50: ${pct(kcbResult.excessVsIdx1)}`);

  console.log('\n=== 年度对比 ===');
  const kcbYears = Object.keys(kcbResult.yearlyReturns).sort();
  const cybYears = Object.keys(cybResult.yearlyReturns).sort();
  console.log(`| 年份 | 生产策略(创业板) | 科创50新策略 | 差异 |`);
  console.log(`|---|---|---|---|`);
  for (const y of kcbYears) {
    const k = kcbResult.yearlyReturns[y] || 0;
    const c = cybResult.yearlyReturns[y] || 0;
    console.log(`| ${y} | ${pct(c)} | ${pct(k)} | ${pct(k - c)} |`);
  }
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
