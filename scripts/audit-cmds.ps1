$ErrorActionPreference = 'Stop'
Set-Location G:\kimi\kimi-code\apps\kimi-code\src\tui
$cmds = Get-ChildItem -File -Path commands -Filter '*.ts' -ErrorAction SilentlyContinue
Write-Host "commands files: $($cmds.Count)"
$rows = foreach ($f in $cmds) {
  $lines = (Get-Content $f.FullName | Measure-Object -Line).Lines
  [PSCustomObject]@{ Lines = $lines; Name = $f.Name }
}
$rows | Sort-Object -Property Lines -Descending | Format-Table -AutoSize
