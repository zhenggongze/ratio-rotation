// 数据源模块
// 获取创业板指(399006)与中证红利(000922)行情数据
// 主源：腾讯；备源：中证官网/新浪
// 双源交叉校验，开盘价与收盘价同时采集（V2引擎必需）
const https = require('https');
const http = require('http');
const { config } = require('./config.cjs');
const { log } = require('./database.cjs');

// ============================================================
// 通用 HTTP GET（返回字符串）
// ============================================================
function httpGet(url, options) {
  options = options || {};
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, {
      headers: options.headers || {},
      timeout: options.timeout || 15000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

// ============================================================
// 重试封装
// ============================================================
async function fetchWithRetry(fetchFn, maxRetries, delays) {
  maxRetries = maxRetries || 3;
  delays = delays || [1, 2, 4];
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetchFn();
    } catch (e) {
      lastErr = e;
      if (i < maxRetries - 1) {
        const delay = delays[i] * 1000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ============================================================
// 腾讯实时接口解析
// 接口：https://qt.gtimg.cn/q=sz399006
// 返回格式：v_sz399006="51~创业板指~399006~3343.96~3345.30~3350.00~...";
// 字段（以~分隔）：
//   [0]市场代码 [1]名称 [2]代码 [3]现价/收盘 [4]昨收
//   [5]今开 [6]成交量(手) [7]成交额 [8]最高 [9]最低
// ============================================================
function parseTencentRealtime(text, code) {
  // 提取引号内内容
  const match = text.match(/"([^"]+)"/);
  if (!match) return null;
  const fields = match[1].split('~');
  if (fields.length < 10) return null;
  return {
    code: fields[2],
    name: fields[1],
    price: parseFloat(fields[3]),   // 现价/收盘价
    prevClose: parseFloat(fields[4]), // 昨收
    open: parseFloat(fields[5]),      // 今开
    volume: parseFloat(fields[6]),    // 成交量
    amount: parseFloat(fields[7]),    // 成交额
    high: parseFloat(fields[8]),      // 最高
    low: parseFloat(fields[9])        // 最低
  };
}

// 获取腾讯实时行情
async function fetchTencentRealtime(code) {
  const url = `https://qt.gtimg.cn/q=${code}`;
  const text = await fetchWithRetry(() => httpGet(url));
  return parseTencentRealtime(text, code);
}

// ============================================================
// 腾讯历史K线接口（前复权，分批拉取）
// 接口：https://ifzq.gtimg.cn/appstock/app/fqkline/get
//   ?param=sz399006,day,2014-07-01,2026-12-31,2000,qfq
// 限制：count 最大 2000，超过返回 param error
// 返回 JSON，路径 data[code].day
// 每条格式：[日期, 开, 收, 高, 低, 成交量]
// ============================================================
const HISTORY_BATCH_SIZE = 2000;

async function fetchTencentHistoryBatch(code, startDate, endDate) {
  const url = `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,${startDate},${endDate},${HISTORY_BATCH_SIZE},qfq`;
  const text = await fetchWithRetry(() => httpGet(url));
  const json = JSON.parse(text);
  const stockData = json.data && json.data[code];
  if (!stockData) return [];
  // 优先 qfqday（前复权），降级 day（不复权）
  const dayArr = stockData.qfqday || stockData.day || stockData.qfqdayData || [];
  return dayArr.map(item => ({
    date: item[0],
    open: parseFloat(item[1]),
    close: parseFloat(item[2]),
    high: parseFloat(item[3]),
    low: parseFloat(item[4]),
    volume: parseFloat(item[5]) || 0
  }));
}

// 分批拉取全历史（count上限2000，需用endDate回溯分批）
// 腾讯接口行为：当日期范围超过count时，返回最近count条
// 所以分批策略：第一批拿最近2000条，后续批次用endDate=前批首日前一天回溯
async function fetchTencentHistory(code, startDate, endDate) {
  startDate = startDate || '2014-07-01';
  endDate = endDate || '2026-12-31';
  const all = [];
  let batchEnd = endDate;
  let batchCount = 0;

  while (true) {
    batchCount++;
    const batch = await fetchTencentHistoryBatch(code, startDate, batchEnd);
    if (batch.length === 0) break;

    all.push(...batch);

    // 如果本批不足 BATCH_SIZE，说明已拉完
    if (batch.length < HISTORY_BATCH_SIZE) break;

    // 下一批用 endDate = 本批首日（最早日期）的前一天
    const firstDate = batch[0].date;
    const d = new Date(firstDate);
    d.setDate(d.getDate() - 1);
    const prevEnd = d.toISOString().slice(0, 10);

    // 如果已经早于 startDate，结束
    if (prevEnd < startDate) break;

    batchEnd = prevEnd;

    // 安全阀：最多拉10批
    if (batchCount >= 10) break;
  }

  // 按日期排序去重（分批可能有重叠）
  const seen = new Set();
  const unique = [];
  for (const item of all.sort((a, b) => a.date < b.date ? -1 : 1)) {
    if (!seen.has(item.date)) {
      seen.add(item.date);
      unique.push(item);
    }
  }

  return unique;
}

// ============================================================
// 新浪实时接口（备用源）
// 接口：https://hq.sinajs.cn/list=sz399006（需带 Referer）
// 返回：var hq_str_sz399006="创业板指,3343.96,3345.30,3350.00,...";
// 字段：0名称 1今开 2昨收 3现价/收盘 4最高 5最低 ...
// 注意：新浪的字段顺序与腾讯不同！
// ============================================================
async function fetchSinaRealtime(code) {
  const url = `https://hq.sinajs.cn/list=${code}`;
  const text = await fetchWithRetry(() =>
    httpGet(url, { headers: { Referer: 'https://finance.sina.com.cn' } }));
  const match = text.match(/"([^"]*)"/);
  if (!match) return null;
  const fields = match[1].split(',');
  if (fields.length < 6) return null;
  return {
    code: code,
    name: fields[0],
    open: parseFloat(fields[1]),     // 今开
    prevClose: parseFloat(fields[2]), // 昨收
    price: parseFloat(fields[3]),     // 现价/收盘
    high: parseFloat(fields[4]),      // 最高
    low: parseFloat(fields[5])        // 最低
  };
}

// ============================================================
// 中证红利 000922 价格指数获取
// 主源：腾讯 sh000922（与创业板同接口）
// 备用：中证官网 CSV（接口不稳定，降级时用）
// ============================================================
async function fetchHliRealtime() {
  return fetchTencentRealtime('sh000922');
}

async function fetchHliHistory(startDate, endDate) {
  return fetchTencentHistory('sh000922', startDate, endDate);
}

// ============================================================
// 科创50 sh000688 获取
// ============================================================
async function fetchKcbRealtime() {
  return fetchTencentRealtime('sh000688');
}

async function fetchKcbHistoryData(startDate, endDate) {
  log('INFO', `开始拉取科创50历史数据: ${startDate} ~ ${endDate}`);
  const [kcbHistory, hliHistory] = await Promise.all([
    fetchTencentHistory('sh000688', startDate, endDate),
    fetchHliHistory(startDate, endDate)
  ]);
  log('INFO', `科创50拉取 ${kcbHistory.length} 条, 红利拉取 ${hliHistory.length} 条`);
  if (kcbHistory.length === 0) throw new Error('科创50历史数据拉取为空');
  // 按日期对齐（字段名复用 cyb_*，实际存科创50数据，便于回测引擎复用）
  const hliMap = new Map();
  hliHistory.forEach(h => hliMap.set(h.date, h));
  const aligned = [];
  for (const c of kcbHistory) {
    const h = hliMap.get(c.date);
    if (h) {
      aligned.push({
        date: c.date,
        cyb_open: c.open, cyb_close: c.close, cyb_high: c.high, cyb_low: c.low,
        hli_open: h.open, hli_close: h.close, hli_high: h.high, hli_low: h.low,
        ratio: Math.round((c.close / h.close) * 10000) / 10000
      });
    }
  }
  log('INFO', `科创50对齐后共 ${aligned.length} 个交易日`);
  return aligned;
}

// ============================================================
// 创业板指 399006 获取
// ============================================================
async function fetchCybRealtime() {
  return fetchTencentRealtime('sz399006');
}

async function fetchCybHistory(startDate, endDate) {
  return fetchTencentHistory('sz399006', startDate, endDate);
}

// ============================================================
// 双源交叉校验
// 主源与备用源收盘价差异 > 0.5% 判异常
// ============================================================
function crossValidate(primary, backup) {
  if (!primary || !backup) return { ok: true, skipped: true, reason: '备用源不可用，跳过校验' };
  // 备用源价格无效时跳过校验（不标记主源数据为异常）
  if (!backup.price || backup.price <= 0 || isNaN(backup.price)) return { ok: true, skipped: true, reason: '备用源价格无效，跳过校验' };
  if (!primary.price || primary.price <= 0 || isNaN(primary.price)) return { ok: false, reason: '主源价格无效' };
  const diff = Math.abs(primary.price - backup.price) / backup.price;
  if (diff > config.dualSourceDiffThreshold) {
    return { ok: false, reason: `双源差异 ${(diff * 100).toFixed(2)}% > 0.5%` };
  }
  return { ok: true, diff: diff };
}

// ============================================================
// 获取某交易日完整数据（含双源校验）
// 返回 { date, cyb_open, cyb_close, hli_open, hli_close, ratio, data_ok, note, is_trading_day }
//
// 重要：date 参数决定数据获取方式
//   - date === 今天：使用实时接口（腾讯实时+新浪备用）
//   - date !== 今天：使用历史K线接口（catchup补跑场景）
// 这样catchup补跑历史日期时能获取到正确的历史数据
// ============================================================
async function fetchDailyData(date) {
  const note = [];

  // 非交易日预判（周六/周日）
  const dayOfWeek = new Date(date + 'T00:00:00+08:00').getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return {
      date,
      data_ok: 0,
      is_trading_day: false,
      note: `非交易日(周${'日一二三四五六'[dayOfWeek]})`
    };
  }

  // 判断是今天还是历史日期
  const { todayBeijingDate } = require('./database.cjs');
  const today = todayBeijingDate();
  const isToday = date === today;

  if (!isToday) {
    // 历史日期：使用历史K线接口
    return await fetchDailyDataFromHistory(date);
  }

  // 今天：使用实时接口（原有逻辑）
  let cybPrimary, hliPrimary;
  try {
    [cybPrimary, hliPrimary] = await Promise.all([
      fetchCybRealtime(),
      fetchHliRealtime()
    ]);
  } catch (e) {
    log('ERROR', `腾讯主源获取失败: ${e.message}`);
    return { date, data_ok: 0, is_trading_day: true, note: '主源请求失败' };
  }

  if (!cybPrimary || !hliPrimary) {
    return { date, data_ok: 0, is_trading_day: true, note: '主源返回空数据' };
  }

  // 价格有效性检查（防止非交易日/停牌返回 0 值）
  if (!cybPrimary.price || cybPrimary.price <= 0 || isNaN(cybPrimary.price)) {
    return {
      date,
      data_ok: 0,
      is_trading_day: false,
      note: `创业板价格无效(${cybPrimary.price})，可能非交易日或停牌`
    };
  }
  if (!hliPrimary.price || hliPrimary.price <= 0 || isNaN(hliPrimary.price)) {
    return {
      date,
      data_ok: 0,
      is_trading_day: false,
      note: `红利价格无效(${hliPrimary.price})，可能非交易日或停牌`
    };
  }

  // 备用源：新浪
  let cybBackup = null, hliBackup = null;
  try {
    [cybBackup, hliBackup] = await Promise.all([
      fetchSinaRealtime('sz399006'),
      fetchSinaRealtime('sh000922')
    ]);
  } catch (e) {
    note.push('新浪备用源失败');
  }

  // 双源校验
  let dataOk = 1;
  if (cybBackup) {
    const cybCheck = crossValidate(cybPrimary, cybBackup);
    if (!cybCheck.ok) {
      dataOk = 0;
      note.push(`创业板${cybCheck.reason}`);
    }
  }
  if (hliBackup) {
    const hliCheck = crossValidate(hliPrimary, hliBackup);
    if (!hliCheck.ok) {
      dataOk = 0;
      note.push(`红利${hliCheck.reason}`);
    }
  }

  // 提取开收
  let cybOpen = cybPrimary.open;
  let cybClose = cybPrimary.price;
  let hliOpen = hliPrimary.open;
  let hliClose = hliPrimary.price;

  // 开盘价缺失时用收盘价替代（降级）
  if (!cybOpen || cybOpen === 0) { cybOpen = cybClose; note.push('创业板开盘价缺失,用收盘替代'); }
  if (!hliOpen || hliOpen === 0) { hliOpen = hliClose; note.push('红利开盘价缺失,用收盘替代'); }

  const ratio = cybClose / hliClose;

  // 比值合理性检查
  if (ratio < config.ratioMin || ratio > config.ratioMax) {
    dataOk = 0;
    note.push(`比值${ratio.toFixed(4)}超出合理范围[${config.ratioMin}, ${config.ratioMax}]`);
  }

  return {
    date,
    cyb_open: cybOpen,
    cyb_close: cybClose,
    hli_open: hliOpen,
    hli_close: hliClose,
    ratio: Math.round(ratio * 10000) / 10000, // 保留4位小数
    data_ok: dataOk,
    is_trading_day: true,
    note: note.join('; ')
  };
}

// ============================================================
// 批量拉取历史数据（用于 init-history）
// 返回两指数的日K数组，按日期对齐
// ============================================================
async function fetchHistoryData(startDate, endDate) {
  log('INFO', `开始拉取历史数据: ${startDate} ~ ${endDate}`);

  const [cybHistory, hliHistory] = await Promise.all([
    fetchCybHistory(startDate, endDate),
    fetchHliHistory(startDate, endDate)
  ]);

  log('INFO', `创业板拉取 ${cybHistory.length} 条, 红利拉取 ${hliHistory.length} 条`);

  if (cybHistory.length === 0 || hliHistory.length === 0) {
    throw new Error('历史数据拉取为空');
  }

  // 按日期对齐（取两源都有的日期）
  const hliMap = new Map();
  hliHistory.forEach(h => hliMap.set(h.date, h));

  const aligned = [];
  for (const c of cybHistory) {
    const h = hliMap.get(c.date);
    if (h) {
      aligned.push({
        date: c.date,
        cyb_open: c.open,
        cyb_close: c.close,
        cyb_high: c.high,
        cyb_low: c.low,
        hli_open: h.open,
        hli_close: h.close,
        hli_high: h.high,
        hli_low: h.low,
        ratio: Math.round((c.close / h.close) * 10000) / 10000
      });
    }
  }

  log('INFO', `对齐后共 ${aligned.length} 个交易日`);
  return aligned;
}

// ============================================================
// 从历史K线接口获取指定日期的数据（catchup补跑用）
// 拉取 date~date+2天 的K线，筛选出 date 当天的数据
// ============================================================
async function fetchDailyDataFromHistory(date) {
  try {
    // 拉取 date 到 date+2天 的K线（确保包含 date 当天）
    const d = new Date(date + 'T00:00:00+08:00');
    d.setDate(d.getDate() + 2);
    const endDate = d.toISOString().slice(0, 10);

    const [cybHistory, hliHistory] = await Promise.all([
      fetchTencentHistory('sz399006', date, endDate),
      fetchTencentHistory('sh000922', date, endDate)
    ]);

    // 筛选指定日期的数据
    const cybRecord = cybHistory.find(r => r.date === date);
    const hliRecord = hliHistory.find(r => r.date === date);

    if (!cybRecord || !hliRecord) {
      // 该日期无数据，可能是节假日或停牌
      return {
        date,
        data_ok: 0,
        is_trading_day: false,
        note: `历史K线无${date}数据，可能为非交易日`
      };
    }

    if (!cybRecord.close || cybRecord.close <= 0 || isNaN(cybRecord.close)) {
      return {
        date,
        data_ok: 0,
        is_trading_day: false,
        note: `创业板历史价格无效(${cybRecord.close})`
      };
    }
    if (!hliRecord.close || hliRecord.close <= 0 || isNaN(hliRecord.close)) {
      return {
        date,
        data_ok: 0,
        is_trading_day: false,
        note: `红利历史价格无效(${hliRecord.close})`
      };
    }

    const ratio = cybRecord.close / hliRecord.close;

    // 比值合理性检查
    if (ratio < config.ratioMin || ratio > config.ratioMax) {
      return {
        date,
        data_ok: 0,
        is_trading_day: true,
        note: `比值${ratio.toFixed(4)}超出合理范围[${config.ratioMin}, ${config.ratioMax}]`
      };
    }

    return {
      date,
      cyb_open: cybRecord.open,
      cyb_close: cybRecord.close,
      hli_open: hliRecord.open,
      hli_close: hliRecord.close,
      ratio: Math.round(ratio * 10000) / 10000,
      data_ok: 1,
      is_trading_day: true,
      note: '历史数据补跑'
    };
  } catch (e) {
    log('ERROR', `历史数据获取失败(${date}): ${e.message}`);
    return {
      date,
      data_ok: 0,
      is_trading_day: true,
      note: `历史数据获取失败: ${e.message}`
    };
  }
}

// ============================================================
// 科创50某交易日完整数据采集（实时 + 历史补跑）
// 与 fetchDailyData 同构，仅替换主指数源为 sh000688
// 比值合理性范围使用 kcb 配置（0.10~0.50）
// ============================================================
async function fetchKcbDailyData(date) {
  const note = [];

  // 非交易日预判（周六/周日）
  const dayOfWeek = new Date(date + 'T00:00:00+08:00').getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return {
      date,
      data_ok: 0,
      is_trading_day: false,
      note: `非交易日(周${'日一二三四五六'[dayOfWeek]})`
    };
  }

  // 判断今天还是历史日期
  const { todayBeijingDate } = require('./database.cjs');
  const today = todayBeijingDate();
  const isToday = date === today;

  if (!isToday) {
    return await fetchKcbDailyDataFromHistory(date);
  }

  // 今天：使用实时接口
  let kcbPrimary, hliPrimary;
  try {
    [kcbPrimary, hliPrimary] = await Promise.all([
      fetchKcbRealtime(),
      fetchHliRealtime()
    ]);
  } catch (e) {
    log('ERROR', `科创50腾讯主源获取失败: ${e.message}`);
    return { date, data_ok: 0, is_trading_day: true, note: '主源请求失败' };
  }

  if (!kcbPrimary || !hliPrimary) {
    return { date, data_ok: 0, is_trading_day: true, note: '主源返回空数据' };
  }

  // 价格有效性检查
  if (!kcbPrimary.price || kcbPrimary.price <= 0 || isNaN(kcbPrimary.price)) {
    return {
      date,
      data_ok: 0,
      is_trading_day: false,
      note: `科创50价格无效(${kcbPrimary.price})，可能非交易日或停牌`
    };
  }
  if (!hliPrimary.price || hliPrimary.price <= 0 || isNaN(hliPrimary.price)) {
    return {
      date,
      data_ok: 0,
      is_trading_day: false,
      note: `红利价格无效(${hliPrimary.price})，可能非交易日或停牌`
    };
  }

  // 备用源：新浪
  let kcbBackup = null, hliBackup = null;
  try {
    [kcbBackup, hliBackup] = await Promise.all([
      fetchSinaRealtime('sh000688'),
      fetchSinaRealtime('sh000922')
    ]);
  } catch (e) {
    note.push('新浪备用源失败');
  }

  // 双源校验
  let dataOk = 1;
  if (kcbBackup) {
    const kcbCheck = crossValidate(kcbPrimary, kcbBackup);
    if (!kcbCheck.ok) {
      dataOk = 0;
      note.push(`科创50${kcbCheck.reason}`);
    }
  }
  if (hliBackup) {
    const hliCheck = crossValidate(hliPrimary, hliBackup);
    if (!hliCheck.ok) {
      dataOk = 0;
      note.push(`红利${hliCheck.reason}`);
    }
  }

  // 提取开收（字段名复用 cyb_*，与回测引擎兼容）
  let cybOpen = kcbPrimary.open;
  let cybClose = kcbPrimary.price;
  let hliOpen = hliPrimary.open;
  let hliClose = hliPrimary.price;

  if (!cybOpen || cybOpen === 0) { cybOpen = cybClose; note.push('科创50开盘价缺失,用收盘替代'); }
  if (!hliOpen || hliOpen === 0) { hliOpen = hliClose; note.push('红利开盘价缺失,用收盘替代'); }

  const ratio = cybClose / hliClose;

  // 比值合理性检查（使用 kcb 配置）
  const kcbCfg = config.kcb;
  if (ratio < kcbCfg.ratioMin || ratio > kcbCfg.ratioMax) {
    dataOk = 0;
    note.push(`比值${ratio.toFixed(4)}超出合理范围[${kcbCfg.ratioMin}, ${kcbCfg.ratioMax}]`);
  }

  return {
    date,
    cyb_open: cybOpen,
    cyb_close: cybClose,
    hli_open: hliOpen,
    hli_close: hliClose,
    ratio: Math.round(ratio * 10000) / 10000,
    data_ok: dataOk,
    is_trading_day: true,
    note: note.join('; ')
  };
}

