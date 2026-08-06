// 幂等检查：检查 OSS 上今日做T信号是否已生成
// 与 check_oss_today.cjs 同设计模式（参考 AI 算力新闻项目）
//
// 逻辑：
//   - 检查 ratio-rotation/data/t0/t0_signal.json 的 date 字段
//   - 若 date == 今日 → 今日信号已生成，exit 0（跳过流水线）
//   - 若 date < 今日 或不存在 → 需要执行，exit 1
//   - 强制刷新：FORCE_REFRESH=1 时跳过检查，exit 1
//   - 异常：fail open，exit 1（宁可重复跑也不能漏掉）
//
// 用法：
//   node check_t0_today.cjs
//   FORCE_REFRESH=1 node check_t0_today.cjs
const path = require('path');

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
  const ossKey = OSS_DATA_PREFIX + 't0/t0_signal.json';

  try {
    const result = await client.get(ossKey);
    const json = JSON.parse(result.content.toString());

    if (json.date >= today) {
      console.log(`T0_SIGNAL_EXISTS: 信号日期 ${json.date} >= 今日 ${today}，跳过流水线`);
      process.exit(0);
    } else {
      console.log(`T0_SIGNAL_STALE: 信号日期 ${json.date} < 今日 ${today}，执行流水线`);
      process.exit(1);
    }
  } catch (e) {
    if (e.code === 'NoSuchKey' || e.status === 404) {
      console.log(`T0_SIGNAL_NOT_FOUND: OSS 无信号文件，执行流水线`);
      process.exit(1);
    }
    console.log(`CHECK_FAILED: ${e.message}，fail open 执行流水线`);
    process.exit(1);
  }
}

main();
