# Create or refresh tui2/ skeleton WITHOUT touching any real file.
#
# Rules:
#   1. NEVER delete or overwrite a tui2/ file that is not a skeleton stub.
#      A tui2/ file is a "skeleton stub" iff its content starts with
#      the banner `// TUI2 SKELETON -- placeholder.`. Real files
#      (env.ts, index.ts, README.md, *.tsx) are preserved verbatim.
#   2. For every tui/X.ts source file, ensure tui2/X.ts exists:
#      - If a tui2/X.tsx sibling exists, write a thin facade
#        `export * from './X.tsx'`. Facade counts as a stub and
#        will be refreshed on each run.
#      - Otherwise, write the v1 re-export stub.
#   3. UTF-8 without BOM (oxlint rejects BOM as irregular whitespace).
#
# This script is the safe re-run: it preserves all real impls and only
# refreshes skeleton stubs / facades / missing files.

$ErrorActionPreference = 'Stop'
$baseDir = 'G:\kimi\kimi-code\apps\kimi-code\src'
$src = Join-Path $baseDir 'tui'
$dst = Join-Path $baseDir 'tui2'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$banner = '// TUI2 SKELETON -- placeholder.'

if (-not (Test-Path $dst)) {
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
}

# Index existing tui2/ .tsx files. .tsx files are NEVER touched.
$existingTsx = @{}
Get-ChildItem -Recurse -File -Path $dst -Filter '*.tsx' -ErrorAction SilentlyContinue | ForEach-Object {
  $rel = $_.FullName.Substring($dst.Length + 1) -replace '\\', '/' -replace '\.tsx$', ''
  $existingTsx[$rel] = $_.FullName
}
Write-Host "existing tui2/ .tsx real impls: $($existingTsx.Count)"

# Helper: is the tui2/ .ts file a skeleton stub we may refresh?
function Test-IsStub($path) {
  if (-not (Test-Path $path)) { return $true }  # missing -> we will create
  $first = (Get-Content $path -TotalCount 1 -ErrorAction SilentlyContinue)
  return ($first -and $first.StartsWith($banner))
}

# Set of every relative path that needs a .ts file. Start from the
# v1 mirror list and union with the .tsx-only list.
$targetPaths = @{}

Get-ChildItem -Recurse -File -Path $src -Filter '*.ts' -ErrorAction SilentlyContinue | ForEach-Object {
  $rel = $_.FullName.Substring($src.Length + 1) -replace '\\', '/' -replace '\.ts$', ''
  $targetPaths[$rel] = $true
}
Write-Host "v1 mirrors: $($targetPaths.Count)"

foreach ($rel in $existingTsx.Keys) {
  $targetPaths[$rel] = $true
}
Write-Host "v1 mirrors + tui2-only .tsx: $($targetPaths.Count)"

$stubsCreated = 0
$facadesCreated = 0
$preservedReal = 0
$preservedStub = 0

foreach ($rel in $targetPaths.Keys) {
  $tsRel = "$rel.ts"
  $tsPath = Join-Path $dst $tsRel
  $tsDir = Split-Path $tsPath -Parent

  if (-not (Test-Path $tsDir)) {
    New-Item -ItemType Directory -Path $tsDir -Force | Out-Null
  }

  if (Test-Path $tsPath) {
    if (-not (Test-IsStub $tsPath)) {
      # Real file (env.ts, index.ts, README.md equivalent in tui2/,
      # or any future tui2/ file with a v1 mirror but real content).
      # Preserve verbatim.
      $preservedReal++
      continue
    }
    $preservedStub++
  }

  if ($existingTsx.ContainsKey($rel)) {
    $baseName = ($rel -split '/')[-1]
    $facade = "export * from './$baseName.tsx'`r`n"
    [System.IO.File]::WriteAllText($tsPath, $facade, $utf8NoBom)
    $facadesCreated++
  } else {
    $v1Rel = "$rel.ts"
    $targetDepth = ($rel -split '/').Count
    $upPath = ('../' * $targetDepth) + 'tui/' + $rel + '.ts'
    $upPath = $upPath -replace '\\', '/'

    $content = @"
// TUI2 SKELETON -- placeholder.
//
// Mirrors: tui/$v1Rel
// Re-exports the v1 surface so the skeleton compiles and resolves imports.
// Replace the body of this file with a real tui2 implementation when
// migrating the matching component, controller, or utility. The skeleton
// keeps the same exported names so callers can swap imports one file at
// a time without churning the rest of the tree.
//
// Status: PLACEHOLDER (re-export only). Do not add new behavior here.
export * from '$upPath';
"@
    [System.IO.File]::WriteAllText($tsPath, $content, $utf8NoBom)
    $stubsCreated++
  }
}

Write-Host "stubs created: $stubsCreated"
Write-Host "facades created/refreshed: $facadesCreated"
Write-Host "stubs left unchanged: $preservedStub"
Write-Host "real files preserved: $preservedReal"

$dstTs = (Get-ChildItem -Recurse -File -Path $dst -Filter '*.ts' -ErrorAction SilentlyContinue).Count
$dstTsx = (Get-ChildItem -Recurse -File -Path $dst -Filter '*.tsx' -ErrorAction SilentlyContinue).Count
Write-Host "tui2/ .ts files: $dstTs"
Write-Host "tui2/ .tsx files: $dstTsx"
