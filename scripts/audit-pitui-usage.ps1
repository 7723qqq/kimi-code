$ErrorActionPreference = 'Stop'
Set-Location G:\kimi\kimi-code\apps\kimi-code\src\tui

$files = Get-ChildItem -Recurse -File -Filter '*.ts'
$importFiles = $files | Where-Object { Select-String -Path $_.FullName -Pattern 'from .@moonshot-ai/pi-tui.' -SimpleMatch -Quiet }
Write-Host "files importing pi-tui: $($importFiles.Count) / $($files.Count)"

$names = @(
  'Container', 'Component', 'TUI', 'TuiAltScreen', 'TuiMainScreen',
  'Markdown', 'Text', 'Spacer', 'Image', 'Key', 'matchesKey',
  'Focusable', 'AutocompleteItem', 'SlashCommand', 'TuiClickEvent',
  'MarkdownOptions', 'MarkdownTheme', 'EditorTheme',
  'truncateToWidth', 'visibleWidth', 'decodeKittyPrintable',
  'fuzzyFilter', 'getCapabilities', 'ImageTheme', 'CURSOR_MARKER',
  'ScrollView', 'OverlayHandle', 'TuiInputListener', 'isFocusable'
)
$rows = foreach ($n in $names) {
  $count = 0
  foreach ($f in $files) {
    if (Select-String -Path $f.FullName -Pattern ("\b" + [regex]::Escape($n) + "\b") -SimpleMatch:$false -Quiet) { $count++ }
  }
  [PSCustomObject]@{ Name = $n; Files = $count }
}
$rows | Sort-Object -Property Files -Descending | Format-Table -AutoSize
