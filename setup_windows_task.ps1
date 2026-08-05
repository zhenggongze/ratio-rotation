# ============================================================
# Ratio Rotation - Windows Task Scheduler Setup Script
# Creates reliable scheduled task with fault tolerance:
#   - Auto run on startup if missed (catchup)
#   - Retry 3 times on failure (5min interval)
#   - Allow running on battery / lock screen
#
# Usage:
#   PowerShell -ExecutionPolicy Bypass -File setup_windows_task.ps1
# ============================================================

$ErrorActionPreference = "Stop"

# Task name
$TaskName = "RatioRotationDaily"
$TaskPath = "\TRAE\"

# Script directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BatPath = Join-Path $ScriptDir "run_daily.bat"

Write-Host "=========================================="
Write-Host "Ratio Rotation - Windows Task Scheduler Setup"
Write-Host "=========================================="
Write-Host "Task Name: $TaskPath$TaskName"
Write-Host "Script:    $BatPath"
Write-Host ""

# Check script exists
if (-not (Test-Path $BatPath)) {
    Write-Host "[ERROR] Script not found: $BatPath" -ForegroundColor Red
    exit 1
}

# Check existing task
$existingTask = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Host "[WARN] Task exists, will delete and recreate..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false
    Write-Host "[OK] Old task deleted" -ForegroundColor Green
}

# ============================================================
# Trigger: Daily at 16:00 (including weekends/holidays)
# 用户要求：每天16:00推送，休息日也推送最新状态
# ============================================================
$Trigger = New-ScheduledTaskTrigger -Daily -At 16:00
$Trigger.StartBoundary = [DateTime]::Today.AddHours(16).AddMinutes(0).ToString("yyyy-MM-dd'T'HH:mm:ss")

# ============================================================
# Action: Execute bat script
# ============================================================
$Action = New-ScheduledTaskAction -Execute $BatPath -WorkingDirectory $ScriptDir

# ============================================================
# Settings: fault tolerance
# ============================================================
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RunOnlyIfNetworkAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew

# StartWhenAvailable:        Auto run after missed trigger (catchup on startup)
# RestartCount 3:            Retry 3 times on failure
# RestartInterval 5min:      Retry interval
# AllowStartIfOnBatteries:   Allow running on battery
# DontStopIfGoingOnBatteries: Dont stop when switching to battery
# RunOnlyIfNetworkAvailable: Need network (data fetch)
# ExecutionTimeLimit 1h:     Max execution time
# MultipleInstances IgnoreNew: Ignore new trigger if running

# ============================================================
# Principal: current user, highest privilege
# ============================================================
$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

# ============================================================
# Register task
# ============================================================
try {
    Register-ScheduledTask `
        -TaskPath $TaskPath `
        -TaskName $TaskName `
        -Trigger $Trigger `
        -Action $Action `
        -Settings $Settings `
        -Principal $Principal `
        -Description "Ratio Rotation daily task (16:00 daily, including weekends. Fetches data, signal detection, push. Includes catchup: auto-runs missed trading days after shutdown/restart.)" `
        -Force

    Write-Host ""
    Write-Host "[SUCCESS] Task created!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Task Details:"
    $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
    $taskInfo = $task | Get-ScheduledTaskInfo
    Write-Host "  Name:        $($task.TaskName)"
    Write-Host "  Path:        $($task.TaskPath)"
    Write-Host "  State:       $($task.State)"
    Write-Host "  Next Run:    $($taskInfo.NextRunTime)"
    Write-Host "  Last Run:    $($taskInfo.LastRunTime)"
    Write-Host "  Last Result: $($taskInfo.LastTaskResult)"
    Write-Host ""
    Write-Host "Fault Tolerance:"
    Write-Host "  - StartWhenAvailable:   Enabled (auto-run missed task on startup)"
    Write-Host "  - Retry on failure:     3 times, 5min interval"
    Write-Host "  - Battery mode:         Allowed"
    Write-Host "  - Lock screen:          Allowed"
    Write-Host "  - Network required:     Yes"
    Write-Host ""
    Write-Host "Manual trigger command:"
    Write-Host "  Start-ScheduledTask -TaskPath '$TaskPath' -TaskName '$TaskName'"
    Write-Host ""
    Write-Host "View history:"
    Write-Host "  Get-ScheduledTaskInfo -TaskPath '$TaskPath' -TaskName '$TaskName'"
    Write-Host ""
    Write-Host "Delete task:"
    Write-Host "  Unregister-ScheduledTask -TaskPath '$TaskPath' -TaskName '$TaskName' -Confirm:`$false"

} catch {
    Write-Host ""
    Write-Host "[ERROR] Task creation failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Possible causes:"
    Write-Host "  1. Need administrator privileges"
    Write-Host "  2. Task path conflict"
    Write-Host "  3. PowerShell execution policy"
    Write-Host ""
    Write-Host "Solution:"
    Write-Host "  Run PowerShell as Administrator, then:"
    Write-Host "  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"
    Write-Host "  .\setup_windows_task.ps1"
    exit 1
}
