$ErrorActionPreference = 'Stop'
Set-Location G:\kimi\kimi-code\apps\kimi-code\src

$src = 'tui'
$dst = 'tui2'

# Walk both trees.
$walk = {
  param($dir)
  Get-ChildItem -Recurse -File -Path $dir -Filter '*.ts' -ErrorAction SilentlyContinue | ForEach-Object {
    $_.FullName.Substring((Get-Item $dir).FullName.Length + 1) -replace '\\', '/'
  }
}
$v1 = & $walk $src
$v2 = & $walk $dst

Write-Host "=== tui/ .ts files: $($v1.Count) ==="
Write-Host "=== tui2/ .ts files: $($v2.Count) ==="
Write-Host ""

# Mirror check.
$missing = @($v1 | Where-Object { $v2 -notcontains $_ })
$extras = @($v2 | Where-Object { $v1 -notcontains $_ -and $_ -ne 'env.ts' -and $_ -ne 'README.md' })
Write-Host "=== mirror gaps (tui/ files without tui2/ counterpart) ==="
if ($missing.Count -eq 0) { Write-Host "  (none)" } else { $missing | ForEach-Object { Write-Host "  $_" } }
Write-Host "=== tui2-only files (extras not in tui/, expected: env.ts, README.md) ==="
if ($extras.Count -eq 0) { Write-Host "  (none)" } else { $extras | ForEach-Object { Write-Host "  $_" } }
Write-Host ""

# .tsx file audit.
$tsxFiles = Get-ChildItem -Recurse -File -Path $dst -Filter '*.tsx' -ErrorAction SilentlyContinue
Write-Host "=== tui2/ .tsx files: $($tsxFiles.Count) ==="
$tsxFiles | ForEach-Object {
  $rel = $_.FullName.Substring((Get-Item $dst).FullName.Length + 1) -replace '\\', '/'
  $sib = Join-Path $_.DirectoryName ($_.BaseName + '.ts')
  $sibExists = Test-Path $sib
  Write-Host ("  {0,-40} sibling .ts exists: {1}" -f $rel, $sibExists)
}
Write-Host ""

# Stub content audit: every .ts whose first line does NOT start with
# the SKELETON banner should be a real file (env.ts, index.ts, or
# a .ts facade for a .tsx sibling). Anything else is a leak.
$banner = '// TUI2 SKELETON -- placeholder.'
$real = @()
$stale = @()
foreach ($f in (Get-ChildItem -Recurse -File -Path $dst -Filter '*.ts' -ErrorAction SilentlyContinue)) {
  $first = (Get-Content $f.FullName -TotalCount 1 -ErrorAction SilentlyContinue)
  $isStub = $first -and $first.StartsWith($banner)
  $rel = $f.FullName.Substring((Get-Item $dst).FullName.Length + 1) -replace '\\', '/'
  if (-not $isStub) {
    $relBase = ($rel -replace '\.ts$', '')
    $hasTsx = Test-Path (Join-Path $f.DirectoryName ($f.BaseName + '.tsx'))
    $isIndex = ($rel -eq 'index.ts')
    $isEnv = ($rel -eq 'env.ts')
    if ($hasTsx -or $isIndex -or $isEnv) {
      $real += $rel
    } else {
      $stale += $rel
    }
  }
}
Write-Host "=== real .ts files (preserved, not stubs): $($real.Count) ==="
$real | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "=== unexpected non-stub .ts files (potential bugs): $($stale.Count) ==="
if ($stale.Count -eq 0) { Write-Host "  (none)" } else { $stale | ForEach-Object { Write-Host "  $_" } }
