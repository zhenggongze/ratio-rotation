$tasks = Get-ScheduledTask | Where-Object { $_.TaskName -match 'ratio|rotation' -or $_.TaskName -match 'valuation' }
if ($tasks) {
    $tasks | Select-Object TaskName, State, TaskPath | Format-Table -AutoSize
    Write-Host "---"
    Write-Host "Total: $($tasks.Count)"
} else {
    Write-Host "No ratio/rotation/valuation tasks found."
    Write-Host "---"
    $all = Get-ScheduledTask
    Write-Host "All tasks count: $($all.Count)"
    Write-Host "---"
    Write-Host "Tasks containing 'daily' or 'push':"
    $all | Where-Object { $_.TaskName -match 'daily|push' } | Select-Object TaskName, State | Format-Table -AutoSize
}
