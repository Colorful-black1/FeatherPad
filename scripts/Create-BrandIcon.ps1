#requires -Version 5.1
# Repo-native vector drawing; no network resources.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconRoot = Join-Path $PSScriptRoot '..\src-tauri\icons'
New-Item -ItemType Directory -Path $iconRoot -Force | Out-Null
$bitmap = [Drawing.Bitmap]::new(256, 256)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([Drawing.Color]::FromArgb(255, 245, 244, 240))
$pen = [Drawing.Pen]::new([Drawing.Color]::FromArgb(255, 69, 100, 59), 10)
$pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
$graphics.DrawBezier($pen, 58, 204, 74, 151, 127, 81, 204, 43)
$graphics.DrawBezier($pen, 78, 160, 50, 74, 124, 43, 204, 43)
$graphics.DrawBezier($pen, 78, 160, 161, 174, 202, 119, 204, 43)
$graphics.DrawLine($pen, 104, 124, 104, 77)
$graphics.DrawLine($pen, 128, 99, 174, 99)
$bitmap.Save((Join-Path $iconRoot 'icon.png'), [Drawing.Imaging.ImageFormat]::Png)
$pngBytes = [IO.File]::ReadAllBytes((Join-Path $iconRoot 'icon.png'))
$stream = [IO.File]::Create((Join-Path $iconRoot 'icon.ico'))
$writer = [IO.BinaryWriter]::new($stream)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
    $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$pngBytes.Length); $writer.Write([uint32]22)
    $writer.Write($pngBytes)
} finally {
    $writer.Dispose(); $graphics.Dispose(); $pen.Dispose(); $bitmap.Dispose()
}
Write-Host 'Created FeatherPad PNG and ICO from local drawing.'
