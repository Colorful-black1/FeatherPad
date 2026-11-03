$ErrorActionPreference = 'Stop'
. .\scripts\Enter-Dev.ps1
$workspaceExe = [IO.Path]::GetFullPath((Join-Path $PWD 'src-tauri/target/release/featherpad.exe'))
if (Get-Process featherpad -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $workspaceExe }) {
  throw 'Run this compile-time service special before desktop acceptance, with the workspace app closed.'
}
# Cargo integration tests may relink the app without Tauri custom-protocol.
# Always regenerate the offline app with pnpm build after this service special.
$faultName = 'featherpad-fault-' + [guid]::NewGuid().ToString('N')
$linuxRoot = '/mnt/' + $faultName
$faultToken = [guid]::NewGuid().ToString()
$env:FEATHERPAD_EXPORT_FAULT_ROOT = '\\wsl.localhost\Ubuntu\mnt\' + $faultName
$env:FEATHERPAD_EXPORT_FAULT_TOKEN = $faultToken
try {
  & wsl.exe -d Ubuntu -u root --exec sh -lc "set -eu; mkdir -p '$linuxRoot'; mount -t tmpfs -o size=16m,mode=0777 tmpfs '$linuxRoot'; printf '%s' 'controlled-original-pdf' > '$linuxRoot/original.pdf'; printf '%s' '$faultToken' > '$linuxRoot/fixture.token'; if dd if=/dev/zero of='$linuxRoot/fill.bin' bs=64K count=256 status=none; then exit 2; else test `$? -eq 1; fi"
  if ($LASTEXITCODE -ne 0) { throw 'Controlled full volume preparation failed' }
  cargo test --release --manifest-path src-tauri/Cargo.toml --locked --offline --test export_faults -- --ignored --nocapture
  $testExit = $LASTEXITCODE
} finally {
  & wsl.exe -d Ubuntu -u root --exec sh -lc "if mountpoint -q '$linuxRoot'; then umount -l '$linuxRoot'; fi; rmdir '$linuxRoot'"
}
Write-Output 'Full-volume service special finished. Run pnpm build before launching desktop acceptance.'
exit $testExit
