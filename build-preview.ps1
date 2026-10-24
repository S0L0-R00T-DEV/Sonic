$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $root "src\SpeedOFreq.App\SpeedOFreq.App.csproj"
$smoke = Join-Path $root "tests\SpeedOFreq.Core.Smoke\SpeedOFreq.Core.Smoke.csproj"
$outRoot = Join-Path $root "artifacts\preview"
$appBin = Join-Path $root "src\SpeedOFreq.App\bin\Release\net10.0-windows"

dotnet build $app -c Release
if ($LASTEXITCODE -ne 0) { throw "WPF app build failed with exit code $LASTEXITCODE" }

dotnet run --project $smoke -c Release
if ($LASTEXITCODE -ne 0) { throw "Core smoke tests failed with exit code $LASTEXITCODE" }

New-Item -ItemType Directory -Force -Path $outRoot | Out-Null

foreach ($rid in @("win-x64", "win-arm64")) {
    dotnet publish $app -c Release -r $rid --self-contained false
    if ($LASTEXITCODE -ne 0) { throw "$rid publish failed with exit code $LASTEXITCODE" }

    $source = Join-Path (Join-Path $appBin $rid) "publish"
    $destination = Join-Path $outRoot $rid
    if (Test-Path $destination) { Remove-Item $destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -Path (Join-Path $source "*") -Destination $destination -Recurse -Force
}

Write-Host "Preview publish complete: $outRoot"
Write-Host "Framework-dependent builds require the .NET 10 Windows Desktop Runtime."
