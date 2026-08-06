// 做T每日记录生成脚本（16:00 收盘后由 daily_rotation workflow 调用）
// 功能：拉取当日行情 → 计算当日做T记录 → 追加/覆盖到 t0_daily.json（按 date 幂等）
// 口径：computeT0Daily 与回测完全一致（向下取整挂单价、佣金万1双边、低开2%跳过）
// 盘中（北京时间 15:30 前）运行时当日行标记"待收盘"，收盘后运行生成完整成交/盈亏
const fs = require('fs');
const path = require('path');
const https = require('https');
const { T0_CONFIG, computeT0Daily } = require('./t0_engine.cjs');

const DAILY_FILE = path.join(__dirname, 'data', 't0', 't0_daily.json');

// ============================================================
// 拉取腾讯实时行情（qt.gtimg.cn，与 t0_signal.cjs 同源）
// ============================================================
function fetchQuote() {
  return new Promise((resolve, reject) => {
    const url = `https://qt.gtimg.cn/q=${T0_CONFIG.SYMBOL}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const txt = Buffer.concat(chunks).toString('utf-8');
          const start = txt.indexOf('"');
          const end = txt.lastIndexOf('"');
          if (start < 0 || end <= start) return reject(new Error('行情返回格式异常: ' + txt.slice(0, 80)));
          const fields = txt.slice(start + 1, end).split('~');
          resolve({
            name: fields[1] || '',
            price: parseFloat(fields[3]),
            prev_close: parseFloat(fields[4]),
            open: parseFloat(fields[5]),
            high: parseFloat(fields[33]),
            low: parseFloat(fields[34]),
            time: fields[30] || ''
          });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// 北京时间当前日期（如 2026-08-06）
function beijingDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 北京时间日期时间字符串（秒级，如 2026-08-06 16:00:05）
function beijingNowStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  console.log('='.repeat(52));
  console.log('  515180 做T每日记录更新');
  console.log('='.repeat(52));

  let quote;
  try {
    quote = await fetchQuote();
    console.log(`  ${quote.name}  当前价: ${quote.price}  开盘: ${quote.open}  高: ${quote.high}  低: ${quote.low}`);
  } catch (e) {
    console.log(`✗ 行情获取失败: ${e.message}`);
    process.exit(1);
  }

  const today = beijingDate();
  const record = computeT0Daily({
    date: today,
    open: quote.open,
    prevClose: quote.prev_close,
    high: quote.high,
    low: quote.low,
    close: quote.price
  });

  // 读取已有记录（首次运行创建）
  let data = { updated_at: '', count: 0, records: [] };
  if (fs.existsSync(DAILY_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DAILY_FILE, 'utf-8')); } catch (e) { data = { updated_at: '', count: 0, records: [] }; }
  }
  if (!Array.isArray(data.records)) data.records = [];

  // 按 date 幂等覆盖
  const idx = data.records.findIndex(r => r.date === record.date);
  if (idx >= 0) data.records[idx] = record; else data.records.push(record);
  // 按日期升序排列（前端倒序展示）
  data.records.sort((a, b) => a.date < b.date ? -1 : 1);

  // 重算累计净利（跳过/未触发 net=0 计入，待收盘行不累计）
  let cum = 0;
  data.records.forEach(r => {
    if (typeof r.net === 'number') { cum += r.net; r.cum_net = Math.round(cum * 100) / 100; }
    else r.cum_net = null;
  });

  data.count = data.records.length;
  data.updated_at = beijingNowStr();
  fs.mkdirSync(path.dirname(DAILY_FILE), { recursive: true });
  fs.writeFileSync(DAILY_FILE, JSON.stringify(data, null, 2), 'utf-8');

  console.log(`\n✓ 每日记录已更新: 共 ${data.count} 条`);
  console.log(`  今日(${record.date}): ${record.status}  买${record.buy_p} 卖${record.sell_p}`);
  console.log(`  更新于: ${data.updated_at}`);
}

main().catch(e => {
  console.error('运行异常:', e.message);
  process.exit(1);
});
