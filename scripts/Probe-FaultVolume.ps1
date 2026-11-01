#requires -Version 5.1
# Creates at most one 64 MiB dynamic fixture image. Never mounts/formats/fills a host disk.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-Dev.ps1')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.artifacts\T102\fault-volumes'))
if (-not $fixtureRoot.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected fault fixture root.' }
$probeRoot = Join-Path $fixtureRoot ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
$ancestor = Get-Item -LiteralPath $probeRoot
while ($ancestor.FullName -ne $projectRoot) {
    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Fault fixture path contains a reparse point.' }
    $ancestor = Get-Item -LiteralPath (Split-Path -Parent $ancestor.FullName)
}
$diskPath = Join-Path $probeRoot 'controlled-64MiB.vhdx'
$record = [ordered]@{ scope='virtual disk creation capability probe only; not a disk-full test'; checkedAt=[DateTime]::UtcNow.ToString('o'); limitBytes=67108864; created=$false; mounted=$false; formatted=$false }
$probeExit = 0
try {
    $disk = New-VHD -Path $diskPath -Dynamic -SizeBytes 67108864 -ErrorAction Stop
    if ($disk.Size -ne 67108864 -or $disk.VhdType -ne 'Dynamic') { throw 'Unexpected fixture virtual disk size/type.' }
    $record.created = $true
} catch {
    $probeExit = 1
    $record.errorId = $_.FullyQualifiedErrorId
    $record.category = [string]$_.CategoryInfo.Category
    $record.hresult = $_.Exception.HResult
    $record.message = $_.Exception.Message.Replace($env:COMPUTERNAME, '<local-machine>')
}
$record.imageExists = Test-Path -LiteralPath $diskPath
$record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $probeRoot 'probe.json') -Encoding UTF8
$record | ConvertTo-Json -Compress
exit $probeExit
