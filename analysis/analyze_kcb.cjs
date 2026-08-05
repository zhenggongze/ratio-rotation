// 科创50/红利 比值分布分析 — 设计新档位表
const fs = require('fs');
const path = require('path');
const { loadHistory, alignIndices } = require('./data_loader.cjs');

const START = '2014-07-01';
const END = '2026-12-31';

function pct(n) { return (n * 100).toFixed(2) + '%'; }

async function main() {
  const [kcbData, hliData] = await Promise.all([
    loadHistory('sh000688', START, END, '科创50'),
    loadHistory('sh000922', START, END, '中证红利')
  ]);

  // 科创50从上市后一个月开始（2020-08-03）
  const kcbStartIdx = kcbData.findIndex(d => d.date >= '2020-08-01');
  const kcbEffective = kcbStartIdx >= 0 ? kcbData.slice(kcbStartIdx) : [];

  const kcbHli = alignIndices(kcbEffective, hliData, '科创50', '红利');
  console.log(`科创50+红利对齐: ${kcbHli.length} 个交易日 (${kcbHli[0].date} ~ ${kcbHli[kcbHli.length-1].date})`);

  // 比值分布
  const ratios = kcbHli.map(d => d.ratio).sort((a, b) => a - b);
  console.log('\n=== 科创50/红利 比值分布 ===');
  console.log(`最低: ${ratios[0].toFixed(4)}`);
  console.log(`最高: ${ratios[ratios.length-1].toFixed(4)}`);
  console.log(`中位数: ${ratios[Math.floor(ratios.length/2)].toFixed(4)}`);

  const percentiles = [1, 2, 3, 5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 85, 88, 90, 92, 95, 97, 98, 99];
  console.log('\n=== 分位数 ===');
  for (const p of percentiles) {
    const idx = Math.min(ratios.length - 1, Math.floor(ratios.length * p / 100));
    console.log(`p${p}: ${ratios[idx].toFixed(4)}`);
  }

  // 参考：创业板/红利 0.332在科创50/红利分布中的分位
  const cybBuy = 0.332;
  const countLe0_332 = ratios.filter(r => r <= cybBuy).length;
  console.log(`\n0.332 在科创50/红利分布中的分位: ${pct(countLe0_332 / ratios.length)}`);
  const cybSell = 0.578;
  const countLe0_578 = ratios.filter(r => r <= cybSell).length;
  console.log(`0.578 在科创50/红利分布中的分位: ${pct(countLe0_578 / ratios.length)}`);

  // 关键：创业板0.332大约是10-15%分位，0.578大约是85%分位
  // 所以科创50应该选对应的分位
  // 需要看科创50的p10、p15、p85、p90

  // 年度比值区间
  console.log('\n=== 按年度比值区间 ===');
  const yearly = {};
  for (const d of kcbHli) {
    const y = d.date.slice(0, 4);
    if (!yearly[y]) yearly[y] = { min: Infinity, max: -Infinity, count: 0 };
    yearly[y].min = Math.min(yearly[y].min, d.ratio);
    yearly[y].max = Math.max(yearly[y].max, d.ratio);
    yearly[y].count++;
  }
  console.log('年份 | 最小 | 最大 | 交易日');
  for (const y of Object.keys(yearly).sort()) {
    const yr = yearly[y];
    console.log(`${y} | ${yr.min.toFixed(4)} | ${yr.max.toFixed(4)} | ${yr.count}`);
  }
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
