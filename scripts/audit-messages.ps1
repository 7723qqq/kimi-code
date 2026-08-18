$ErrorActionPreference = 'Stop'
Set-Location G:\kimi\kimi-code\apps\kimi-code\src\tui\components
$dirs = @('messages', 'dialogs', 'panes', 'chrome')
foreach ($d in $dirs) {
  $files = Get-ChildItem -Recurse -File -Path $d -Filter '*.ts' -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "== $d/ $($files.Count) files =="
  $rows = foreach ($f in $files) {
    $lines = (Get-Content $f.FullName | Measure-Object -Line).Lines
    [PSCustomObject]@{ Lines = $lines; Name = $f.Name }
  }
  $rows | Sort-Object -Property Lines -Descending | Select-Object -First 20 | Format-Table -AutoSize
}
