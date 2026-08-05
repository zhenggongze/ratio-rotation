// 配置加载模块
// 读取 .env 环境变量与策略参数（20档滞回带版本）
const path = require('path');
const fs = require('fs');

// 尝试加载 .env（可选，系统环境变量优先）
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) {
  // dotenv 未安装时降级为纯系统环境变量
}

// ============================================================
// 策略参数：20档买入档位表（比值从高到低，规格2.3节）
// 每档触发条件：比值 ≤ 对应阈值
// ============================================================
const BUY_LEVELS = [
  0.3500, 0.3479, 0.3458, 0.3437, 0.3416,
  0.3395, 0.3374, 0.3353, 0.3332, 0.3311,
  0.3289, 0.3268, 0.3247, 0.3226, 0.3205,
  0.3184, 0.3163, 0.3142, 0.3121, 0.3100
];

// ============================================================
// 策略参数：20档卖出档位表（比值从低到高，规格2.4节）
// 每档触发条件：比值 ≥ 对应阈值
// ============================================================
const SELL_LEVELS = [
  0.6000, 0.6058, 0.6116, 0.6174, 0.6232,
  0.6289, 0.6347, 0.6405, 0.6463, 0.6521,
  0.6579, 0.6637, 0.6695, 0.6753, 0.6811,
  0.6868, 0.6926, 0.6984, 0.7042, 0.7100
];

// ============================================================
// 科创50策略参数：20档买入档位表
// 每档触发条件：比值 ≤ 对应阈值
// ============================================================
const KCB_BUY_LEVELS = [
  0.1550, 0.1537, 0.1524, 0.1511, 0.1497,
  0.1484, 0.1471, 0.1458, 0.1445, 0.1432,
  0.1418, 0.1405, 0.1392, 0.1379, 0.1366,
  0.1353, 0.1339, 0.1326, 0.1313, 0.1300
];

// ============================================================
// 科创50策略参数：20档卖出档位表（分位数法校准，对齐创业板85%~98%分位）
// 每档触发条件：比值 ≥ 对应阈值
// ============================================================
const KCB_SELL_LEVELS = [
  0.2930, 0.2957, 0.2985, 0.3012, 0.3039,
  0.3067, 0.3094, 0.3122, 0.3149, 0.3176,
  0.3204, 0.3231, 0.3258, 0.3286, 0.3313,
  0.3341, 0.3368, 0.3395, 0.3423, 0.3450
];

