// 红利做T 对标指数数据（5 类差异化：标的自身 / A股风格 / 无风险 / 港股 / 美股 / 黄金）
// 用途：每日记录模块展示「同期涨跌」对标卡片 + 每日列表的「当日上证 / 当日创业板」两列
// 输出：data/t0/t0_bench.json
// 数据源：腾讯行情（A股/港股/ETF 用 fqkline；美股用 usfqkline），与项目 datasource.cjs 同源
const fs = require('fs');
const path = require('path');
const https = require('https');

const BENCH_FILE = path.join(__dirname, 'data', 't0', 't0_bench.json');
const DAILY_FILE = path.join(__dirname, 'data', 't0', 't0_daily.json');
const COUNT = 120;   // 拉取最近 120 个交易日（覆盖每日记录区间并留出基准日）

// 分组顺序即页面卡片顺序；overnight=该市场在北京时间当日早上收盘（隔夜数据）
const INDICES = [
  { key: 'zzhl',   name: '中证红利',     code: 'sh000922',  group: '标的自身',   gkey: 'self',  src: 'cn' },
  { key: 'szhl',   name: '深证红利',     code: 'sz399324',  group: '标的自身',   gkey: 'self',  src: 'cn' },
  { key: 'sh',     name: '上证指数',     code: 'sh000001',  group: 'A股风格',    gkey: 'a',     src: 'cn' },
  { key: 'hs300',  name: '沪深300',      code: 'sh000300',  group: 'A股风格',    gkey: 'a',     src: 'cn' },
  { key: 'cyb',    name: '创业板指',     code: 'sz399006',  group: 'A股风格',    gkey: 'a',     src: 'cn' },
  { key: 'kc50',   name: '科创50',       code: 'sh000688',  group: 'A股风格',    gkey: 'a',     src: 'cn' },
  { key: 'bond',   name: '上证国债指数', code: 'sh000012',  group: '无风险对照', gkey: 'bond',  src: 'cn' },
  { key: 'hsi',    name: '恒生指数',     code: 'hkHSI',     group: '港股',       gkey: 'hk',    src: 'cn' },
  { key: 'hstech', name: '恒生科技',     code: 'hkHSTECH',  group: '港股',       gkey: 'hk',    src: 'cn' },
  { key: 'spx',    name: '标普500',      code: 'usINX',     group: '美股',       gkey: 'us',    src: 'us', overnight: true },
  { key: 'ndx',    name: '纳斯达克100',  code: 'usNDX',     group: '美股',       gkey: 'us',    src: 'us', overnight: true },
  { key: 'gold',   name: '黄金ETF',      code: 'sh518880',  group: '黄金',       gkey: 'gold',  src: 'cn' }
];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    }).on('error', reject);
  });
}

// 拉取日线：A股/港股/ETF 用 fqkline；美股用 usfqkline
async function fetchKline(idx) {
  const host = idx.src === 'us' ? 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get' : 'https://ifzq.gtimg.cn/appstock/app/fqkline/get';
  const txt = await httpGet(`${host}?param=${idx.code},day,,,${COUNT},qfq`);
  const json = JSON.parse(txt);
  const node = json.data && json.data[idx.code];
  const arr = node && (node.qfqday || node.day);
  if (!Array.isArray(arr) || !arr.length) throw new Error(`${idx.code} 无数据`);
  return arr.map(r => ({ date: String(r[0]), close: parseFloat(r[2]) })).filter(r => r.date && isFinite(r.close));
}

function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
const fmtDate = s => s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);

