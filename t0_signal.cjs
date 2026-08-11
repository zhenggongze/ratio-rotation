// 做T每日信号脚本
// 用法:
//   node t0_signal.cjs                    # 拉取行情算信号，保存 t0_signal.json，输出文本
//   node t0_signal.cjs --push             # 同时推送 PushDeer（GitHub Actions 用）
// 数据源: 腾讯实时行情 qt.gtimg.cn（与 t0-strategy daily_signal.py 一致）
const fs = require('fs');
const path = require('path');
const https = require('https');
const { T0_CONFIG, computeT0Signal, loadBacktestJson } = require('./t0_engine.cjs');
const { sendPushWithRetry } = require('./pusher.cjs');
const { isTradingDay, todayBeijing } = require('./trading_day.cjs');

// 尝试加载 .env（本地开发用，GitHub Actions 用环境变量）
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) { /* dotenv 未安装时降级 */ }

const SIGNAL_FILE = path.join(__dirname, 'data', 't0', 't0_signal.json');

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
  const hm = now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60; // UTC → 北京时间（任何时区一致）
  const total = hm % (24 * 60);
  if (9 * 60 + 15 <= total && total < 9 * 60 + 26) return 'collection';      // 集合竞价中
  if (9 * 60 + 26 <= total && total <= 9 * 60 + 40) return 'open_set';       // 竞价已定格
  return 'other';                                                            // 其他时段
}

// ============================================================
// 北京时间日期字符串（如: 8月6日(周四) 09:25）
// ============================================================
function beijingDateStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const iso = d.toISOString();
  const month = parseInt(iso.slice(5, 7), 10);
  const day = parseInt(iso.slice(8, 10), 10);
  const hour = parseInt(iso.slice(11, 13), 10);
  const minute = iso.slice(14, 16);
  return `${month}月${day}日(${weekdays[d.getUTCDay()]}) ${String(hour).padStart(2, '0')}:${minute}`;
}

// ============================================================
// 格式化信号文本（简洁纯文本，与轮动推送风格一致）
// ============================================================
function formatSignalText(sig) {
  const L = [];
  L.push(`【做T挂单信号】${beijingDateStr()}`);
  if (sig.skip) {
    L.push(`⚠ 低开${Math.abs(sig.gap_pct)}%超2%，按纪律今日不做T不挂单`);
    return L.join('\n');
  }
  const gapDesc = sig.gap_pct > 0 ? `高开${sig.gap_pct}%` : (sig.gap_pct < 0 ? `低开${Math.abs(sig.gap_pct)}%` : '平开');
  const buyPct = ((1 - T0_CONFIG.BUY_K) * 100).toFixed(1);      // v2 买 -0.3%
  const sellPct = ((T0_CONFIG.SELL_K - 1) * 100).toFixed(1);    // v2 卖 +0.8%
  L.push(`昨收${sig.prev_close.toFixed(3)} 今开${sig.open.toFixed(3)}（${gapDesc}）`);
  L.push(`买入：${sig.buy_p.toFixed(3)}（开盘价跌${buyPct}%）`);
  L.push(`卖出：${sig.sell_p.toFixed(3)}（开盘价涨${sellPct}%）`);
  L.push(`「限价委托」+「即时现价」`);
  return L.join('\n');
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

  // 交易日守卫：非交易日（周末/法定节假日/调休）不拉行情、不推送，直接静默退出
  if (!isTradingDay(today)) {
    console.log(`非交易日(${today})，跳过做T信号生成与推送`);
    process.exit(0);
  }

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

  const text = formatSignalText(sig);
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

  // 推送（复用 pusher.cjs：type=text + 3次重试，与轮动推送一致）
  if (doPush) {
    console.log('\n推送 PushDeer...');
    const r = await sendPushWithRetry(text, '', 't0_signal');
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
