// 主入口文件 — 子命令路由
// 规格第四节：run-daily、run-yearly、check-calibration、show-strategy、
// init-history、init-history-kcb、replay、push-test、set-param、fetch-test、export-excel、backup、confirm-trade
const fs = require('fs');
const path = require('path');
const { config, getStrategyConfig, getKcbStrategyConfig } = require('./config.cjs');
const { loadData, saveData, backup, log, nowBeijing, todayBeijingDate,
  getLatestRecord, getRecordByDate, upsertDailyRecord, addTradeLog,
  addConsistencyLog, listMonthlyArchives, restoreFromMonthlyArchive
} = require('./database.cjs');
const { calcRatio, determineSignal, getDistanceToNextAction } = require('./strategy.cjs');
const { fetchDailyData, fetchHistoryData, fetchKcbDailyData, fetchKcbHistoryData } = require('./datasource.cjs');
const { runBacktest, verifyConsistency, calcDailyReturn, getHliDividendRate, CYB_DAILY_DIV } = require('./engine.cjs');
const { calcYearlyStats, updateYearlyStats, getCurrentStatus, calcPercentile } = require('./stats.cjs');
const { buildDailyPushMessage, sendPushWithRetry, pushTest, buildAlertTemplate } = require('./pusher.cjs');
const { calibrateCommand } = require('./calibrate.cjs');
const { generateHealthReport, formatHealthReport } = require('./health_check.cjs');
const { exportExcel: exportExcelFn } = require('./exporter.cjs');
const { generateChart: generateChartFn } = require('./chart.cjs');
const { exportFrontendData } = require('./export_frontend_data.cjs');
const { isTradingDay, todayBeijing } = require('./trading_day.cjs');

