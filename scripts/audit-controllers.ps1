$ErrorActionPreference = 'Stop'
Set-Location G:\kimi\kimi-code\apps\kimi-code\src\tui
$dirs = @('controllers', 'reverse-rpc', 'theme', 'utils')
foreach ($d in $dirs) {
  $files = Get-ChildItem -Recurse -File -Path $d -Filter '*.ts' -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "== $d/ $($files.Count) files =="
  $rows = foreach ($f in $files) {
    $lines = (Get-Content $f.FullName | Measure-Object -Line).Lines
    [PSCustomObject]@{ Lines = $lines; Name = $f.Name }
  }
  $rows | Sort-Object -Property Lines -Descending | Format-Table -AutoSize
}
