// OSS 数据同步模块
// 作用：GitHub Actions 是无状态环境，每次运行都是全新容器
//       本模块负责运行前从 OSS 下载历史数据，运行后上传更新后的数据
//       确保跨次运行的状态一致性（仓位、资产值、trade_log 等）
//
// 环境变量：
//   OSS_ACCESS_KEY_ID     - 阿里云 AccessKey ID
//   OSS_ACCESS_KEY_SECRET - 阿里云 AccessKey Secret
//   OSS_BUCKET            - OSS Bucket（默认 portfolio-analysis-hosting）
//   OSS_REGION            - OSS 区域（默认 cn-hangzhou）
//   OSS_DATA_PREFIX       - OSS 数据存储前缀（默认 ratio-rotation/data/）
//
// 用法：
//   node oss_data_sync.cjs download  # 运行前下载
//   node oss_data_sync.cjs upload    # 运行后上传
const fs = require('fs');
const path = require('path');

// 尝试加载 .env（本地开发用，GitHub Actions 用环境变量）
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) { /* dotenv 未安装时降级 */ }

// ============================================================
// 配置
// ============================================================
const ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || '';
const ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || '';
const BUCKET = process.env.OSS_BUCKET || 'portfolio-analysis-hosting';
const REGION = process.env.OSS_REGION || 'cn-hangzhou';
const OSS_DATA_PREFIX = process.env.OSS_DATA_PREFIX || 'ratio-rotation/data/';

// 需要同步的数据文件列表（相对 data/ 目录）
const DATA_FILES = [
  'ratio_rotation_data.json',
  'kcb_rotation_data.json',
  'history_data.json',
  'hli_dividend_rates.json',
  't0/t0_backtest.json',
  't0/t0_signal.json'
];

const DATA_DIR = path.join(__dirname, 'data');

// ============================================================
// 初始化 OSS 客户端
// ============================================================
function getOssClient() {
  if (!ACCESS_KEY_ID || !ACCESS_KEY_SECRET) {
    console.log('✗ 缺少 OSS 密钥配置（OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET）');
    process.exit(1);
  }
  const OSS = require('ali-oss').default || require('ali-oss');
  return new OSS({
    region: `oss-${REGION}`,
    accessKeyId: ACCESS_KEY_ID,
    accessKeySecret: ACCESS_KEY_SECRET,
    bucket: BUCKET,
    secure: true
  });
}

// ============================================================
// 下载：从 OSS 拉取最新数据文件到本地 data/
// ============================================================
async function download() {
  console.log('='.repeat(60));
  console.log('  从 OSS 下载数据文件');
  console.log('='.repeat(60));
  const client = getOssClient();

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const fname of DATA_FILES) {
    const ossKey = OSS_DATA_PREFIX + fname;
    const localPath = path.join(DATA_DIR, fname);
    try {
      const result = await client.get(ossKey);
      fs.writeFileSync(localPath, result.content);
      // 解析验证
      const json = JSON.parse(result.content.toString());
      const recCount = (json.daily_records || []).length;
      const label = recCount > 0 ? `${recCount} 条记录` : `${result.content.length} 字节`;
      console.log(`  ✓ ${fname} (${label})`);
      downloaded++;
    } catch (e) {
      if (e.code === 'NoSuchKey' || e.status === 404) {
        console.log(`  - ${fname} (OSS 不存在，跳过)`);
        skipped++;
      } else {
        console.log(`  ✗ ${fname} 下载失败: ${e.message}`);
        failed++;
      }
    }
  }

  console.log(`\n  下载完成: ${downloaded} 成功, ${skipped} 跳过, ${failed} 失败`);
  // 即使部分文件下载失败也继续（history_data.json 可能不存在，不影响主流程）
  return failed === 0 || downloaded > 0;
}

// ============================================================
// 上传：将本地 data/ 数据文件上传到 OSS
// ============================================================
async function upload() {
  console.log('='.repeat(60));
  console.log('  上传数据文件到 OSS');
  console.log('='.repeat(60));
  const client = getOssClient();

  let uploaded = 0;
  let failed = 0;

  for (const fname of DATA_FILES) {
    const localPath = path.join(DATA_DIR, fname);
    const ossKey = OSS_DATA_PREFIX + fname;
    if (!fs.existsSync(localPath)) {
      console.log(`  - ${fname} (本地不存在，跳过)`);
      continue;
    }
    try {
      const content = fs.readFileSync(localPath);
      // 验证 JSON 合法性，防止上传损坏文件
      JSON.parse(content.toString());
      await client.put(ossKey, content, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
      const json = JSON.parse(content.toString());
      const recCount = (json.daily_records || []).length;
      const label = recCount > 0 ? `${recCount} 条记录` : `${content.length} 字节`;
      console.log(`  ✓ ${fname} (${label})`);
      uploaded++;
    } catch (e) {
      console.log(`  ✗ ${fname} 上传失败: ${e.message}`);
      failed++;
    }
  }

  // 同时上传 frontend_data.json 到 public 目录对应 OSS 路径
  const frontendLocal = path.join(DATA_DIR, 'frontend_data.json');
  const frontendOss = 'ratio-rotation/frontend_data.json';
  if (fs.existsSync(frontendLocal)) {
    try {
      const content = fs.readFileSync(frontendLocal);
      JSON.parse(content.toString());
      await client.put(frontendOss, content, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
      console.log(`  ✓ frontend_data.json (${content.length} 字节) → ${frontendOss}`);
      uploaded++;
    } catch (e) {
      console.log(`  ✗ frontend_data.json 上传失败: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n  上传完成: ${uploaded} 成功, ${failed} 失败`);
  if (failed > 0) process.exit(1);
  return true;
}

// ============================================================
// 主入口
// ============================================================
async function main() {
  const action = process.argv[2];
  if (action === 'download') {
    const ok = await download();
    process.exit(ok ? 0 : 1);
  } else if (action === 'upload') {
    await upload();
  } else {
    console.log('用法: node oss_data_sync.cjs <download|upload>');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('运行异常:', e.message);
  process.exit(1);
});
