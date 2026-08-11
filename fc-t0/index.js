// 做T系统 - 阿里云函数计算（FC 3.0）云端 API：实际卖出价修正数据持久化
// 仿照持仓分析系统 portfolio-api 的稳定落库模式：
//   - 数据存 OSS 独立文件 ratio-rotation/data/t0/t0_adjustments.json（与每日自动生成的 t0_daily.json 分离，不被系统重算覆盖）
//   - 每次保存先写永不删除的备份，再原子写入主文件
//   - 提供 /api/t0/save 与 /api/t0/load，前端录入实际卖出价后即时落库，刷新/换设备不丢
// 模块隔离：save 支持可选 module 参数（t0=红利 / cyb=创业板 / kcb=科创50），key 为 module:date；
//           不传 module 时沿用旧的 date 裸 key（兼容红利已存数据），load 原样返回全部记录由前端按前缀过滤。
// 端点：
//   GET  /api/t0/load           拉取全部实际卖出价修正记录
//   POST /api/t0/save           保存单日修正 { date, actual_sell_price, module? }
//   GET  /api/t0/health         健康检查
'use strict';

const OSS = require('ali-oss');

// ====== 配置（从 FC 环境变量读取，永不硬编码） ======
const OSS_CLIENT = new OSS({
  region: 'oss-cn-hangzhou',
  accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
  bucket: process.env.OSS_BUCKET || 'portfolio-analysis-hosting',
  internal: true,            // FC 内网访问 OSS，免流量费
  secure: true
});

const DATA_KEY = 'ratio-rotation/data/t0/t0_adjustments.json';
const BACKUP_PREFIX = 'ratio-rotation/data/t0/backups/';

// ====== 响应辅助函数（FC 3.0：返回对象即可） ======
function jsonResp(statusCode, obj, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Private-Network': 'true'
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return {
    statusCode: statusCode,
    headers: headers,
    body: typeof obj === 'string' ? obj : JSON.stringify(obj),
    isBase64Encoded: false
  };
}

function textResp(statusCode, text) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: text,
    isBase64Encoded: false
  };
}

// ====== 解析 FC 3.0 event ======
function parseEvent(event) {
  let evt;
  if (Buffer.isBuffer(event)) {
    evt = JSON.parse(event.toString('utf-8'));
  } else if (typeof event === 'string') {
    evt = JSON.parse(event);
  } else {
    evt = event;
  }
  const method = ((evt.requestContext && evt.requestContext.http && evt.requestContext.http.method) || 'GET').toUpperCase();
  const path = (evt.requestContext && evt.requestContext.http && evt.requestContext.http.path) || evt.rawPath || '/';
  let body = evt.body || '';
  if (evt.isBase64Encoded && body) {
    body = Buffer.from(body, 'base64').toString('utf-8');
  }
  return { method, path, body };
}

// ====== OSS 数据读写 ======
async function loadDataFromOSS() {
  try {
    const result = await OSS_CLIENT.get(DATA_KEY);
    return JSON.parse(result.content.toString('utf-8'));
  } catch (e) {
    if (e.code === 'NoSuchKey' || e.status === 404) {
      return { updated_at: null, records: {} };
    }
    throw e;
  }
}

async function saveDataToOSS(data) {
  const jsonStr = JSON.stringify(data, null, 2);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  // 1. 备份（永不删除）
  const backupKey = BACKUP_PREFIX + 'backup_' + ts + '.json';
  await OSS_CLIENT.put(backupKey, Buffer.from(jsonStr, 'utf-8'));

  // 2. 主数据文件
  await OSS_CLIENT.put(DATA_KEY, Buffer.from(jsonStr, 'utf-8'), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });

  return { backup: backupKey, size: jsonStr.length };
}

// ====== 入口 ======
exports.handler = async (event, context) => {
  let method, path, body;
  try {
    const parsed = parseEvent(event);
    method = parsed.method;
    path = parsed.path;
    body = parsed.body;
  } catch (e) {
    return jsonResp(400, { error: 'event 解析失败: ' + e.message });
  }

  // CORS 预检
  if (method === 'OPTIONS') return jsonResp(200, {});

  if (method === 'GET' && (path === '/api/t0/health' || path === '/api/t0')) {
    return textResp(200, 't0-adjust-api ok at ' + new Date().toISOString());
  }

  // 拉取全部修正记录
  if (method === 'GET' && path === '/api/t0/load') {
    try {
      const data = await loadDataFromOSS();
      return jsonResp(200, data);
    } catch (e) {
      console.error('[load] 失败:', e.message);
      return jsonResp(500, { error: e.message });
    }
  }

  // 保存单日修正
  if (method === 'POST' && path === '/api/t0/save') {
    let incoming;
    try { incoming = JSON.parse(body); }
    catch (e) { return jsonResp(400, { success: false, error: '无效的JSON请求体' }); }

    const date = String(incoming.date || '').trim();
    const price = Number(incoming.actual_sell_price);
    // 模块隔离：允许的 module 前缀，防止异常 key 写入
    const module = String(incoming.module || '').trim();
    const moduleOk = module === '' || module === 't0' || module === 'cyb' || module === 'kcb';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResp(400, { success: false, error: 'date 格式应为 YYYY-MM-DD' });
    }
    if (!(price > 0) || price > 100) {
      return jsonResp(400, { success: false, error: '实际卖出价应为正数且不超过100' });
    }
    if (!moduleOk) {
      return jsonResp(400, { success: false, error: 'module 仅支持 t0/cyb/kcb（可省略）' });
    }
    const key = module ? module + ':' + date : date;

    try {
      const existing = await loadDataFromOSS();
      existing.records = existing.records || {};
      existing.records[key] = {
        actual_sell_price: Math.round(price * 1000) / 1000,
        updated_at: new Date().toISOString()
      };
      existing.updated_at = new Date().toISOString();
      const saved = await saveDataToOSS(existing);
      return jsonResp(200, { success: true, date: date, saved: saved });
    } catch (e) {
      console.error('[save] 失败:', e.message);
      return jsonResp(500, { success: false, error: e.message });
    }
  }

  return jsonResp(404, { error: 'Not Found: ' + method + ' ' + path });
};
