// 年度校准模块
// 规格7.5节：每年1月1日10:00定时运行，检查档位参数是否需要校准
// 防过度拟合纪律：只建议不自动改参；校准窗口固定近5年；单次变动<0.005不建议调整
const fs = require('fs');
const path = require('path');
const { config } = require('./config.cjs');
const { loadData, saveData, backup, log, nowBeijing, addCalibrationLog } = require('./database.cjs');
const { calcPercentile } = require('./stats.cjs');
const { buildCalibrationTemplate, sendPushWithRetry } = require('./pusher.cjs');

// ============================================================
// 计算中位数
// ============================================================
function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ============================================================
// 计算窗口分位数（value在窗口中小于等于的比例）
// 与 stats.cjs 的 calcPercentile 一致：count(<=value) / total
// ============================================================
function percentileInWindow(value, window) {
  return calcPercentile(value, window);
}

// ============================================================
// 计算窗口的第p分位值（p为0~1，如0.05表示第5百分位）
// 用于反推建议值：suggested_buy_top = 窗口5%分位
// ============================================================
function valueAtPercentile(window, p) {
  if (!window || window.length === 0) return 0;
  const sorted = window.slice().sort((a, b) => a - b);
  // 线性插值法
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// ============================================================
// 四舍五入到指定小数位（默认0.001）
// ============================================================
function roundTo(value, step) {
  const s = step || 0.001;
  return Math.round(value / s) * s;
}

// ============================================================
// 获取比值序列
// 优先从 daily_records 获取（运行时数据），否则从 history_data.json 加载（历史初始化数据）
// ============================================================
function getRatioSeries(data) {
  // 优先用 daily_records
  if (data.daily_records && data.daily_records.length > 0) {
    return data.daily_records.map(r => ({
      date: r.date,
      ratio: r.ratio
    }));
  }
  // 回退到 history_data.json
  const histFile = path.join(config.dataDir, 'history_data.json');
  if (fs.existsSync(histFile)) {
    try {
      const raw = fs.readFileSync(histFile, 'utf-8');
      const json = JSON.parse(raw);
      if (json.data && Array.isArray(json.data)) {
        return json.data.map(d => ({
          date: d.date,
          ratio: d.cyb_close / d.hli_close
        }));
      }
    } catch (e) {
      log('ERROR', `读取 history_data.json 失败: ${e.message}`);
    }
  }
  return [];
}

// ============================================================
// 截取窗口内比值序列（windowStart <= date < checkDate）
// 规格7.5节：取最近5年比值序列，窗口至少3年，不足用全部历史
// ============================================================
function getWindowRatios(ratioSeries, checkDate, windowYears) {
  const years = windowYears || config.calibWindowYears;
  const checkYear = parseInt(checkDate.slice(0, 4));
  // 窗口起点：checkDate 前 windowYears 年的1月1日
  // 如 checkDate=2026-01-01, windowYears=5 → windowStart=2021-01-01
  const windowStart = `${checkYear - years}-01-01`;

  let window = ratioSeries.filter(r => r.date >= windowStart && r.date < checkDate);

  // 窗口至少3年，不足用全部历史（checkDate 之前）
  const minDays = 3 * config.tradingDaysPerYear; // 约756个交易日
  if (window.length < minDays) {
    log('WARN', `窗口数据不足 (${window.length} < ${minDays})，回退到全部历史`);
    window = ratioSeries.filter(r => r.date < checkDate);
  }

  return window.map(r => r.ratio);
}

// ============================================================
// 核心校准逻辑
// 规格7.5节：
// 1. 取近5年比值序列
// 2. 计算现行买入上界0.332的窗口分位数、卖出下界0.578的窗口分位数、窗口中位数
// 3. 判定：若 buy_pct ∈ [0.02, 0.10] 且 sell_pct ∈ [0.65, 0.85]
//          且窗口中位数偏离全历史中位数0.45 ≤ ±0.05 → changed=0
//          否则按窗口分位数反推建议值 → changed=1
// 4. 单次建议变动 < 0.005 时不建议调整（防过度拟合）
// ============================================================
function runCalibration(checkDate, data) {
  const ratioSeries = getRatioSeries(data);
  if (ratioSeries.length === 0) {
    log('ERROR', '无比值数据可用于校准');
    return null;
  }

  // 全历史比值（checkDate 之前）
  const allRatios = ratioSeries.filter(r => r.date < checkDate).map(r => r.ratio);
  if (allRatios.length === 0) {
    log('ERROR', `校准日 ${checkDate} 之前无历史数据`);
    return null;
  }

  // 窗口比值序列（近5年）
  const windowRatios = getWindowRatios(ratioSeries, checkDate, config.calibWindowYears);
  if (windowRatios.length === 0) {
    log('ERROR', `窗口内无比值数据`);
    return null;
  }

  // 现行参数
  const buyZoneTopCurrent = config.buyZoneTop;     // 0.332
  const sellZoneBotCurrent = config.sellZoneBottom; // 0.578

  // 计算分位数
  const buyPct = percentileInWindow(buyZoneTopCurrent, windowRatios);
  const sellPct = percentileInWindow(sellZoneBotCurrent, windowRatios);

  // 窗口中位数
  const windowMedian = median(windowRatios);

  // 全历史中位数（实际计算，与 config.calibHistoryMedian=0.45 对比）
  const historyMedianActual = median(allRatios);
  const historyMedianRef = config.calibHistoryMedian; // 0.45

  // 中位数漂移
  const medianDrift = Math.abs(windowMedian - historyMedianRef);

  // 判定是否需要调整
  const buyInRange = buyPct >= config.calibBuyPctMin && buyPct <= config.calibBuyPctMax;
  const sellInRange = sellPct >= config.calibSellPctMin && sellPct <= config.calibSellPctMax;
  const medianStable = medianDrift <= config.calibMedianDriftMax;

  let changed = 0;
  let suggestedBuyTop = null;
  let suggestedSellBot = null;
  let reason = '';

  if (buyInRange && sellInRange && medianStable) {
    // 无需调整
    changed = 0;
    reason = `买入上界${buyZoneTopCurrent}在窗口分位${(buyPct * 100).toFixed(1)}%（合理区间2%~10%），` +
             `卖出下界${sellZoneBotCurrent}在窗口分位${(sellPct * 100).toFixed(1)}%（合理区间65%~85%），` +
             `中位数漂移${medianDrift.toFixed(3)}（≤0.05），参数仍有效`;
  } else {
    // 需要调整，反推建议值
    suggestedBuyTop = roundTo(valueAtPercentile(windowRatios, 0.05), 0.001);
    suggestedSellBot = roundTo(valueAtPercentile(windowRatios, 0.70), 0.001);

    // 防过度拟合：单次建议变动 < 0.005 时不建议调整
    const buyDelta = Math.abs(suggestedBuyTop - buyZoneTopCurrent);
    const sellDelta = Math.abs(suggestedSellBot - sellZoneBotCurrent);

    if (buyDelta < config.calibMinAdjustStep && sellDelta < config.calibMinAdjustStep) {
      changed = 0; // 变动太小，仍不建议调整
      reason = `虽分位偏离合理区间，但建议变动幅度过小（买${buyDelta.toFixed(3)}/卖${sellDelta.toFixed(3)} < 0.005），不建议调整`;
      suggestedBuyTop = null;
      suggestedSellBot = null;
    } else {
      changed = 1;
      const reasons = [];
      if (!buyInRange) {
        reasons.push(`买入上界${buyZoneTopCurrent}在窗口仅处${(buyPct * 100).toFixed(1)}%分位（${buyPct < config.calibBuyPctMin ? '过低' : '过高'}，合理2%~10%），建议${suggestedBuyTop > buyZoneTopCurrent ? '上移' : '下移'}至${suggestedBuyTop.toFixed(3)}`);
      }
      if (!sellInRange) {
        reasons.push(`卖出下界${sellZoneBotCurrent}在窗口处${(sellPct * 100).toFixed(1)}%分位（${sellPct < config.calibSellPctMin ? '过低' : '过高'}，合理65%~85%），建议${suggestedSellBot > sellZoneBotCurrent ? '上移' : '下移'}至${suggestedSellBot.toFixed(3)}`);
      }
      if (!medianStable) {
        reasons.push(`中位数漂移${medianDrift.toFixed(3)} > 0.05（窗口中位数${windowMedian.toFixed(3)} vs 历史${historyMedianRef}）`);
      }
      reason = reasons.join('；');
    }
  }

  // 窗口范围
  const windowStart = `${parseInt(checkDate.slice(0, 4)) - config.calibWindowYears}-01-01`;
  const windowEnd = checkDate; // 校准日当天不计入窗口

  const result = {
    check_date: checkDate,
    window_start: windowStart,
    window_end: windowEnd,
    buy_zone_top_current: buyZoneTopCurrent,
    sell_zone_bot_current: sellZoneBotCurrent,
    buy_zone_top_pct: buyPct,
    sell_zone_bot_pct: sellPct,
    window_median: windowMedian,
    history_median_ref: historyMedianRef,
    history_median_actual: historyMedianActual,
    median_drift: medianDrift,
    suggested_buy_top: suggestedBuyTop,
    suggested_sell_bot: suggestedSellBot,
    changed: changed,
    reason: reason,
    window_size: windowRatios.length,
    history_size: allRatios.length
  };

  log('INFO', `校准完成: changed=${changed}, buy_pct=${(buyPct * 100).toFixed(1)}%, sell_pct=${(sellPct * 100).toFixed(1)}%, median_drift=${medianDrift.toFixed(3)}`);

  return result;
}

// ============================================================
// 写入校准日志到 calibration_log 表
// 规格6.6节 calibration_log 表结构
// ============================================================
function writeCalibrationLog(data, result) {
  const entry = {
    check_date: result.check_date,
    window_start: result.window_start,
    window_end: result.window_end,
    buy_zone_top_current: result.buy_zone_top_current,
    sell_zone_bot_current: result.sell_zone_bot_current,
    buy_zone_top_pct: result.buy_zone_top_pct,
    sell_zone_bot_pct: result.sell_zone_bot_pct,
    window_median: result.window_median,
    suggested_buy_top: result.suggested_buy_top,
    suggested_sell_bot: result.suggested_sell_bot,
    changed: result.changed,
    reason: result.reason,
    created_at: nowBeijing()
  };
  addCalibrationLog(data, entry);
  return entry;
}

// ============================================================
// 命令行入口：check-calibration
// 用法：node calibrate.cjs [check_date]
// 默认 check_date = 今天；测试可传 2026-01-01
// ============================================================
async function calibrateCommand(checkDateArg) {
  const checkDate = checkDateArg || new Date().toISOString().slice(0, 10);

  console.log('='.repeat(60));
  console.log(`年度校准检查 — 校准日: ${checkDate}`);
  console.log('='.repeat(60));

  // 强制备份（规格7.10：校准前强制备份）
  const data = loadData();
  const backupFile = backup('calibration');
  if (backupFile) {
    log('INFO', `校准前备份: ${backupFile}`);
  }

  // 运行校准
  const result = runCalibration(checkDate, data);
  if (!result) {
    console.log('✗ 校准失败：无比值数据');
    return { success: false, error: '无比值数据' };
  }

  // 写入 calibration_log
  const logEntry = writeCalibrationLog(data, result);
  saveData(data);

  // 输出校准报告
  console.log('');
  console.log('─'.repeat(60));
  console.log('校准报告');
  console.log('─'.repeat(60));
  console.log(`窗口范围: ${result.window_start} ~ ${result.window_end}`);
  console.log(`窗口数据量: ${result.window_size} 个交易日 (全历史 ${result.history_size})`);
  console.log(`现行买入上界: ${result.buy_zone_top_current} → 窗口分位 ${(result.buy_zone_top_pct * 100).toFixed(1)}% (合理区间 2%~10%)`);
  console.log(`现行卖出下界: ${result.sell_zone_bot_current} → 窗口分位 ${(result.sell_zone_bot_pct * 100).toFixed(1)}% (合理区间 65%~85%)`);
  console.log(`窗口中位数: ${result.window_median.toFixed(4)}`);
  console.log(`全历史中位数: ${result.history_median_actual.toFixed(4)} (规格参考值 ${result.history_median_ref})`);
  console.log(`中位数漂移: ${result.median_drift.toFixed(4)} (阈值 ≤ 0.05)`);
  console.log('');

  if (result.changed === 0) {
    console.log('✓ 判定: 无需调整 (changed=0)');
  } else {
    console.log('⚠ 判定: 建议调整 (changed=1)');
    console.log(`  建议买入上界: ${result.suggested_buy_top.toFixed(3)} (现行 ${result.buy_zone_top_current})`);
    console.log(`  建议卖出下界: ${result.suggested_sell_bot.toFixed(3)} (现行 ${result.sell_zone_bot_current})`);
  }
  console.log('');
  console.log(`理由: ${result.reason}`);
  console.log('');

  // 推送模板六
  const pushMsg = buildCalibrationTemplate(result);
  console.log('─'.repeat(60));
  console.log('推送内容（模板六）');
  console.log('─'.repeat(60));
  console.log(pushMsg);
  console.log('');

  const pushResult = await sendPushWithRetry(pushMsg, '', 'calibration', data);
  if (pushResult.success) {
    console.log('✓ 校准结果已推送');
  } else {
    console.log('✗ 推送失败:', pushResult.error);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('校准完成');
  console.log('='.repeat(60));

  return { success: true, result, pushResult };
}

// ============================================================
// 单元测试辅助：不写库不推送，仅返回校准结果
// ============================================================
function calibrateOnly(checkDate, data) {
  return runCalibration(checkDate, data);
}

// ============================================================
// 命令行入口
// ============================================================
if (require.main === module) {
  const args = process.argv.slice(2);
  const checkDate = args[0] || null;
  calibrateCommand(checkDate).catch(e => {
    console.error('校准运行异常:', e);
    process.exit(1);
  });
}

module.exports = {
  runCalibration,
  writeCalibrationLog,
  calibrateCommand,
  calibrateOnly,
  median,
  valueAtPercentile,
  percentileInWindow,
  getRatioSeries,
  getWindowRatios
};
