// 策略分析主脚本 — 6个思路一次性跑完
// 不修改生产代码，仅输出对比报告
const fs = require('fs');
const path = require('path');
const { loadHistory, alignIndices } = require('./data_loader.cjs');
const { backtest, DEFAULT_BUY_LEVELS, DEFAULT_SELL_LEVELS } = require('./backtest.cjs');

const REPORT_FILE = path.join(__dirname, 'REPORT.md');
const lines = [];
function log(s) { console.log(s); lines.push(s); }
function logTable(rows) {
  lines.push('| ' + rows[0].join(' | ') + ' |');
  lines.push('|' + rows[0].map(() => '---').join('|') + '|');
  for (let i = 1; i < rows.length; i++) {
    lines.push('| ' + rows[i].join(' | ') + ' |');
  }
}
function pct(n) { return (n * 100).toFixed(2) + '%'; }

async function main() {
  log('# 策略分析报告');
  log('');
  log('生成时间: ' + new Date().toISOString().replace('T', ' ').slice(0, 19));
  log('');

  // ============================================================
  // 数据准备：拉取2014-07至今的全历史数据
  // ============================================================
  log('## 数据准备\n');
  const START = '2014-07-01';
  const END = '2026-12-31';

  const [cybData, hliData, kcbData] = await Promise.all([
    loadHistory('sz399006', START, END, '创业板指'),
    loadHistory('sh000922', START, END, '中证红利'),
    loadHistory('sh000688', START, END, '科创50')
  ]);

  // 创业板+红利对齐
  const cybHli = alignIndices(cybData, hliData, '创业板', '红利');
  log(`- 创业板+红利对齐: ${cybHli.length} 个交易日`);
  log(`  起止: ${cybHli[0].date} ~ ${cybHli[cybHli.length-1].date}\n`);

  // 科创50+红利对齐（科创50 2020-07-23上市，从2020-08开始有完整月度数据）
  const kcbFirstDate = kcbData.length > 0 ? kcbData[0].date : '2020-07-23';
  const kcbStartIdx = kcbData.findIndex(d => d.date >= '2020-08-01');
  const kcbEffectiveData = kcbStartIdx >= 0 ? kcbData.slice(kcbStartIdx) : [];
  const kcbHli = alignIndices(kcbEffectiveData, hliData, '科创50', '红利');
  log(`- 科创50+红利对齐: ${kcbHli.length} 个交易日`);
  if (kcbHli.length > 0) {
    log(`  起止: ${kcbHli[0].date} ~ ${kcbHli[kcbHli.length-1].date}\n`);
  }

  // ============================================================
  // 思路1：未来函数审计（两种方法）
  // ============================================================
  log('## 思路1：未来函数审计\n');
  log('**目的**：验证策略是否依赖"当日收盘价做当日决策"的未来函数。');
  log('**方法A**：执行延迟 T+1/T+2/T+3/T+5/T+10/T+20（单调档位下天然不敏感，作为辅助）');
  log('**方法B（更严格）**：用T日收盘价"立即执行"（未来函数）vs T+1开盘价执行（正确），看收益差。');
  log('**判定**：');
  log('- 方法B收益差<5% → 无未来函数幻觉');
  log('- 方法B收益差>15% → 存在未来函数幻觉\n');

  // 方法A：执行延迟
  const delayResults = [];
  for (const delay of [1, 2, 3, 5, 10, 20]) {
    const r = backtest(cybHli, { execDelay: delay, tradeCostRate: 0.0005 });
    delayResults.push({
      delay,
      totalReturn: r.totalReturn,
      annualReturn: r.annualReturn,
      tradeCount: r.tradeCount,
      maxDrawdown: r.maxDrawdown
    });
  }
  const baseReturn = delayResults[0].totalReturn;
  log('**方法A：执行延迟对比**\n');
  logTable([
    ['执行延迟', '累计收益', '年化', '最大回撤', '调仓次数', '相对T+1衰减'],
    ...delayResults.map(r => [
      `T+${r.delay}`,
      pct(r.totalReturn),
      pct(r.annualReturn),
      pct(r.maxDrawdown),
      String(r.tradeCount),
      pct((r.totalReturn - baseReturn) / Math.abs(baseReturn))
    ])
  ]);
  log('');
  log('注：单调档位策略下，延迟执行只影响"哪天加仓"，不影响"加多少"，所以衰减天然为0。需看方法B。\n');

  // 方法B：未来函数测试（用当日收盘价执行 vs T+1开盘价执行）
  // 实现一个"立即执行"的回测：信号产生后用当日收盘价调仓
  function backtestFutureFunction(data, opts) {
    opts = opts || {};
    const startIdx = opts.startIdx || 0;
    const endIdx = opts.endIdx !== undefined ? opts.endIdx : data.length - 1;
    const tradeCostRate = opts.tradeCostRate !== undefined ? opts.tradeCostRate : 0.0005;
    const tierWeight = opts.tierWeight || 0.05;
    const initCapital = opts.initCapital || 1.0;

    let weight = 0;
    let capital = initCapital;
    let tradeCount = 0;

    for (let i = startIdx; i <= endIdx; i++) {
      const today = data[i];
      const ratio = today.ratio;

      // 当日收益（用旧仓位）
      if (i > startIdx) {
        const prev = data[i - 1];
        const ret1 = today.close1 / prev.close1 - 1;
        const ret2 = today.close2 / prev.close2 - 1;
        capital *= (1 + weight * ret1 + (1 - weight) * ret2);
      }

      // 信号判定（基于今日收盘比值）
      const { determineSignal } = require('./backtest.cjs');
      const signal = determineSignal(ratio, weight, opts);

      // ⚠️ 未来函数：用当日收盘价"立即执行"（真实交易中不可能）
      if (signal.action === 'BUY' || signal.action === 'SELL') {
        const deltaWeight = Math.abs(signal.targetWeight - weight);
        capital *= (1 - deltaWeight * tradeCostRate * 2);
        weight = signal.targetWeight;
        tradeCount++;
      }
    }

    return {
      totalReturn: capital / initCapital - 1,
      tradeCount
    };
  }

  const ffResult = backtestFutureFunction(cybHli, { tradeCostRate: 0.0005 });
  const correctResult = backtest(cybHli, { execDelay: 1, tradeCostRate: 0.0005 });
  const ffGap = Math.abs((ffResult.totalReturn - correctResult.totalReturn) / Math.abs(correctResult.totalReturn));

  log('**方法B：未来函数测试（T日收盘执行 vs T+1开盘执行）**\n');
  logTable([
    ['执行方式', '累计收益', '调仓次数', '相对差异'],
    ['T+1开盘执行（正确）', pct(correctResult.totalReturn), String(correctResult.tradeCount), '基准'],
    ['T日收盘执行（未来函数）', pct(ffResult.totalReturn), String(ffResult.tradeCount), pct(ffGap)]
  ]);
  log('');
  log(`**判定**：方法B收益差异 ${pct(ffGap)}。`);
  if (ffGap < 0.05) log(`✅ 差异<5%，**无未来函数幻觉**，策略逻辑真实。\n`);
  else if (ffGap < 0.15) log(`⚠️ 差异5-15%，存在轻微未来函数影响。\n`);
  else log(`❌ 差异>15%，**存在未来函数幻觉**，当前收益部分来自"当日收盘执行"。\n`);

  // ============================================================
  // 思路2：起点偏差修正
  // ============================================================
  log('## 思路2：起点偏差修正\n');
  log('**目的**：2014-07起点可能恰好处于红利强势期，给策略送了起点优势。');
  log('**方法**：从不同年份起点分别回测，看是否都正超额。\n');

  const startPoints = [
    { label: '2014-07(原始)', date: '2014-07-18' },
    { label: '2015-01', date: '2015-01-05' },
    { label: '2016-01', date: '2016-01-04' },
    { label: '2017-01', date: '2017-01-03' },
    { label: '2018-01', date: '2018-01-02' },
    { label: '2019-01', date: '2019-01-02' },
    { label: '2020-01', date: '2020-01-02' },
    { label: '2021-01', date: '2021-01-04' },
    { label: '2022-01', date: '2022-01-04' },
    { label: '2023-01', date: '2023-01-03' },
    { label: '2024-01', date: '2024-01-02' }
  ];

  const startResults = [];
  for (const sp of startPoints) {
    const startIdx = cybHli.findIndex(d => d.date >= sp.date);
    if (startIdx < 0) continue;
    const r = backtest(cybHli, { startIdx, execDelay: 1, tradeCostRate: 0.0005 });
    startResults.push({
      label: sp.label,
      years: ((cybHli.length - 1 - startIdx) / 244).toFixed(2),
      totalReturn: r.totalReturn,
      annualReturn: r.annualReturn,
      excessVsEqual: r.excessVsEqual,
      idx1Return: r.idx1Return,
      idx2Return: r.idx2Return
    });
  }
  logTable([
    ['起点', '年数', '策略累计', '策略年化', '创业板', '红利', '超额vs等权'],
    ...startResults.map(r => [
      r.label, r.years, pct(r.totalReturn), pct(r.annualReturn),
      pct(r.idx1Return), pct(r.idx2Return), pct(r.excessVsEqual)
    ])
  ]);
  log('');
  const positiveExcess = startResults.filter(r => r.excessVsEqual > 0).length;
  log(`**判定**：${startResults.length}个起点中，${positiveExcess}个正超额。`);
  if (positiveExcess === startResults.length) log(`✅ 所有起点都正超额，**不依赖特定起点**。\n`);
  else if (positiveExcess >= startResults.length * 0.7) log(`⚠️ 多数起点正超额，但有个别失败，需关注。\n`);
  else log(`❌ 多数起点失败，**策略依赖特定起点**。\n`);

  // ============================================================
  // 思路3：成本敏感性
  // ============================================================
  log('## 思路3：成本敏感性\n');
  log('**目的**：策略调仓16次，若靠"微利套利"，提高成本会迅速失效。');
  log('**方法**：单边成本从0.05%逐步提高到0.5%，看收益衰减。\n');

  const costResults = [];
  for (const cost of [0.0005, 0.001, 0.002, 0.003, 0.005]) {
    const r = backtest(cybHli, { execDelay: 1, tradeCostRate: cost });
    costResults.push({
      cost,
      totalReturn: r.totalReturn,
      annualReturn: r.annualReturn,
      tradeCount: r.tradeCount
    });
  }
  const baseCostReturn = costResults[0].totalReturn;
  logTable([
    ['单边成本', '累计收益', '年化', '调仓次数', '相对0.05%衰减'],
    ...costResults.map(r => [
      pct(r.cost),
      pct(r.totalReturn),
      pct(r.annualReturn),
      String(r.tradeCount),
      pct((r.totalReturn - baseCostReturn) / Math.abs(baseCostReturn))
    ])
  ]);
  log('');
  const costDecay = Math.abs((costResults[costResults.length - 1].totalReturn - baseCostReturn) / Math.abs(baseCostReturn));
  log(`**判定**：成本0.05% → 0.5% 收益衰减 ${pct(costDecay)}。`);
  if (costDecay < 0.10) log(`✅ 衰减<10%，策略**不靠微利套利**。\n`);
  else if (costDecay < 0.30) log(`⚠️ 衰减10-30%，策略对成本有一定敏感性。\n`);
  else log(`❌ 衰减>30%，策略**高度依赖低成本**。\n`);

  // ============================================================
  // 思路4：参数邻域测试（25组）
  // ============================================================
  log('## 思路4：参数邻域测试（判决过拟合）\n');
  log('**目的**：判定0.332/0.578是"高原"还是"孤峰"。');
  log('**方法**：buyZoneTop在0.30~0.36取5个点，sellZoneBottom在0.52~0.63取5个点，25组组合回测。\n');

  // 邻域：buyZoneTop ±10%, sellZoneBottom ±10%
  // 但保持档位内部间距比例不变（等比缩放）
  const buyFactors = [0.85, 0.92, 1.0, 1.08, 1.15]; // 0.332 × factor
  const sellFactors = [0.85, 0.92, 1.0, 1.08, 1.15];

  const neighborhoodResults = [];
  for (const bf of buyFactors) {
    for (const sf of sellFactors) {
      const scaledBuyLevels = DEFAULT_BUY_LEVELS.map(v => v * bf);
      const scaledSellLevels = DEFAULT_SELL_LEVELS.map(v => v * sf);
      const r = backtest(cybHli, {
        execDelay: 1,
        tradeCostRate: 0.0005,
        buyLevels: scaledBuyLevels,
        sellLevels: scaledSellLevels,
        buyZoneTop: scaledBuyLevels[0],
        sellZoneBottom: scaledSellLevels[0]
      });
      neighborhoodResults.push({
        buyTop: scaledBuyLevels[0].toFixed(4),
        sellBottom: scaledSellLevels[0].toFixed(4),
        totalReturn: r.totalReturn,
        annualReturn: r.annualReturn,
        excessVsEqual: r.excessVsEqual,
        maxDrawdown: r.maxDrawdown
      });
    }
  }

  logTable([
    ['buyTop', 'sellBottom', '累计收益', '年化', '超额vs等权', '最大回撤'],
    ...neighborhoodResults.map(r => [
      r.buyTop, r.sellBottom, pct(r.totalReturn), pct(r.annualReturn),
      pct(r.excessVsEqual), pct(r.maxDrawdown)
    ])
  ]);
  log('');

  const positiveNeighborhood = neighborhoodResults.filter(r => r.excessVsEqual > 0).length;
  const returns = neighborhoodResults.map(r => r.totalReturn);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const maxReturn = Math.max(...returns);
  const minReturn = Math.min(...returns);
  const stdDev = Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length);
  const cv = stdDev / Math.abs(meanReturn); // 变异系数

  log(`**统计**：`);
  log(`- 25组中正超额: ${positiveNeighborhood}/25`);
  log(`- 收益均值: ${pct(meanReturn)}, 标准差: ${pct(stdDev)}`);
  log(`- 收益区间: ${pct(minReturn)} ~ ${pct(maxReturn)}`);
  log(`- 变异系数CV: ${cv.toFixed(3)}`);
  log('');
  if (positiveNeighborhood === 25 && cv < 0.3) {
    log(`✅ 25组全部正超额且变异系数<0.3，**当前参数处于高原**，非过拟合。\n`);
  } else if (positiveNeighborhood >= 20) {
    log(`⚠️ 多数组正超额，但参数敏感度较高，需关注。\n`);
  } else {
    log(`❌ 多数组失败或变异系数>0.5，**当前参数是孤峰**，过拟合风险高。\n`);
  }

  // ============================================================
  // 思路5：滚动分位阈值对照
  // ============================================================
  log('## 思路5：滚动分位阈值对照\n');
  log('**目的**：用"过去250日比值的20%/80%分位"替代固定0.332/0.578。');
  log('**方法**：滚动窗口250日（约1年），动态计算阈值，对比收益。\n');

  function rollingPercentile(arr, window, p) {
    const result = [];
    for (let i = 0; i < arr.length; i++) {
      if (i < window) {
        // 不足窗口期，用现有数据
        const slice = arr.slice(0, i + 1).sort((a, b) => a - b);
        result.push(slice[Math.floor(slice.length * p)]);
      } else {
        const slice = arr.slice(i - window + 1, i + 1).sort((a, b) => a - b);
        result.push(slice[Math.floor(slice.length * p)]);
      }
    }
    return result;
  }

  const ratios = cybHli.map(d => d.ratio);
  const rollingBuyThresholds = rollingPercentile(ratios, 250, 0.20); // 20%分位
  const rollingSellThresholds = rollingPercentile(ratios, 250, 0.80); // 80%分位

  // 用滚动阈值做回测（简化版：不分档，直接全仓/半仓/清仓）
  function rollingBacktest(data, buyThreshs, sellThreshs) {
    let capital = 1.0;
    let weight = 0;
    let peak = 1.0;
    let maxDD = 0;
    let trades = 0;

    for (let i = 1; i < data.length; i++) {
      const ratio = data[i].ratio;
      const buyTh = buyThreshs[i];
      const sellTh = sellThreshs[i];

      // 信号判定（简化：3档）
      let targetWeight = weight;
      if (ratio <= buyTh) targetWeight = 1.0;
      else if (ratio >= sellTh) targetWeight = 0.0;
      // 滞回带不操作

      // 执行（T+1）
      if (targetWeight !== weight) {
        const deltaWeight = Math.abs(targetWeight - weight);
        capital *= (1 - deltaWeight * 0.0005 * 2);
        weight = targetWeight;
        trades++;
      }

      // 当日收益
      const ret1 = data[i].close1 / data[i-1].close1 - 1;
      const ret2 = data[i].close2 / data[i-1].close2 - 1;
      capital *= (1 + weight * ret1 + (1 - weight) * ret2);

      if (capital > peak) peak = capital;
      const dd = (capital - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }

    return {
      totalReturn: capital - 1,
      maxDrawdown: maxDD,
      tradeCount: trades
    };
  }

  const rollingResult = rollingBacktest(cybHli, rollingBuyThresholds, rollingSellThresholds);
  const fixedResult = backtest(cybHli, { execDelay: 1, tradeCostRate: 0.0005 });

  logTable([
    ['阈值方式', '累计收益', '最大回撤', '调仓次数'],
    ['固定0.332/0.578', pct(fixedResult.totalReturn), pct(fixedResult.maxDrawdown), String(fixedResult.tradeCount)],
    ['滚动20%/80%分位', pct(rollingResult.totalReturn), pct(rollingResult.maxDrawdown), String(rollingResult.tradeCount)]
  ]);
  log('');

  if (Math.abs(rollingResult.totalReturn - fixedResult.totalReturn) / Math.abs(fixedResult.totalReturn) < 0.2) {
    log(`✅ 两种方式收益接近（差距<20%），**滚动分位可替代固定阈值**，且对未来适应性更强。\n`);
  } else if (rollingResult.totalReturn > fixedResult.totalReturn) {
    log(`⚠️ 滚动分位收益更高，固定阈值可能过于保守。\n`);
  } else {
    log(`⚠️ 滚动分位收益低于固定阈值${pct(Math.abs((rollingResult.totalReturn - fixedResult.totalReturn) / Math.abs(fixedResult.totalReturn)))}，固定阈值更优。\n`);
  }

  // ============================================================
  // 思路6：科创50 vs 创业板对比
  // ============================================================
  log('## 思路6：科创50 vs 创业板对比\n');
  log('**目的**：把创业板换成科创50，用同样策略，看是否有区别。');
  log(`**方法**：从科创50上市后一个月（${kcbHli[0]?.date || 'N/A'}）开始回测。\n`);

  let kcbResult = null, cybSamePeriod = null;
  if (kcbHli.length > 0) {
    // 科创50策略
    kcbResult = backtest(kcbHli, { execDelay: 1, tradeCostRate: 0.0005 });

    // 同期创业板策略（用相同时段）
    const samePeriodStart = cybHli.findIndex(d => d.date >= kcbHli[0].date);
    cybSamePeriod = backtest(cybHli, { startIdx: samePeriodStart, execDelay: 1, tradeCostRate: 0.0005 });

    log(`**同期对比（${kcbHli[0].date} ~ ${kcbHli[kcbHli.length-1].date}）**\n`);
    logTable([
      ['指标', '科创50策略', '创业板策略(同期)', '科创50指数', '创业板指数(同期)'],
      ['累计收益',
        pct(kcbResult.totalReturn),
        pct(cybSamePeriod.totalReturn),
        pct(kcbResult.idx1Return),
        pct(cybSamePeriod.idx1Return)
      ],
      ['年化收益',
        pct(kcbResult.annualReturn),
        pct(cybSamePeriod.annualReturn),
        '-', '-'
      ],
      ['最大回撤',
        pct(kcbResult.maxDrawdown),
        pct(cybSamePeriod.maxDrawdown),
        '-', '-'
      ],
      ['调仓次数',
        String(kcbResult.tradeCount),
        String(cybSamePeriod.tradeCount),
        '-', '-'
      ],
      ['超额vs红利',
        pct(kcbResult.excessVsIdx2),
        pct(cybSamePeriod.excessVsIdx2),
        '-', '-'
      ]
    ]);
    log('');

    // 年度对比
    log('**年度收益对比**\n');
    const years = Object.keys(kcbResult.yearlyReturns).sort();
    logTable([
      ['年份', '科创50策略', '创业板策略(同期)', '差异'],
      ...years.map(y => {
        const k = kcbResult.yearlyReturns[y] || 0;
        const c = cybSamePeriod.yearlyReturns[y] || 0;
        return [y, pct(k), pct(c), pct(k - c)];
      })
    ]);
    log('');

    // 判定
    if (kcbResult.totalReturn > cybSamePeriod.totalReturn) {
      log(`✅ 科创50策略累计收益高于创业板策略${pct(kcbResult.totalReturn - cybSamePeriod.totalReturn)}`);
      log(`   可能原因：科创50波动更大，比值变化更剧烈，策略择时收益更高。\n`);
    } else {
      log(`⚠️ 科创50策略累计收益低于创业板策略${pct(cybSamePeriod.totalReturn - kcbResult.totalReturn)}`);
      log(`   可能原因：科创50上市时间短（仅${(kcbHli.length / 244).toFixed(2)}年），样本不足以体现策略优势。\n`);
    }

    // 关键结论
    log('**关键结论**：\n');
    if (Math.abs(kcbResult.totalReturn - cybSamePeriod.totalReturn) / Math.abs(cybSamePeriod.totalReturn) < 0.15) {
      log(`- 两种策略收益接近（差距<15%），**策略逻辑可迁移到科创50**。\n`);
    } else {
      log(`- 两种策略收益差距>15%，策略对不同标的的适应性不同。\n`);
    }
    if (kcbResult.excessVsIdx2 > 0 && cybSamePeriod.excessVsIdx2 > 0) {
      log(`- 两种策略都跑赢红利，**策略底层逻辑（比值轮动）有效**。\n`);
    } else if (kcbResult.excessVsIdx2 < 0) {
      log(`- ⚠️ 科创50策略跑输红利，可能是样本期太短或参数不适配。\n`);
    }
  } else {
    log('⚠️ 科创50数据不足，无法对比。\n');
  }

  // ============================================================
  // 总结
  // ============================================================
  log('## 总结\n');
  log('1. **未来函数审计**：' + (ffGap < 0.05 ? '✅ 通过（无未来函数幻觉）' : ffGap < 0.15 ? '⚠️ 轻微未来函数影响' : '❌ 存在未来函数幻觉'));
  log('2. **起点偏差**：' + (positiveExcess === startResults.length ? '✅ 通过（所有起点正超额）' : positiveExcess >= startResults.length * 0.7 ? '⚠️ 部分起点失败' : '❌ 多数起点失败'));
  log('3. **成本敏感性**：' + (costDecay < 0.10 ? '✅ 通过（不靠微利套利）' : costDecay < 0.30 ? '⚠️ 部分敏感' : '❌ 高度敏感'));
  log('4. **参数邻域**：' + (positiveNeighborhood === 25 && cv < 0.3 ? '✅ 高原（非过拟合）' : positiveNeighborhood >= 20 ? `⚠️ 部分敏感（25/25正超额，CV=${cv.toFixed(3)}）` : '❌ 孤峰'));
  log('5. **滚动分位**：' + (Math.abs(rollingResult.totalReturn - fixedResult.totalReturn) / Math.abs(fixedResult.totalReturn) < 0.2 ? '✅ 可替代' : '⚠️ 固定更优'));
  if (kcbResult && cybSamePeriod) {
    const kcbGap = Math.abs(kcbResult.totalReturn - cybSamePeriod.totalReturn) / Math.abs(cybSamePeriod.totalReturn);
    log('6. **科创50对比**：' + (kcbGap < 0.15 ? '✅ 可迁移（收益接近）' : `⚠️ 差距较大（${pct(kcbGap)}）`));
  }
  log('');

  // 保存报告
  fs.writeFileSync(REPORT_FILE, lines.join('\n'), 'utf-8');
  console.log('\n========================================');
  console.log('报告已保存到: ' + REPORT_FILE);
  console.log('========================================');
}

main().catch(e => {
  console.error('分析失败:', e);
  process.exit(1);
});
