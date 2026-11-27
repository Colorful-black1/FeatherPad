param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$BuildRef = "",
  [string]$BuildTag = "",
  [switch]$RequireUpdater
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$target = Join-Path $repo "src-tauri/target/release"
$bundle = Join-Path $target "bundle/nsis"
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
if (-not $output.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Output directory must stay inside the repository: $output"
}
if (Test-Path -LiteralPath $output) {
  throw "Refusing to reuse an existing output directory: $output"
}
New-Item -ItemType Directory -Path $output -Force | Out-Null

$installer = Get-ChildItem -LiteralPath $bundle -Filter "*-setup.exe" -File -ErrorAction Stop |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) {
  throw "NSIS installer is missing under $bundle"
}

$installerName = "FeatherPad_${Version}_x64-setup.exe"
$installerCopy = Join-Path $output $installerName
Copy-Item -LiteralPath $installer.FullName -Destination $installerCopy

# Tauri v2 can sign either the installer directly or a .nsis.zip wrapper.
$updaterSource = $installer
$signature = Get-ChildItem -LiteralPath $bundle -Filter "*.sig" -File |
  Where-Object { $_.Name -like "$($installer.Name)*" } |
  Sort-Object { $_.Name -like "*.exe.sig" } -Descending |
  Select-Object -First 1
if (-not $signature) {
  $zip = Get-ChildItem -LiteralPath $bundle -Filter "*.zip" -File |
    Where-Object { $_.Name -like "*setup*" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($zip) {
    $zipSignature = Get-ChildItem -LiteralPath $bundle -Filter "$($zip.Name).sig" -File |
      Select-Object -First 1
    if ($zipSignature) {
      $updaterSource = $zip
      $signature = $zipSignature
    }
  }
}
$updaterCopy = $null
if (-not $signature) {
  if ($RequireUpdater) {
    throw "Updater signature is missing under $bundle. Build with createUpdaterArtifacts and TAURI_SIGNING_PRIVATE_KEY."
  }
  Write-Host "No updater signature found; packaging an unsigned manual build."
} else {
  $updaterExtension = [IO.Path]::GetExtension($updaterSource.Name)
  $updaterBase = if ($updaterExtension -eq ".zip") {
    "FeatherPad_${Version}_x64-setup.zip"
  } else {
    "FeatherPad_${Version}_x64-setup.exe"
  }
  $updaterCopy = Join-Path $output $updaterBase
  Copy-Item -LiteralPath $updaterSource.FullName -Destination $updaterCopy
  Copy-Item -LiteralPath $signature.FullName -Destination (Join-Path $output "$updaterBase.sig")
}

$portableDirectory = Join-Path $output ".portable-$Version"
New-Item -ItemType Directory -Path $portableDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $target "featherpad.exe") -Destination (Join-Path $portableDirectory "featherpad.exe")
Copy-Item -LiteralPath (Join-Path $repo "packaging/README-portable.txt") -Destination (Join-Path $portableDirectory "README.txt")
Set-Content -LiteralPath (Join-Path $portableDirectory "portable.flag") -Value "FeatherPad portable mode" -Encoding UTF8
foreach ($relative in @('THIRD-PARTY-NOTICES.md', 'packaging/LICENSE-TEXTS.txt', 'packaging/third-party-inventory.json',
    'docs/USER-GUIDE.md', 'docs/RECOVERY.md', 'docs/RELEASE-NOTES.md')) {
  $destination = Join-Path $portableDirectory $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination $destination
}
$portableZip = Join-Path $output "FeatherPad_${Version}_x64-portable.zip"
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $portableDirectory -Force).FullName -DestinationPath $portableZip -CompressionLevel Optimal
Remove-Item -LiteralPath $portableDirectory -Recurse -Force

$buildInfo = @(
  "version=$Version",
  "tag=$BuildTag",
  "ref=$BuildRef",
  "commit=$env:GITHUB_SHA",
  "updater_signed=$([bool]$updaterCopy)",
  "built_at=$([DateTime]::UtcNow.ToString('o'))"
)
Set-Content -LiteralPath (Join-Path $output "BUILD-INFO.txt") -Value $buildInfo -Encoding UTF8

$checksumFiles = @($installerCopy, $portableZip)
if ($updaterCopy -and $updaterCopy -ne $installerCopy) { $checksumFiles += $updaterCopy }
@($checksumFiles | ForEach-Object {
  $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
  "$hash  $([IO.Path]::GetFileName($_))"
}) | Set-Content -LiteralPath (Join-Path $output "SHA256SUMS.txt") -Encoding UTF8

Get-ChildItem -LiteralPath $output -File | Select-Object Name, Length
