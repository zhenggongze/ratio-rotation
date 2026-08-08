// OSS 部署脚本（Node.js 版）
// 部署前端展示页到阿里云 OSS + 刷新 CDN
// 密钥从环境变量读取，绝不硬编码
//
// 环境变量配置（在系统环境变量或 .env 中设置）：
//   OSS_ACCESS_KEY_ID     - 阿里云 AccessKey ID
//   OSS_ACCESS_KEY_SECRET - 阿里云 AccessKey Secret
//   OSS_BUCKET            - OSS Bucket 名称（默认 ratio-rotation-hosting）
//   OSS_REGION            - OSS 区域（默认 cn-hangzhou）
//   CDN_DOMAIN            - CDN 域名（如 ratio-rotation.top）

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

// 尝试加载 .env
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) {
  // dotenv 未安装时降级为纯系统环境变量
}

const OSS = require('ali-oss').default || require('ali-oss');

// ============================================================
// 配置（从环境变量读取，绝不硬编码）
// ============================================================
const ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || '';
const ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || '';
// 默认部署到 portfolio-analysis-hosting 的 ratio-rotation/ 子目录
// （因为新建的 ratio-rotation-hosting 受"阻止公共访问"限制无法设置公共读）
// 如需独立部署，设置 OSS_BUCKET=ratio-rotation-hosting OSS_PREFIX= 并先在控制台关闭阻止公共访问
const BUCKET = process.env.OSS_BUCKET || 'portfolio-analysis-hosting';
const REGION = process.env.OSS_REGION || 'cn-hangzhou';
const CDN_DOMAIN = process.env.CDN_DOMAIN || 'portfolio-analysis.top';
const OSS_PREFIX = process.env.OSS_PREFIX || 'ratio-rotation/';

const PUBLIC_DIR = path.join(__dirname, 'public');

// ============================================================
// 检查配置
// ============================================================
function checkConfig() {
  if (!ACCESS_KEY_ID || !ACCESS_KEY_SECRET) {
    console.log('✗ 缺少 OSS 密钥配置');
    console.log('  请设置环境变量:');
    console.log('    set OSS_ACCESS_KEY_ID=你的AccessKeyID');
    console.log('    set OSS_ACCESS_KEY_SECRET=你的AccessKeySecret');
    console.log('  或参照 portfolio-analysis 项目的 deploy_v2.py 中的密钥');
    return false;
  }
  return true;
}

