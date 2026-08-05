// GitHub Actions 工作流日志系统
// 严格参考 AI 算力新闻项目 workflow_logger.py 的设计
//
// 功能：收集步骤日志 → 上传OSS归档 → PushDeer通知
// 模式：
//   --record <step_name> <status> [detail]   记录步骤状态
//   --finish <run_id>                         汇总并上报
//
// 设计要点：
//   1. if:always() 确保失败时也推送通知（用户能知道任务失败）
//   2. 幂等跳过时不重复推送（避免同一份数据发多条通知）
//   3. PushDeer 推送失败不影响工作流退出码
const fs = require('fs');
const path = require('path');
const https = require('https');

try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) { /* 纯环境变量降级 */ }

// ============================================================
// 配置
// ============================================================
const BASE = __dirname;
const LOGS_DIR = path.join(BASE, 'logs', 'workflow');
fs.mkdirSync(LOGS_DIR, { recursive: true });

const PUSHDEER_KEY = process.env.PUSHDEER_KEY || '';
const PUSHDEER_URL = 'https://api2.pushdeer.com/message/push';

const OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || '';
const OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || '';
const OSS_BUCKET = process.env.OSS_BUCKET || 'portfolio-analysis-hosting';
const OSS_REGION = process.env.OSS_REGION || 'cn-hangzhou';

// ============================================================
// 日志文件路径
// ============================================================
function logPath(runId) {
  return path.join(LOGS_DIR, `${runId}.jsonl`);
}

// ============================================================
// --record <step_name> <status> [detail]
// ============================================================
function cmdRecord() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log('用法: workflow_logger.cjs --record <step_name> <status> [detail]');
    process.exit(1);
  }
  const runId = process.env.RUN_ID || 'unknown';
  const stepName = args[1];
  const status = args[2];
  const detail = args.slice(3).join(' ');

  const record = {
    ts: new Date().toISOString(),
    run_id: runId,
    step: stepName,
    status: status,
    detail: (detail || '').slice(0, 1000)
  };
  fs.appendFileSync(logPath(runId), JSON.stringify(record) + '\n');
  console.log(`[LOG] ${stepName} → ${status}`);
}

// ============================================================
// OSS 上传
// ============================================================
async function uploadToOss(data, ossKey) {
  if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET) {
    console.log('[OSS] 跳过：未配置 OSS 密钥');
    return false;
  }
  const OSS = require('ali-oss').default || require('ali-oss');
  const client = new OSS({
    region: `oss-${OSS_REGION}`,
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    bucket: OSS_BUCKET,
    secure: true
  });
  try {
    const body = Buffer.from(JSON.stringify(data, null, 2));
    const result = await client.put(ossKey, body, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
    console.log(`[OSS] ${result.res.status === 200 ? '✅' : '❌'} ${ossKey}`);
    return result.res.status === 200;
  } catch (e) {
    console.log(`[OSS] ❌ ${ossKey} -> ${e.message}`);
    return false;
  }
}

// ============================================================
// PushDeer 推送（带重试）
// ============================================================
function pushNotification(title, body, success) {
  if (!PUSHDEER_KEY) {
    console.log('[PUSH] 跳过：未配置 PUSHDEER_KEY');
    return Promise.resolve(false);
  }
  const icon = success ? '✅' : '❌';
  const text = `${icon} ${title}`;
  const payload = JSON.stringify({
    pushkey: PUSHDEER_KEY,
    text: text,
    desp: body || '',
    type: 'markdown'
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api2.pushdeer.com',
      path: '/message/push',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    function attempt(n) {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.code === 0) {
              console.log('[PUSH] ✅ 通知发送成功');
              resolve(true);
            } else {
              console.log(`[PUSH] 失败(${n}): ${json.message || 'unknown'}`);
              if (n < 3) setTimeout(() => attempt(n + 1), 2000);
              else resolve(false);
            }
          } catch (e) {
            console.log(`[PUSH] 解析失败(${n}): ${e.message}`);
            if (n < 3) setTimeout(() => attempt(n + 1), 2000);
            else resolve(false);
          }
        });
      });
      req.on('error', (e) => {
        console.log(`[PUSH] 异常(${n}): ${e.message}`);
        if (n < 3) setTimeout(() => attempt(n + 1), 2000);
        else resolve(false);
      });
      req.write(payload);
      req.end();
    }
    attempt(1);
  });
}

// ============================================================
// 从 OSS 读取今日数据状态（幂等跳过时用）
// ============================================================
async function fetchTodayStatus() {
  if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET) return '?';
  const OSS = require('ali-oss').default || require('ali-oss');
  const client = new OSS({
    region: `oss-${OSS_REGION}`,
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    bucket: OSS_BUCKET,
    secure: true
  });
  try {
    const result = await client.get('ratio-rotation/data/ratio_rotation_data.json');
    const json = JSON.parse(result.content.toString());
    const records = json.daily_records || [];
    if (records.length === 0) return '0';
    const latest = records[records.length - 1];
    return `${records.length}条 (最新: ${latest.date})`;
  } catch (e) {
    return '?';
  }
}

