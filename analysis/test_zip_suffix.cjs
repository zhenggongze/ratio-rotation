// 测试 .zip 后缀是否被加密软件篡改
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

async function main() {
  // 生成一个最小 xlsx，但保存为 .zip 后缀
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('test');
  ws.addRow(['hello', 'world']);
  const zipPath = path.join(__dirname, 'test_xlsx.zip');
  await wb.xlsx.writeFile(zipPath);

  console.log('=== 写入后立即检查 ===');
  let b = fs.readFileSync(zipPath);
  console.log('test_xlsx.zip ->', b.slice(0, 8).toString('hex'), b.length);

  // 等待10秒
  await new Promise(r => setTimeout(r, 10000));
  console.log('=== 10秒后检查 ===');
  b = fs.readFileSync(zipPath);
  console.log('test_xlsx.zip ->', b.slice(0, 8).toString('hex'), b.length);

  // 同进程读取验证
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.readFile(zipPath);
  console.log('同进程读取: OK, sheets:', wb2.worksheets.length);
}
main().catch(e => { console.error(e); process.exit(1); });
