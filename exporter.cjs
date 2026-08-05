// Excel 导出模块
// 规格7.7节：导出xlsx，三张表（每日统计、每年统计、档位操作）
// 样式：表头深蓝底白字、斑马纹、细边框、操作列红绿标注、冻结首行、自动筛选
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { config, getStrategyConfig } = require('./config.cjs');
const { loadData, log, nowBeijing, backup } = require('./database.cjs');

// 样式常量
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true, size: 11 };
const THIN_BORDER = {
  top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
};
const ZEBRA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
const BUY_FONT = { color: { argb: 'FFCC0000' }, bold: true };  // 红色（买入）
const SELL_FONT = { color: { argb: 'FF008000' }, bold: true }; // 绿色（卖出）

// ============================================================
// 设置表头样式
// ============================================================
function styleHeaderRow(ws, colCount) {
  for (let col = 1; col <= colCount; col++) {
    const cell = ws.getCell(1, col);
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = THIN_BORDER;
  }
  ws.getRow(1).height = 22;
}

// ============================================================
// 设置数据行样式（斑马纹+边框）
// ============================================================
function styleDataRow(ws, rowIdx, colCount) {
  for (let col = 1; col <= colCount; col++) {
    const cell = ws.getCell(rowIdx, col);
    cell.border = THIN_BORDER;
    if (rowIdx % 2 === 0) {
      cell.fill = ZEBRA_FILL;
    }
  }
}

// ============================================================
// 表一：每日统计表
// ============================================================
function buildDailySheet(ws, dailyRecords) {
  // 表头
  const headers = [
    '日期', '当日比值', '创业板收盘', '红利收盘',
    '创业板持仓占比', '红利持仓占比',
    '当日操作', '操作说明',
    '当日策略波动', '当日创业板波动', '当日红利波动',
    '期末总资产'
  ];
  ws.addRow(headers);
  styleHeaderRow(ws, headers.length);

  // 数据行
  for (let i = 0; i < dailyRecords.length; i++) {
    const r = dailyRecords[i];
    const row = [
      r.date,
      r.ratio,
      r.cyb_close,
      r.hli_close,
      r.cyb_weight,
      r.hli_weight,
      r.action || 'HOLD',
      r.signal_note || '',
      r.daily_ret,
      r.cyb_ret,
      r.hli_ret,
      r.asset_value
    ];
    const rowIdx = i + 2;
    ws.addRow(row);

    // 斑马纹+边框
    styleDataRow(ws, rowIdx, headers.length);

    // 操作列红绿标注（第7列）
    const actionCell = ws.getCell(rowIdx, 7);
    if (r.action === 'BUY') {
      actionCell.font = BUY_FONT;
    } else if (r.action === 'SELL') {
      actionCell.font = SELL_FONT;
    }

    // 百分比格式
    ws.getCell(rowIdx, 5).numFmt = '0.0%';
    ws.getCell(rowIdx, 6).numFmt = '0.0%';
    ws.getCell(rowIdx, 9).numFmt = '0.00%';
    ws.getCell(rowIdx, 10).numFmt = '0.00%';
    ws.getCell(rowIdx, 11).numFmt = '0.00%';
    ws.getCell(rowIdx, 12).numFmt = '#,##0.00';
  }

  // 冻结首行
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // 自动筛选
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  // 列宽
  ws.columns.forEach((col, i) => {
    col.width = [12, 10, 12, 12, 14, 14, 10, 30, 14, 14, 14, 16][i] || 12;
  });
}

