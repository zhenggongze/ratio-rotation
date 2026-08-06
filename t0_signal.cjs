// 做T每日信号脚本
// 用法:
//   node t0_signal.cjs                    # 拉取行情算信号，保存 t0_signal.json，输出文本
//   node t0_signal.cjs --push             # 同时推送 PushDeer（GitHub Actions 用）
// 数据源: 腾讯实时行情 qt.gtimg.cn（与 t0-strategy daily_signal.py 一致）
const fs = require('fs');
const path = require('path');
const https = require('https');
const { T0_CONFIG, computeT0Signal, loadBacktestJson } = require('./t0_engine.cjs');

// 尝试加载 .env（本地开发用，GitHub Actions 用环境变量）
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) { /* dotenv 未安装时降级 */ }

const SIGNAL_FILE = path.join(__dirname, 'data', 't0', 't0_signal.json');
const PUSHDEER_KEY = process.env.PUSHDEER_KEY || '';
const PUSHDEER_URL = process.env.PUSHDEER_URL || 'https://api2.pushdeer.com/message/push';

// ============================================================
// 拉取腾讯实时行情
// ============================================================
function fetchQuote() {
  return new Promise((resolve, reject) => {
    const url = `https://qt.gtimg.cn/q=${T0_CONFIG.SYMBOL}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          // 腾讯接口返回 GBK 编码，需转 UTF-8（股票代码字段是 ASCII，直接 toString 也够用）
          const txt = buf.toString('utf-8');
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
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ============================================================
// 判断当前时段
// ============================================================
function currentPhase() {
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes() + 8 * 60; // UTC → 北京时间
  const total = hm % (24 * 60);
  if (9 * 60 + 15 <= total && total < 9 * 60 + 26) return 'collection';      // 集合竞价中
  if (9 * 60 + 26 <= total && total <= 9 * 60 + 40) return 'open_set';       // 竞价已定格
  return 'other';                                                            // 其他时段
}

// ============================================================
// 格式化信号文本（推送/展示用）
// ============================================================
function formatSignalText(sig, phaseLabel) {
  const L = [];
  L.push(`【515180 红利ETF · 做T挂单信号】`);
  L.push(`━━━━━━━━━━━━━━━━━━`);
  L.push(`时间: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (UTC)`);
  if (phaseLabel) L.push(`时段: ${phaseLabel}`);
  L.push(`昨收: ${sig.prev_close.toFixed(3)}`);
  L.push(`今开: ${sig.open.toFixed(3)} (跳空 ${sig.gap_pct >= 0 ? '+' : ''}${sig.gap_pct}%)`);
  L.push(`━━━━━━━━━━━━━━━━━━`);
  if (sig.skip) {
    L.push(`⚠ ${sig.skip_reason}`);
  } else {
    L.push(`【买入监控价】 ${sig.buy_p.toFixed(3)}  (开盘×${T0_CONFIG.BUY_K})`);
    L.push(`【卖出监控价】 ${sig.sell_p.toFixed(3)}  (开盘×${T0_CONFIG.SELL_K})`);
    L.push(`委托数量: ${sig.shares.toLocaleString()} 股`);
    L.push(`买入金额约: ${sig.buy_amt.toLocaleString()} 元`);
    L.push(`卖出金额约: ${sig.sell_amt.toLocaleString()} 元`);
    L.push(`━━━━━━━━━━━━━━━━━━`);
    L.push(`操作: 条件单→日内先买后卖`);
    L.push(`  先买=${sig.buy_p.toFixed(3)} 后卖=${sig.sell_p.toFixed(3)}`);
    L.push(`  市价委托(对手方最优) 当日有效`);
    L.push(`14:50 若只买未卖→手动卖出等量当日了结`);
  }
  L.push(`━━━━━━━━━━━━━━━━━━`);
  return L.join('\n');
}

// ============================================================
// 推送 PushDeer
// ============================================================
async function pushDeer(text) {
  if (!PUSHDEER_KEY) {
    console.log('  ⚠ 未配置 PUSHDEER_KEY，跳过推送');
    return { success: false, error: 'no key' };
  }
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ pushkey: PUSHDEER_KEY, text: text, desp: '', type: 'markdown' });
    const url = `${PUSHDEER_URL}?${params.toString()}`;
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          resolve({ success: json.code === 0, error: json.error || json.content || d });
        } catch (e) {
          resolve({ success: false, error: d.slice(0, 100) });
        }
      });
    }).on('error', reject);
  });
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const doPush = process.argv.includes('--push');
  const dateArg = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  // 用北京时间日期（UTC+8），确保与 A 股交易日一致
  const beijingNow = new Date(Date.now() + 8 * 3600 * 1000);
  const today = dateArg || beijingNow.toISOString().slice(0, 10);

  console.log('='.repeat(52));
  console.log(`  515180 红利ETF 做T信号  ${today}`);
  console.log('='.repeat(52));

  // 拉取行情
  let quote;
  try {
    quote = await fetchQuote();
    console.log(`  ${quote.name}  当前价: ${quote.price}  昨收: ${quote.prev_close}`);
  } catch (e) {
    console.log(`✗ 行情获取失败: ${e.message}`);
    process.exit(1);
  }

  // 选择开盘价（9:25 后优先用开盘价，否则用当前价）
  const phase = currentPhase();
  let phaseLabel = '';
  if (phase === 'collection') phaseLabel = '集合竞价中(动态价)';
  else if (phase === 'open_set') phaseLabel = '竞价已定格(开盘价确定)';
  else phaseLabel = '非竞价时段(参考价)';

  const openPrice = (phase === 'open_set' || phase === 'other') && quote.open > 0 ? quote.open : quote.price;
  const sig = computeT0Signal(openPrice, quote.prev_close);
  if (sig.error) {
    console.log(`✗ 信号计算失败: ${sig.error}`);
    process.exit(1);
  }

  const text = formatSignalText(sig, phaseLabel);
  console.log('\n' + text);

  // 保存信号文件
  const payload = {
    date: today,
    generated_at: new Date().toISOString(),
    phase: phaseLabel,
    signal: {
      ...sig,
      current_price: quote.price,
      high: quote.high,
      low: quote.low,
      quote_time: quote.time
    }
  };
  fs.mkdirSync(path.dirname(SIGNAL_FILE), { recursive: true });
  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`\n✓ 信号已保存: ${SIGNAL_FILE}`);

  // 推送
  if (doPush) {
    console.log('\n推送 PushDeer...');
    const r = await pushDeer(text);
    if (r.success) {
      console.log('  ✓ 推送成功');
    } else {
      console.log(`  ✗ 推送失败: ${r.error}`);
      process.exit(1);
    }
  }

  // 输出 JSON 摘要供 workflow 提取
  console.log('\nSIGNAL_SUMMARY=' + JSON.stringify({ date: today, skip: sig.skip, buy_p: sig.buy_p, sell_p: sig.sell_p, shares: sig.shares }));
}

main().catch(e => {
  console.error('运行异常:', e.message);
  process.exit(1);
});
