#requires -Version 5.1
# Dot-source: . .\scripts\Enter-Dev.ps1
# ASCII source is intentional: Windows PowerShell 5.1 also reads UTF-8 without BOM safely.
# This script only changes the current process, never machine/user environment settings.
[CmdletBinding()]
param([string]$DevRoot = 'E:\Codeing\featherpad-dev')
$ErrorActionPreference = 'Stop'
if ($MyInvocation.InvocationName -ne '.') {
    throw 'Dot-source this script: . .\scripts\Enter-Dev.ps1'
}
$resolvedDevRoot = [System.IO.Path]::GetFullPath($DevRoot)
if (-not $resolvedDevRoot.StartsWith('E:\Codeing\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'All new development directories must be under E:\Codeing.'
}
$nodeDir = 'E:\Codeing\nvm\v22.13.0'
$pnpmScript = 'E:\Codeing\node\node_global\node_modules\pnpm\bin\pnpm.cjs'
$rustBin = 'C:\Users\abcd\.cargo\bin'
$rustupHome = 'C:\Users\abcd\.rustup'
foreach ($requiredPath in @("$nodeDir\node.exe", $pnpmScript, "$rustBin\cargo.exe", "$rustBin\rustc.exe", $rustupHome)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Previously discovered tool is missing: $requiredPath. Re-run Probe-Environment; do not auto-install."
    }
}
$cacheRoot = Join-Path $resolvedDevRoot 'cache'
foreach ($directoryName in @('pnpm-store', 'npm', 'cargo', 'temp', 'playwright')) {
    New-Item -ItemType Directory -Path (Join-Path $cacheRoot $directoryName) -Force | Out-Null
}
$env:PATH = "$nodeDir;$rustBin;C:\Program Files\Git\cmd;$env:PATH"
$env:RUSTUP_HOME = $rustupHome
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
$env:CARGO_HOME = Join-Path $cacheRoot 'cargo'
$env:npm_config_cache = Join-Path $cacheRoot 'npm'
$env:npm_config_store_dir = Join-Path $cacheRoot 'pnpm-store'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $cacheRoot 'playwright'
$env:TEMP = Join-Path $cacheRoot 'temp'
$env:TMP = $env:TEMP
$msvcInit = 'E:\Codeing\sdks\vs2022\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $msvcInit)) {
    throw 'Previously discovered MSVC initialization is missing. Re-run Probe-Environment.'
}
# Import the developer environment into this process only. No user/machine PATH edits.
$msvcEnvironment = & $env:ComSpec /d /s /c "`"`"$msvcInit`" >nul && set`""
if ($LASTEXITCODE -ne 0) { throw 'MSVC developer environment initialization failed.' }
foreach ($environmentLine in $msvcEnvironment) {
    if ($environmentLine -match '^([^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}
$env:PATH = "$nodeDir;$rustBin;C:\Program Files\Git\cmd;$env:PATH"
$env:FEATHERPAD_NODE_EXE = Join-Path $nodeDir 'node.exe'
$env:FEATHERPAD_PNPM_SCRIPT = $pnpmScript
function global:pnpm { & $env:FEATHERPAD_NODE_EXE $env:FEATHERPAD_PNPM_SCRIPT @args }
Write-Host 'FeatherPad session: existing Node 22.13.0 and Rust; new caches stay on E:\Codeing.'
& $env:FEATHERPAD_NODE_EXE --version
if ($LASTEXITCODE -ne 0) { throw 'Node version check failed.' }
& $env:FEATHERPAD_NODE_EXE $pnpmScript --version
if ($LASTEXITCODE -ne 0) { throw 'pnpm version check failed.' }
& "$rustBin\rustc.exe" --version
if ($LASTEXITCODE -ne 0) { throw 'Rust version check failed.' }
Write-Host 'MSVC loaded for this process. No dependencies installed or system PATH changed.'
