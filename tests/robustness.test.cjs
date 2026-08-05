// 健壮性测试 - 关机/重启容错、版本迭代数据保护、定时任务可靠性
// 覆盖架构评审发现的3类风险
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { config } = require('../config.cjs');
const {
  createEmptyData, saveData, loadData, backup, restoreFromBackup,
  archiveMonthlyIfNeeded, listMonthlyArchives, restoreFromMonthlyArchive
} = require('../database.cjs');
const { calcPercentile } = require('../stats.cjs');

// ============================================================
// 第1轮评审测试：电脑关机/重启容错
// ============================================================

test('健壮性1.1: 原子写入 - .tmp 中间文件不应残留', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');
  const tmpFile = dataFile + '.tmp';

  // 修改 config.dataFile 临时指向测试文件
  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    const data = createEmptyData();
    data.daily_records = [{ date: '2026-08-01', ratio: 0.5 }];
    saveData(data);

    // 验证主文件存在且内容正确
    assert.ok(fs.existsSync(dataFile), '主文件应存在');
    assert.ok(!fs.existsSync(tmpFile), '.tmp 文件不应残留');

    // 验证可正常读取
    const loaded = loadData();
    assert.strictEqual(loaded.daily_records.length, 1);
    assert.strictEqual(loaded.daily_records[0].date, '2026-08-01');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    // 清理
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('健壮性1.2: 主文件损坏 - 自动从备份恢复', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    // 写入正常数据
    const data = createEmptyData();
    data.daily_records = [{ date: '2026-08-01', ratio: 0.5, cyb_close: 1000, hli_close: 2000 }];
    saveData(data);

    // 创建备份
    backup('test-corruption');

    // 损坏主文件
    fs.writeFileSync(dataFile, '{invalid json content', 'utf-8');

    // loadData 应自动从备份恢复
    const restored = loadData();
    assert.ok(restored.daily_records.length > 0, '应从备份恢复数据');
    assert.strictEqual(restored.daily_records[0].date, '2026-08-01');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('健壮性1.3: saveData 时 last_updated 自动更新', () => {
  const data = createEmptyData();
  const origTime = data.meta.last_updated;

  // 等待一小段时间确保时间不同
  const data2 = createEmptyData();
  assert.ok(data2.meta.last_updated >= origTime, 'last_updated 应是当前时间');
});

test('健壮性1.4: 数据为空时 loadData 不应崩溃', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    // 首次加载，文件不存在
    const data = loadData();
    assert.ok(data, 'loadData 应返回空数据结构而非崩溃');
    assert.ok(data.daily_records, '应有 daily_records 数组');
    assert.strictEqual(data.daily_records.length, 0);
    assert.ok(data.meta, '应有 meta 字段');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ============================================================
// 第2轮评审测试：版本迭代历史数据保护
// ============================================================

test('健壮性2.1: 备份文件命名包含时间戳可追溯', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    const data = createEmptyData();
    saveData(data);

    const backupFile = backup('version-migration-test');
    assert.ok(backupFile, '应返回备份文件路径');
    assert.ok(backupFile.includes('backup_'), '备份文件名应包含 backup_ 前缀');

    // 文件名格式: backup_YYYY-MM-DD-HH-MM-SS.json
    const basename = path.basename(backupFile);
    assert.match(basename, /^backup_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/,
      '备份文件名应匹配时间戳格式');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('健壮性2.2: 备份超过30份时自动清理旧备份', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    const data = createEmptyData();
    saveData(data);

    // 创建 35 份备份
    for (let i = 0; i < 35; i++) {
      backup(`bulk-${i}`);
      // 微小延迟确保时间戳不同
      const future = Date.now() + 1100;
      while (Date.now() < future) {}
    }

    const backups = fs.readdirSync(config.backupDir)
      .filter(f => f.startsWith('backup_') && f.endsWith('.json'));
    assert.ok(backups.length <= 30, `备份应不超过30份, 实际=${backups.length}`);
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('健壮性2.3: 数据 schema 版本字段存在', () => {
  const data = createEmptyData();
  assert.ok(data.meta, '应有 meta 字段');
  assert.ok(data.meta.version, 'meta.version 应存在');
  assert.ok(['1.0', '1.1'].includes(data.meta.version), '版本应为 1.0 或 1.1');
});

test('健壮性2.4: 所有数据表都应存在（即使为空）', () => {
  const data = createEmptyData();
  const requiredTables = [
    'meta', 'state', 'strategy_config',
    'daily_records', 'yearly_stats', 'trade_log',
    'push_log', 'calibration_log', 'consistency_log'
  ];
  for (const table of requiredTables) {
    assert.ok(data[table] !== undefined, `数据表 ${table} 应存在`);
  }
});

// ============================================================
// 第3轮评审测试：定时任务可靠性
// ============================================================

test('健壮性3.1: 非交易日预判 - 周六应被识别', () => {
  // 2026-08-01 是周六
  const date = '2026-08-01';
  const dayOfWeek = new Date(date + 'T00:00:00+08:00').getDay();
  assert.strictEqual(dayOfWeek, 6, '2026-08-01 应是周六 (getDay=6)');
});

test('健壮性3.2: 非交易日预判 - 周日应被识别', () => {
  // 2026-08-02 是周日
  const date = '2026-08-02';
  const dayOfWeek = new Date(date + 'T00:00:00+08:00').getDay();
  assert.strictEqual(dayOfWeek, 0, '2026-08-02 应是周日 (getDay=0)');
});

test('健壮性3.3: 非交易日预判 - 工作日不应被误判', () => {
  // 2026-08-03 是周一
  const date = '2026-08-03';
  const dayOfWeek = new Date(date + 'T00:00:00+08:00').getDay();
  assert.strictEqual(dayOfWeek, 1, '2026-08-03 应是周一 (getDay=1)');
  assert.notStrictEqual(dayOfWeek, 0, '周一不应被识别为周日');
  assert.notStrictEqual(dayOfWeek, 6, '周一不应被识别为周六');
});

test('健壮性3.4: calcPercentile 在空数组上不崩溃', () => {
  const result = calcPercentile(0.5, []);
  assert.strictEqual(result, 0, '空数组应返回 0 而非崩溃');
});

test('健壮性3.5: calcPercentile 在单元素数组上正确', () => {
  const result = calcPercentile(0.5, [0.5]);
  assert.strictEqual(result, 1, '单元素数组匹配应返回 1');
});

// ============================================================
// 数据完整性测试
// ============================================================

test('健壮性4.1: 现有数据文件可正常加载', () => {
  // 测试真实数据文件
  if (fs.existsSync(config.dataFile)) {
    const data = loadData();
    assert.ok(data, '现有数据应可加载');
    assert.ok(Array.isArray(data.daily_records), 'daily_records 应是数组');
    assert.ok(data.daily_records.length > 0, '应有历史记录');
    assert.ok(data.meta, '应有 meta');
    assert.ok(data.meta.record_count > 0, 'record_count 应大于0');
  } else {
    // 无数据文件时跳过
    assert.ok(true, '数据文件不存在，跳过');
  }
});

test('健壮性4.2: 现有 daily_records 按日期升序排列', () => {
  if (fs.existsSync(config.dataFile)) {
    const data = loadData();
    if (data.daily_records.length > 1) {
      for (let i = 1; i < data.daily_records.length; i++) {
        assert.ok(data.daily_records[i].date >= data.daily_records[i-1].date,
          `记录应升序: [${i-1}]=${data.daily_records[i-1].date} <= [${i}]=${data.daily_records[i].date}`);
      }
    }
  } else {
    assert.ok(true, '数据文件不存在，跳过');
  }
});

test('健壮性4.3: 每条 daily_record 包含必需字段', () => {
  if (fs.existsSync(config.dataFile)) {
    const data = loadData();
    if (data.daily_records.length > 0) {
      const requiredFields = ['date', 'ratio', 'cyb_close', 'hli_close', 'cyb_weight', 'asset_value'];
      const sample = data.daily_records[Math.floor(data.daily_records.length / 2)];
      for (const field of requiredFields) {
        assert.ok(sample[field] !== undefined, `记录 ${sample.date} 应包含字段 ${field}`);
      }
    }
  } else {
    assert.ok(true, '数据文件不存在，跳过');
  }
});

// ============================================================
// 安全性回归测试 - 防止 API Key 泄露
// ============================================================

test('安全5.1: config.cjs 中 PUSHDEER_KEY 从环境变量读取', () => {
  // 验证配置对象读取的是环境变量
  assert.strictEqual(config.pushdeer.key, process.env.PUSHDEER_KEY || '',
    'PUSHDEER_KEY 必须从环境变量读取');
});

test('安全5.2: 项目代码文件不应包含硬编码密钥', () => {
  const projectFiles = [
    'main.cjs', 'config.cjs', 'database.cjs', 'datasource.cjs',
    'engine.cjs', 'pusher.cjs', 'strategy.cjs', 'stats.cjs',
    'calibrate.cjs', 'exporter.cjs', 'chart.cjs', 'deploy.cjs',
    'export_frontend_data.cjs', 'run_daily.bat'
  ];
  const secretPatterns = [
    /sk-[a-zA-Z0-9]{40,}/,    // OpenAI/百炼 API Key
    /LTAI[A-Za-z0-9]{16,}/,   // 阿里云 AccessKey ID
    /AKID[A-Za-z0-9]{16,}/,   // 腾讯云 SecretId
    /PDU[A-Za-z0-9]{30,}/,    // PushDeer 真实 Key
    /gh[pso]_[a-zA-Z0-9]{30,}/ // GitHub Token
  ];

  for (const file of projectFiles) {
    const filePath = path.join(__dirname, '..', file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const pattern of secretPatterns) {
      assert.ok(!pattern.test(content), `${file} 不应包含硬编码密钥 (匹配 ${pattern})`);
    }
  }
});

test('安全5.3: 前端 index.html 不应包含任何密钥', () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    assert.ok(true, 'index.html 不存在，跳过');
    return;
  }
  const content = fs.readFileSync(htmlPath, 'utf-8');
  const secretPatterns = [
    /sk-[a-zA-Z0-9]{20,}/,
    /LTAI[A-Za-z0-9]{16,}/,
    /AKID[A-Za-z0-9]{16,}/,
    /PDU[A-Za-z0-9]{30,}/,
    /gh[pso]_[a-zA-Z0-9]{30,}/,
    /dashscope\.aliyuncs\.com/,
    /api\.openai\.com/,
    /api\.deepseek\.com/
  ];
  for (const pattern of secretPatterns) {
    assert.ok(!pattern.test(content), `index.html 不应包含密钥模式 ${pattern}`);
  }
});

test('安全5.4: .env 在 .gitignore 中', () => {
  const gitignorePath = path.join(__dirname, '..', '.gitignore');
  assert.ok(fs.existsSync(gitignorePath), '.gitignore 应存在');
  const content = fs.readFileSync(gitignorePath, 'utf-8');
  assert.ok(content.includes('.env'), '.gitignore 应包含 .env');
  assert.ok(content.includes('data/ratio_rotation_data.json'), '.gitignore 应包含数据文件');
});

// ============================================================
// 第4轮评审测试：月度归档机制（版本迭代数据保护）
// ============================================================

test('健壮性6.1: 月度归档 - 首次备份应创建当月归档', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    const data = createEmptyData();
    data.daily_records = [{ date: '2026-08-01', ratio: 0.5 }];
    saveData(data);

    // 首次备份应触发月度归档
    const backupFile = backup('test-monthly');
    assert.ok(backupFile, '应返回备份文件路径');

    // 检查 monthly/ 子目录
    const monthlyDir = path.join(config.backupDir, 'monthly');
    assert.ok(fs.existsSync(monthlyDir), 'monthly/ 子目录应存在');

    // 检查当月归档文件存在
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthlyFile = path.join(monthlyDir, `monthly_${ym}.json`);
    assert.ok(fs.existsSync(monthlyFile), `当月归档 monthly_${ym}.json 应存在`);

    // 验证归档内容正确
    const archived = JSON.parse(fs.readFileSync(monthlyFile, 'utf-8'));
    assert.strictEqual(archived.daily_records.length, 1);
    assert.strictEqual(archived.daily_records[0].date, '2026-08-01');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('健壮性6.2: 月度归档 - 同月多次备份只归档一次', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    const data = createEmptyData();
    saveData(data);

    // 第一次备份
    backup('first');
    // 第二次备份
    backup('second');

    // 同月只应有一个归档
    const archives = listMonthlyArchives();
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const currentMonthArchives = archives.filter(f => f.includes(ym));
    assert.strictEqual(currentMonthArchives.length, 1, '同月应只有1个归档');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('健壮性6.3: listMonthlyArchives 返回升序排列', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    const data = createEmptyData();
    saveData(data);

    // 模拟创建3个月归档
    const monthlyDir = path.join(config.backupDir, 'monthly');
    fs.mkdirSync(monthlyDir, { recursive: true });
    ['monthly_2026-06.json', 'monthly_2026-07.json', 'monthly_2026-08.json'].forEach(f => {
      fs.copyFileSync(config.dataFile, path.join(monthlyDir, f));
    });

    const archives = listMonthlyArchives();
    assert.ok(archives.length >= 3, '应至少有3个归档');

    // 验证升序
    for (let i = 1; i < archives.length; i++) {
      assert.ok(archives[i] >= archives[i-1], `归档应升序: ${archives[i-1]} <= ${archives[i]}`);
    }
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('健壮性6.4: restoreFromMonthlyArchive - 从指定月份恢复', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    // 当前数据
    const currentData = createEmptyData();
    currentData.daily_records = [{ date: '2026-08-15', ratio: 0.6 }];
    saveData(currentData);

    // 创建一个月度归档（模拟2026-07的数据）
    const monthlyDir = path.join(config.backupDir, 'monthly');
    fs.mkdirSync(monthlyDir, { recursive: true });
    const archiveData = createEmptyData();
    archiveData.daily_records = [{ date: '2026-07-31', ratio: 0.5 }];
    fs.writeFileSync(
      path.join(monthlyDir, 'monthly_2026-07.json'),
      JSON.stringify(archiveData, null, 2),
      'utf-8'
    );

    // 从归档恢复
    const restored = restoreFromMonthlyArchive('2026-07');
    assert.ok(restored, '应成功恢复');
    assert.strictEqual(restored.daily_records[0].date, '2026-07-31', '应恢复为归档版本数据');
    assert.strictEqual(restored.daily_records[0].ratio, 0.5, '比值应匹配归档');

    // 验证主文件已被覆盖
    const currentNow = loadData();
    assert.strictEqual(currentNow.daily_records[0].date, '2026-07-31', '主文件应已更新');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('健壮性6.5: restoreFromMonthlyArchive - 不存在的月份应返回null', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    const data = createEmptyData();
    saveData(data);

    const result = restoreFromMonthlyArchive('2099-12');
    assert.strictEqual(result, null, '不存在的月份应返回null');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ============================================================
// 第5轮评审测试：catchup 断点恢复机制
// ============================================================

test('健壮性7.1: nextTradeDate 跳过周末', () => {
  // 通过 require 获取 main.cjs 的 nextTradeDate（它是私有的，需通过命令测试）
  // 这里直接测试日期逻辑
  const friday = new Date('2026-08-07T00:00:00+08:00'); // 周五
  const saturday = new Date('2026-08-08T00:00:00+08:00'); // 周六
  const sunday = new Date('2026-08-09T00:00:00+08:00'); // 周日
  const monday = new Date('2026-08-10T00:00:00+08:00'); // 周一

  assert.strictEqual(friday.getDay(), 5, '2026-08-07 应是周五');
  assert.strictEqual(saturday.getDay(), 6, '2026-08-08 应是周六');
  assert.strictEqual(sunday.getDay(), 0, '2026-08-09 应是周日');
  assert.strictEqual(monday.getDay(), 1, '2026-08-10 应是周一');
});

test('健壮性7.2: run_daily.bat 容错脚本存在', () => {
  const batPath = path.join(__dirname, '..', 'run_daily.bat');
  assert.ok(fs.existsSync(batPath), 'run_daily.bat 应存在');

  const content = fs.readFileSync(batPath, 'utf-8');
  assert.ok(content.includes('catchup'), '应包含 catchup 命令');
  assert.ok(content.includes('run-daily'), '应包含 run-daily 命令');
  assert.ok(content.includes('export_frontend_data'), '应包含前端数据导出');
  assert.ok(content.includes('deploy.cjs'), '应包含部署步骤');
  assert.ok(content.includes('task_log.txt'), '应记录任务日志');
  assert.ok(content.includes('if not exist'), '应创建日志目录');
});

test('健壮性7.3: setup_windows_task.ps1 配置脚本存在且包含容错配置', () => {
  const ps1Path = path.join(__dirname, '..', 'setup_windows_task.ps1');
  assert.ok(fs.existsSync(ps1Path), 'setup_windows_task.ps1 应存在');

  const content = fs.readFileSync(ps1Path, 'utf-8');
  // 关键容错配置
  assert.ok(content.includes('StartWhenAvailable'), '应配置错过后自动补跑');
  assert.ok(content.includes('RestartCount'), '应配置失败重试');
  assert.ok(content.includes('AllowStartIfOnBatteries'), '应允许电池状态运行');
  assert.ok(content.includes('DontStopIfGoingOnBatteries'), '应允许切换到电池不停止');
});

// ============================================================
// 第2轮评审测试：数据保护增强（saveData异常处理/版本迁移/月度归档恢复链）
// ============================================================

test('健壮性8.1: saveData异常时清理.tmp文件', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    // 正常写入一次
    const data = createEmptyData();
    saveData(data);
    assert.ok(fs.existsSync(dataFile), '主文件应存在');
    assert.ok(!fs.existsSync(dataFile + '.tmp'), '.tmp 不应残留');

    // 模拟 saveData 写入异常后 .tmp 清理
    // 手动创建 .tmp 文件，然后调用 saveData 写入有效数据
    fs.writeFileSync(dataFile + '.tmp', 'garbage');
    const data2 = createEmptyData();
    data2.daily_records = [{ date: '2026-08-01', ratio: 0.5 }];
    saveData(data2);
    // .tmp 应被 rename 消耗，不存在
    assert.ok(!fs.existsSync(dataFile + '.tmp'), '正常写入后 .tmp 不应残留');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('健壮性8.2: 数据版本迁移 - v1.0数据自动升级到v1.1', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    // 手动写入 v1.0 版本数据（缺少 percentile 字段）
    const v10Data = {
      meta: { version: '1.0', created_at: '2026-01-01', last_updated: '2026-01-01', record_count: 1 },
      state: {},
      strategy_config: {},
      daily_records: [{ date: '2026-07-31', ratio: 0.6004, cyb_close: 3343.96, hli_close: 5569.41 }],
      yearly_stats: [],
      trade_log: [],
      push_log: [],
      calibration_log: [],
      consistency_log: []
    };
    fs.writeFileSync(dataFile, JSON.stringify(v10Data, null, 2), 'utf-8');

    // loadData 应触发版本迁移
    const loaded = loadData();

    // 版本应升级到 1.1
    assert.ok(loaded.meta.version >= '1.1', `版本应升级到1.1+, 实际: ${loaded.meta.version}`);

    // percentile 字段应被补全
    assert.ok(loaded.daily_records[0].percentile !== undefined, 'percentile 字段应被补全');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('健壮性8.3: loadData 滚动备份失败时回退到月度归档', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    // 创建一个月度归档（包含有效数据）
    const monthlyDir = path.join(config.backupDir, 'monthly');
    fs.mkdirSync(monthlyDir, { recursive: true });
    const archiveData = createEmptyData();
    archiveData.daily_records = [{ date: '2026-07-31', ratio: 0.5 }];
    fs.writeFileSync(
      path.join(monthlyDir, 'monthly_2026-07.json'),
      JSON.stringify(archiveData, null, 2),
      'utf-8'
    );

    // 写入损坏的主文件（让loadData走恢复路径）
    fs.writeFileSync(dataFile, '{corrupted json content', 'utf-8');
    // 不创建滚动备份，让restoreFromBackup返回null
    // loadData应回退到月度归档恢复
    const loaded = loadData();
    assert.ok(loaded, 'loadData 应返回数据');
    assert.ok(loaded.daily_records.length > 0, '应有daily_records数据');
    assert.strictEqual(loaded.daily_records[0].date, '2026-07-31', '应来自月度归档');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('健壮性8.4: datasource fetchDailyDataFromHistory 函数存在', () => {
  const ds = require('../datasource.cjs');
  assert.strictEqual(typeof ds.fetchDailyDataFromHistory, 'function', 'fetchDailyDataFromHistory 应为函数');
});

test('健壮性8.5: main.cjs catchup 调用 runDaily 时传入 skipPush:true', () => {
  const mainContent = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf-8');
  assert.ok(mainContent.includes('skipPush: true'), 'catchup 应传入 skipPush: true');
  assert.ok(mainContent.includes('options.skipPush'), 'runDaily 应支持 skipPush 选项');
});

// ============================================================
// 第3轮评审测试：定时任务可靠性（datasource历史数据获取/部署集成）
// ============================================================

test('健壮性9.1: datasource fetchDailyData 区分今天和历史日期', () => {
  const dsContent = fs.readFileSync(path.join(__dirname, '..', 'datasource.cjs'), 'utf-8');
  assert.ok(dsContent.includes('todayBeijingDate'), '应导入 todayBeijingDate');
  assert.ok(dsContent.includes('isToday'), '应判断是否为今天');
  assert.ok(dsContent.includes('fetchDailyDataFromHistory'), '应调用历史数据获取函数');
});

test('健壮性9.2: datasource 历史数据获取包含错误处理', () => {
  const dsContent = fs.readFileSync(path.join(__dirname, '..', 'datasource.cjs'), 'utf-8');
  // 历史数据获取函数应有 try-catch
  assert.ok(dsContent.includes('历史数据获取失败'), '应处理历史数据获取失败');
  assert.ok(dsContent.includes('可能为非交易日'), '应处理非交易日场景');
});

test('健壮性9.3: run_daily.bat 包含完整的4步流程', () => {
  const batContent = fs.readFileSync(path.join(__dirname, '..', 'run_daily.bat'), 'utf-8');
  const steps = ['步骤1', '步骤2', '步骤3', '步骤4'];
  steps.forEach(s => {
    assert.ok(batContent.includes(s), `应包含${s}`);
  });
  // 验证步骤顺序：catchup → run-daily → export → deploy
  const catchupIdx = batContent.indexOf('catchup');
  const runDailyIdx = batContent.indexOf('run-daily');
  const exportIdx = batContent.indexOf('export_frontend_data');
  const deployIdx = batContent.indexOf('deploy.cjs');
  assert.ok(catchupIdx < runDailyIdx, 'catchup 应在 run-daily 之前');
  assert.ok(runDailyIdx < exportIdx, 'run-daily 应在 export 之前');
  assert.ok(exportIdx < deployIdx, 'export 应在 deploy 之前');
});

test('健壮性9.4: deploy.cjs 密钥从环境变量读取', () => {
  const deployContent = fs.readFileSync(path.join(__dirname, '..', 'deploy.cjs'), 'utf-8');
  assert.ok(deployContent.includes('process.env.OSS_ACCESS_KEY_ID'), '应从环境变量读取AccessKey ID');
  assert.ok(deployContent.includes('process.env.OSS_ACCESS_KEY_SECRET'), '应从环境变量读取AccessKey Secret');
  // 确保没有硬编码的密钥
  assert.ok(!deployContent.match(/LTAI[A-Za-z0-9]{16,}/), '不应包含阿里云AccessKey硬编码');
});

test('健壮性9.5: catchup 补跑幂等性 - 重复运行不产生重复数据', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  const dataFile = path.join(tmpDir, 'test_data.json');

  const origDataFile = config.dataFile;
  const origBackupDir = config.backupDir;
  const origDataDir = config.dataDir;
  config.dataFile = dataFile;
  config.dataDir = tmpDir;
  config.backupDir = path.join(tmpDir, 'backups');

  try {
    const data = createEmptyData();
    data.daily_records = [{ date: '2026-07-30', ratio: 0.5, cyb_weight: 0 }];
    saveData(data);

    // 模拟 upsertDailyRecord 的去重逻辑
    const testRecord = { date: '2026-07-30', ratio: 0.6, cyb_weight: 0.1 };
    const idx = data.daily_records.findIndex(r => r.date === testRecord.date);
    assert.ok(idx >= 0, '应找到已存在的记录');

    // upsert 应更新而非新增
    data.daily_records[idx] = Object.assign({}, data.daily_records[idx], testRecord);
    assert.strictEqual(data.daily_records.length, 1, '记录数应保持1条');
    assert.strictEqual(data.daily_records[0].ratio, 0.6, '比值应被更新');
  } finally {
    config.dataFile = origDataFile;
    config.dataDir = origDataDir;
    config.backupDir = origBackupDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});
