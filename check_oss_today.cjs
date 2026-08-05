// 幂等检查：检查 OSS 上今日数据是否已生成
// 严格参考 AI 算力新闻项目 check_oss_today.py 的设计
//
// 逻辑：
//   - 检查 ratio_rotation_data.json 中最新 daily_record 的日期
//   - 若最新日期 == 今日 → 今日数据已生成，exit 0（跳过流水线）
//   - 若最新日期 < 今日 → 需要执行流水线，exit 1
//   - 强制刷新：FORCE_REFRESH=1 时跳过检查，exit 1
//   - 异常：fail open，exit 1（宁可重复跑也不能漏掉）
//
// 用法：
//   node check_oss_today.cjs
//   FORCE_REFRESH=1 node check_oss_today.cjs  # 强制重新生成
const fs = require('fs');
const path = require('path');
const https = require('https');

// 尝试加载 .env
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) { /* 纯环境变量降级 */ }

// ============================================================
// 配置
// ============================================================
const ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || '';
const ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || '';
const BUCKET = process.env.OSS_BUCKET || 'portfolio-analysis-hosting';
const REGION = process.env.OSS_REGION || 'cn-hangzhou';
const OSS_DATA_PREFIX = process.env.OSS_DATA_PREFIX || 'ratio-rotation/data/';

// ============================================================
// 北京时间今日日期
// ============================================================
function todayBeijingDate() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  return beijing.toISOString().slice(0, 10);
}

// ============================================================
// 主检查逻辑
// ============================================================
async function main() {
  // 强制刷新模式
  if (process.env.FORCE_REFRESH === '1') {
    console.log('FORCE_REFRESH=1，跳过幂等检查，执行流水线');
    process.exit(1);
  }

  if (!ACCESS_KEY_ID || !ACCESS_KEY_SECRET) {
    console.log('未配置 OSS 凭据，fail open 执行流水线');
    process.exit(1);
  }

  const OSS = require('ali-oss').default || require('ali-oss');
  const client = new OSS({
    region: `oss-${REGION}`,
    accessKeyId: ACCESS_KEY_ID,
    accessKeySecret: ACCESS_KEY_SECRET,
    bucket: BUCKET,
    secure: true
  });

  const today = todayBeijingDate();
  const ossKey = OSS_DATA_PREFIX + 'ratio_rotation_data.json';

  try {
    const result = await client.get(ossKey);
    const json = JSON.parse(result.content.toString());
    const records = json.daily_records || [];

    if (records.length === 0) {
      console.log(`TODAY_DATA_EMPTY: 数据文件无 daily_records，执行流水线`);
      process.exit(1);
    }

    // 取最新记录的日期
    const latestRecord = records[records.length - 1];
    const latestDate = latestRecord.date;

    if (latestDate >= today) {
      console.log(`TODAY_DATA_EXISTS: 最新记录 ${latestDate} >= 今日 ${today}，跳过流水线`);
      process.exit(0);
    } else {
      console.log(`TODAY_DATA_STALE: 最新记录 ${latestDate} < 今日 ${today}，执行流水线`);
      process.exit(1);
    }
  } catch (e) {
    if (e.code === 'NoSuchKey' || e.status === 404) {
      console.log(`TODAY_DATA_NOT_FOUND: OSS 无数据文件，执行流水线`);
      process.exit(1);
    }
    console.log(`CHECK_FAILED: ${e.message}，fail open 执行流水线`);
    process.exit(1);
  }
}

main();
