#requires -Version 5.1
# Test-only handle that denies deletion of one owned fixture. No production IPC.
param([Parameter(Mandatory=$true)][string]$Path,
      [Parameter(Mandatory=$true)][string]$Ready,
      [Parameter(Mandatory=$true)][string]$Release)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifacts = Join-Path $project '.artifacts\T002'
$target = [IO.Path]::GetFullPath($Path)
if (-not $target.StartsWith($artifacts + '\webview2-', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture outside owned root.' }
$owner = $target.Substring($artifacts.Length + 1).Split('\')[0]
$ownedRoot = Join-Path $artifacts $owner
$name = [IO.Path]::GetFileName($target)
if ($name -notmatch '^trash-lock-([0-9a-f-]{36})\.txt$') { throw 'Unexpected lock fixture name.' }
$token = $Matches[1]
foreach ($control in @(@($Ready, 'ready'), @($Release, 'release'))) {
    $expected = Join-Path $ownedRoot ('trash-lock-' + $token + '.' + $control[1])
    if ([IO.Path]::GetFullPath($control[0]) -ne $expected -or (Test-Path -LiteralPath $expected)) { throw 'Invalid fixture control path.' }
}
$item = Get-Item -LiteralPath $target
if ($item.PSIsContainer -or $item.Length -gt 1024) { throw 'Unexpected lock fixture type/size.' }
$ancestor = $item
while ($ancestor.FullName -ne $project) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture chain contains reparse point.' }
    $ancestor = Get-Item -LiteralPath (Split-Path -Parent $ancestor.FullName)
}
$handle = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
    [IO.File]::WriteAllText($Ready, 'ready')
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not (Test-Path -LiteralPath $Release) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
} finally { $handle.Dispose() }
