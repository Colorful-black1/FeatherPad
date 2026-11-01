#requires -Version 5.1
param([switch]$Desktop)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-Dev.ps1')
Push-Location (Join-Path $PSScriptRoot '..')
try {
    foreach ($taskName in @('typecheck', 'lint', 'test:unit', 'test:integration', 'test:e2e')) {
        & $env:FEATHERPAD_NODE_EXE $env:FEATHERPAD_PNPM_SCRIPT $taskName
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    & cargo fmt --manifest-path src-tauri/Cargo.toml --check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & cargo clippy --manifest-path src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if ($Desktop) {
        & $env:FEATHERPAD_NODE_EXE $env:FEATHERPAD_PNPM_SCRIPT test:desktop
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
} finally { Pop-Location }
exit 0
