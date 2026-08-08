// 创业板(159915) 做T每日记录脚本
// 用法:
//   node t0_cyb_daily.cjs              # 拉腾讯当日1分钟K线，判定当日记录（16:00后运行）
//   node t0_cyb_daily.cjs --init       # 用本地 pytdx 1分钟数据(2026-05~08) 初始化历史每日记录
// 输出: data/t0/t0_daily_cyb.json（按 date 幂等覆盖，与红利 t0_daily.json 结构一致）
const fs = require('fs');
const path = require('path');
const https = require('https');
const { CYB_CONFIG, computeMinuteDailyCyb } = require('./t0_engine_cyb.cjs');

const DAILY_FILE = path.join(__dirname, 'data', 't0', 't0_daily_cyb.json');
// 每日记录起点：2026-08-06 起（观察期从该日启用；此前的数据全部归入历史业绩回测，不再出现在每日记录）
const START_DATE = '2026-08-06';

function beijingDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function beijingNowStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function fetchQuote() {
  return new Promise((resolve, reject) => {
    const url = `https://qt.gtimg.cn/q=${CYB_CONFIG.SYMBOL}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const txt = Buffer.concat(chunks).toString('utf-8');
          const start = txt.indexOf('"');
          const end = txt.lastIndexOf('"');
          if (start < 0 || end <= start) return reject(new Error('行情返回格式异常'));
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

// 腾讯当日1分钟K线（OHLC，与回测同一判定口径）
function fetchM1() {
  return new Promise((resolve, reject) => {
    const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${CYB_CONFIG.SYMBOL},m1,,320`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const m1 = json.data && json.data[CYB_CONFIG.SYMBOL] && json.data[CYB_CONFIG.SYMBOL].m1;
          if (!Array.isArray(m1)) return reject(new Error('1分钟K线数据格式异常'));
          const list = [];
          for (const row of m1) {
            const dt = String(row[0]);
            const open = parseFloat(row[1]), close = parseFloat(row[2]), high = parseFloat(row[3]), low = parseFloat(row[4]);
            if (!dt || isNaN(open) || isNaN(close) || isNaN(high) || isNaN(low) || low <= 0) continue;
            list.push({ date: dt, time: dt.slice(8, 10) + ':' + dt.slice(10, 12), open, close, high, low });
          }
          resolve(list);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function loadDaily() {
  let data = { updated_at: '', count: 0, records: [] };
  if (fs.existsSync(DAILY_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DAILY_FILE, 'utf-8')); } catch (e) { data = { updated_at: '', count: 0, records: [] }; }
  }
  if (!Array.isArray(data.records)) data.records = [];
  return data;
}

function saveDaily(data) {
  data.count = data.records.length;
  data.updated_at = beijingNowStr();
  fs.mkdirSync(path.dirname(DAILY_FILE), { recursive: true });
  fs.writeFileSync(DAILY_FILE, JSON.stringify(data, null, 2), 'utf-8');
  return data;
}

function recomputeCum(data) {
  let cum = 0;
  data.records.forEach(r => {
    if (typeof r.net === 'number') { cum += r.net; r.cum_net = Math.round(cum * 100) / 100; }
    else r.cum_net = null;
  });
  return data;
}

// 周末（周六/周日）为 A 股非交易日
function isWeekend(d) {
  const w = new Date(d + 'T00:00:00Z').getUTCDay();
  return w === 0 || w === 6;
}

// ---- 模式1：初始化历史记录（用本地 pytdx 1分钟数据 2026-05~08） ----
function initFromLocal() {
  const src = path.join(__dirname, 'data', 't0', '159915_1min_pytdx.json');
  if (!fs.existsSync(src)) { console.log(`✗ 本地1分钟数据不存在: ${src}`); process.exit(1); }
  const mins = JSON.parse(fs.readFileSync(src, 'utf-8'));
  const byDay = {};
  for (const m of mins) (byDay[m.date] = byDay[m.date] || []).push(m);
  // 每日记录只保留 START_DATE（含）之后，之前的归入历史业绩回测
  const days = Object.keys(byDay).sort().filter(d => d >= START_DATE);
  const data = loadDaily();
  // 清理 START_DATE 之前的旧记录（起点已变更）
  data.records = data.records.filter(r => r.date >= START_DATE);
  const prev = {};
  let prevClose = null;
  // 按日期升序判定，首日 prevClose 用前一天收盘（从行情推算：用当日开盘反推不可靠，首日用 null 会 gap=0）
  // 简化：用每个交易日 T-1 收盘价（从当天 1 分钟数据取最后一根 close 前值）
  const dayList = days.map(d => ({ d, bars: byDay[d].sort((a, b) => a.time < b.time ? -1 : 1) }));
  const closes = {};
  dayList.forEach(x => { closes[x.d] = x.bars[x.bars.length - 1].close; });
  for (let i = 0; i < dayList.length; i++) {
    const { d, bars } = dayList[i];
    const rec = computeMinuteDailyCyb(d, bars, i > 0 ? closes[dayList[i - 1].d] : null);
    const idx = data.records.findIndex(r => r.date === rec.date);
    if (idx >= 0) data.records[idx] = rec; else data.records.push(rec);
  }
  data.records.sort((a, b) => a.date < b.date ? -1 : 1);
  recomputeCum(data);
  saveDaily(data);
  console.log(`✓ 初始化完成: ${data.records.length} 条记录 (${days[0]} ~ ${days[days.length - 1]})`);
}

// ---- 模式2：每日更新（拉腾讯当日） ----
async function updateDaily() {
  console.log('='.repeat(52));
  console.log('  159915 创业板ETF 做T每日记录更新');
  console.log('='.repeat(52));
  // 先加载并清理（无论是否交易日都执行，保证 CI 幂等）：
  //  ① START_DATE 之前的旧记录裁剪（起点=观察期启用日，此前归历史业绩回测）
  //  ② 周末"待收盘"占位记录删除（周末为非交易日）
  const data = loadDaily();
  data.records = data.records.filter(r => r.date >= START_DATE && !(r.status === '待收盘' && isWeekend(r.date)));
  // 周末非交易日：清理后直接保存退出（不生成"待收盘"占位记录）
  if (isWeekend(beijingDate())) {
    recomputeCum(data);
    saveDaily(data);
    console.log('✗ 今日为周末，非交易日，跳过（已清理周末待收盘占位）');
    process.exit(0);
  }
  const quote = await fetchQuote();
  console.log(`  ${quote.name}  当前价: ${quote.price}  开盘: ${quote.open}  高: ${quote.high}  低: ${quote.low}`);

  const today = beijingDate();
  const bjNow = new Date(Date.now() + 8 * 3600 * 1000);
  const bjHm = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes();

  let record;
  if (bjHm < 15 * 60 + 30) {
    // 盘中：待收盘占位（收盘后 workflow 重新运行生成真实记录）
    const open = quote.open > 0 ? quote.open : quote.price;
    const factor = 10 ** CYB_CONFIG.PRICE_DECIMAL;
    const buyP = Math.floor(open * CYB_CONFIG.BUY_K * factor) / factor;
    const sellP = Math.floor(open * CYB_CONFIG.SELL_K * factor) / factor;
    const shares = Math.floor(CYB_CONFIG.CAPITAL / open / 100) * 100 || 100;
    record = {
      date: today, status: '待收盘', prev_close: Math.round(quote.prev_close * 1000) / 1000,
      open: Math.round(open * 1000) / 1000, buy_p: buyP, sell_p: sellP,
      close: quote.price, buy_filled: null, sell_filled: null, gross: null, commission: null,
      trades: null, net: null, hold_pct: null, net_pct: null, excess_pct: null, buy_time: null, sell_time: null
    };
  } else {
    const m1 = await fetchM1();
    const dayCompact = today.replace(/-/g, '');
    const dayBars = m1.filter(b => String(b.date).slice(0, 8) === dayCompact);
    if (dayBars.length === 0) {
      console.log('✗ 当日1分钟K线为空（可能非交易日），跳过');
      process.exit(1);
    }
    record = computeMinuteDailyCyb(today, dayBars, quote.prev_close);
  }

  const idx = data.records.findIndex(r => r.date === record.date);
  if (idx >= 0) data.records[idx] = record; else data.records.push(record);
  data.records.sort((a, b) => a.date < b.date ? -1 : 1);
  recomputeCum(data);
  saveDaily(data);
  console.log(`\n✓ 每日记录已更新: 共 ${data.count} 条`);
  console.log(`  今日(${record.date}): ${record.status}  买${record.buy_p} 卖${record.sell_p}`);
}

const mode = process.argv.includes('--init') ? 'init' : 'daily';
if (mode === 'init') initFromLocal();
else updateDaily().catch(e => { console.error('运行异常:', e.message); process.exit(1); });
