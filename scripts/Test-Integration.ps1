#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-Dev.ps1')
# Filesystem fixtures share a Windows volume. Keep test binaries serial so sibling
# setup cannot race a directory revision assertion; explicit concurrency tests stay in-test.
& cargo test --manifest-path (Join-Path $PSScriptRoot '..\src-tauri\Cargo.toml') --locked --offline --tests -- --test-threads=1
exit $LASTEXITCODE
