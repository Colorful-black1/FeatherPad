param(
  [string]$OutputDirectory = ".artifacts/release",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
if (-not $output.StartsWith("E:\", [StringComparison]::OrdinalIgnoreCase)) {
  throw "Packaging output must stay on E: drive: $output"
}

if (-not $SkipBuild) {
  Push-Location $repo
  try {
    & pnpm tauri build --bundles nsis
    if ($LASTEXITCODE -ne 0) {
      throw "Tauri release/NSIS build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

$exe = Join-Path $repo "src-tauri/target/release/featherpad.exe"
$installer = Get-ChildItem (Join-Path $repo "src-tauri/target/release/bundle/nsis") -Filter "*-setup.exe" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
  throw "Release executable is missing: $exe"
}
if (-not $installer) {
  throw "NSIS installer is missing. Run without -SkipBuild first."
}

$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
$short = $hash.Substring(0, 8)
New-Item -ItemType Directory -Path $output -Force | Out-Null

$portableDirectory = Join-Path $output "FeatherPad-M4-portable-$short"
if (Test-Path -LiteralPath $portableDirectory) {
  throw "Refusing to overwrite existing portable directory: $portableDirectory"
}
New-Item -ItemType Directory -Path $portableDirectory | Out-Null
Copy-Item -LiteralPath $exe -Destination (Join-Path $portableDirectory "featherpad.exe")
Copy-Item -LiteralPath (Join-Path $repo "packaging/README-portable.txt") -Destination (Join-Path $portableDirectory "README.txt")
Set-Content -LiteralPath (Join-Path $portableDirectory "portable.flag") -Value "FeatherPad portable mode" -Encoding UTF8

$portableZip = Join-Path $output "FeatherPad-M4-portable-$short.zip"
if (Test-Path -LiteralPath $portableZip) {
  throw "Refusing to overwrite existing portable archive: $portableZip"
}
Compress-Archive -LiteralPath @(
  (Join-Path $portableDirectory "featherpad.exe"),
  (Join-Path $portableDirectory "README.txt"),
  (Join-Path $portableDirectory "portable.flag")
) -DestinationPath $portableZip -CompressionLevel Optimal

$installerCopy = Join-Path $output "FeatherPad-M4-installer-$short.exe"
if (Test-Path -LiteralPath $installerCopy) {
  throw "Refusing to overwrite existing installer: $installerCopy"
}
Copy-Item -LiteralPath $installer.FullName -Destination $installerCopy
Copy-Item -LiteralPath (Join-Path $repo "packaging/README-installer.txt") -Destination (Join-Path $output "INSTALL.txt")

$installerHash = (Get-FileHash -LiteralPath $installerCopy -Algorithm SHA256).Hash
$zipHash = (Get-FileHash -LiteralPath $portableZip -Algorithm SHA256).Hash
@(
  "$hash  featherpad.exe / FeatherPad-M4-portable-$short.zip payload",
  "$installerHash  FeatherPad-M4-installer-$short.exe",
  "$zipHash  FeatherPad-M4-portable-$short.zip"
) | Set-Content -LiteralPath (Join-Path $output "SHA256SUMS.txt") -Encoding UTF8

[pscustomobject]@{
  OutputDirectory = $output
  ReleaseSha256 = $hash
  InstallerSha256 = $installerHash
  PortableZipSha256 = $zipHash
  PortableZip = $portableZip
  Installer = $installerCopy
} | ConvertTo-Json -Depth 3
