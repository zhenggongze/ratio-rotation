// PushDeer 推送模块
// 规格7.3节：8个推送模板，纯文本，精简不超过150字
// 接口：POST https://api2.pushdeer.com/message/push
// 参数：pushkey、text、desp(可选)、type=text
// 支持双策略：创业板/红利 + 科创50/红利（通过 opts 参数切换）
const https = require('https');
const { config } = require('./config.cjs');
const { log, nowBeijing, addPushLog } = require('./database.cjs');
const { getDistanceToNextAction } = require('./strategy.cjs');

// ============================================================
// 发送 PushDeer 推送
// ============================================================
function sendPush(text, desp, msgType) {
  const key = config.pushdeer.key;
  if (!key) {
    log('WARN', 'PUSHDEER_KEY 未配置，跳过推送');
    return { success: false, error: 'PUSHDEER_KEY 未配置' };
  }

  const payload = JSON.stringify({
    pushkey: key,
    text: text,
    desp: desp || '',
    type: 'text'
  });

  const options = {
    hostname: 'api2.pushdeer.com',
    path: '/message/push',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0) {
            log('INFO', `推送成功: ${msgType || 'daily'}`);
            resolve({ success: true, response: json });
          } else {
            log('ERROR', `推送失败: ${json.message || data}`);
            resolve({ success: false, error: json.message || data });
          }
        } catch (e) {
          log('ERROR', `推送响应解析失败: ${e.message}`);
          resolve({ success: false, error: e.message });
        }
      });
    });

    req.on('error', (e) => {
      log('ERROR', `推送请求失败: ${e.message}`);
      resolve({ success: false, error: e.message });
    });

    req.write(payload);
    req.end();
  });
}

