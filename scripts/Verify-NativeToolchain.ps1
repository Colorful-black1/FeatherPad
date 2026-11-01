#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-Dev.ps1')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceRoot = Join-Path $projectRoot '.artifacts\T000'
New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
$source = Join-Path $evidenceRoot 'native-probe.rs'
$executable = Join-Path $evidenceRoot 'native-probe.exe'
[IO.File]::WriteAllText($source, 'fn main() { println!("featherpad-native-ok"); }', [Text.UTF8Encoding]::new($false))
& rustc --crate-name featherpad_native_probe --edition 2021 $source -o $executable
$compileExit = $LASTEXITCODE
if ($compileExit -ne 0) { throw "Rust native compilation failed: $compileExit" }
$actual = & $executable
$runExit = $LASTEXITCODE
if ($runExit -ne 0 -or $actual -ne 'featherpad-native-ok') {
    throw "Rust native execution failed: $runExit"
}
$evidence = [ordered]@{
    schemaVersion = 1
    taskId = 'T000'
    featureId = 'F-DESK-013'
    checkedAt = [DateTime]::UtcNow.ToString('o')
    rustc = (& rustc --version)
    linker = (Get-Command link.exe -ErrorAction Stop).Source
    compileExitCode = $compileExit
    runExitCode = $runExit
    stdout = $actual
    executableSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash
    scope = 'Native MSVC compilation and execution only; not Tauri/WebView2 validation'
}
$json = $evidence | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $evidenceRoot 'result.json'), $json, [Text.UTF8Encoding]::new($false))
$json
