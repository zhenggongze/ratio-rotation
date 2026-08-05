// 科创50参数样本外验证 — 防止2026年牛市过拟合
// 训练期：2020-08 ~ 2024-12（选参数）
// 验证期：2025-01 ~ 2026-07（验证参数）
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
  const [kcbData, hliData] = await Promise.all([
    loadHistory('sh000688', START, END, '科创50'),
    loadHistory('sh000922', START, END, '中证红利')
  ]);
  const kcbStartIdx = kcbData.findIndex(d => d.date >= '2020-08-01');
  const kcbHli = alignIndices(kcbData.slice(kcbStartIdx), hliData, '科创50', '红利');

  // 切分训练/验证期
  const trainEndIdx = kcbHli.findIndex(d => d.date >= '2025-01-01');
  const train = kcbHli.slice(0, trainEndIdx);
  const valid = kcbHli.slice(trainEndIdx);

  console.log(`训练期: ${train[0].date} ~ ${train[train.length-1].date} (${train.length}日)`);
  console.log(`验证期: ${valid[0].date} ~ ${valid[valid.length-1].date} (${valid.length}日)`);

  // 训练期回测（记录最终weight和净值，供验证期继承）
  function trainAndValidate(bt, sb) {
    const opts = {
      execDelay: 1, tradeCostRate: 0.0005,
      buyLevels: genBuyLevels(bt), sellLevels: genSellLevels(sb),
      buyZoneTop: bt, sellZoneBottom: sb
    };
    const trainR = backtest(train, { ...opts, initCapital: 1.0 });
    // 验证期继承训练期末的仓位和净值
    const initW = trainR.finalWeight;
    const validR = backtest(valid, { ...opts, initWeight: initW, initCapital: 1.0 });
    return { trainR, validR, initW };
  }

  // ============================================================
  // 第一步：在训练期上选参数（粗扫描）
  // ============================================================
  console.log('\n=== 训练期粗扫描（2020-08 ~ 2024-12） ===');
  const buyCandidates = [0.146, 0.155, 0.171, 0.179, 0.187];
  const sellCandidates = [0.264, 0.279, 0.292, 0.300, 0.306];

  const trainResults = [];
  for (const bt of buyCandidates) {
    for (const sb of sellCandidates) {
      const r = backtest(train, {
        execDelay: 1, tradeCostRate: 0.0005,
        buyLevels: genBuyLevels(bt), sellLevels: genSellLevels(sb),
        buyZoneTop: bt, sellZoneBottom: sb
      });
      trainResults.push({ bt, sb, totalReturn: r.totalReturn, annualReturn: r.annualReturn, excessVsIdx2: r.excessVsIdx2, tradeCount: r.tradeCount });
    }
  }

  console.log('买顶端 | 卖底端 | 训练累计 | 训练年化 | 超额vs红利 | 调仓');
  for (const r of trainResults) {
    console.log(`${r.bt.toFixed(3)} | ${r.sb.toFixed(3)} | ${pct(r.totalReturn)} | ${pct(r.annualReturn)} | ${pct(r.excessVsIdx2)} | ${r.tradeCount}`);
  }

  // ============================================================
  // 第二步：训练期Top3参数 → 验证期测试（继承仓位）
  // ============================================================
  trainResults.sort((a, b) => b.totalReturn - a.totalReturn);
  const topParams = trainResults.slice(0, 3);
  console.log('\n=== 训练期Top3 → 验证期表现（继承仓位） ===');
  console.log('买顶端 | 卖底端 | 训练累计 | 期末仓位 | 验证累计 | 验证年化 | 验证超额vs红利 | 全期累计');

  for (const p of topParams) {
    const { trainR, validR, initW } = trainAndValidate(p.bt, p.sb);
    const fullR = backtest(kcbHli, {
      execDelay: 1, tradeCostRate: 0.0005,
      buyLevels: genBuyLevels(p.bt), sellLevels: genSellLevels(p.sb),
      buyZoneTop: p.bt, sellZoneBottom: p.sb
    });
    console.log(`${p.bt.toFixed(3)} | ${p.sb.toFixed(3)} | ${pct(trainR.totalReturn)} | ${(initW * 100).toFixed(0)}% | ${pct(validR.totalReturn)} | ${pct(validR.annualReturn)} | ${pct(validR.excessVsIdx2)} | ${pct(fullR.totalReturn)}`);
  }

  // ============================================================
  // 第三步：分位基准参数全期对比
  // ============================================================
  console.log('\n=== 分位基准参数全期对比 ===');
  const candidates = [
    { name: 'p10/p90 (0.146/0.306)', bt: 0.146, sb: 0.306 },
    { name: 'p15/p85 (0.171/0.292)', bt: 0.171, sb: 0.292 },
    { name: 'p12/p88 (0.155/0.300)', bt: 0.155, sb: 0.300 },
    { name: 'p10/p85 (0.146/0.292)', bt: 0.146, sb: 0.292 },
    { name: 'p15/p90 (0.171/0.306)', bt: 0.171, sb: 0.306 }
  ];

  for (const c of candidates) {
    const { trainR, validR, initW } = trainAndValidate(c.bt, c.sb);
    console.log(`${c.name}: 训练=${pct(trainR.totalReturn)}, 期末仓=${(initW * 100).toFixed(0)}%, 验证=${pct(validR.totalReturn)} (年化${pct(validR.annualReturn)}), 验证超额=${pct(validR.excessVsIdx2)}`);
  }

  // ============================================================
  // 第四步：推荐参数的邻域稳健性（全期）
  // ============================================================
  // 基于训练期结果选推荐参数
  console.log('\n=== 推荐参数全期邻域（±10%） ===');
  const recBt = 0.146, recSb = 0.306;
  const btRange = [recBt * 0.9, recBt * 0.95, recBt, recBt * 1.05, recBt * 1.10];
  const sbRange = [recSb * 0.9, recSb * 0.95, recSb, recSb * 1.05, recSb * 1.10];
  const nb = [];
  for (const bt of btRange) {
    for (const sb of sbRange) {
      const r = backtest(kcbHli, {
        execDelay: 1, tradeCostRate: 0.0005,
        buyLevels: genBuyLevels(bt), sellLevels: genSellLevels(sb),
        buyZoneTop: bt, sellZoneBottom: sb
      });
      nb.push({ bt: bt.toFixed(4), sb: sb.toFixed(4), totalReturn: r.totalReturn, excess: r.excessVsIdx2 });
    }
  }
  const pos = nb.filter(r => r.excess > 0).length;
  const rets = nb.map(r => r.totalReturn);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  console.log(`${pos}/25 正超额, 均值=${pct(mean)}, CV=${(std / Math.abs(mean)).toFixed(3)}`);
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