// ============================================================
// 表二：每年统计表
// ============================================================
function buildYearlySheet(ws, yearlyStats) {
  const headers = [
    '年份', '年度收益率', '年度最大回撤',
    '年初资产', '年末资产',
    '平均创业板仓位', '买入次数', '卖出次数',
    '创业板年度涨跌', '红利年度涨跌',
    '红利持有基准', '全年主要动作'
  ];
  ws.addRow(headers);
  styleHeaderRow(ws, headers.length);

  for (let i = 0; i < yearlyStats.length; i++) {
    const s = yearlyStats[i];
    const row = [
      s.year,
      s.annual_ret,
      s.max_drawdown,
      s.asset_start,
      s.asset_end,
      s.avg_weight,
      s.buy_count,
      s.sell_count,
      s.cyb_ret,
      s.hli_ret,
      s.hli_bh_ret,
      s.summary || ''
    ];
    const rowIdx = i + 2;
    ws.addRow(row);
    styleDataRow(ws, rowIdx, headers.length);

    // 百分比格式
    ws.getCell(rowIdx, 2).numFmt = '0.0%';
    ws.getCell(rowIdx, 3).numFmt = '0.0%';
    ws.getCell(rowIdx, 4).numFmt = '#,##0.00';
    ws.getCell(rowIdx, 5).numFmt = '#,##0.00';
    ws.getCell(rowIdx, 6).numFmt = '0.0%';
    ws.getCell(rowIdx, 9).numFmt = '0.0%';
    ws.getCell(rowIdx, 10).numFmt = '0.0%';
    ws.getCell(rowIdx, 11).numFmt = '0.0%';
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  ws.columns.forEach((col, i) => {
    col.width = [8, 12, 12, 16, 16, 14, 10, 10, 14, 14, 14, 30][i] || 12;
  });
}

// ============================================================
// 表三：档位操作表
// ============================================================
function buildTiersSheet(ws, stratConf) {
  const headers = ['类型', '档位', '触发条件', '单档操作', '单档金额', '累计/剩余仓位', '理由'];
  ws.addRow(headers);
  styleHeaderRow(ws, headers.length);

  const buyLevels = stratConf.buy_levels || config.buyLevels;
  const sellLevels = stratConf.sell_levels || config.sellLevels;

  let rowIdx = 2;

  // 买入20档
  for (let i = 0; i < buyLevels.length; i++) {
    const tier = i + 1;
    ws.addRow([
      '买入', `买${tier}档`, `≤${buyLevels[i].toFixed(4)}`,
      '买入5%', `${config.tierAmount}元`,
      `累计${tier * 5}%`,
      '比值进入历史低位区，左侧分批承接，摊低成本'
    ]);
    styleDataRow(ws, rowIdx, headers.length);
    ws.getCell(rowIdx, 1).font = BUY_FONT;
    rowIdx++;
  }

  // 空行分隔
  ws.addRow([]);
  rowIdx++;

  // 卖出20档
  for (let i = 0; i < sellLevels.length; i++) {
    const tier = i + 1;
    ws.addRow([
      '卖出', `卖${tier}档`, `≥${sellLevels[i].toFixed(4)}`,
      '卖出5%', `${config.tierAmount}元`,
      `剩余${100 - tier * 5}%`,
      '比值进入历史中高位区，右侧分批止盈，锁定利润'
    ]);
    styleDataRow(ws, rowIdx, headers.length);
    ws.getCell(rowIdx, 1).font = SELL_FONT;
    rowIdx++;
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  ws.columns.forEach((col, i) => {
    col.width = [8, 10, 14, 12, 12, 14, 40][i] || 12;
  });
}

// ============================================================
// 导出 Excel
// ============================================================
async function exportExcel(outputPath) {
  const outFile = outputPath || path.join(config.dataDir, `ratio_rotation_export_${nowBeijing().slice(0, 10)}.xlsx`);

  console.log('='.repeat(60));
  console.log('Excel 导出');
  console.log('='.repeat(60));

  const data = loadData();
  if (!data.daily_records || data.daily_records.length === 0) {
    console.log('✗ 无数据可导出，请先运行 init-history');
    return { success: false, error: '无数据' };
  }

  console.log(`数据量: ${data.daily_records.length} 条每日记录, ${data.yearly_stats.length} 条年别统计`);

  // 备份
  backup('export-excel');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '比值轮动系统';
  workbook.created = new Date();

  // 表一：每日统计
  console.log('\n[1/3] 生成每日统计表...');
  const ws1 = workbook.addWorksheet('每日统计');
  buildDailySheet(ws1, data.daily_records);
  console.log(`  ${data.daily_records.length} 行`);

  // 表二：每年统计
  console.log('[2/3] 生成每年统计表...');
  const ws2 = workbook.addWorksheet('每年统计');
  buildYearlySheet(ws2, data.yearly_stats);
  console.log(`  ${data.yearly_stats.length} 行`);

  // 表三：档位操作
  console.log('[3/3] 生成档位操作表...');
  const ws3 = workbook.addWorksheet('档位操作');
  buildTiersSheet(ws3, data.strategy_config || getStrategyConfig());
  console.log('  40 行 (买20 + 卖20)');

  // 写入文件
  await workbook.xlsx.writeFile(outFile);

  console.log('\n' + '='.repeat(60));
  console.log(`✓ 导出完成: ${outFile}`);
  console.log('='.repeat(60));

  return { success: true, outputPath: outFile };
}

// ============================================================
// 命令行入口
// ============================================================
if (require.main === module) {
  const args = process.argv.slice(2);
  const outputPath = args[0] || null;
  exportExcel(outputPath).catch(e => {
    console.error('导出异常:', e.message);
    process.exit(1);
  });
}

module.exports = { exportExcel };
