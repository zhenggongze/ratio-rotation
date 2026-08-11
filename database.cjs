// 数据库模块（JSON 持久化）
// 参照 portfolio-analysis 的原子写入+备份+日志模式
// 替代规格第六节的 SQLite 7张表，用 JSON 数组/对象存储
const fs = require('fs');
const path = require('path');
const { config, getStrategyConfig } = require('./config.cjs');

// ============================================================
// 初始化空数据结构（对应 SQLite 7张表）
// ============================================================
function createEmptyData(stratConfig) {
  return {
    meta: {
      version: '1.1',
      created_at: nowBeijing(),
      last_updated: nowBeijing(),
      record_count: 0
    },
    // 运行时状态（替代 buy_tiers_used / sell_tiers_used 持久化）
    state: {
      current_weight: 0,      // 当前生效权重（T日持有）
      buy_tiers_used: 0,      // 已买入档数
      sell_tiers_used: 0,     // 已卖出档数
      last_run_date: null,    // 最后运行日期
      last_signal_date: null  // 最后信号日期
    },
    // 表三 strategy_config
    strategy_config: stratConfig || getStrategyConfig(),
    // 表一 daily_records（每日记录，按日期升序）
    daily_records: [],
    // 表二 yearly_stats（年别统计）
    yearly_stats: [],
    // 表四 trade_log（调仓日志，按 exec_date 升序）
    trade_log: [],
    // 表五 push_log（推送日志）
    push_log: [],
    // 表六 calibration_log（年度校准日志）
    calibration_log: [],
    // 表七 consistency_log（自洽校验日志）
    consistency_log: []
  };
}

// ============================================================
// 北京时间工具
// ============================================================
function nowBeijing() {
  const now = new Date();
  // 转为北京时间 ISO 字符串
  const beijing = new Date(now.getTime() + config.beijingOffset);
  return beijing.toISOString().slice(0, 19).replace('T', ' ');
}

function todayBeijingDate() {
  const now = new Date();
  const beijing = new Date(now.getTime() + config.beijingOffset);
  return beijing.toISOString().slice(0, 10);
}

// ============================================================
// 确保目录存在
// ============================================================
function ensureDirs() {
  [config.dataDir, config.backupDir, config.logDir, config.logDailyDir, config.logErrorDir]
    .forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}

// ============================================================
// 读取数据
// 恢复优先级：主文件 → 滚动备份(最近30份) → 月度归档(长期) → 重建空数据
// ============================================================
function loadData(filePath, stratConfig) {
  filePath = filePath || config.dataFile;
  ensureDirs();
  if (!fs.existsSync(filePath)) {
    const empty = createEmptyData(stratConfig);
    saveData(empty, filePath);
    return empty;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    // 版本迁移（数据结构升级时自动补全缺失字段）
    return migrateData(data);
  } catch (e) {
    // 仅默认策略文件尝试备份恢复
    if (filePath !== config.dataFile) {
      console.error('[数据库] 文件损坏，重建空数据:', filePath);
      const empty = createEmptyData(stratConfig);
      saveData(empty, filePath);
      return empty;
    }
    // 文件损坏，尝试从备份恢复
    console.error('[数据库] 主文件损坏，尝试备份恢复:', e.message);
    const restored = restoreFromBackup();
    if (restored) return restored;
    // 滚动备份全部失败，尝试从月度归档恢复
    console.error('[数据库] 滚动备份恢复失败，尝试月度归档恢复...');
    const archives = listMonthlyArchives();
    for (let i = archives.length - 1; i >= 0; i--) {
      const ym = archives[i].match(/^monthly_(\d{4}-\d{2})\.json$/);
      if (ym) {
        const restored = restoreFromMonthlyArchive(ym[1]);
        if (restored) return restored;
      }
    }
    console.error('[数据库] 无可用备份（含月度归档），重建空数据');
    const empty = createEmptyData(stratConfig);
    saveData(empty);
    return empty;
  }
}

// ============================================================
// 数据版本迁移 — 自动补全缺失字段，保证向后兼容
// 版本迭代时新增字段在此处补全，避免旧数据加载后缺字段
// ============================================================
function migrateData(data) {
  if (!data.meta) data.meta = { version: '1.0' };
  const version = data.meta.version || '1.0';

  // v1.0 → v1.1: 补全 percentile 字段（历史记录可能缺失）
  if (version < '1.1') {
    if (data.daily_records) {
      data.daily_records.forEach(r => {
        if (r.percentile === undefined) r.percentile = null;
      });
    }
    data.meta.version = '1.1';
  }

  return data;
}