// ============================================================
// 科创50历史K线接口取指定日期数据（catchup 补跑用）
// ============================================================
async function fetchKcbDailyDataFromHistory(date) {
  try {
    const d = new Date(date + 'T00:00:00+08:00');
    d.setDate(d.getDate() + 2);
    const endDate = d.toISOString().slice(0, 10);

    const [kcbHistory, hliHistory] = await Promise.all([
      fetchTencentHistory('sh000688', date, endDate),
      fetchTencentHistory('sh000922', date, endDate)
    ]);

    const kcbRecord = kcbHistory.find(r => r.date === date);
    const hliRecord = hliHistory.find(r => r.date === date);

    if (!kcbRecord || !hliRecord) {
      return {
        date,
        data_ok: 0,
        is_trading_day: false,
        note: `历史K线无${date}数据，可能为非交易日`
      };
    }

    if (!kcbRecord.close || kcbRecord.close <= 0 || isNaN(kcbRecord.close)) {
      return {
        date,
        data_ok: 0,
        is_trading_day: false,
        note: `科创50历史价格无效(${kcbRecord.close})`
      };
    }
    if (!hliRecord.close || hliRecord.close <= 0 || isNaN(hliRecord.close)) {
      return {
        date,
        data_ok: 0,
        is_trading_day: false,
        note: `红利历史价格无效(${hliRecord.close})`
      };
    }

    const ratio = kcbRecord.close / hliRecord.close;
    const kcbCfg = config.kcb;
    if (ratio < kcbCfg.ratioMin || ratio > kcbCfg.ratioMax) {
      return {
        date,
        data_ok: 0,
        is_trading_day: true,
        note: `比值${ratio.toFixed(4)}超出合理范围[${kcbCfg.ratioMin}, ${kcbCfg.ratioMax}]`
      };
    }

    return {
      date,
      cyb_open: kcbRecord.open,
      cyb_close: kcbRecord.close,
      hli_open: hliRecord.open,
      hli_close: hliRecord.close,
      ratio: Math.round(ratio * 10000) / 10000,
      data_ok: 1,
      is_trading_day: true,
      note: '历史数据补跑'
    };
  } catch (e) {
    log('ERROR', `科创50历史数据获取失败(${date}): ${e.message}`);
    return {
      date,
      data_ok: 0,
      is_trading_day: true,
      note: `历史数据获取失败: ${e.message}`
    };
  }
}

module.exports = {
  httpGet,
  fetchWithRetry,
  parseTencentRealtime,
  fetchTencentRealtime,
  fetchTencentHistory,
  fetchSinaRealtime,
  fetchCybRealtime,
  fetchCybHistory,
  fetchHliRealtime,
  fetchHliHistory,
  fetchKcbRealtime,
  fetchKcbHistoryData,
  fetchKcbDailyData,
  fetchKcbDailyDataFromHistory,
  crossValidate,
  fetchDailyData,
  fetchDailyDataFromHistory,
  fetchHistoryData
};
