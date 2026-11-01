#requires -Version 5.1
[CmdletBinding()]
param([switch]$AsJson)
$ErrorActionPreference = 'Stop'
$checks = [System.Collections.Generic.List[object]]::new()
function Add-PathCheck([string]$Name, [string]$Path, [string]$Level = 'path') {
    $checks.Add([pscustomobject]@{ name = $Name; path = $Path; level = $Level; found = (Test-Path -LiteralPath $Path) })
}
Add-PathCheck 'node-selected' 'E:\Codeing\nvm\v22.13.0\node.exe'
Add-PathCheck 'pnpm-script' 'E:\Codeing\node\node_global\node_modules\pnpm\bin\pnpm.cjs'
Add-PathCheck 'rustc' 'C:\Users\abcd\.cargo\bin\rustc.exe'
Add-PathCheck 'cargo' 'C:\Users\abcd\.cargo\bin\cargo.exe'
Add-PathCheck 'git' 'C:\Program Files\Git\cmd\git.exe'
Add-PathCheck 'msvc-init' 'E:\Codeing\sdks\vs2022\VC\Auxiliary\Build\vcvars64.bat'
Add-PathCheck 'windows-sdk' 'C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0'
Add-PathCheck 'webview2' 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application\156.0.4314.50'
$versions = [ordered]@{}
$versionProbes = @(
    @{ Name = 'node'; Exe = 'E:\Codeing\nvm\v22.13.0\node.exe'; Args = @('--version') },
    @{ Name = 'pnpm'; Exe = 'E:\Codeing\nvm\v22.13.0\node.exe'; Args = @('E:\Codeing\node\node_global\node_modules\pnpm\bin\pnpm.cjs', '--version') },
    @{ Name = 'rustc'; Exe = 'C:\Users\abcd\.cargo\bin\rustc.exe'; Args = @('--version') },
    @{ Name = 'cargo'; Exe = 'C:\Users\abcd\.cargo\bin\cargo.exe'; Args = @('--version') },
    @{ Name = 'git'; Exe = 'C:\Program Files\Git\cmd\git.exe'; Args = @('--version') }
)
foreach ($probe in $versionProbes) {
    if (Test-Path -LiteralPath $probe.Exe) {
        $probeArgs = $probe.Args
        $versionOutput = & $probe.Exe @probeArgs 2>&1
        $versions[$probe.Name] = [ordered]@{ output = ($versionOutput -join "`n"); exitCode = $LASTEXITCODE }
    }
}
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$msvcComponent = $null
if (Test-Path -LiteralPath $vswhere) {
    $msvcComponent = (& $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath) -join "`n"
}
$report = [ordered]@{
    schemaVersion = 1
    checkedAt = [datetime]::UtcNow.ToString('o')
    scope = 'read-only discovery; no installation or compilation'
    checks = $checks.ToArray()
    versions = $versions
    msvcComponentLocation = $msvcComponent
    nativeCompilationVerified = $false
    newToolInstallRoot = 'E:\Codeing\featherpad-dev'
}
if ($AsJson) { $report | ConvertTo-Json -Depth 7 }
else {
    $checks | Format-Table -AutoSize
    $versions | ConvertTo-Json -Depth 4
    Write-Host "MSVC component: $msvcComponent"
    Write-Host 'Discovery only: paths and versions checked; no tools installed or native build performed.'
}
$missing = @($checks | Where-Object { -not $_.found })
$failed = @($versions.Values | Where-Object { $_.exitCode -ne 0 })
if ($missing.Count -gt 0 -or $failed.Count -gt 0 -or -not $msvcComponent) {
    Write-Warning 'Environment differs from the recorded snapshot. Locate existing tools before any E-drive-only installation.'
    exit 1
}