// ============================================================
// 主部署流程
// ============================================================
async function main() {
  console.log('='.repeat(60));
  console.log('  比值轮动系统 — OSS 部署（Node.js）');
  console.log('='.repeat(60));

  if (!checkConfig()) {
    process.exit(1);
  }

  console.log(`\n  Bucket: ${BUCKET}`);
  console.log(`  Region: ${REGION}`);
  console.log(`  CDN:    ${CDN_DOMAIN}`);
  console.log(`  目录:   ${PUBLIC_DIR}`);

  // 检查 public 目录
  if (!fs.existsSync(PUBLIC_DIR)) {
    console.log(`\n✗ public 目录不存在: ${PUBLIC_DIR}`);
    console.log('  请先运行: node export_frontend_data.cjs');
    process.exit(1);
  }

  // 初始化 OSS 客户端
  const client = new OSS({
    region: `oss-${REGION}`,
    accessKeyId: ACCESS_KEY_ID,
    accessKeySecret: ACCESS_KEY_SECRET,
    bucket: BUCKET,
    secure: true
  });

  // 步骤1：检查 Bucket 是否存在，不存在则创建
  console.log(`\n[1/5] 检查 Bucket`);
  console.log('-'.repeat(60));
  let bucketExisted = false;
  try {
    await client.getBucketInfo(BUCKET);
    console.log(`  ✓ Bucket ${BUCKET} 已存在`);
    bucketExisted = true;
  } catch (e) {
    if (e.code === 'NoSuchBucket') {
      console.log(`  Bucket 不存在，尝试创建...`);
      try {
        await client.putBucket(BUCKET);
        console.log(`  ✓ Bucket ${BUCKET} 创建成功`);
        bucketExisted = true;
      } catch (createErr) {
        console.log(`  ✗ Bucket 创建失败: ${createErr.message}`);
        console.log(`  请手动在阿里云控制台创建 Bucket: ${BUCKET}`);
        process.exit(1);
      }
    } else {
      console.log(`  ✗ 检查 Bucket 失败: ${e.message}`);
      process.exit(1);
    }
  }

  // 步骤2：关闭"阻止公共访问"（如开启），设置 Bucket ACL 为公共读
  console.log(`\n[2/5] 配置 Bucket 访问权限`);
  console.log('-'.repeat(60));

  // 先尝试关闭阻止公共访问
  try {
    // 使用 deleteBucketPublicAccessBlock 关闭阻止公共访问
    const ossHttp = require('ali-oss').prototype;
    const options = {
      method: 'DELETE',
      bucket: BUCKET,
      subres: 'publicAccessBlock'
    };
    // ali-oss 内部方法，通过 _request 调用
    await client._request(options);
    console.log(`  ✓ 已关闭"阻止公共访问"`);
  } catch (e) {
    // 可能未开启或接口不支持，忽略
    if (e.code !== 'NoSuchPublicAccessBlockConfiguration') {
      console.log(`  ⚠ 关闭阻止公共访问: ${e.message || e.code}`);
    }
  }

  // 设置 Bucket ACL 为公共读
  try {
    await client.putBucketACL(BUCKET, 'public-read');
    console.log(`  ✓ Bucket ACL 设置为 public-read`);
  } catch (e) {
    console.log(`  ⚠ Bucket ACL 设置失败: ${e.message}`);
    console.log(`  请在阿里云控制台手动关闭 Bucket 的"阻止公共访问":`);
    console.log(`  https://oss.console.aliyun.com/bucket/permission-setting/${BUCKET}/access-block`);
  }

  // 设置静态网站托管
  // supportSubDir=true：子目录自动查找 IndexDocument（让 /ratio-rotation/ 返回 ratio-rotation/index.html）
  // 不影响持仓系统：持仓系统子目录无 index.html 时仍回退 ErrorDocument（SPA 路由）
  try {
    await client.putBucketWebsite(BUCKET, {
      index: 'index.html',
      error: 'index.html',
      supportSubDir: 'true',
      type: '0'
    });
    console.log(`  ✓ 静态网站托管已配置 (index=index.html, supportSubDir=true)`);
  } catch (e) {
    console.log(`  ⚠ 静态网站托管配置失败: ${e.message}`);
  }

  // 步骤3：上传文件
  console.log(`\n[3/5] 上传文件到 OSS`);
  console.log('-'.repeat(60));

  const filesToUpload = [
    // cache 策略：index.html 每次验证（页面必须新）；数据文件可 304 验证（省流量且及时更新）；
    // vendor 静态资源长缓存（文件不变时浏览器直接复用，不再请求）
    // gzip: 大 JSON 压缩传输（浏览器自动解压），弱网/手机端加载提速
    { local: 'index.html', oss: OSS_PREFIX + 'index.html', contentType: 'text/html; charset=utf-8', cache: 'no-cache' },
    { local: 'api_config.json', oss: OSS_PREFIX + 'api_config.json', contentType: 'application/json; charset=utf-8', cache: 'no-cache' },
    { local: 'frontend_data.json', oss: OSS_PREFIX + 'frontend_data.json', contentType: 'application/json; charset=utf-8', cache: 'no-cache', gzip: true },
    { local: 't0_backtest.json', oss: OSS_PREFIX + 't0_backtest.json', contentType: 'application/json; charset=utf-8', cache: 'no-cache', gzip: true },
    { local: 't0_backtest_cyb.json', oss: OSS_PREFIX + 't0_backtest_cyb.json', contentType: 'application/json; charset=utf-8', cache: 'no-cache', gzip: true },
    { local: 'vendor/chart.umd.min.js', oss: OSS_PREFIX + 'vendor/chart.umd.min.js', contentType: 'application/javascript; charset=utf-8', cache: 'public, max-age=604800' }
  ];

  for (const file of filesToUpload) {
    const localPath = path.join(PUBLIC_DIR, file.local);
    if (!fs.existsSync(localPath)) {
      console.log(`  ✗ ${file.local} 不存在，跳过`);
      continue;
    }

    const raw = fs.readFileSync(localPath);
    const useGzip = !!file.gzip && raw.length > 1024;
    const body = useGzip ? zlib.gzipSync(raw) : raw;
    const headers = {
      'Content-Type': file.contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': file.cache || 'no-cache',
      'Pragma': 'no-cache'
    };
    if (useGzip) headers['Content-Encoding'] = 'gzip';

    try {
      // 先删除旧文件（清除旧元数据）
      try {
        await client.delete(file.oss);
      } catch (e) {
        // 忽略删除失败（文件可能不存在）
      }

      // 上传新文件（gzip 文件带 Content-Encoding: gzip，浏览器自动解压）
      const result = await client.put(file.oss, body, { headers });

      // 设置 ACL 为公共读（portfolio-analysis-hosting 已是 public-read，这里仍尝试设置）
      try {
        await client.putACL(file.oss, 'public-read');
      } catch (e) {
        // 忽略 ACL 设置失败（Bucket 已是公共读时无需设置）
      }

      console.log(`  ✓ ${file.oss} (${body.length} 字节${useGzip ? ', gzip' : ''})`);
    } catch (e) {
      console.log(`  ✗ ${file.oss} 上传失败: ${e.message}`);
    }
  }

  // 上传 meta refresh 跳转页到 ratio-rotation（无尾斜杠，不带 OSS_PREFIX）
  // 访问 /ratio-rotation 时返回此 HTML，浏览器自动跳转到 /ratio-rotation/
  // 解决无尾斜杠路径访问问题（OSS 静态托管仅对带尾斜杠路径生效 SupportSubDir）
  if (BUCKET === 'portfolio-analysis-hosting' && OSS_PREFIX === 'ratio-rotation/') {
    try {
      const prefixPath = 'ratio-rotation';
      const redirectHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="0;url=/ratio-rotation/">
<title>跳转中...</title>
</head>
<body>正在跳转至<a href="/ratio-rotation/">比值轮动系统</a>...</body>
</html>`;
      await client.put(prefixPath, Buffer.from(redirectHtml), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'inline',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
      try { await client.putACL(prefixPath, 'public-read'); } catch (e) { /* 忽略 */ }
      console.log(`  ✓ ${prefixPath} (meta refresh 跳转页, ${Buffer.byteLength(redirectHtml)} 字节)`);
    } catch (e) {
      console.log(`  ✗ meta refresh 跳转页上传失败: ${e.message}`);
    }
  }

  // 步骤4：静态网站托管（portfolio-analysis-hosting 已配置，跳过）
  console.log(`\n[4/5] 静态网站托管`);
  console.log('-'.repeat(60));
  if (BUCKET === 'portfolio-analysis-hosting') {
    console.log(`  ✓ 复用 ${BUCKET} 的静态网站托管配置（无需重新配置）`);
  } else {
    try {
      await client.putBucketWebsite(BUCKET, {
        index: 'index.html',
        error: 'index.html'
      });
      console.log(`  ✓ 静态网站托管已配置 (index=index.html, error=index.html)`);
    } catch (e) {
      console.log(`  ⚠ 静态网站托管配置失败: ${e.message}`);
    }
  }

  // 步骤5：验证访问
  console.log(`\n[5/6] 验证访问`);
  console.log('-'.repeat(60));

  const https = require('https');
  const prefixPath = OSS_PREFIX.endsWith('/') ? OSS_PREFIX.slice(0, -1) : OSS_PREFIX;
  const testUrl = `https://${CDN_DOMAIN}/${prefixPath}/`;
  const ossUrl = `https://${BUCKET}.oss-${REGION}.aliyuncs.com/${prefixPath}/index.html`;

  // 先验证 OSS 直接访问
  await new Promise((resolve) => {
    const req = https.get(ossUrl, { timeout: 10000, headers: { 'User-Agent': 'deploy-script' } }, (res) => {
      console.log(`  OSS 直访: HTTP ${res.statusCode} ${ossUrl}`);
      if (res.statusCode === 200) {
        console.log(`  ✓ OSS 直接访问成功`);
      }
      res.resume();
      resolve();
    });
    req.on('error', (e) => {
      console.log(`  ⚠ OSS 直访失败: ${e.message}`);
      resolve();
    });
    req.on('timeout', () => {
      console.log(`  ⚠ OSS 直访超时`);
      req.destroy();
      resolve();
    });
  });

  // 再验证 CDN 访问
  await new Promise((resolve) => {
    const req = https.get(testUrl, { timeout: 10000, headers: { 'User-Agent': 'deploy-script' } }, (res) => {
      console.log(`  CDN 访问: HTTP ${res.statusCode} ${testUrl}`);
      if (res.statusCode === 200) {
        console.log(`  ✓ CDN 访问成功`);
      } else if (res.statusCode === 404) {
        console.log(`  ⚠ CDN 返回 404，可能缓存未刷新`);
      }
      res.resume();
      resolve();
    });
    req.on('error', (e) => {
      console.log(`  ⚠ CDN 访问失败: ${e.message}`);
      resolve();
    });
    req.on('timeout', () => {
      console.log(`  ⚠ CDN 访问超时`);
      req.destroy();
      resolve();
    });
  });

  // 步骤6：刷新 CDN 缓存
  console.log(`\n[6/6] 刷新 CDN 缓存`);
  console.log('-'.repeat(60));

  const crypto = require('crypto');
  const refreshPaths = [
    `https://${CDN_DOMAIN}/${prefixPath}`,
    `https://${CDN_DOMAIN}/${prefixPath}/`,
    `https://${CDN_DOMAIN}/${prefixPath}/index.html`,
    `https://${CDN_DOMAIN}/${prefixPath}/api_config.json`,
    `https://${CDN_DOMAIN}/${prefixPath}/frontend_data.json`,
    `https://${CDN_DOMAIN}/${prefixPath}/t0_backtest.json`,
    `https://${CDN_DOMAIN}/${prefixPath}/t0_backtest_cyb.json`,
    `https://${CDN_DOMAIN}/${prefixPath}/vendor/chart.umd.min.js`
  ];

  try {
    // 阿里云 RPC API v1.0 签名
    const params = {
      Action: 'RefreshObjectCaches',
      Format: 'JSON',
      Version: '2018-05-10',
      AccessKeyId: ACCESS_KEY_ID,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: crypto.randomBytes(16).toString('hex'),
      Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      ObjectPath: refreshPaths.join('\n'),
      ObjectType: 'File'
    };

    // 排序并编码
    const sortedKeys = Object.keys(params).sort();
    const canonicalized = sortedKeys.map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
    const stringToSign = 'GET&' + percentEncode('/') + '&' + percentEncode(canonicalized);
    const signature = crypto.createHmac('sha1', ACCESS_KEY_SECRET + '&').update(stringToSign).digest('base64');
    params.Signature = signature;

    const queryString = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const refreshUrl = `https://cdn.aliyuncs.com/?${queryString}`;

    await new Promise((resolve) => {
      const req = https.get(refreshUrl, { timeout: 15000 }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (result.RefreshTaskId) {
              console.log(`  ✓ CDN 缓存已刷新 (TaskId: ${result.RefreshTaskId})`);
              console.log(`    刷新路径:`);
              refreshPaths.forEach(p => console.log(`      - ${p}`));
            } else {
              console.log(`  ⚠ CDN 刷新返回: ${body.substring(0, 200)}`);
            }
          } catch (e) {
            console.log(`  ⚠ CDN 刷新响应解析失败: ${body.substring(0, 200)}`);
          }
          resolve();
        });
      });
      req.on('error', (e) => {
        console.log(`  ⚠ CDN 刷新失败: ${e.message}`);
        console.log(`  请手动刷新: https://cdn.console.aliyun.com/#/refresh`);
        resolve();
      });
      req.on('timeout', () => {
        console.log(`  ⚠ CDN 刷新超时`);
        req.destroy();
        resolve();
      });
    });
  } catch (e) {
    console.log(`  ⚠ CDN 刷新异常: ${e.message}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('  部署完成');
  console.log('='.repeat(60));
  console.log(`\n  访问地址: https://${CDN_DOMAIN}/${prefixPath}/`);
  console.log(`  备用地址: https://${CDN_DOMAIN}/${prefixPath}/index.html`);
  console.log(`\n  注意:`);
  console.log(`    1. CDN 缓存刷新约需 5-30 秒生效`);
  console.log(`    2. 数据更新后重新运行: node export_frontend_data.cjs && node deploy.cjs`);
  console.log(`    3. 如需独立域名 ratio-rotation.top，需在阿里云控制台:`);
  console.log(`       a. 关闭 ratio-rotation-hosting Bucket 的"阻止公共访问"`);
  console.log(`       b. 设置 OSS_BUCKET=ratio-rotation-hosting OSS_PREFIX= CDN_DOMAIN=ratio-rotation.top`);
  console.log(`       c. 重新运行 node deploy.cjs`);
}

// ============================================================
// 阿里云 RPC API percentEncode
// ============================================================
function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

main().catch(err => {
  console.error('部署异常:', err);
  process.exit(1);
});