// ============================================================
// --finish <run_id> 汇总并上报
// ============================================================
async function cmdFinish() {
  const runId = process.argv[3];
  if (!runId) {
    console.log('用法: workflow_logger.cjs --finish <run_id>');
    process.exit(1);
  }

  // 读取步骤记录
  const records = [];
  const lp = logPath(runId);
  if (fs.existsSync(lp)) {
    const lines = fs.readFileSync(lp, 'utf-8').split('\n');
    for (const line of lines) {
      if (line.trim()) {
        try { records.push(JSON.parse(line)); } catch (e) { /* 跳过损坏行 */ }
      }
    }
  }

  const steps = records.map(r => ({
    step: r.step || '?',
    status: r.status || 'unknown',
    detail: r.detail || ''
  }));

  const successCount = steps.filter(s => s.status === 'success').length;
  const failureCount = steps.filter(s => s.status === 'failure').length;
  const finalStatus = failureCount === 0 ? 'success' : 'failure';

  console.log('\n' + '='.repeat(50));
  console.log('  📊 工作流执行报告');
  console.log(`  Run ID:     ${runId}`);
  console.log(`  最终状态:   ${finalStatus === 'success' ? '✅ 成功' : '❌ 失败'}`);
  console.log(`  总步骤:     ${steps.length}`);
  console.log(`  成功:       ${successCount}`);
  console.log(`  失败:       ${failureCount}`);
  console.log('='.repeat(50) + '\n');

  for (const s of steps) {
    const icon = s.status === 'success' ? '✅' : s.status === 'failure' ? '❌' : '⏳';
    console.log(`  ${icon} ${s.step}`);
  }

  // 上传到 OSS
  const report = {
    run_id: runId,
    timestamp: new Date().toISOString(),
    workflow: process.env.GITHUB_WORKFLOW || '创红轮动每日推送',
    run_number: process.env.GITHUB_RUN_NUMBER || '?',
    repository: process.env.GITHUB_REPOSITORY || '',
    branch: (process.env.GITHUB_REF || '').replace('refs/heads/', ''),
    commit: (process.env.GITHUB_SHA || '').slice(0, 8),
    final_status: finalStatus,
    total_steps: steps.length,
    success_count: successCount,
    failure_count: failureCount,
    steps: steps
  };
  await uploadToOss(report, `ratio-rotation/workflow_logs/${runId}.json`);

  // 构造推送消息
  let body;
  const pipelineAbsent = !records.some(r => r.step === '运行每日任务');

  if (failureCount > 0) {
    const failed = steps.filter(s => s.status === 'failure');
    const errorDetail = failed.map(s => `❌ **${s.step}**: ${s.detail.slice(0, 200)}`).join('\n');
    body = `### ❌ 创红轮动 - 执行失败\n\n` +
           `| 项目 | 值 |\n|------|------|\n` +
           `| Run ID | \`${runId}\` |\n` +
           `| 总步骤 | ${steps.length} |\n` +
           `| 成功 | ${successCount} |\n` +
           `| 失败 | ${failureCount} |\n\n` +
           `**失败步骤：**\n${errorDetail}\n\n` +
           `📋 详细日志: https://portfolio-analysis.top/ratio-rotation/workflow_logs/${runId}.json`;
  } else {
    let dataStatus = '?';
    if (pipelineAbsent) {
      dataStatus = await fetchTodayStatus();
      console.log(`\n  ℹ️ 幂等检查跳过流水线，从OSS读取数据状态: ${dataStatus}`);
    }
    body = `### ✅ 创红轮动 - 执行成功\n\n` +
           `| 项目 | 值 |\n|------|------|\n` +
           `| Run ID | \`${runId}\` |\n` +
           `| 数据状态 | ${dataStatus} |\n` +
           `| 步骤数 | ${steps.length} |\n\n` +
           `🌐 访问: https://portfolio-analysis.top/ratio-rotation/`;
  }

  // 幂等跳过时不重复推送
  if (pipelineAbsent && finalStatus === 'success') {
    console.log('\n  ℹ️ 今日数据已存在（幂等检查跳过流水线），不重复推送通知');
  } else {
    await pushNotification('创红轮动 工作流报告', body, finalStatus === 'success');
  }

  // 保存报告
  fs.writeFileSync(lp, JSON.stringify(report, null, 2));
  process.exit(finalStatus === 'success' ? 0 : 1);
}

// ============================================================
// 主入口
// ============================================================
const mode = process.argv[2];
if (mode === '--record') {
  cmdRecord();
} else if (mode === '--finish') {
  cmdFinish();
} else {
  console.log('用法: node workflow_logger.cjs --record|--finish ...');
  process.exit(1);
}
