// 数据加载模块（分析专用，不依赖生产代码）
// 拉取创业板指(sz399006)、中证红利(sh000922)、科创50(sh000688) 历史K线
const https = require('https');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 腾讯历史K线分批拉取
async function fetchTencentHistory(code, startDate, endDate) {
  const all = [];
  let batchEnd = endDate;
  let batchCount = 0;

  while (true) {
    batchCount++;
    const url = `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,${startDate},${batchEnd},2000,qfq`;
    const text = await httpGet(url);
    const json = JSON.parse(text);
    const stockData = json.data && json.data[code];
    if (!stockData) break;
    const dayArr = stockData.qfqday || stockData.day || stockData.qfqdayData || [];
    if (dayArr.length === 0) break;

    const batch = dayArr.map(item => ({
      date: item[0],
      open: parseFloat(item[1]),
      close: parseFloat(item[2]),
      high: parseFloat(item[3]),
      low: parseFloat(item[4]),
      volume: parseFloat(item[5]) || 0
    }));

    all.push(...batch);
    if (batch.length < 2000) break;

    const firstDate = batch[0].date;
    const d = new Date(firstDate);
    d.setDate(d.getDate() - 1);
    batchEnd = d.toISOString().slice(0, 10);
    if (batchEnd < startDate) break;
    if (batchCount >= 10) break;
  }

  const seen = new Set();
  const unique = [];
  for (const item of all.sort((a, b) => a.date < b.date ? -1 : 1)) {
    if (!seen.has(item.date)) { seen.add(item.date); unique.push(item); }
  }
  return unique;
}

// 带文件缓存的数据加载（避免重复请求腾讯接口）
async function loadHistory(code, startDate, endDate, label) {
  const cacheFile = path.join(CACHE_DIR, `${code}_${startDate}_${endDate}.json`);
  if (fs.existsSync(cacheFile)) {
    console.log(`[缓存] ${label} (${code})`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  }

  console.log(`[拉取] ${label} (${code}) ${startDate} ~ ${endDate}`);
  const data = await fetchTencentHistory(code, startDate, endDate);
  fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  ✓ ${data.length} 条`);
  return data;
}

// 对齐两个指数的日期
function alignIndices(idx1Data, idx2Data, label1, label2) {
  const map2 = new Map();
  idx2Data.forEach(d => map2.set(d.date, d));
  const aligned = [];
  for (const a of idx1Data) {
    const b = map2.get(a.date);
    if (b) {
      aligned.push({
        date: a.date,
        open1: a.open, close1: a.close, high1: a.high, low1: a.low,
        open2: b.open, close2: b.close, high2: b.high, low2: b.low,
        ratio: a.close / b.close
      });
    }
  }
  return aligned;
}

module.exports = {
  loadHistory,
  alignIndices,
  httpGet
};