// ============================================================
// 子命令：run-daily
// 规格7.1节：每交易日15:30执行
// 时序：T日收盘后采集数据 → 判定信号 → 计算收益 → 记录 → 推送
// T日推送的是"T+1开盘操作"，T+1日的cyb_weight才是w_target
// 当前生产仅启用 创业板/红利 轮动（科创50/红利已暂停）
// ============================================================
async function runDaily(dateArg, options) {
  options = options || {};
  const skipPush = options.skipPush === true; // catchup补跑时为true，不推送
  const forcePushOnNonTrading = options.forcePushOnNonTrading === true; // 默认false：非交易日不推送休市消息
  const today = dateArg || todayBeijingDate();
  console.log('='.repeat(60));
  console.log(`每日运行 — 日期: ${today}`);
  console.log('='.repeat(60));

  // 策略配置（当前生产仅启用 创业板/红利 轮动；科创50/红利 已暂停使用）
  const strats = [
    {
      name: 'cyb',
      label: '创业板/红利',
      cfg: config,
      dataFile: config.dataFile,
      fetchFn: fetchDailyData,
      stratConfigFn: getStrategyConfig,
      title: '创红轮动',
      idxName: '创',
      idxLabel: '创业板'
    }
  ];

  const results = [];
  const pushParts = []; // 推送消息各策略片段
  let allSkipped = true;
  let hasError = false;
  let errorNote = '';

  for (const strat of strats) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`策略：${strat.label}`);
    console.log('─'.repeat(60));
    const r = await _runDailyForStrategy(today, strat, { skipPush: true });
    results.push({ strat: strat.name, ...r });

    if (r.skipped) {
      // 非交易日：构造休市推送片段
      if (forcePushOnNonTrading && !skipPush) {
        const latest = r.latestRecord;
        if (latest) {
          const pushMsg = buildDailyPushMessage(latest, {
            weightBefore: latest.cyb_weight,
            targetWeight: latest.cyb_weight,
            tiers: 0
          }, null, { title: strat.title, idxName: strat.idxName, cfg: strat.cfg });
          if (pushMsg) {
            // 标注休市
            const weekendMsg = pushMsg.replace(`【${strat.title}】`, `【${strat.title}·休市】`);
            pushParts.push(weekendMsg);
          }
        }
      }
    } else if (r.success) {
      allSkipped = false;
      // 交易日：构造正常推送片段
      const pushMsg = buildDailyPushMessage(r.record, {
        weightBefore: r.wNow,
        targetWeight: r.signal.targetWeight,
        tiers: r.signal.tiers
      }, r.execDate, { title: strat.title, idxName: strat.idxName, cfg: strat.cfg });
      if (pushMsg) pushParts.push(pushMsg);
    } else {
      hasError = true;
      errorNote = r.error || '';
      // 数据异常：构造告警片段（标注具体策略）
      const alertMsg = buildAlertTemplate(today, r.error || '数据异常', { title: strat.title });
      if (alertMsg) pushParts.push(alertMsg);
    }
  }

  // 统一推送
  if (!skipPush && pushParts.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('推送');
    console.log('='.repeat(60));
    const mergedMsg = pushParts.join('\n\n');
    console.log('推送内容:');
    console.log(mergedMsg);

    // 推送日志记录双策略 latestDate
    const pushData = { latestDate: today };
    const pushResult = await sendPushWithRetry(mergedMsg, '', 'daily', pushData);
    if (pushResult.success) {
      console.log('✓ 推送成功');
    } else {
      console.log('✗ 推送失败:', pushResult.error);
    }
  }

  // 同步前端数据（确保 frontend_data.json 包含双策略最新数据）
  try {
    console.log('\n同步前端数据...');
    exportFrontendData();
  } catch (e) {
    log('WARN', `同步前端数据失败: ${e.message}`);
    console.log(`  ⚠ 同步前端数据失败: ${e.message}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('每日运行完成');
  console.log('='.repeat(60));

  // 返回汇总
  return {
    success: !hasError,
    skipped: allSkipped,
    results
  };
}

// ============================================================
// 通用：为单个策略执行 runDaily 流程（不推送，只返回结果与推送片段所需字段）
// strat: { name, cfg, dataFile, fetchFn, stratConfigFn, title, idxName }
// 返回：{ success, skipped, reason, error, record, signal, wNow, execDate, latestRecord }
// ============================================================
async function _runDailyForStrategy(today, strat, options) {
  options = options || {};
  const cfg = strat.cfg;
  const data = loadData(strat.dataFile, strat.stratConfigFn());

  // 第一步：采集当日数据
  console.log('\n[1/6] 采集行情数据...');
  const dailyData = await strat.fetchFn(today);
  if (dailyData.data_ok === 0) {
    const isTradingDay = dailyData.is_trading_day !== false;
    if (!isTradingDay) {
      log('INFO', `[${strat.name}] 非交易日: ${dailyData.note}`);
      console.log(`✓ [${strat.name}] 非交易日: ${dailyData.note}`);
      const latest = getLatestRecord(data);
      saveData(data, strat.dataFile);
      return { success: true, skipped: true, reason: dailyData.note, latestRecord: latest };
    } else {
      log('ERROR', `[${strat.name}] 数据异常: ${dailyData.note}`);
      console.log(`✗ [${strat.name}] 数据异常: ${dailyData.note}`);
      saveData(data, strat.dataFile);
      return { success: false, error: dailyData.note };
    }
  }

  const { cyb_open, cyb_close, hli_open, hli_close } = dailyData;
  const ratio = calcRatio(cyb_close, hli_close);
  console.log(`  ${strat.idxLabel}: 开${cyb_open} 收${cyb_close}`);
  console.log(`  红利:   开${hli_open} 收${hli_close}`);
  console.log(`  比值: ${ratio.toFixed(4)}`);

  // 比值合理性检查
  if (ratio < cfg.ratioMin || ratio > cfg.ratioMax) {
    log('WARN', `[${strat.name}] 比值 ${ratio.toFixed(4)} 超出合理区间 [${cfg.ratioMin}, ${cfg.ratioMax}]`);
  }

  // 第二步：读取T-1日的daily_record
  console.log('\n[2/6] 读取当前权重...');
  const prevRecord = getLatestRecord(data);
  let wYesterday = 0;
  let wNow = 0;

  if (prevRecord) {
    wYesterday = prevRecord.cyb_weight;
    const prevTrade = data.trade_log.find(t => t.signal_date === prevRecord.date && t.confirmed !== 2);
    if (prevTrade && (prevRecord.action === 'BUY' || prevRecord.action === 'SELL')) {
      wNow = prevTrade.weight_after;
      console.log(`  T-1日信号: ${prevRecord.action} ${prevTrade.tiers}档, T日执行调仓`);
      console.log(`  权重变化: ${(wYesterday * 100).toFixed(0)}% → ${(wNow * 100).toFixed(0)}%`);
    } else {
      wNow = wYesterday;
      console.log(`  当前权重: ${(wNow * 100).toFixed(0)}% (无调仓)`);
    }
  } else {
    console.log('  无历史记录，首日运行，权重0%');
  }

  // 第三步：计算T日策略收益
  console.log('\n[3/6] 计算当日收益...');
  const hasTrade = wYesterday !== wNow;
  const prevClose = prevRecord
    ? { cyb: prevRecord.cyb_close, hli: prevRecord.hli_close }
    : { cyb: cyb_open, hli: hli_open };

  const dividends = {
    cyb: CYB_DAILY_DIV,
    hli: getHliDividendRate(today)
  };
  const ret = calcDailyReturn(
    prevClose,
    { cyb: cyb_open, hli: hli_open },
    { cyb: cyb_close, hli: hli_close },
    wYesterday, wNow, hasTrade, dividends
  );

  const prevAsset = prevRecord ? prevRecord.asset_value : cfg.initCapital || config.initCapital;
  const assetValue = prevAsset * (1 + ret.dailyRet);
  console.log(`  隔夜段: ${(ret.overnightRet * 100).toFixed(4)}%`);
  console.log(`  日内段: ${(ret.intradayRet * 100).toFixed(4)}%`);
  console.log(`  当日收益: ${(ret.dailyRet * 100).toFixed(4)}%`);
  console.log(`  期末资产: ${assetValue.toFixed(2)}元`);

  // 第四步：生成T日信号
  console.log('\n[4/6] 判定信号...');
  const signal = determineSignal(ratio, wNow, cfg);
  console.log(`  信号: ${signal.action} ${signal.tiers > 0 ? signal.tiers + '档' : ''}`);
  if (signal.note) console.log(`  说明: ${signal.note}`);

  // 第五步：确定执行日（T+1）
  let execDate = null;
  if (signal.action === 'BUY' || signal.action === 'SELL') {
    execDate = nextTradeDate(today);
    console.log(`  执行日: ${execDate} (T+1开盘)`);
  }

  // 第六步：写入daily_records
  console.log('\n[5/6] 写入每日记录...');
  const cybRet = prevClose.cyb > 0 ? (cyb_close / prevClose.cyb - 1) : 0;
  const hliRet = prevClose.hli > 0 ? (hli_close / prevClose.hli - 1) : 0;

  const record = {
    date: today,
    ratio: Math.round(ratio * 10000) / 10000,
    cyb_open, cyb_close, hli_open, hli_close,
    cyb_weight: wNow,
    hli_weight: 1 - wNow,
    action: signal.action,
    action_tiers: signal.tiers,
    action_amount: signal.amount,
    exec_date: execDate,
    daily_ret: ret.dailyRet,
    cyb_ret: cybRet,
    hli_ret: hliRet,
    asset_value: assetValue,
    signal_note: signal.note,
    data_ok: 1,
    created_at: nowBeijing()
  };
  upsertDailyRecord(data, record);

  // 历史分位
  const allRatios = data.daily_records.map(r => r.ratio);
  record.percentile = calcPercentile(record.ratio, allRatios);

  // 写入trade_log
  if (signal.action === 'BUY' || signal.action === 'SELL') {
    addTradeLog(data, {
      signal_date: today,
      exec_date: execDate,
      direction: signal.action,
      tiers: signal.tiers,
      amount: signal.amount,
      ratio_at_signal: Math.round(ratio * 10000) / 10000,
      weight_before: wNow,
      weight_after: signal.targetWeight,
      confirmed: 0,
      actual_weight_after: null,
      created_at: nowBeijing()
    });
    console.log(`  已写入trade_log: ${signal.action} ${signal.tiers}档`);
  }

  // 更新年别统计
  console.log('\n[6/6] 更新年别统计 & 保存...');
  updateYearlyStats(data, data.daily_records, data.trade_log, cfg.initCapital || config.initCapital);
  saveData(data, strat.dataFile);
  console.log('  数据已保存');

  // 收益自洽校验
  const consistency = verifyConsistency(data.daily_records, cfg.initCapital || config.initCapital);
  if (consistency.alertCount > 0) {
    log('WARN', `[${strat.name}] 自洽校验发现 ${consistency.alertCount} 条告警`);
    for (const alert of consistency.alerts.slice(0, 5)) {
      addConsistencyLog(data, {
        check_time: nowBeijing(),
        check_type: alert.type,
        result: 1,
        detail: `${alert.date}: ${alert.detail}`,
        created_at: nowBeijing()
      });
      console.log(`  ⚠ ${alert.date}: ${alert.detail}`);
    }
    saveData(data, strat.dataFile);
  } else {
    console.log(`  ✓ 全部 ${consistency.totalChecked} 条记录校验通过`);
  }

  return { success: true, skipped: false, record, signal, wNow, execDate };
}

// ============================================================
// 计算下一个交易日（简化版：跳过周末）
// 实际生产中应使用交易日历
// ============================================================
function nextTradeDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+08:00');
  d.setDate(d.getDate() + 1);
  // 跳过周末
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

// ============================================================
// 子命令：catchup（断点恢复）
// 检测 last_run_date 后错过的交易日，依次补跑
// 适用场景：电脑关机/重启/休眠后，定时任务错过的交易日数据补全
// 双策略并行：取创业板/科创50中最早的最后记录日期作为起始检查点
// ============================================================
async function catchup(startDateArg) {
  const today = todayBeijingDate();
  console.log('='.repeat(60));
  console.log(`断点恢复 — 检查错过的交易日 (今日: ${today})`);
  console.log('='.repeat(60));

  // 双策略：分别读取最新记录日期，取最早作为起始检查点
  let startCheckDate;
  if (startDateArg) {
    startCheckDate = startDateArg;
  } else {
    const cybData = loadData(config.dataFile, getStrategyConfig());
    const kcbData = loadData(config.kcb.dataFile, getKcbStrategyConfig());
    const cybLatest = getLatestRecord(cybData);
    const kcbLatest = getLatestRecord(kcbData);

    if (!cybLatest && !kcbLatest) {
      console.log('✗ 双策略均无历史记录，请先运行 init-history 和 init-history-kcb');
      return { success: false, error: '无历史记录' };
    }

    // 取两者中较早的最后记录日期
    const dates = [];
    if (cybLatest) dates.push(cybLatest.date);
    if (kcbLatest) dates.push(kcbLatest.date);
    const earliestDate = dates.sort()[0];
    startCheckDate = nextTradeDate(earliestDate);

    console.log(`  创业板最后记录: ${cybLatest ? cybLatest.date : '无'}`);
    console.log(`  科创50最后记录: ${kcbLatest ? kcbLatest.date : '无'}`);
    console.log(`  起始检查日期: ${startCheckDate}`);
  }

  // 生成需要补跑的交易日列表（不含今日，因为今日由正常定时任务处理）
  const missedDates = [];
  let checkDate = startCheckDate;
  while (checkDate < today) {
    const dayOfWeek = new Date(checkDate + 'T00:00:00+08:00').getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      missedDates.push(checkDate);
    }
    const d = new Date(checkDate + 'T00:00:00+08:00');
    d.setDate(d.getDate() + 1);
    checkDate = d.toISOString().slice(0, 10);
  }

  if (missedDates.length === 0) {
    console.log('✓ 无错过的交易日，数据已是最新');
    return { success: true, missed: 0 };
  }

  console.log(`\n发现 ${missedDates.length} 个错过的交易日:`);
  missedDates.forEach(d => console.log(`  - ${d}`));
  console.log('');

  // 备份当前数据（仅备份创业板主文件，科创50由各自 saveData 内部处理）
  const backupFile = backup('catchup-before');
  console.log(`✓ 已备份创业板数据: ${backupFile}\n`);

  // 依次补跑（补跑时不推送，避免用户收到过期通知）
  // runDaily 已支持双策略并行，会同时补跑创业板+科创50
  const results = [];
  for (const date of missedDates) {
    console.log(`\n[${results.length + 1}/${missedDates.length}] 补跑 ${date}...`);
    try {
      const result = await runDaily(date, { skipPush: true });
      results.push({ date, ...result });
    } catch (e) {
      console.log(`✗ 补跑 ${date} 失败: ${e.message}`);
      log('ERROR', `catchup 补跑 ${date} 失败: ${e.message}`);
      results.push({ date, success: false, error: e.message });
    }
  }

  // 汇总
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  console.log('\n' + '='.repeat(60));
  console.log(`断点恢复完成: 成功 ${successCount} 个, 失败 ${failCount} 个`);
  console.log('='.repeat(60));

  if (failCount > 0) {
    console.log('\n失败日期:');
    results.filter(r => !r.success).forEach(r => {
      console.log(`  - ${r.date}: ${r.error || r.reason || '未知错误'}`);
    });
  }

  return { success: failCount === 0, results };
}

// ============================================================
// 子命令：init-history
// 规格7.1节补拉机制：用历史数据回放生成daily_records、yearly_stats
// ============================================================
async function initHistory() {
  console.log('='.repeat(60));
  console.log('历史数据初始化');
  console.log('='.repeat(60));

  const histFile = path.join(config.dataDir, 'history_data.json');
  if (!fs.existsSync(histFile)) {
    console.log('✗ 历史数据文件不存在: data/history_data.json');
    console.log('请先运行: python fetch_history.py');
    return { success: false, error: '历史数据文件不存在' };
  }

  // 加载历史数据
  const raw = fs.readFileSync(histFile, 'utf-8');
  const histJson = JSON.parse(raw);
  const historyData = histJson.data || histJson;

  if (!Array.isArray(historyData) || historyData.length === 0) {
    console.log('✗ 历史数据为空');
    return { success: false, error: '历史数据为空' };
  }

  console.log(`历史数据: ${historyData.length} 个交易日`);
  console.log(`数据范围: ${historyData[0].date} ~ ${historyData[historyData.length - 1].date}`);

  // 备份现有数据
  const data = loadData();
  backup('init-history');

  // 运行回测
  console.log('\n开始回放...');
  const result = runBacktest(historyData, config.initCapital);

  // 写入数据
  data.daily_records = result.dailyRecords;
  data.trade_log = result.tradeLog;
  // 显式更新 strategy_config 为当前 config.cjs 中的最新参数（与 initHistoryKcb 保持一致）
  // 否则重新初始化后 strategy_config 仍是旧版本，导致数据与参数不一致
  data.strategy_config = getStrategyConfig();
  data.state = {
    current_weight: result.dailyRecords[result.dailyRecords.length - 1].cyb_weight,
    buy_tiers_used: result.buyCount,
    sell_tiers_used: result.sellCount,
    last_run_date: result.dailyRecords[result.dailyRecords.length - 1].date,
    last_signal_date: result.dailyRecords[result.dailyRecords.length - 1].date
  };

  // 生成年别统计
  updateYearlyStats(data, data.daily_records, data.trade_log, config.initCapital);

  // 运行自洽校验
  console.log('\n运行自洽校验...');
  const consistency = verifyConsistency(data.daily_records, config.initCapital);
  console.log(`  校验记录: ${consistency.totalChecked}`);
  console.log(`  告警数量: ${consistency.alertCount}`);

  saveData(data);

  // 输出结果
  console.log('\n' + '='.repeat(60));
  console.log('初始化完成');
  console.log('='.repeat(60));
  console.log(`总交易日: ${result.tradingDays}`);
  console.log(`期末资产: ${result.finalAsset.toFixed(2)}元`);
  console.log(`总收益: ${(result.totalRet * 100).toFixed(2)}%`);
  console.log(`年化收益: ${(result.annualRet * 100).toFixed(2)}%`);
  console.log(`最大回撤: ${(result.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`总调仓: ${result.tradeCount}次 (买${result.buyCount} 卖${result.sellCount})`);

  // 输出历年收益
  console.log('\n历年收益:');
  for (const stat of data.yearly_stats) {
    console.log(`  ${stat.year}: ${(stat.annual_ret * 100).toFixed(1)}% (买${stat.buy_count} 卖${stat.sell_count})`);
  }

  return { success: true, result };
}

// ============================================================
// 子命令：init-history-kcb
// 科创50/红利策略历史数据初始化
// 在线拉取科创50(sh000688) 历史K线，红利数据复用创业板策略已拉取的数据（保证两策略红利价格一致）
// 起始日期：2020-08-01（科创50指数基准日）
// ============================================================
async function initHistoryKcb() {
  console.log('='.repeat(60));
  console.log('科创50/红利 历史数据初始化');
  console.log('='.repeat(60));

  const startDate = config.kcb.historyStart;
  const endDate = todayBeijingDate();
  console.log(`数据范围: ${startDate} ~ ${endDate}`);

  // 在线拉取科创50历史数据
  console.log('\n[1/4] 在线拉取科创50历史K线...');
  let kcbHistory;
  try {
    const { fetchTencentHistory } = require('./datasource.cjs');
    kcbHistory = await fetchTencentHistory('sh000688', startDate, endDate);
  } catch (e) {
    console.log(`✗ 拉取科创50历史数据失败: ${e.message}`);
    log('ERROR', `init-history-kcb 拉取失败: ${e.message}`);
    return { success: false, error: e.message };
  }

  if (!Array.isArray(kcbHistory) || kcbHistory.length === 0) {
    console.log('✗ 科创50历史数据为空');
    return { success: false, error: '历史数据为空' };
  }
  console.log(`  科创50共 ${kcbHistory.length} 个交易日`);

  // 复用创业板策略已拉取的红利数据（保证两策略红利价格完全一致）
  console.log('  从 ratio_rotation_data.json 复用红利数据...');
  const cybData = loadData(config.dataFile, getStrategyConfig());
  if (!cybData.daily_records || cybData.daily_records.length === 0) {
    console.log('✗ 创业板策略数据不存在，请先运行 init-history');
    return { success: false, error: '创业板策略数据不存在' };
  }
  const hliMap = new Map();
  for (const r of cybData.daily_records) {
    hliMap.set(r.date, { open: r.hli_open, close: r.hli_close, high: r.hli_high, low: r.hli_low });
  }

  // 按日期对齐（字段名复用 cyb_*，实际存科创50数据，便于回测引擎复用）
  const historyData = [];
  for (const c of kcbHistory) {
    const h = hliMap.get(c.date);
    if (h) {
      historyData.push({
        date: c.date,
        cyb_open: c.open, cyb_close: c.close, cyb_high: c.high, cyb_low: c.low,
        hli_open: h.open, hli_close: h.close, hli_high: h.high, hli_low: h.low,
        ratio: Math.round((c.close / h.close) * 10000) / 10000
      });
    }
  }
  console.log(`  对齐后共 ${historyData.length} 个交易日`);
  console.log(`  数据范围: ${historyData[0].date} ~ ${historyData[historyData.length - 1].date}`);

  // 加载/初始化数据文件
  const data = loadData(config.kcb.dataFile, getKcbStrategyConfig());

  // 运行回测（使用 kcb 配置）
  console.log('\n[2/4] 开始回放（使用科创50档位参数）...');
  const result = runBacktest(historyData, config.initCapital, config.kcb);

  // 写入数据
  data.daily_records = result.dailyRecords;
  data.trade_log = result.tradeLog;
  data.strategy_config = getKcbStrategyConfig();
  data.state = {
    current_weight: result.dailyRecords[result.dailyRecords.length - 1].cyb_weight,
    buy_tiers_used: result.buyCount,
    sell_tiers_used: result.sellCount,
    last_run_date: result.dailyRecords[result.dailyRecords.length - 1].date,
    last_signal_date: result.dailyRecords[result.dailyRecords.length - 1].date
  };

  // 生成年别统计
  console.log('\n[3/4] 生成年别统计...');
  updateYearlyStats(data, data.daily_records, data.trade_log, config.initCapital);

  // 自洽校验
  console.log('\n[4/4] 运行自洽校验...');
  const consistency = verifyConsistency(data.daily_records, config.initCapital);
  console.log(`  校验记录: ${consistency.totalChecked}`);
  console.log(`  告警数量: ${consistency.alertCount}`);

  saveData(data, config.kcb.dataFile);
  console.log(`  数据已保存: ${config.kcb.dataFile}`);

  // 同步前端数据
  try {
    console.log('\n同步前端数据...');
    exportFrontendData();
  } catch (e) {
    log('WARN', `同步前端数据失败: ${e.message}`);
  }

  // 输出结果
  console.log('\n' + '='.repeat(60));
  console.log('科创50/红利 初始化完成');
  console.log('='.repeat(60));
  console.log(`总交易日: ${result.tradingDays}`);
  console.log(`期末资产: ${result.finalAsset.toFixed(2)}元`);
  console.log(`总收益: ${(result.totalRet * 100).toFixed(2)}%`);
  console.log(`年化收益: ${(result.annualRet * 100).toFixed(2)}%`);
  console.log(`最大回撤: ${(result.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`总调仓: ${result.tradeCount}次 (买${result.buyCount} 卖${result.sellCount})`);

  // 输出历年收益
  console.log('\n历年收益:');
  for (const stat of data.yearly_stats) {
    console.log(`  ${stat.year}: ${(stat.annual_ret * 100).toFixed(1)}% (买${stat.buy_count} 卖${stat.sell_count})`);
  }

  return { success: true, result };
}

// ============================================================
// 子命令：replay
// 规格11.2节：历史回放验收
// ============================================================
async function replay(args) {
  const startDate = (args && args[0]) || config.historyStart;
  const endDate = (args && args[1]) || config.historyEnd;

  console.log('='.repeat(60));
  console.log(`历史回放: ${startDate} ~ ${endDate}`);
  console.log('='.repeat(60));

  const histFile = path.join(config.dataDir, 'history_data.json');
  if (!fs.existsSync(histFile)) {
    console.log('✗ 历史数据文件不存在: data/history_data.json');
    return { success: false, error: '历史数据文件不存在' };
  }

  const raw = fs.readFileSync(histFile, 'utf-8');
  const histJson = JSON.parse(raw);
  let historyData = histJson.data || histJson;

  // 按日期范围筛选
  historyData = historyData.filter(d => d.date >= startDate && d.date <= endDate);
  console.log(`回放数据: ${historyData.length} 个交易日`);

  // 运行回测
  const result = runBacktest(historyData, config.initCapital);

  // 输出全周期业绩
  console.log('\n' + '='.repeat(60));
  console.log('全周期业绩（规格3.1验收基准）');
  console.log('='.repeat(60));
  console.log(`总收益: ${(result.totalRet).toFixed(2)}倍 (验收目标: 13.82倍)`);
  console.log(`年化收益: ${(result.annualRet * 100).toFixed(2)}% (验收目标: 26.01%)`);
  console.log(`最大回撤: ${(result.maxDrawdown * 100).toFixed(2)}% (验收目标: -45.55%)`);
  console.log(`期末资产: ${result.finalAsset.toFixed(2)}元 (验收目标: 23,711,564.93元)`);
  console.log(`总调仓: ${result.tradeCount}次 (买${result.buyCount} 卖${result.sellCount}) (验收目标: 36次)`);

  // 输出历年收益
  const yearlyStats = calcYearlyStats(result.dailyRecords, result.tradeLog, config.initCapital);
  console.log('\n历年收益（规格3.2验收基准）:');
  console.log('年份  策略收益  红利持有  买入  卖出');
  for (const stat of yearlyStats) {
    console.log(`${stat.year}  ${(stat.annual_ret * 100).toFixed(1)}%  ${(stat.hli_bh_ret * 100).toFixed(1)}%  ${stat.buy_count}  ${stat.sell_count}`);
  }

  // 关键调仓剧本验证
  console.log('\n' + '='.repeat(60));
  console.log('关键调仓剧本验证（规格3.3）');
  console.log('='.repeat(60));

  // 剧本一：2024年V型急跌建仓
  const script1 = result.tradeLog.filter(t => t.signal_date >= '2024-01-25' && t.signal_date <= '2024-01-31' && t.direction === 'BUY');
  console.log(`\n剧本一（2024年V型急跌建仓）:`);
  console.log(`  买入调仓次数: ${script1.length} (预期4次)`);
  for (const t of script1) {
    console.log(`  ${t.signal_date} → ${t.exec_date}: 买${t.tiers}档 (${(t.weight_before * 100).toFixed(0)}%→${(t.weight_after * 100).toFixed(0)}%)`);
  }

  // 剧本二：2026年高位清仓
  const script2 = result.tradeLog.filter(t => t.exec_date >= '2026-01-01' && t.exec_date <= '2026-07-31' && t.direction === 'SELL');
  console.log(`\n剧本二（2026年高位清仓）:`);
  console.log(`  卖出调仓次数: ${script2.length} (预期10次)`);
  for (const t of script2) {
    console.log(`  ${t.signal_date} → ${t.exec_date}: 卖${t.tiers}档 (${(t.weight_before * 100).toFixed(0)}%→${(t.weight_after * 100).toFixed(0)}%)`);
  }

  // 自洽校验
  console.log('\n' + '='.repeat(60));
  console.log('收益自洽校验');
  console.log('='.repeat(60));
  const consistency = verifyConsistency(result.dailyRecords, config.initCapital);
  console.log(`  校验记录: ${consistency.totalChecked}`);
  console.log(`  告警数量: ${consistency.alertCount}`);
  console.log(`  结果: ${consistency.passed ? '✓ 通过' : '✗ 有告警'}`);

  return { success: true, result };
}

// ============================================================
// 子命令：show-strategy
// 规格7.4节：策略汇总展示
// ============================================================
function showStrategy() {
  const data = loadData();
  const stratConf = data.strategy_config || getStrategyConfig();

  console.log('='.repeat(60));
  console.log('策略汇总');
  console.log('='.repeat(60));

  // 现行参数
  console.log('\n现行参数版本:');
  console.log(`  param_version: ${stratConf.param_version}`);
  console.log(`  effective_from: ${stratConf.effective_from}`);
  console.log(`  初始本金: ${stratConf.init_capital}元`);
  console.log(`  每档金额: ${stratConf.tier_amount}元`);
  console.log(`  买入上界: ${stratConf.buy_zone_top}`);
  console.log(`  卖出下界: ${stratConf.sell_zone_bottom}`);
  console.log(`  清仓上界: ${stratConf.sell_zone_top}`);

  // 买入档位表
  console.log('\n' + '─'.repeat(60));
  console.log('买入操作表（20档，比值从高到低）');
  console.log('─'.repeat(60));
  console.log('档位  触发条件    单档操作      累计仓位');
  for (let i = 0; i < stratConf.buy_levels.length; i++) {
    const tier = i + 1;
    const threshold = stratConf.buy_levels[i];
    const cumWeight = (tier * 5);
    console.log(`买${String(tier).padStart(2, ' ')}档  ≤${threshold.toFixed(4)}  买入5%(8万)  ${cumWeight}%`);
  }

  // 卖出档位表
  console.log('\n' + '─'.repeat(60));
  console.log('卖出操作表（20档，比值从低到高）');
  console.log('─'.repeat(60));
  console.log('档位  触发条件    单档操作      剩余仓位');
  for (let i = 0; i < stratConf.sell_levels.length; i++) {
    const tier = i + 1;
    const threshold = stratConf.sell_levels[i];
    const remWeight = 100 - (tier * 5);
    console.log(`卖${String(tier).padStart(2, ' ')}档  ≥${threshold.toFixed(4)}  卖出5%(8万)  ${remWeight}%`);
  }

  // 滞回带说明
  console.log('\n' + '─'.repeat(60));
  console.log('滞回带: 0.332 < 比值 < 0.578，不操作');
  console.log('  历史回测: 无滞回带年化约17.9%，有滞回带约26.1%');
  console.log('  中间70%交易日不操作是收益的重要来源');

  // 策略核心原则
  console.log('\n' + '─'.repeat(60));
  console.log('策略核心原则:');
  console.log('  1. 买卖不对称: 买错拿着等，卖错踏空主升浪，宁可买晚不可卖早');
  console.log('  2. 滞回带过滤震荡噪声');
  console.log('  3. 空仓不等于现金: 空仓创业板即全部持有红利(年化约13%)');
  console.log('  4. 卖出后可能长期等待再买入(历史最长8年)');
  console.log('  5. 历史回测: 2014-07~2026-07 年化26.01%，总收益13.82倍');
  console.log('  6. 失效风险: 创业板长期阴跌时持续亏损，比值中枢漂移需校准');

  // 当前状态
  console.log('\n' + '─'.repeat(60));
  console.log('当前状态:');
  const status = getCurrentStatus(data.daily_records);
  if (status) {
    console.log(`  日期: ${status.date}`);
    console.log(`  比值: ${status.ratio.toFixed(4)} (历史p${(status.percentile * 100).toFixed(0)}分位)`);
    console.log(`  创业板收盘: ${status.cybClose}`);
    console.log(`  红利收盘: ${status.hliClose}`);
    console.log(`  当前仓位: 创业板${(status.cybWeight * 100).toFixed(0)}% 红利${(status.hliWeight * 100).toFixed(0)}%`);
    console.log(`  期末资产: ${status.assetValue.toFixed(2)}元`);

    // 距下一档位
    const distance = getDistanceToNextAction(status.ratio, status.cybWeight);
    if (distance) {
      console.log(`  下一步: ${distance.desc}`);
    }
  } else {
    console.log('  无历史数据，请先运行 init-history');
  }

  return { success: true };
}

// ============================================================
// 子命令：run-yearly
// 规格7.2节：年别统计
// ============================================================
function runYearly() {
  console.log('='.repeat(60));
  console.log('年别统计更新');
  console.log('='.repeat(60));

  const data = loadData();
  updateYearlyStats(data, data.daily_records, data.trade_log, config.initCapital);
  saveData(data);

  console.log('\n历年统计:');
  console.log('年份  年度收益  最大回撤  年初资产  年末资产  均仓  买  卖');
  for (const stat of data.yearly_stats) {
    console.log(
      `${stat.year}  ${(stat.annual_ret * 100).toFixed(1)}%  ` +
      `${(stat.max_drawdown * 100).toFixed(1)}%  ` +
      `${stat.asset_start.toFixed(0)}  ${stat.asset_end.toFixed(0)}  ` +
      `${(stat.avg_weight * 100).toFixed(0)}%  ${stat.buy_count}  ${stat.sell_count}`
    );
  }

  return { success: true };
}

// ============================================================
// 子命令：fetch-test
// 测试数据获取，验证当日数据与已知锚点一致
// ============================================================
async function fetchTest(dateArg) {
  const date = dateArg || todayBeijingDate();
  console.log('='.repeat(60));
  console.log(`数据获取测试 — ${date}`);
  console.log('='.repeat(60));

  console.log('\n采集实时数据...');
  const result = await fetchDailyData(date);
  console.log(`  data_ok: ${result.data_ok}`);
  if (result.note && result.note.length > 0) {
    console.log(`  note: ${result.note.join('; ')}`);
  }
  if (result.data_ok === 1) {
    console.log(`  创业板: 开${result.cyb_open} 收${result.cyb_close}`);
    console.log(`  红利:   开${result.hli_open} 收${result.hli_close}`);
    const ratio = result.cyb_close / result.hli_close;
    console.log(`  比值: ${ratio.toFixed(4)}`);
  }

  return result;
}

// ============================================================
// 子命令：set-param
// 手动更新策略参数（记录版本与理由）
// ============================================================
function setParam(args) {
  const key = args && args[0];
  const value = args && args[1];
  const note = args && args.slice(2).join(' ');

  if (!key || value === undefined) {
    console.log('用法: node main.cjs set-param <key> <value> [note]');
    console.log('可用key: buy_zone_top, sell_zone_bottom, sell_zone_top, init_capital, tier_amount');
    return { success: false, error: '参数不完整' };
  }

  const data = loadData();
  backup('set-param');

  // 更新strategy_config
  const numValue = parseFloat(value);
  if (key === 'buy_zone_top') {
    data.strategy_config.buy_zone_top = numValue;
    config.buyZoneTop = numValue;
  } else if (key === 'sell_zone_bottom') {
    data.strategy_config.sell_zone_bottom = numValue;
    config.sellZoneBottom = numValue;
  } else if (key === 'sell_zone_top') {
    data.strategy_config.sell_zone_top = numValue;
    config.sellZoneTop = numValue;
  } else if (key === 'init_capital') {
    data.strategy_config.init_capital = numValue;
    config.initCapital = numValue;
  } else if (key === 'tier_amount') {
    data.strategy_config.tier_amount = numValue;
    config.tierAmount = numValue;
  } else {
    console.log(`✗ 未知参数: ${key}`);
    return { success: false, error: '未知参数' };
  }

  // 记录版本
  data.strategy_config.param_version = `manual-${nowBeijing().slice(0, 10)}`;
  data.strategy_config.note = note || `手动更新 ${key}=${value}`;

  saveData(data);
  console.log(`✓ 已更新 ${key} = ${value}`);
  console.log(`  版本: ${data.strategy_config.param_version}`);
  console.log(`  说明: ${data.strategy_config.note}`);

  return { success: true };
}

// ============================================================
// 子命令：confirm-trade
// 规格7.6节：实盘执行确认（双轨机制）
// ============================================================
function confirmTrade(args) {
  const signalDate = args && args[0];
  const confirmedStr = args && args[1];
  const actualWeightStr = args && args[2];

  if (!signalDate) {
    console.log('用法: node main.cjs confirm-trade <signal_date> <confirmed:0|1|2> [actual_weight_after]');
    console.log('  confirmed: 0=未确认, 1=已执行, 2=跳过未执行');
    return { success: false, error: '参数不完整' };
  }

  const data = loadData();
  const trade = data.trade_log.find(t => t.signal_date === signalDate);
  if (!trade) {
    console.log(`✗ 未找到信号日 ${signalDate} 的调仓记录`);
    return { success: false, error: '调仓记录不存在' };
  }

  trade.confirmed = parseInt(confirmedStr || '1', 10);
  if (actualWeightStr) {
    trade.actual_weight_after = parseFloat(actualWeightStr);
  }

  saveData(data);
  console.log(`✓ 已确认 ${signalDate} 的调仓记录:`);
  console.log(`  方向: ${trade.direction} ${trade.tiers}档`);
  console.log(`  确认状态: ${trade.confirmed} (0未确认/1已执行/2跳过)`);
  if (trade.actual_weight_after !== null) {
    console.log(`  实际仓位: ${(trade.actual_weight_after * 100).toFixed(0)}% (系统建议 ${(trade.weight_after * 100).toFixed(0)}%)`);
  }

  return { success: true, trade };
}

// ============================================================
// 子命令：notify-failure — 任务失败时推送通知（供 bat 调用）
// 参考 AI 算力新闻项目 workflow_logger.py --finish 的 if:always 机制
// 用途：run_daily.bat 检测到 node 退出码非0时调用，确保用户知道任务失败
// ============================================================
async function notifyFailure(errorMsg) {
  errorMsg = errorMsg || 'run-daily 执行失败（未捕获异常）';
  const msg = [
    '【创红轮动·任务失败】',
    `时间: ${nowBeijing()}`,
    `错误: ${errorMsg}`,
    '请检查 data/logs/daily/run_daily_console.log'
  ].join('\n');

  console.log('推送失败通知...');
  console.log(msg);

  const result = await sendPushWithRetry(msg, '', 'failure');
  if (result.success) {
    console.log('✓ 失败通知已推送');
  } else {
    console.log('✗ 失败通知推送失败:', result.error);
  }
  return result;
}

// ============================================================
// 子命令：health-check — 策略健康度监控
// 用法：node main.cjs health-check [check_date] [cyb|kcb]
// 默认 check_date=今天，策略=创业板
// ============================================================
async function healthCheckCommand(checkDateArg, strategyArg) {
  const checkDate = checkDateArg || nowBeijing().slice(0, 10);
  const isKcb = strategyArg === 'kcb';
  const cfg = isKcb ? config.kcb : config;
  const indexName = isKcb ? '科创50' : '创业板';
  const dataFile = isKcb ? config.kcb.dataFile : config.dataFile;

  console.log('='.repeat(60));
  console.log(`策略健康度监控 — ${indexName}/红利`);
  console.log(`检查日: ${checkDate}`);
  console.log('='.repeat(60));

  const data = loadData();
  // 从 daily_records 构造 ratioSeries
  const allRecords = (data.daily_records || []).map(r => ({
    date: r.date,
    ratio: isKcb ? (r.kcb_ratio || r.ratio) : r.ratio
  })).filter(r => r.ratio > 0);

  // 科创50需要从 kcb_rotation_data.json 读取
  let ratioSeries = allRecords;
  if (isKcb) {
    try {
      const kcbData = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
      ratioSeries = (kcbData.daily_records || []).map(r => ({
        date: r.date,
        ratio: r.ratio
      })).filter(r => r.ratio > 0);
    } catch (e) {
      console.log('✗ 读取科创50数据失败:', e.message);
      return { success: false, error: e.message };
    }
  }

  if (ratioSeries.length === 0) {
    console.log('✗ 无比值数据');
    return { success: false, error: '无数据' };
  }

  const report = generateHealthReport(ratioSeries, checkDate, cfg);
  const reportText = formatHealthReport(report, indexName);

  console.log('');
  console.log(reportText);
  console.log('');
  console.log('='.repeat(60));

  // 推送健康度报告
  const pushResult = await sendPushWithRetry(reportText, '', 'health-check', data);
  if (pushResult.success) {
    console.log('✓ 健康度报告已推送');
  } else {
    console.log('✗ 推送失败:', pushResult.error);
  }

  return { success: true, report, pushResult };
}

// ============================================================
// 子命令：backup
// ============================================================
function backupCommand() {
  const data = loadData();
  const backupFile = backup('manual');
  console.log(`✓ 已备份到: ${backupFile}`);
  return { success: true, backupFile };
}

// ============================================================
// 子命令：list-archives — 列出所有月度归档
// 用途：版本迭代后查看可回滚的历史版本
// ============================================================
function listArchivesCommand() {
  const archives = listMonthlyArchives();
  if (archives.length === 0) {
    console.log('无月度归档');
    return { success: true, archives: [] };
  }
  console.log('='.repeat(60));
  console.log(`月度归档列表 (共 ${archives.length} 个)`);
  console.log('='.repeat(60));
  archives.forEach(f => {
    // 解析月份
    const match = f.match(/^monthly_(\d{4}-\d{2})\.json$/);
    const ym = match ? match[1] : '?';
    console.log(`  - ${ym}  (${f})`);
  });
  console.log('');
  console.log('回滚命令: node main.cjs restore-monthly YYYY-MM');
  return { success: true, archives };
}

// ============================================================
// 子命令：restore-monthly — 从月度归档恢复数据
// 用途：版本迭代导致数据异常时回滚到历史版本
// ============================================================
function restoreMonthlyCommand(yearMonth) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    console.log('✗ 参数格式错误，应为 YYYY-MM，例如: 2026-07');
    return { success: false, error: '参数格式错误' };
  }
  console.log('='.repeat(60));
  console.log(`从月度归档恢复: ${yearMonth}`);
  console.log('='.repeat(60));

  const restored = restoreFromMonthlyArchive(yearMonth);
  if (!restored) {
    console.log(`✗ 月度归档 ${yearMonth} 不存在或恢复失败`);
    return { success: false, error: '归档不存在或恢复失败' };
  }

  console.log(`✓ 已从 monthly_${yearMonth}.json 恢复`);
  console.log(`  记录数: ${restored.daily_records.length}`);
  if (restored.daily_records.length > 0) {
    const first = restored.daily_records[0];
    const last = restored.daily_records[restored.daily_records.length - 1];
    console.log(`  数据范围: ${first.date} ~ ${last.date}`);
  }
  console.log('');
  console.log('注意: 当前数据已覆盖为归档版本，后续需重新运行 catchup 补全到最新');
  return { success: true, restored };
}

// ============================================================
// 子命令：export-excel
// 规格7.7节：导出三张表（每日统计、每年统计、档位操作）
// ============================================================
async function exportExcel(args) {
  const outputPath = args && args[0];
  return exportExcelFn(outputPath);
}

// ============================================================
// 子命令：chart
// 规格7.8节：创业板走势与仓位对应图 + 当前状态卡片
// ============================================================
function chartCommand(args) {
  const outputPath = args && args[0];
  return generateChartFn(outputPath);
}

// ============================================================
// 帮助信息
// ============================================================
function showHelp() {
  console.log('比值轮动交易决策辅助系统');
  console.log('');
  console.log('用法: node main.cjs <command> [args]');
  console.log('');
  console.log('可用命令:');
  console.log('  run-daily [date]          每日运行（采集数据、信号判定、记录、推送）');
  console.log('  catchup [start_date]      断点恢复 — 补跑错过的交易日（关机/重启后使用）');
  console.log('  run-yearly                更新年别统计');
  console.log('  check-calibration [date]  年度校准检查');
  console.log('  health-check [date] [cyb|kcb]  策略健康度监控');
  console.log('  show-strategy             策略汇总展示');
  console.log('  init-history              历史数据初始化回放（创业板/红利）');
  console.log('  init-history-kcb          科创50/红利 历史数据初始化（在线拉取+回测）');
  console.log('  replay [start] [end]      历史回放验收');
  console.log('  push-test                 推送测试');
  console.log('  set-param <key> <value>   设置策略参数');
  console.log('  fetch-test [date]         数据获取测试');
  console.log('  export-excel [output]     Excel导出（三张表）');
  console.log('  chart [output]            生成走势图（HTML）');
  console.log('  backup                    手动备份');
  console.log('  list-archives             列出所有月度归档（版本回滚用）');
  console.log('  restore-monthly <YYYY-MM> 从月度归档恢复数据（版本回滚）');
  console.log('  confirm-trade <date> <0|1|2> [weight]  实盘执行确认');
  console.log('  notify-failure [msg]       推送失败通知（bat 检测到 node 崩溃时调用）');
  console.log('');
  console.log('示例:');
  console.log('  node main.cjs init-history');
  console.log('  node main.cjs init-history-kcb     # 初始化科创50/红利策略历史数据');
  console.log('  node main.cjs run-daily 2026-07-31');
  console.log('  node main.cjs catchup             # 自动检测并补跑错过的交易日');
  console.log('  node main.cjs catchup 2026-07-15  # 从指定日期开始补跑');
  console.log('  node main.cjs list-archives       # 查看可回滚的月度版本');
  console.log('  node main.cjs restore-monthly 2026-07  # 回滚到2026年7月版本');
  console.log('  node main.cjs replay 2014-07-01 2026-07-31');
  console.log('  node main.cjs check-calibration 2026-01-01');
}

// ============================================================
// 主入口
// ============================================================
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const cmdArgs = args.slice(1);

  const commands = {
    'run-daily': () => runDaily(cmdArgs[0]),
    'catchup': () => catchup(cmdArgs[0]),
    'run-yearly': runYearly,
    'check-calibration': () => calibrateCommand(cmdArgs[0]),
    'health-check': () => healthCheckCommand(cmdArgs[0], cmdArgs[1]),
    'show-strategy': showStrategy,
    'init-history': initHistory,
    'init-history-kcb': initHistoryKcb,
    'replay': () => replay(cmdArgs),
    'push-test': pushTest,
    'set-param': () => setParam(cmdArgs),
    'fetch-test': () => fetchTest(cmdArgs[0]),
    'export-excel': () => exportExcel(cmdArgs),
    'chart': () => chartCommand(cmdArgs),
    'backup': backupCommand,
    'list-archives': listArchivesCommand,
    'restore-monthly': () => restoreMonthlyCommand(cmdArgs[0]),
    'confirm-trade': () => confirmTrade(cmdArgs),
    'notify-failure': () => notifyFailure(cmdArgs.join(' '))
  };

  if (!command || !commands[command]) {
    showHelp();
    process.exit(1);
  }

  try {
    const result = await commands[command]();
    // run-daily 内部已处理所有错误（含数据异常告警推送），退出码始终为0
    // 只有未捕获异常（走 catch 分支）才退出码1，触发 bat 的 notify-failure
    if (command === 'run-daily') {
      process.exit(0);
    }
    process.exit(result && result.success === false ? 1 : 0);
  } catch (e) {
    console.error('运行异常:', e.message);
    log('ERROR', `命令 ${command} 运行异常: ${e.message}`);
    process.exit(1);
  }
}

main();
