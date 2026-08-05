# E2E测试用例文档 — 比值轮动系统

## 测试环境
- 生产URL: https://portfolio-analysis.top/ratio-rotation/index.html
- 桌面端视口: 1280x900
- 移动端视口: 428x926 (iPhone 14 Plus)

---

## 第1轮：主流程冒烟测试（用户首次访问）

| 用例ID | 测试点 | 预期结果 | 验证方式 |
|--------|--------|----------|----------|
| 1.1 | 页面能正常打开 | HTTP 200, 标题包含"比值轮动" | navigate + title检查 |
| 1.2 | 加载完成 | loading隐藏, content显示 | DOM display检查 |
| 1.3 | 头部标题渲染 | h1包含"创业板"和"红利" | textContent检查 |
| 1.4 | 指标卡片渲染 | metricsGrid有5个卡片 | querySelectorAll计数 |
| 1.5 | 当前状态渲染 | statusContent有内容 | innerHTML长度>50 |
| 1.6 | 走势图Canvas | chart canvas存在 | getElementById检查 |
| 1.7 | Chart.js初始化 | Chart对象存在且canvas已绑定 | typeof Chart检查 |
| 1.8 | 历年收益表 | yearlyTable有行 | tr计数>0 |
| 1.9 | 档位操作表 | buyTiersTable和sellTiersTable有行 | tr计数>0 |
| 1.10 | 调仓记录 | tradesTable有行 | tr计数>0 |
| 1.11 | 最近60交易日 | dailyTable有行 | tr计数>0 |
| 1.12 | 页脚渲染 | footer包含"数据更新时间" | textContent检查 |
| 1.13 | 无JS错误 | pageerror列表为空 | pageerror监听 |
| 1.14 | 无控制台错误 | console error为空 | console监听 |

---

## 第2轮：核心交互测试（滚动/点击/图表）

| 用例ID | 测试点 | 预期结果 | 验证方式 |
|--------|--------|----------|----------|
| 2.1 | 页面滚动 | scrollY变化, 无错误 | scroll down + scrollY检查 |
| 2.2 | 回到顶部 | scrollY=0 | scroll up + 检查 |
| 2.3 | Chart.js数据集 | 3个dataset(创业板/红利/仓位) | Chart.getChart检查 |
| 2.4 | Chart.js数据点 | labels数量>100 | chart.data.labels检查 |
| 2.5 | 滚动到图表区域 | 图表可见 | scrollIntoView + 截图 |
| 2.6 | 滚动到收益表 | 表格可见 | scrollIntoView + 检查 |
| 2.7 | 滚动到底部 | 页脚可见 | scroll + footer检查 |
| 2.8 | 窗口resize | 无JS错误 | resize + error检查 |

---

## 第3轮：移动端适配测试（iPhone 14 Plus 428x926）

| 用例ID | 测试点 | 预期结果 | 验证方式 |
|--------|--------|----------|----------|
| 3.1 | 移动端页面加载 | content显示 | viewport设置 + DOM检查 |
| 3.2 | 移动端指标卡片 | 卡片横向排列或网格 | innerWidth检查 |
| 3.3 | 移动端响应式布局 | yearly-mobile显示, yearly-desktop隐藏 | computedStyle检查 |
| 3.4 | 移动端图表渲染 | Chart.js正常渲染 | chart实例检查 |
| 3.5 | 移动端滚动 | 可正常滚动 | scroll + scrollY检查 |
| 3.6 | 移动端表格 | 表格不溢出 | scrollWidth <= clientWidth |
| 3.7 | 移动端无JS错误 | pageerror为空 | error监听 |

---

## 第4轮：桌面端深度交互测试

| 用例ID | 测试点 | 预期结果 | 验证方式 |
|--------|--------|----------|----------|
| 4.1 | 桌面端布局 | 宽度1280, 内容居中 | innerWidth检查 |
| 4.2 | 桌面端收益表 | yearly-desktop显示 | computedStyle检查 |
| 4.3 | 桌面端档位表 | tiers-grid显示为grid | computedStyle检查 |
| 4.4 | 桌面端图表尺寸 | canvas宽高合理 | canvas.width/height |
| 4.5 | 桌面端全页滚动 | scrollHeight>viewport | body.scrollHeight检查 |
| 4.6 | 桌面端数据完整性 | 所有表格行数合理 | tr计数验证 |
| 4.7 | 桌面端无控制台警告 | console warning为空 | console监听 |

---

## 第5轮：数据展示完整性测试

| 用例ID | 测试点 | 预期结果 | 验证方式 |
|--------|--------|----------|----------|
| 5.1 | 当前比值显示 | statusContent包含4位小数 | textContent正则 |
| 5.2 | 历史分位显示 | 包含"p"和数字 | textContent检查 |
| 5.3 | 仓位百分比显示 | 包含"0%"或"100%" | textContent检查 |
| 5.4 | 收益表年份覆盖 | 2014~当前年份 | tr计数和文本 |
| 5.5 | 负收益正确显示 | 包含负号 | textContent检查 |
| 5.6 | 日期格式正确 | YYYY-MM-DD格式 | textContent正则 |
| 5.7 | 前后端数据一致 | current_status与后端latest一致 | fetch对比 |
| 5.8 | 比值计算正确 | cyb_close/hli_close=ratio | 数值验证 |
| 5.9 | 月度图表数据点 | monthly_chart长度>100 | 数据计数 |
| 5.10 | 调仓记录完整性 | trade方向/档数/日期完整 | 文本检查 |