// ============================================================
// 配置对象
// ============================================================
const config = {
  // PushDeer 推送（从系统环境变量读取，绝不硬编码）
  pushdeer: {
    key: process.env.PUSHDEER_KEY || '',
    url: 'https://api2.pushdeer.com/message/push',
    timeout: 10000,
    maxRetries: 3,
    retryDelays: [10, 60, 300] // 规格：10秒、60秒、300秒
  },

  // 数据源
  datasource: {
    primary: process.env.DATA_SOURCE_PRIMARY || 'tencent',
    backup: process.env.DATA_SOURCE_BACKUP || 'csindex'
  },

  // 资金参数
  initCapital: parseFloat(process.env.INIT_CAPITAL || '1600000'),
  tierAmount: parseFloat(process.env.TIER_AMOUNT || '80000'),

  // 策略区域端点
  buyZoneTop: parseFloat(process.env.BUY_ZONE_TOP || '0.35'),
  sellZoneBottom: parseFloat(process.env.SELL_ZONE_BOTTOM || '0.6'),
  sellZoneTop: parseFloat(process.env.SELL_ZONE_TOP || '0.710'),

  // 档位表
  buyLevels: BUY_LEVELS,
  sellLevels: SELL_LEVELS,
  totalTiers: 20,
  tierWeight: 0.05, // 每档5%仓位

  // 交易成本
  tradeCostRate: 0.0005, // 单边0.05%

  // 分红率兜底（年均）
  hliDividendAnnual: 0.044,  // 红利年均4.4%
  cybDividendAnnual: 0.009,  // 创业板年均0.9%
  tradingDaysPerYear: 252,

  // 校准
  calibWindowYears: parseInt(process.env.CALIB_WINDOW_YEARS || '5', 10),
  calibBuyPctMin: 0.02,
  calibBuyPctMax: 0.10,
  calibSellPctMin: 0.65,
  calibSellPctMax: 0.85,
  calibMedianDriftMax: 0.05,
  calibHistoryMedian: 0.45,
  calibMinAdjustStep: 0.005, // 单次建议变动幅度<0.005不建议调整

  // 比值合理性检查范围
  ratioMin: 0.28,
  ratioMax: 0.90,

  // 双源差异阈值
  dualSourceDiffThreshold: 0.005, // 0.5%

  // 收益自洽校验阈值
  assetCheckTolerance: 0.01,      // 0.01元
  identity3Tolerance: 0.0001,     // 0.0001
  naiveReplayTolerance: 0.0001,   // 0.01%

  // 路径
  dataDir: path.join(__dirname, 'data'),
  dataFile: path.join(__dirname, 'data', 'ratio_rotation_data.json'),
  backupDir: path.join(__dirname, 'data', 'backups'),
  logDir: path.join(__dirname, 'data', 'logs'),
  logDailyDir: path.join(__dirname, 'data', 'logs', 'daily'),
  logErrorDir: path.join(__dirname, 'data', 'logs', 'errors'),

  // 时区
  timezone: 'Asia/Shanghai',
  beijingOffset: 8 * 3600 * 1000,

  // 历史回放范围
  historyStart: '2014-07-01',
  historyEnd: '2026-07-31',

  // 科创50策略配置（双策略并行，分位数法校准对齐创业板分位）
  kcb: {
    indexCode: 'sh000688',
    indexName: '科创50',
    buyZoneTop: 0.155,
    sellZoneBottom: 0.293,
    sellZoneTop: 0.345,
    buyLevels: KCB_BUY_LEVELS,
    sellLevels: KCB_SELL_LEVELS,
    tierWeight: 0.05,
    tierAmount: 80000,
    dataFile: path.join(__dirname, 'data', 'kcb_rotation_data.json'),
    historyStart: '2020-08-01',
    ratioMin: 0.10,
    ratioMax: 0.50
  }
};

// ============================================================
// 策略配置（写入 strategy_config，支持版本化）
// ============================================================
function getStrategyConfig() {
  return {
    param_version: '20tier-hysteresis-v2',
    effective_from: '2014-07-01',
    init_capital: config.initCapital,
    tier_amount: config.tierAmount,
    buy_zone_top: config.buyZoneTop,
    sell_zone_bottom: config.sellZoneBottom,
    sell_zone_top: config.sellZoneTop,
    buy_levels: config.buyLevels,
    sell_levels: config.sellLevels,
    note: '20档滞回带v2，买入上界0.35(p12)，卖出下界0.6(p85)，拉宽买入区提升实操可执行性'
  };
}

// ============================================================
// 科创50策略配置
// ============================================================
function getKcbStrategyConfig() {
  return {
    param_version: '20tier-hysteresis-kcb-v3',
    effective_from: '2020-08-01',
    init_capital: config.initCapital,
    tier_amount: config.kcb.tierAmount,
    buy_zone_top: config.kcb.buyZoneTop,
    sell_zone_bottom: config.kcb.sellZoneBottom,
    sell_zone_top: config.kcb.sellZoneTop,
    buy_levels: config.kcb.buyLevels,
    sell_levels: config.kcb.sellLevels,
    note: '科创50/红利20档滞回带v3，分位数法校准对齐创业板：买入0.155(12%分位)，卖出0.293~0.345(85%~98%分位)，消除过拟合'
  };
}

module.exports = { config, getStrategyConfig, getKcbStrategyConfig };