// ============================================================
// 原子写入（先写 .tmp 再 rename，防止中途崩溃）
// 异常时清理 .tmp 残留文件，避免污染后续写入
// ============================================================
function saveData(data, filePath) {
  filePath = filePath || config.dataFile;
  ensureDirs();
  data.meta = data.meta || {};
  data.meta.last_updated = nowBeijing();
  if (data.daily_records) {
    data.meta.record_count = data.daily_records.length;
  }
  const tmpFile = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpFile, filePath);
  } catch (e) {
    // 写入失败，清理 .tmp 残留
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (cleanErr) {}
    throw e; // 重新抛出，让调用方处理
  }
}

// ============================================================
// 备份（双轨：滚动备份保留30份 + 月度归档长期保留）
// 月度归档：每月首次备份时复制一份到 monthly/ 子目录，永久保留
// 用途：版本迭代回滚、灾难性数据损坏恢复、审计追溯
// ============================================================
function backup(reason) {
  ensureDirs();
  if (!fs.existsSync(config.dataFile)) return null;
  const ts = nowBeijing().replace(/[: ]/g, '-').slice(0, 19);
  const backupFile = path.join(config.backupDir, `backup_${ts}.json`);
  fs.copyFileSync(config.dataFile, backupFile);

  // 清理超过30份的旧备份（仅清理滚动备份，不影响月度归档）
  const backups = fs.readdirSync(config.backupDir)
    .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
    .sort().reverse();
  backups.slice(30).forEach(f => {
    try { fs.unlinkSync(path.join(config.backupDir, f)); } catch (e) {}
  });

  // 月度归档：每月首次备份时归档一份
  try {
    archiveMonthlyIfNeeded(backupFile);
  } catch (e) {
    console.error('[数据库] 月度归档失败:', e.message);
  }

  return backupFile;
}

// ============================================================
// 月度归档 — 每月首次备份时复制到 monthly/ 子目录
// 文件名格式: monthly_YYYY-MM.json，每月仅归档一次
// ============================================================
function archiveMonthlyIfNeeded(latestBackupFile) {
  const monthlyDir = path.join(config.backupDir, 'monthly');
  if (!fs.existsSync(monthlyDir)) fs.mkdirSync(monthlyDir, { recursive: true });

  // 北京时间月份（用 UTC+8 计算，避免 UTC 环境月份偏移）
  const now = new Date(Date.now() + config.beijingOffset);
  const yearMonth = now.toISOString().slice(0, 7);
  const monthlyFile = path.join(monthlyDir, `monthly_${yearMonth}.json`);

  // 当月已归档则跳过
  if (fs.existsSync(monthlyFile)) return false;

  fs.copyFileSync(latestBackupFile, monthlyFile);
  console.log(`[数据库] 月度归档完成: monthly_${yearMonth}.json`);
  return true;
}

// ============================================================
// 列出所有月度归档（按月份升序）
// ============================================================
function listMonthlyArchives() {
  const monthlyDir = path.join(config.backupDir, 'monthly');
  if (!fs.existsSync(monthlyDir)) return [];
  return fs.readdirSync(monthlyDir)
    .filter(f => f.startsWith('monthly_') && f.endsWith('.json'))
    .sort();
}

// ============================================================
// 从指定月度归档恢复（用于版本回滚）
// ============================================================
function restoreFromMonthlyArchive(yearMonth) {
  const monthlyDir = path.join(config.backupDir, 'monthly');
  const archiveFile = path.join(monthlyDir, `monthly_${yearMonth}.json`);
  if (!fs.existsSync(archiveFile)) {
    console.error(`[数据库] 月度归档不存在: monthly_${yearMonth}.json`);
    return null;
  }
  try {
    const raw = fs.readFileSync(archiveFile, 'utf-8');
    const data = JSON.parse(raw);
    console.log(`[数据库] 从月度归档恢复: monthly_${yearMonth}.json`);
    // 恢复前先备份当前数据
    backup('before-monthly-restore');
    saveData(data);
    return data;
  } catch (e) {
    console.error(`[数据库] 月度归档恢复失败: ${e.message}`);
    return null;
  }
}

