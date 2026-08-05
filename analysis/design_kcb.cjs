// 科创50/红利 新档位表设计 — 分位扫描 + 邻域验证
const fs = require('fs');
const path = require('path');
const { loadHistory, alignIndices } = require('./data_loader.cjs');
const { backtest, determineSignal } = require('./backtest.cjs');

const START = '2014-07-01';
const END = '2026-12-31';

function pct(n) { return (n * 100).toFixed(2) + '%'; }

// 生成档位表：按给定比例跨度（对齐创业板设计的非对称特征）
// 创业板：买入底端/顶端 = 0.310/0.332 = 0.934（密集）
//         卖出顶端/底端 = 0.710/0.578 = 1.228（稀疏）
const BUY_RATIO = 0.934;   // 底端 = 顶端 × 0.934
const SELL_RATIO = 1.228;  // 顶端 = 底端 × 1.228

function genBuyLevels(top) {
  const bottom = top * BUY_RATIO;
  const levels = [];
  for (let i = 0; i < 20; i++) {
    levels.push(top - (top - bottom) * i / 19);
  }
  return levels;
}

function genSellLevels(bottom) {
  const top = bottom * SELL_RATIO;
  const levels = [];
  for (let i = 0; i < 20; i++) {
    levels.push(bottom + (top - bottom) * i / 19);
  }
  return levels;
}

