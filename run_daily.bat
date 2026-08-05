@echo off
chcp 65001 >nul
REM 比值轮动系统 — 每日定时任务启动脚本
REM 由 Windows 任务计划程序 \RatioRotationDaily16 每天 16:00 调用
REM 双策略并行：创业板/红利 + 科创50/红利
REM 参考 AI 算力新闻项目 workflow_logger.py --finish 的 if:always 机制
REM 失败时自动推送 PushDeer 通知，确保用户知道任务状态

cd /d "D:\TRAE SOLO CN\各类测试\ratio-rotation"

REM 记录开始时间
echo. >> data\logs\daily\run_daily_console.log
echo ===== %date% %time% 开始运行 ===== >> data\logs\daily\run_daily_console.log

REM 执行每日任务（采集数据 + 判定信号 + 计算收益 + 推送 + 同步前端数据）
node main.cjs run-daily >> data\logs\daily\run_daily_console.log 2>&1
set EXITCODE=%errorlevel%

REM 检查退出码：非0表示 node 崩溃（未捕获异常），推送失败通知
if not %EXITCODE%==0 (
  echo ===== %date% %time% node崩溃 退出码%EXITCODE% 推送失败通知 ===== >> data\logs\daily\run_daily_console.log
  node main.cjs notify-failure "run-daily退出码%EXITCODE% 未捕获异常" >> data\logs\daily\run_daily_console.log 2>&1
)

REM 记录结束时间
echo ===== %date% %time% 运行结束 ===== >> data\logs\daily\run_daily_console.log
echo. >> data\logs\daily\run_daily_console.log