function restoreFromBackup() {
  if (!fs.existsSync(config.backupDir)) return null;
  const backups = fs.readdirSync(config.backupDir)
    .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
    .sort().reverse();
  for (const f of backups) {
    try {
      const raw = fs.readFileSync(path.join(config.backupDir, f), 'utf-8');
      const data = JSON.parse(raw);
      console.log(`[数据库] 从备份恢复: ${f}`);
      saveData(data);
      return data;
    } catch (e) {}
  }
  return null;
}

// ============================================================
// 日志系统（参照 portfolio-analysis 的 appendLog）
// ============================================================
function appendLog(entry) {
  ensureDirs();
  const today = todayBeijingDate();
  const line = JSON.stringify(entry) + '\n';
  try {
    fs.appendFileSync(path.join(config.logDailyDir, `log_${today}.jsonl`), line, 'utf-8');
    if (entry.level === 'ERROR' || entry.level === 'FATAL') {
      fs.appendFileSync(path.join(config.logErrorDir, `error_${today}.jsonl`), line, 'utf-8');
    }
  } catch (e) {
    console.error('[日志] 写入失败:', e.message);
  }
}

function log(level, message, meta) {
  const entry = {
    time: nowBeijing(),
    level,
    message,
    meta: meta || {}
  };
  appendLog(entry);
  if (level === 'ERROR' || level === 'FATAL') {
    console.error(`[${level}] ${message}`);
  } else if (level === 'WARN') {
    console.warn(`[WARN] ${message}`);
  } else {
    console.log(`[${level}] ${message}`);
  }
  return entry;
}

// ============================================================
// 查询辅助
// ============================================================

// 按日期查 daily_record
function getRecordByDate(data, date) {
  return data.daily_records.find(r => r.date === date);
}

// 取最近一条 daily_record
function getLatestRecord(data) {
  const records = data.daily_records;
  if (records.length === 0) return null;
  return records[records.length - 1];
}

// 取某日期之前的最近一条
function getRecordBefore(data, date) {
  const records = data.daily_records.filter(r => r.date < date);
  if (records.length === 0) return null;
  return records[records.length - 1];
}

// 按年筛选 daily_records
function getRecordsByYear(data, year) {
  const prefix = String(year);
  return data.daily_records.filter(r => r.date.startsWith(prefix));
}

// 按年查 yearly_stat
function getYearlyStat(data, year) {
  return data.yearly_stats.find(s => s.year === year);
}

// 按执行日查 trade_log
function getTradesByExecYear(data, year) {
  const prefix = String(year);
  return data.trade_log.filter(t => t.exec_date && t.exec_date.startsWith(prefix));
}

// 插入或更新 daily_record（按 date 去重）
function upsertDailyRecord(data, record) {
  const idx = data.daily_records.findIndex(r => r.date === record.date);
  if (idx >= 0) {
    data.daily_records[idx] = Object.assign({}, data.daily_records[idx], record);
  } else {
    data.daily_records.push(record);
    // 保持日期升序
    data.daily_records.sort((a, b) => a.date < b.date ? -1 : 1);
  }
}

// 插入 trade_log
function addTradeLog(data, trade) {
  data.trade_log.push(trade);
  data.trade_log.sort((a, b) =>
    (a.exec_date || '') < (b.exec_date || '') ? -1 : 1);
}

// 插入 push_log
function addPushLog(data, entry) {
  if (!data || !Array.isArray(data.push_log)) return; // 防御：data 不完整时跳过
  data.push_log.push(entry);
  // 只保留最近1000条
  if (data.push_log.length > 1000) {
    data.push_log = data.push_log.slice(-1000);
  }
}

// 插入 calibration_log
function addCalibrationLog(data, entry) {
  data.calibration_log.push(entry);
}

// 插入 consistency_log
function addConsistencyLog(data, entry) {
  data.consistency_log.push(entry);
  if (data.consistency_log.length > 2000) {
    data.consistency_log = data.consistency_log.slice(-2000);
  }
}

module.exports = {
  createEmptyData,
  nowBeijing,
  todayBeijingDate,
  ensureDirs,
  loadData,
  saveData,
  backup,
  restoreFromBackup,
  // 月度归档（版本迭代数据保护）
  archiveMonthlyIfNeeded,
  listMonthlyArchives,
  restoreFromMonthlyArchive,
  log,
  appendLog,
  // 查询
  getRecordByDate,
  getLatestRecord,
  getRecordBefore,
  getRecordsByYear,
  getYearlyStat,
  getTradesByExecYear,
  // 写入
  upsertDailyRecord,
  addTradeLog,
  addPushLog,
  addCalibrationLog,
  addConsistencyLog
};