async function main() {
  const [kcbData, hliData] = await Promise.all([
    loadHistory('sh000688', START, END, '科创50'),
    loadHistory('sh000922', START, END, '中证红利')
  ]);

  const kcbStartIdx = kcbData.findIndex(d => d.date >= '2020-08-01');
  const kcbEffective = kcbStartIdx >= 0 ? kcbData.slice(kcbStartIdx) : [];
  const kcbHli = alignIndices(kcbEffective, hliData, '科创50', '红利');
  console.log(`科创50+红利: ${kcbHli.length} 交易日 (${kcbHli[0].date} ~ ${kcbHli[kcbHli.length-1].date})`);

  // ============================================================
  // 第一步：粗扫描（买入顶端 × 卖出底端，基于分位数）
  // ============================================================
  console.log('\n=== 粗扫描：买入顶端 × 卖出底端 ===');
  const buyCandidates = [0.146, 0.155, 0.171, 0.179, 0.187]; // p10-p30
  const sellCandidates = [0.264, 0.279, 0.292, 0.300, 0.306]; // p75-p90

  const scanResults = [];
  for (const bt of buyCandidates) {
    for (const sb of sellCandidates) {
      const buyLevels = genBuyLevels(bt);
      const sellLevels = genSellLevels(sb);
      const r = backtest(kcbHli, {
        execDelay: 1,
        tradeCostRate: 0.0005,
        buyLevels,
        sellLevels,
        buyZoneTop: bt,
        sellZoneBottom: sb
      });
      scanResults.push({
        bt, sb,
        totalReturn: r.totalReturn,
        annualReturn: r.annualReturn,
        excessVsIdx2: r.excessVsIdx2,
        maxDrawdown: r.maxDrawdown,
        tradeCount: r.tradeCount
      });
    }
  }

  console.log('\n买顶端 | 卖底端 | 累计 | 年化 | 超额vs红利 | 回撤 | 调仓');
  for (const r of scanResults) {
    console.log(`${r.bt.toFixed(3)} | ${r.sb.toFixed(3)} | ${pct(r.totalReturn)} | ${pct(r.annualReturn)} | ${pct(r.excessVsIdx2)} | ${pct(r.maxDrawdown)} | ${r.tradeCount}`);
  }

  // 找最优
  scanResults.sort((a, b) => b.totalReturn - a.totalReturn);
  console.log(`\n最优组合: 买顶端=${scanResults[0].bt.toFixed(3)}, 卖底端=${scanResults[0].sb.toFixed(3)}, 累计=${pct(scanResults[0].totalReturn)}`);

  // ============================================================
  // 第二步：精选邻域验证（围绕粗扫描最优，±5个点）
  // ============================================================
  const best = scanResults[0];
  const btRange = [best.bt * 0.85, best.bt * 0.92, best.bt, best.bt * 1.08, best.bt * 1.15];
  const sbRange = [best.sb * 0.85, best.sb * 0.92, best.sb, best.sb * 1.08, best.sb * 1.15];

  console.log('\n=== 邻域验证（围绕最优 ±15%） ===');
  const neighborhood = [];
  for (const bt of btRange) {
    for (const sb of sbRange) {
      const buyLevels = genBuyLevels(bt);
      const sellLevels = genSellLevels(sb);
      const r = backtest(kcbHli, {
        execDelay: 1,
        tradeCostRate: 0.0005,
        buyLevels,
        sellLevels,
        buyZoneTop: bt,
        sellZoneBottom: sb
      });
      neighborhood.push({
        bt: bt.toFixed(4), sb: sb.toFixed(4),
        totalReturn: r.totalReturn,
        excessVsIdx2: r.excessVsIdx2
      });
    }
  }

  console.log('\n买顶端 | 卖底端 | 累计 | 超额vs红利');
  for (const r of neighborhood) {
    console.log(`${r.bt} | ${r.sb} | ${pct(r.totalReturn)} | ${pct(r.excessVsIdx2)}`);
  }

  const posCount = neighborhood.filter(r => r.excessVsIdx2 > 0).length;
  const returns = neighborhood.map(r => r.totalReturn);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length);
  const cv = std / Math.abs(mean);
  console.log(`\n邻域: ${posCount}/25 正超额, 均值=${pct(mean)}, CV=${cv.toFixed(3)}`);

  // ============================================================
  // 第三步：选定推荐参数（优先选p10-p15/p85-p90中位附近的稳健值）
  // ============================================================
  console.log('\n=== 推荐参数 ===');
  // 粗扫描最优附近 + 分位合理性（p15/p85附近）
  const recBuyTop = 0.171;   // p15
  const recSellBottom = 0.292; // p85
  const recBuyLevels = genBuyLevels(recBuyTop);
  const recSellLevels = genSellLevels(recSellBottom);
  const rec = backtest(kcbHli, {
    execDelay: 1, tradeCostRate: 0.0005,
    buyLevels: recBuyLevels, sellLevels: recSellLevels,
    buyZoneTop: recBuyTop, sellZoneBottom: recSellBottom
  });

  console.log(`买入区顶端: ${recBuyTop}`);
  console.log(`买入区底端: ${recBuyLevels[19].toFixed(4)}`);
  console.log(`卖出区底端: ${recSellBottom}`);
  console.log(`卖出区顶端: ${recSellLevels[19].toFixed(4)}`);
  console.log(`\n买入档位表: [${recBuyLevels.map(v => v.toFixed(4)).join(', ')}]`);
  console.log(`卖出档位表: [${recSellLevels.map(v => v.toFixed(4)).join(', ')}]`);
  console.log(`\n回测验证:`);
  console.log(`  累计收益: ${pct(rec.totalReturn)}`);
  console.log(`  年化: ${pct(rec.annualReturn)}`);
  console.log(`  最大回撤: ${pct(rec.maxDrawdown)}`);
  console.log(`  调仓次数: ${rec.tradeCount}`);
  console.log(`  超额vs红利: ${pct(rec.excessVsIdx2)}`);
  console.log(`  科创50指数: ${pct(rec.idx1Return)}`);
  console.log(`  红利指数: ${pct(rec.idx2Return)}`);

  // 年度明细
  console.log('\n年度收益:');
  const years = Object.keys(rec.yearlyReturns).sort();
  for (const y of years) {
    console.log(`  ${y}: ${pct(rec.yearlyReturns[y])}`);
  }
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