(async () => {
  console.log('='.repeat(64));
  console.log('  红利做T 对标指数数据生成（5 类差异化对标）');
  console.log('='.repeat(64));

  // 1. 逐指数拉取并计算自身日涨跌
  const bars = {};    // key → [{date, close}]
  const pctOf = {};   // key → { date: 当日涨跌% }
  for (const idx of INDICES) {
    const arr = await fetchKline(idx);
    bars[idx.key] = arr;
    const m = {};
    for (let i = 1; i < arr.length; i++) {
      m[arr[i].date] = Math.round((arr[i].close / arr[i - 1].close - 1) * 10000) / 100;
    }
    pctOf[idx.key] = m;
    const last = arr[arr.length - 1];
    console.log(`  ✓ ${idx.name.padEnd(12)} ${idx.code.padEnd(10)} ${arr.length}个交易日，最新 ${last.date} 收 ${last.close}`);
  }

  // 2. A股交易日基准 = 上证指数日期集合（每日记录日期与之对齐）
  const aDates = bars.sh.map(b => b.date);

  // 3. records：每个 A股交易日 → 各指数当日涨跌
  //    - A股/港股/ETF：仅当自身交易日与 A股交易日一致时取值（口径严格）
  //    - 美股（overnight）：取最近一个 ≤ 该日的收盘（即北京时间当日早上的隔夜收盘），并记录其实际日期
  const records = {};
  for (const d of aDates) {
    const rec = {};
    for (const idx of INDICES) {
      const map = pctOf[idx.key];
      if (idx.overnight) {
        const b = bars[idx.key];
        let hit = null;
        for (let i = b.length - 1; i >= 0; i--) { if (b[i].date <= d) { hit = b[i].date; break; } }
        rec[idx.key + '_pct'] = (hit && map[hit] != null) ? map[hit] : null;
        rec[idx.key + '_asof'] = hit;
      } else {
        rec[idx.key + '_pct'] = (map[d] != null) ? map[d] : null;
      }
    }
    records[d] = rec;
  }

  // 4. 同期区间：每日记录首日的前一交易日 → 最新交易日（各指数取自身 ≤ 该日的最近收盘）
  let period = null;
  try {
    const daily = JSON.parse(fs.readFileSync(DAILY_FILE, 'utf-8'));
    const recs = daily.records || [];
    if (recs.length) {
      const start = recs[0].date.replace(/-/g, '');
      const end = recs[recs.length - 1].date.replace(/-/g, '');
      const startKey = fmtDate(start), endKey = fmtDate(end);
      const idxStart = aDates.indexOf(startKey);
      const baseDate = idxStart > 0 ? aDates[idxStart - 1] : null;
      if (baseDate) {
        const lastOnOrBefore = (arr, d) => {
          for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].date <= d) return arr[i]; }
          return null;
        };
        const items = [];
        for (const idx of INDICES) {
          const b = bars[idx.key];
          const eb = lastOnOrBefore(b, endKey);
          const bb = lastOnOrBefore(b, baseDate);
          const pct = (eb && bb && bb.close) ? Math.round((eb.close / bb.close - 1) * 10000) / 100 : null;
          items.push({
            key: idx.key, name: idx.name, group: idx.group, gkey: idx.gkey,
            overnight: !!idx.overnight,
            pct,
            close: eb ? Math.round(eb.close * 10000) / 10000 : null,
            asof: eb ? eb.date : null
          });
        }
        period = { start: startKey, end: endKey, base_date: baseDate, items };
        console.log('\n同期区间: ' + startKey + ' ~ ' + endKey + '（基准日 ' + baseDate + '）');
        for (const it of items) {
          const flag = it.asof === endKey ? '' : `  [数据截至 ${it.asof}]`;
          console.log(`   ${it.name.padEnd(12)} ${String(it.pct).padStart(7)}%${flag}`);
        }
      }
    }
  } catch (e) {
    console.log('  ⚠ 同期区间计算失败（不影响当日数据）:', e.message);
  }

  const out = {
    updated_at: beijingNow(),
    source: 'tencent',
    indices: INDICES.map(i => ({ key: i.key, name: i.name, code: i.code, group: i.group, gkey: i.gkey, overnight: !!i.overnight })),
    period,
    records
  };
  fs.writeFileSync(BENCH_FILE, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`\n✅ 已输出: ${BENCH_FILE}（${Object.keys(records).length} 个交易日 × ${INDICES.length} 个对标指数）`);
})().catch(e => { console.log('✗ 失败:', e.message); process.exit(1); });
