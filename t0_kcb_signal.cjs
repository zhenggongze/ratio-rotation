// 科创50(588000) 做T每日信号脚本
// 拉取腾讯实时行情 → 按科创50参数（买1.0%/卖1.4%、高开>3%跳、低开>2%跳、14:00了结）算信号
// 输出: data/t0/t0_signal_kcb.json
const fs = require('fs');
const path = require('path');
const https = require('https');
const { KCB_CONFIG } = require('./t0_engine_kcb.cjs');

try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (e) { /* 可选 */ }

const SIGNAL_FILE = path.join(__dirname, 'data', 't0', 't0_signal_kcb.json');

function fetchQuote() {
  return new Promise((resolve, reject) => {
    const url = `https://qt.gtimg.cn/q=${KCB_CONFIG.SYMBOL}`;
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

function floorN(value, ndigits) {
  const factor = 10 ** ndigits;
  return Math.floor(value * factor) / factor;
}

function computeSignal(openPrice, prevClose) {
  if (!openPrice || openPrice <= 0 || !prevClose || prevClose <= 0) return { error: '行情数据无效' };
  const buyP = floorN(openPrice * KCB_CONFIG.BUY_K, KCB_CONFIG.PRICE_DECIMAL);
  const sellP = floorN(openPrice * KCB_CONFIG.SELL_K, KCB_CONFIG.PRICE_DECIMAL);
  const shares = Math.floor(KCB_CONFIG.CAPITAL / openPrice / 100) * 100 || 100;
  const gapPct = Math.round((openPrice / prevClose - 1) * 10000) / 100;
  // 高开>3% 或 低开>2% → 跳过
  const skipUp = openPrice > prevClose * (1 + KCB_CONFIG.SKIP_UP);
  const skipDrop = openPrice < prevClose * (1 - KCB_CONFIG.SKIP_DROP);
  const skip = skipUp || skipDrop;
  const skipReason = skip
    ? (skipUp ? `高开${gapPct}%超3%，按纪律今日不做T` : `低开${Math.abs(gapPct)}%超2%，按纪律今日不做T`)
    : '';
  return {
    open: Math.round(openPrice * 1000) / 1000,
    prev_close: Math.round(prevClose * 1000) / 1000,
    gap_pct: gapPct,
    buy_p: buyP,
    sell_p: sellP,
    shares: shares,
    buy_amt: Math.round(buyP * shares),
    sell_amt: Math.round(sellP * shares),
    skip: skip,
    skip_reason: skipReason,
    settle_time: KCB_CONFIG.SETTLE_TIME
  };
}

function currentPhase() {
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes() + 8 * 60;
  const total = hm % (24 * 60);
  if (9 * 60 + 15 <= total && total < 9 * 60 + 26) return 'collection';
  if (9 * 60 + 26 <= total && total <= 9 * 60 + 40) return 'open_set';
  return 'other';
}

async function main() {
  console.log('='.repeat(52));
  console.log('  588000 科创50ETF 做T信号');
  console.log('='.repeat(52));
  const quote = await fetchQuote();
  console.log(`  ${quote.name}  当前价: ${quote.price}  昨收: ${quote.prev_close}  开盘: ${quote.open}`);

  const phase = currentPhase();
  const phaseLabel = phase === 'collection' ? '集合竞价中(动态价)' : (phase === 'open_set' ? '竞价已定格(开盘价确定)' : '非竞价时段(参考价)');
  const openPrice = (phase === 'open_set' || phase === 'other') && quote.open > 0 ? quote.open : quote.price;
  const sig = computeSignal(openPrice, quote.prev_close);
  if (sig.error) { console.log(`✗ 信号计算失败: ${sig.error}`); process.exit(1); }

  const buyPct = ((1 - KCB_CONFIG.BUY_K) * 100).toFixed(1);
  const sellPct = ((KCB_CONFIG.SELL_K - 1) * 100).toFixed(1);
  console.log(`  昨收${sig.prev_close} 今开${sig.open} (缺口${sig.gap_pct}%)`);
  console.log(`  买入: ${sig.buy_p}（开盘跌${buyPct}%） | 卖出: ${sig.sell_p}（开盘涨${sellPct}%） | 14:00了结`);
  if (sig.skip) console.log(`  ⚠ ${sig.skip_reason}`);

  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const payload = {
    date: today,
    generated_at: new Date().toISOString(),
    phase: phaseLabel,
    signal: { ...sig, current_price: quote.price, high: quote.high, low: quote.low, quote_time: quote.time }
  };
  fs.mkdirSync(path.dirname(SIGNAL_FILE), { recursive: true });
  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`\n✓ 信号已保存: ${SIGNAL_FILE}`);
}

main().catch(e => { console.error('运行异常:', e.message); process.exit(1); });
