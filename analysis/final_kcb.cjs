// 科创50策略最终参数生成 — 完整回测 + 邻域 + 年度 + 报告
const fs = require('fs');
const path = require('path');
const { loadHistory, alignIndices } = require('./data_loader.cjs');
const { backtest } = require('./backtest.cjs');

const START = '2014-07-01';
const END = '2026-12-31';

function pct(n) { return (n * 100).toFixed(2) + '%'; }

const BUY_RATIO = 0.934;
const SELL_RATIO = 1.228;

function genBuyLevels(top) {
  const bottom = top * BUY_RATIO;
  const levels = [];
  for (let i = 0; i < 20; i++) levels.push(top - (top - bottom) * i / 19);
  return levels;
}
function genSellLevels(bottom) {
  const top = bottom * SELL_RATIO;
  const levels = [];
  for (let i = 0; i < 20; i++) levels.push(bottom + (top - bottom) * i / 19);
  return levels;
}

async function main() {
  const [kcbData, hliData, cybData] = await Promise.all([
    loadHistory('sh000688', START, END, '科创50'),
    loadHistory('sh000922', START, END, '中证红利'),
    loadHistory('sz399006', START, END, '创业板')
  ]);
  const kcbStartIdx = kcbData.findIndex(d => d.date >= '2020-08-01');
  const kcbHli = alignIndices(kcbData.slice(kcbStartIdx), hliData, '科创50', '红利');

  // ============================================================
  // 最终推荐参数（基于训练期最优0.146 + 全期邻域稳健）
  // ============================================================
  const REC = { bt: 0.146, sb: 0.306 };

  const buyLevels = genBuyLevels(REC.bt);
  const sellLevels = genSellLevels(REC.sb);
  const opts = {
    execDelay: 1, tradeCostRate: 0.0005,
    buyLevels, sellLevels,
    buyZoneTop: REC.bt, sellZoneBottom: REC.sb
  };

  console.log('========================================');
  console.log('  科创50/红利 比值轮动策略（新参数）');
  console.log('========================================\n');

  console.log(`买入区顶端: ${REC.bt}`);
  console.log(`买入区底端: ${buyLevels[19].toFixed(4)}`);
  console.log(`卖出区底端: ${REC.sb}`);
  console.log(`卖出区顶端: ${sellLevels[19].toFixed(4)}\n`);

  console.log('买入档位表（20档）:');
  console.log(JSON.stringify(buyLevels.map(v => +v.toFixed(4))));
  console.log('\n卖出档位表（20档）:');
  console.log(JSON.stringify(sellLevels.map(v => +v.toFixed(4))));

  // 完整回测
  const r = backtest(kcbHli, opts);
  console.log('\n=== 全期回测（2020-08 ~ 2026-07，6年） ===');
  console.log(`累计收益: ${pct(r.totalReturn)}`);
  console.log(`年化收益: ${pct(r.annualReturn)}`);
  console.log(`最大回撤: ${pct(r.maxDrawdown)}`);
  console.log(`调仓次数: ${r.tradeCount}`);
  console.log(`超额vs科创50: ${pct(r.excessVsIdx1)}`);
  console.log(`超额vs红利: ${pct(r.excessVsIdx2)}`);
  console.log(`科创50指数: ${pct(r.idx1Return)}`);
  console.log(`红利指数: ${pct(r.idx2Return)}`);

  console.log('\n=== 年度收益 ===');
  const years = Object.keys(r.yearlyReturns).sort();
  for (const y of years) {
    console.log(`  ${y}: ${pct(r.yearlyReturns[y])}`);
  }

  // 调仓记录
  console.log('\n=== 调仓记录 ===');
  for (const t of r.tradeLog) {
    console.log(`  ${t.signalDate} (${t.execDate}) ${t.action} ${(t.oldWeight*100).toFixed(0)}%→${(t.newWeight*100).toFixed(0)}%`);
  }

  // 邻域稳健性
  console.log('\n=== 邻域稳健性（±10%） ===');
  const btRange = [REC.bt * 0.9, REC.bt * 0.95, REC.bt, REC.bt * 1.05, REC.bt * 1.10];
  const sbRange = [REC.sb * 0.9, REC.sb * 0.95, REC.sb, REC.sb * 1.05, REC.sb * 1.10];
  const nb = [];
  for (const bt of btRange) {
    for (const sb of sbRange) {
      const rr = backtest(kcbHli, {
        execDelay: 1, tradeCostRate: 0.0005,
        buyLevels: genBuyLevels(bt), sellLevels: genSellLevels(sb),
        buyZoneTop: bt, sellZoneBottom: sb
      });
      nb.push(rr.totalReturn);
    }
  }
  const mean = nb.reduce((a, b) => a + b, 0) / nb.length;
  const std = Math.sqrt(nb.reduce((a, b) => a + (b - mean) ** 2, 0) / nb.length);
  const cv = std / Math.abs(mean);
  console.log(`25组: 均值=${pct(mean)}, 标准差=${pct(std)}, CV=${cv.toFixed(3)}`);
  console.log(`最低=${pct(Math.min(...nb))}, 最高=${pct(Math.max(...nb))}`);

  // 写入最终参数文件
  const paramFile = path.join(__dirname, 'kcb_final_params.json');
  fs.writeFileSync(paramFile, JSON.stringify({
    name: '科创50/红利比值轮动',
    period: `${kcbHli[0].date} ~ ${kcbHli[kcbHli.length-1].date}`,
    buyZoneTop: REC.bt,
    sellZoneBottom: REC.sb,
    buyLevels: buyLevels.map(v => +v.toFixed(4)),
    sellLevels: sellLevels.map(v => +v.toFixed(4)),
    backtest: {
      totalReturn: +r.totalReturn.toFixed(4),
      annualReturn: +r.annualReturn.toFixed(4),
      maxDrawdown: +r.maxDrawdown.toFixed(4),
      tradeCount: r.tradeCount,
      excessVsKcb: +r.excessVsIdx1.toFixed(4),
      excessVsHli: +r.excessVsIdx2.toFixed(4)
    },
    neighborhood: {
      cv: +cv.toFixed(3),
      mean: +mean.toFixed(4),
      min: +Math.min(...nb).toFixed(4),
      max: +Math.max(...nb).toFixed(4)
    }
  }, null, 2), 'utf-8');
  console.log('\n参数已保存: ' + paramFile);
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
