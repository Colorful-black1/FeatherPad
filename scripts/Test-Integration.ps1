#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-Dev.ps1')
& cargo test --manifest-path (Join-Path $PSScriptRoot '..\src-tauri\Cargo.toml') --locked --offline --tests
exit $LASTEXITCODE
