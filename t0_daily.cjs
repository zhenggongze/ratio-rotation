// 做T每日记录生成脚本（16:00 收盘后由 daily_rotation workflow 调用）
// 功能：拉取当日行情+1分钟K线 → 分钟级真实判定当日做T记录（与历史回测同一口径）→ 追加/覆盖到 t0_daily.json（按 date 幂等）
// 口径：收盘后（15:30 后）用腾讯 1 分钟K线（OHLC）经 computeMinuteDaily 判定真实买卖成交，与历史回测 low/high 判定完全一致，无任何日线猜测
// 盘中（北京时间 15:30 前）运行时当日行标记"待收盘"，收盘后运行生成完整成交/盈亏
const fs = require('fs');
const path = require('path');
const https = require('https');
const { T0_CONFIG, computeT0Daily, computeMinuteDaily } = require('./t0_engine.cjs');

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
// 拉取腾讯当日 1 分钟 K 线（mkline，含 OHLC，与历史回测同一判定口径）
// 返回: [{ date, time, open, close, high, low }, ...]（最近320条，含当日全天）
// ============================================================
function fetchM1() {
  return new Promise((resolve, reject) => {
    const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${T0_CONFIG.SYMBOL},m1,,320`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const m1 = json.data && json.data[T0_CONFIG.SYMBOL] && json.data[T0_CONFIG.SYMBOL].m1;
          if (!Array.isArray(m1)) return reject(new Error('1分钟K线数据格式异常'));
          const list = [];
          for (const row of m1) {
            const dt = String(row[0]);
            const open = parseFloat(row[1]), close = parseFloat(row[2]), high = parseFloat(row[3]), low = parseFloat(row[4]);
            if (!dt || isNaN(open) || isNaN(close) || isNaN(high) || isNaN(low) || low <= 0) continue;
            list.push({ date: Number(dt), time: dt.slice(8, 10) + ':' + dt.slice(10, 12), open, close, high, low });
          }
          resolve(list);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ============================================================
// 分钟级单日记录生成（收盘后 15:30 之后调用，与历史回测同一口径 computeMinuteDaily）
// bars: 腾讯 1 分钟 K 线（{date,open,close,high,low}），过滤当日 → 判定真实买卖成交
// ============================================================
function buildMinuteRecord(day, bars, prevClose) {
  const dayCompact = day.replace(/-/g, '');
  const dayBars = bars.filter(b => String(b.date).slice(0, 8) === dayCompact);
  if (dayBars.length === 0) throw new Error('当日 1 分钟K线为空');
  return computeMinuteDaily(day, dayBars, prevClose);
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

  // 北京时间当前时间
  const bjNow = new Date(Date.now() + 8 * 3600 * 1000);
  const bjHm = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes();

  let record;
  if (bjHm < 15 * 60 + 30) {
    // 盘中（15:30 前）：分时未完整，标记"待收盘"占位；收盘后 16:00 workflow 重新运行生成分钟级完整记录
    record = computeT0Daily({
      date: today,
      open: quote.open,
      prevClose: quote.prev_close,
      high: quote.high,
      low: quote.low,
      close: quote.price,
      recoverPrice: null
    });
  } else {
    // 收盘后：拉当日 1 分钟K线（OHLC），分钟级真实判定（与历史回测完全同口径：low/high 判定）
    let m1;
    try {
      m1 = await fetchM1();
    } catch (e) {
      console.log(`✗ 1分钟K线获取失败（分钟级判定必需，拒绝降级为日线猜测）: ${e.message}`);
      process.exit(1);
    }
    record = buildMinuteRecord(today, m1, quote.prev_close);
  }

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