// ============================================================
// 带重试的推送（3次重试：10秒、60秒、300秒）
// ============================================================
async function sendPushWithRetry(text, desp, msgType, data) {
  const maxRetries = config.pushdeer.maxRetries;
  const delays = config.pushdeer.retryDelays;

  for (let i = 0; i < maxRetries; i++) {
    const result = await sendPush(text, desp, msgType);

    if (data) {
      addPushLog(data, {
        push_time: nowBeijing(),
        date: data.latestDate || '',
        msg_type: msgType || 'daily',
        content: text,
        status: result.success ? 'SUCCESS' : 'FAIL',
        error: result.error || '',
        retry_count: i
      });
    }

    if (result.success) {
      return result;
    }

    if (i < maxRetries - 1) {
      const delay = delays[i] * 1000;
      log('WARN', `推送失败，${delays[i]}秒后重试 (${i + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  log('ERROR', `推送连续失败 ${maxRetries} 次: ${msgType}`);
  return { success: false, error: '重试耗尽' };
}

// ============================================================
// 日期格式化辅助
// ============================================================
function formatExecDate(execDate) {
  if (!execDate) return '';
  const d = new Date(execDate + 'T00:00:00+08:00');
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const week = weekdays[d.getDay()];
  return `${month}月${day}日(${week})`;
}

function formatTodayDate(date) {
  if (!date) return '';
  const d = new Date(date + 'T00:00:00+08:00');
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const week = weekdays[d.getDay()];
  return `${month}月${day}日(${week})`;
}

// 格式化涨跌幅（带正负号、百分比）
function fmtPct(n, digits) {
  digits = digits || 2;
  if (n === null || n === undefined || isNaN(n)) return '-';
  const sign = n >= 0 ? '+' : '';
  return sign + (n * 100).toFixed(digits) + '%';
}

// 格式化价格（去掉小数点后多余0）
function fmtPrice(n) {
  if (!n) return '-';
  return Number(n).toFixed(2).replace(/\.?0+$/, '') || '0';
}

// ============================================================
// 计算距下一档的具体距离（绝对值 + 百分比）
// ============================================================
function calcDistanceDesc(ratio, currentWeight, cfg) {
  const distance = getDistanceToNextAction(ratio, currentWeight, cfg);
  if (!distance) return '';

  const threshold = distance.threshold;
  const diff = threshold - ratio;
  const pct = ratio > 0 ? (diff / ratio * 100) : 0;
  const sign = diff >= 0 ? '升' : '跌';

  return `${distance.desc}(距${sign}${Math.abs(diff).toFixed(4)}/${Math.abs(pct).toFixed(1)}%)`;
}

// ============================================================
// 模板一：买入（T+1开盘操作）
// opts: { title, idxName, cfg } — 默认创业板
// ============================================================
function buildBuyTemplate(record, signal, execDate, opts) {
  opts = opts || {};
  const title = opts.title || '创红轮动';
  const idxName = opts.idxName || '创';
  const cfg = opts.cfg || config;
  const dateStr = formatExecDate(execDate);
  const ratio = record.ratio.toFixed(4);
  const weightBefore = (signal.weightBefore !== undefined ? signal.weightBefore : record.cyb_weight);
  const weightAfter = signal.targetWeight;
  const tiers = signal.tiers;
  const amount = (tiers * cfg.tierAmount / 10000).toFixed(0);
  const pct = record.percentile ? 'p' + Math.round(record.percentile * 100) : 'N/A';
  const dailyRetStr = (record.daily_ret !== undefined && record.daily_ret !== null)
    ? fmtPct(record.daily_ret) : '-';

  const distanceDesc = calcDistanceDesc(record.ratio, weightAfter, cfg);

  return [
    `【${title}】${dateStr}开盘买入`,
    `${idxName}${fmtPrice(record.cyb_close)} 红${fmtPrice(record.hli_close)}（比值${ratio}）`,
    `仓位: ${idxName}${(weightBefore * 100).toFixed(0)}%→${(weightAfter * 100).toFixed(0)}% 红利${((1-weightBefore) * 100).toFixed(0)}%→${((1-weightAfter) * 100).toFixed(0)}%（历史${pct}分位）`,
    `当日收益：${dailyRetStr}`,
    `操作建议：买${tiers}档${amount}万`,
    `下档: ${distanceDesc}`
  ].join('\n');
}

// ============================================================
// 模板二：卖出（T+1开盘操作）
// ============================================================
function buildSellTemplate(record, signal, execDate, opts) {
  opts = opts || {};
  const title = opts.title || '创红轮动';
  const idxName = opts.idxName || '创';
  const cfg = opts.cfg || config;
  const dateStr = formatExecDate(execDate);
  const ratio = record.ratio.toFixed(4);
  const weightBefore = (signal.weightBefore !== undefined ? signal.weightBefore : record.cyb_weight);
  const weightAfter = signal.targetWeight;
  const tiers = signal.tiers;
  const amount = (tiers * cfg.tierAmount / 10000).toFixed(0);
  const pct = record.percentile ? 'p' + Math.round(record.percentile * 100) : 'N/A';
  const dailyRetStr = (record.daily_ret !== undefined && record.daily_ret !== null)
    ? fmtPct(record.daily_ret) : '-';

  const distanceDesc = calcDistanceDesc(record.ratio, weightAfter, cfg);

  return [
    `【${title}】${dateStr}开盘卖出`,
    `${idxName}${fmtPrice(record.cyb_close)} 红${fmtPrice(record.hli_close)}（比值${ratio}）`,
    `仓位: ${idxName}${(weightBefore * 100).toFixed(0)}%→${(weightAfter * 100).toFixed(0)}% 红利${((1-weightBefore) * 100).toFixed(0)}%→${((1-weightAfter) * 100).toFixed(0)}%（历史${pct}分位）`,
    `当日收益：${dailyRetStr}`,
    `操作建议：卖${tiers}档${amount}万`,
    `下档: ${distanceDesc}`
  ].join('\n');
}

// ============================================================
// 模板三：滞回带无操作
// ============================================================
function buildHoldTemplate(record, opts) {
  opts = opts || {};
  const title = opts.title || '创红轮动';
  const idxName = opts.idxName || '创';
  const cfg = opts.cfg || config;
  const dateStr = formatTodayDate(record.date);
  const ratio = record.ratio.toFixed(4);
  const weight = (record.cyb_weight * 100).toFixed(0);
  const hliWeight = (100 - parseInt(weight));
  const pct = record.percentile ? 'p' + Math.round(record.percentile * 100) : 'N/A';
  const dailyRetStr = (record.daily_ret !== undefined && record.daily_ret !== null)
    ? fmtPct(record.daily_ret) : '-';

  const distanceDesc = calcDistanceDesc(record.ratio, record.cyb_weight, cfg);

  return [
    `【${title}】${dateStr}`,
    `${idxName}${fmtPrice(record.cyb_close)} 红${fmtPrice(record.hli_close)}（比值${ratio}）`,
    `仓位: ${idxName}${weight}% 红利${hliWeight}%（历史${pct}分位）`,
    `当日收益：${dailyRetStr}`,
    `操作建议：明日无操作`,
    `下档: ${distanceDesc}`
  ].join('\n');
}

// ============================================================
// 模板四：买入区已满仓无操作
// ============================================================
function buildFullHoldTemplate(record, opts) {
  opts = opts || {};
  const title = opts.title || '创红轮动';
  const idxName = opts.idxName || '创';
  const cfg = opts.cfg || config;
  const dateStr = formatTodayDate(record.date);
  const ratio = record.ratio.toFixed(4);
  const pct = record.percentile ? 'p' + Math.round(record.percentile * 100) : 'N/A';
  const dailyRetStr = (record.daily_ret !== undefined && record.daily_ret !== null)
    ? fmtPct(record.daily_ret) : '-';

  const distanceDesc = calcDistanceDesc(record.ratio, 1.0, cfg);

  return [
    `【${title}】${dateStr}`,
    `${idxName}${fmtPrice(record.cyb_close)} 红${fmtPrice(record.hli_close)}（比值${ratio}）`,
    `仓位: ${idxName}100% 红利0%（历史${pct}分位）`,
    `当日收益：${dailyRetStr}`,
    `操作建议：明日无操作`,
    `下档: ${distanceDesc}`
  ].join('\n');
}

// ============================================================
// 模板五：卖出区已清仓无操作
// ============================================================
function buildEmptyTemplate(record, opts) {
  opts = opts || {};
  const title = opts.title || '创红轮动';
  const idxName = opts.idxName || '创';
  const cfg = opts.cfg || config;
  const dateStr = formatTodayDate(record.date);
  const ratio = record.ratio.toFixed(4);
  const pct = record.percentile ? 'p' + Math.round(record.percentile * 100) : 'N/A';
  const dailyRetStr = (record.daily_ret !== undefined && record.daily_ret !== null)
    ? fmtPct(record.daily_ret) : '-';

  const distanceDesc = calcDistanceDesc(record.ratio, 0, cfg);

  return [
    `【${title}】${dateStr}`,
    `${idxName}${fmtPrice(record.cyb_close)} 红${fmtPrice(record.hli_close)}（比值${ratio}）`,
    `仓位: ${idxName}0% 红利100%（历史${pct}分位）`,
    `当日收益：${dailyRetStr}`,
    `操作建议：明日无操作`,
    `下档: ${distanceDesc}`
  ].join('\n');
}

// ============================================================
// 模板六：年度校准结果
// ============================================================
function buildCalibrationTemplate(calibResult) {
  const buyTop = calibResult.buy_zone_top_current;
  const sellBot = calibResult.sell_zone_bot_current;
  const median = calibResult.window_median ? calibResult.window_median.toFixed(2) : 'N/A';
  const historyMedian = config.calibHistoryMedian;

  let suggestion;
  if (calibResult.changed === 0) {
    suggestion = '无需调整';
  } else {
    const buySuggest = calibResult.suggested_buy_top ? calibResult.suggested_buy_top.toFixed(3) : 'N/A';
    const sellSuggest = calibResult.suggested_sell_bot ? calibResult.suggested_sell_bot.toFixed(3) : 'N/A';
    const buyDir = calibResult.suggested_buy_top > buyTop ? '上移' : '下移';
    const sellDir = calibResult.suggested_sell_bot > sellBot ? '上移' : '下移';
    suggestion = `买${buyDir}至${buySuggest} 卖${sellDir}至${sellSuggest}`;
  }

  return [
    `【创红轮动·年度校准】已用近5年数据检查档位`,
    `现行: 买小于等于${buyTop} 卖大于等于${sellBot}`,
    `窗口中位数: ${median} 历史${historyMedian}`,
    `建议: ${suggestion}`,
    `请确认后手动更新参数`
  ].join('\n');
}

// ============================================================
// 模板七：数据告警（真实异常，非非交易日）
// opts: { title, idxName } — 默认创业板
// ============================================================
function buildAlertTemplate(date, alertMsg, opts) {
  opts = opts || {};
  const title = opts.title || '创红轮动';
  const dateStr = formatTodayDate(date);

  return [
    `【${title}·数据异常】${dateStr}`,
    `异常: ${alertMsg}`,
    `今日已跳过信号，待人工复核`,
    `建议: 检查行情源后手动运行`,
    `node main.cjs run-daily ${date}`
  ].join('\n');
}

// ============================================================
// 模板八：月度回顾
// ============================================================
function buildMonthlyTemplate(monthlyStat) {
  const month = monthlyStat.month;
  const startWeight = (monthlyStat.startWeight * 100).toFixed(0);
  const endWeight = (monthlyStat.endWeight * 100).toFixed(0);
  const monthRet = (monthlyStat.monthRet * 100).toFixed(1);
  const ytdRet = (monthlyStat.ytdRet * 100).toFixed(1);
  const ratio = monthlyStat.lastRatio.toFixed(4);
  const pct = (monthlyStat.percentile * 100).toFixed(0);

  let focus;
  if (monthlyStat.lastRatio > config.sellZoneBottom) {
    focus = '距清仓完成继续卖出';
  } else if (monthlyStat.lastRatio > (config.buyZoneTop + config.sellZoneBottom) / 2) {
    focus = '升破0.578进入卖出区';
  } else if (monthlyStat.lastRatio > config.buyZoneTop) {
    focus = '跌破0.332买入';
  } else {
    focus = '继续买入建仓';
  }

  return [
    `【创红轮动·月度回顾】${month}月`,
    `月初仓位${startWeight}% 月末${endWeight}%`,
    `${month}月收益${monthRet.startsWith('-') ? '' : '加'}${monthRet}% 年内加${ytdRet}%`,
    `比值 ${ratio} 历史p${pct}分位`,
    `下月关注: ${focus}`
  ].join('\n');
}

// ============================================================
// 根据当日记录选择推送模板
// record 可选字段：percentile（历史分位，0~1）
// opts: { title, idxName, cfg } — 默认创业板
// ============================================================
function buildDailyPushMessage(record, signal, execDate, opts) {
  if (!record) return null;

  const action = record.action;

  switch (action) {
    case 'BUY':
      return buildBuyTemplate(record, signal || {
        weightBefore: record.cyb_weight,
        targetWeight: record.cyb_weight,
        tiers: record.action_tiers
      }, execDate || record.exec_date, opts);

    case 'SELL':
      return buildSellTemplate(record, signal || {
        weightBefore: record.cyb_weight,
        targetWeight: record.cyb_weight,
        tiers: record.action_tiers
      }, execDate || record.exec_date, opts);

    case 'FULL_HOLD':
      return buildFullHoldTemplate(record, opts);

    case 'EMPTY':
      return buildEmptyTemplate(record, opts);

    case 'HOLD':
    default:
      return buildHoldTemplate(record, opts);
  }
}

// ============================================================
// 推送测试消息
// ============================================================
async function pushTest() {
  const testMsg = [
    '【创红轮动】推送测试',
    `时间: ${nowBeijing()}`,
    '如果您收到此消息，说明推送配置正常',
    'type=text 纯文本格式'
  ].join('\n');

  console.log('发送推送测试消息...');
  console.log('消息内容:');
  console.log(testMsg);
  console.log('');

  const result = await sendPushWithRetry(testMsg, '', 'test');

  if (result.success) {
    console.log('✓ 推送测试成功！请检查手机是否收到消息。');
  } else {
    console.log('✗ 推送测试失败:', result.error);
    console.log('请检查 .env 中的 PUSHDEER_KEY 是否正确配置。');
  }

  return result;
}

module.exports = {
  sendPush,
  sendPushWithRetry,
  buildBuyTemplate,
  buildSellTemplate,
  buildHoldTemplate,
  buildFullHoldTemplate,
  buildEmptyTemplate,
  buildCalibrationTemplate,
  buildAlertTemplate,
  buildMonthlyTemplate,
  buildDailyPushMessage,
  pushTest
};
