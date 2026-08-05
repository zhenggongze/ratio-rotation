// 图表生成模块
// 规格7.8节：创业板走势与仓位对应图（HTML）+ 当前状态卡片
// X轴月份，左轴创业板指收盘价（折线），右轴创业板平均仓位（0~100%面积），月度降采样
const fs = require('fs');
const path = require('path');
const { config } = require('./config.cjs');
const { loadData, nowBeijing } = require('./database.cjs');
const { getCurrentStatus, calcPercentile } = require('./stats.cjs');
const { getDistanceToNextAction } = require('./strategy.cjs');

// ============================================================
// 月度降采样：按月取创业板收盘均值和仓位均值
// ============================================================
function downsampleMonthly(dailyRecords) {
  const monthly = {};
  for (const r of dailyRecords) {
    const monthKey = r.date.slice(0, 7); // YYYY-MM
    if (!monthly[monthKey]) {
      monthly[monthKey] = { date: monthKey, cybSum: 0, weightSum: 0, count: 0, ratioSum: 0 };
    }
    monthly[monthKey].cybSum += r.cyb_close;
    monthly[monthKey].weightSum += r.cyb_weight;
    monthly[monthKey].ratioSum += r.ratio;
    monthly[monthKey].count++;
  }

  return Object.values(monthly)
    .sort((a, b) => a.date < b.date ? -1 : 1)
    .map(m => ({
      date: m.date,
      cybClose: m.cybSum / m.count,
      cybWeight: m.weightSum / m.count,
      ratio: m.ratioSum / m.count
    }));
}

// ============================================================
// 生成创业板走势与仓位对应图（HTML + Chart.js）
// ============================================================
function generateChartHTML(dailyRecords, outputPath) {
  const monthly = downsampleMonthly(dailyRecords);
  const labels = monthly.map(m => m.date);
  const cybData = monthly.map(m => Math.round(m.cybClose * 100) / 100);
  const weightData = monthly.map(m => Math.round(m.cybWeight * 1000) / 10);

  // 当前状态
  const status = getCurrentStatus(dailyRecords);
  const distance = status ? getDistanceToNextAction(status.ratio, status.cybWeight) : null;
  const allRatios = dailyRecords.map(r => r.ratio);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>创业板/红利比值轮动 — 走势与仓位图</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, "Microsoft YaHei", sans-serif; background: #f5f6fa; padding: 20px; }
  h1 { color: #1F4E79; margin-bottom: 16px; font-size: 22px; }
  .card {
    background: #fff; border-radius: 8px; padding: 20px; margin-bottom: 20px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  }
  .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .status-item { background: #f8f9fb; border-radius: 6px; padding: 12px 16px; }
  .status-label { color: #888; font-size: 12px; margin-bottom: 4px; }
  .status-value { color: #1F4E79; font-size: 18px; font-weight: bold; }
  .status-value.red { color: #CC0000; }
  .status-value.green { color: #008000; }
  .chart-container { position: relative; height: 450px; width: 100%; }
  .footer { text-align: center; color: #999; font-size: 12px; margin-top: 20px; }
</style>
</head>
<body>
  <h1>创业板/红利比值轮动 — 走势与仓位图</h1>

  <div class="card">
    <h2 style="color:#1F4E79;font-size:16px;margin-bottom:12px;">当前状态</h2>
    <div class="status-grid">
      <div class="status-item">
        <div class="status-label">日期</div>
        <div class="status-value">${status ? status.date : 'N/A'}</div>
      </div>
      <div class="status-item">
        <div class="status-label">当日比值</div>
        <div class="status-value">${status ? status.ratio.toFixed(4) : 'N/A'}</div>
      </div>
      <div class="status-item">
        <div class="status-label">历史分位</div>
        <div class="status-value">p${status ? (status.percentile * 100).toFixed(0) : 0}</div>
      </div>
      <div class="status-item">
        <div class="status-label">创业板仓位</div>
        <div class="status-value ${status && status.cybWeight > 0 ? 'red' : 'green'}">${status ? (status.cybWeight * 100).toFixed(0) : 0}%</div>
      </div>
      <div class="status-item">
        <div class="status-label">红利仓位</div>
        <div class="status-value green">${status ? (status.hliWeight * 100).toFixed(0) : 0}%</div>
      </div>
      <div class="status-item">
        <div class="status-label">期末资产</div>
        <div class="status-value">${status ? status.assetValue.toFixed(2) : 'N/A'}元</div>
      </div>
      <div class="status-item">
        <div class="status-label">下一步</div>
        <div class="status-value" style="font-size:14px;">${distance ? distance.desc : 'N/A'}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2 style="color:#1F4E79;font-size:16px;margin-bottom:12px;">创业板走势与仓位对应图（月度降采样）</h2>
    <div class="chart-container">
      <canvas id="chart"></canvas>
    </div>
  </div>

  <div class="footer">生成时间: ${nowBeijing()} | 比值轮动交易决策辅助系统</div>

  <script>
    const ctx = document.getElementById('chart').getContext('2d');
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [
          {
            type: 'line',
            label: '创业板指收盘价',
            data: ${JSON.stringify(cybData)},
            borderColor: '#CC0000',
            backgroundColor: 'rgba(204,0,0,0.05)',
            yAxisID: 'y1',
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.1
          },
          {
            type: 'line',
            label: '创业板仓位(%)',
            data: ${JSON.stringify(weightData)},
            borderColor: '#1F4E79',
            backgroundColor: 'rgba(31,78,121,0.15)',
            yAxisID: 'y2',
            pointRadius: 0,
            borderWidth: 1.5,
            fill: true,
            tension: 0.1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            ticks: { maxTicksLimit: 24, font: { size: 10 } }
          },
          y1: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: '创业板指收盘价', color: '#CC0000' },
            ticks: { color: '#CC0000' }
          },
          y2: {
            type: 'linear',
            position: 'right',
            min: 0, max: 100,
            title: { display: true, text: '创业板仓位(%)', color: '#1F4E79' },
            ticks: { color: '#1F4E79', callback: v => v + '%' },
            grid: { drawOnChartArea: false }
          }
        },
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                if (ctx.dataset.yAxisID === 'y2') {
                  return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + '%';
                }
                return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2);
              }
            }
          }
        }
      }
    });
  </script>
</body>
</html>`;

  const outFile = outputPath || path.join(config.dataDir, `chart_${nowBeijing().slice(0, 10)}.html`);
  fs.writeFileSync(outFile, html, 'utf-8');
  return outFile;
}

// ============================================================
// 生成图表命令
// ============================================================
function generateChart(outputPath) {
  console.log('='.repeat(60));
  console.log('图表生成');
  console.log('='.repeat(60));

  const data = loadData();
  if (!data.daily_records || data.daily_records.length === 0) {
    console.log('✗ 无数据，请先运行 init-history');
    return { success: false, error: '无数据' };
  }

  console.log(`数据量: ${data.daily_records.length} 条`);
  console.log('生成创业板走势与仓位对应图...');

  const outFile = generateChartHTML(data.daily_records, outputPath);

  console.log('\n' + '='.repeat(60));
  console.log(`✓ 图表已生成: ${outFile}`);
  console.log('='.repeat(60));

  return { success: true, outputPath: outFile };
}

// ============================================================
// 命令行入口
// ============================================================
if (require.main === module) {
  const args = process.argv.slice(2);
  const outputPath = args[0] || null;
  generateChart(outputPath);
}

module.exports = { generateChart, generateChartHTML, downsampleMonthly };
