# Generates the NSIS wizard artwork from the existing Sonic brand assets.
# Run from the SonicUI project root with Windows PowerShell.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$resources = Join-Path $root 'resources'
$build = Join-Path $root 'build'
$blueIcon = [System.Drawing.Image]::FromFile((Join-Path $resources 'sonic-icon-blue.png'))
$redIcon = [System.Drawing.Image]::FromFile((Join-Path $resources 'sonic-icon-red.png'))

function New-SonicArtwork([int]$Width, [int]$Height, [string]$Path, [bool]$Sidebar) {
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $bounds = [System.Drawing.Rectangle]::new(0, 0, $Width, $Height)
  $gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $bounds,
    [System.Drawing.Color]::FromArgb(7, 19, 43),
    [System.Drawing.Color]::FromArgb(13, 47, 82),
    35
  )
  $graphics.FillRectangle($gradient, $bounds)
  $blueBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(210, 0, 115, 230))
  $redBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(210, 235, 48, 65))
  $graphics.FillPolygon($blueBrush, @(
    [System.Drawing.Point]::new(0, [int]($Height * 0.70)),
    [System.Drawing.Point]::new($Width, [int]($Height * 0.48)),
    [System.Drawing.Point]::new($Width, [int]($Height * 0.57)),
    [System.Drawing.Point]::new(0, [int]($Height * 0.79))
  ))
  $graphics.FillPolygon($redBrush, @(
    [System.Drawing.Point]::new(0, [int]($Height * 0.80)),
    [System.Drawing.Point]::new($Width, [int]($Height * 0.58)),
    [System.Drawing.Point]::new($Width, [int]($Height * 0.63)),
    [System.Drawing.Point]::new(0, [int]($Height * 0.85))
  ))
  $whiteBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  if ($Sidebar) {
    $graphics.DrawImage($blueIcon, [System.Drawing.Rectangle]::new(28, 42, 108, 108))
    $fontTitle = [System.Drawing.Font]::new('Segoe UI', 24, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fontSub = [System.Drawing.Font]::new('Segoe UI', 8, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $graphics.DrawString('SONIC', $fontTitle, $whiteBrush, [single]18, [single]166)
    $graphics.DrawString('DOWNLOAD MANAGER', $fontSub, $whiteBrush, [single]19, [single]199)
    $fontTag = [System.Drawing.Font]::new('Segoe UI', 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $graphics.DrawString('Fast. Focused. In control.', $fontTag, $whiteBrush, [single]18, [single]226)
    $fontTitle.Dispose(); $fontSub.Dispose(); $fontTag.Dispose()
  } else {
    $graphics.DrawImage($blueIcon, [System.Drawing.Rectangle]::new(8, 8, 40, 40))
    $fontTitle = [System.Drawing.Font]::new('Segoe UI', 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fontSub = [System.Drawing.Font]::new('Segoe UI', 7, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $graphics.DrawString('Sonic Setup', $fontTitle, $whiteBrush, [single]54, [single]10)
    $graphics.DrawString('Secure installation and updates', $fontSub, $whiteBrush, [single]55, [single]32)
    $fontTitle.Dispose(); $fontSub.Dispose()
  }
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $whiteBrush.Dispose(); $blueBrush.Dispose(); $redBrush.Dispose()
  $gradient.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}

try {
  New-SonicArtwork 164 314 (Join-Path $build 'installerSidebar.bmp') $true
  New-SonicArtwork 150 57 (Join-Path $build 'installerHeader.bmp') $false
  Write-Host 'Created Sonic blue/red NSIS installer artwork.'
} finally {
  $blueIcon.Dispose()
  $redIcon.Dispose()
}
