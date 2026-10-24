$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $root "src\SpeedOFreq.App\SpeedOFreq.App.csproj"
$cli = Join-Path $root "src\SpeedOFreq.Cli\SpeedOFreq.Cli.csproj"
$smoke = Join-Path $root "tests\SpeedOFreq.Core.Smoke\SpeedOFreq.Core.Smoke.csproj"
$outRoot = Join-Path $root "artifacts\cli-queue-20261018"

dotnet build $app -c Release
if ($LASTEXITCODE -ne 0) { throw "GUI build failed with exit code $LASTEXITCODE" }
dotnet build $cli -c Release
if ($LASTEXITCODE -ne 0) { throw "CLI build failed with exit code $LASTEXITCODE" }
dotnet run --project $smoke -c Release
if ($LASTEXITCODE -ne 0) { throw "Core smoke tests failed with exit code $LASTEXITCODE" }

New-Item -ItemType Directory -Force -Path $outRoot | Out-Null
foreach ($rid in @("win-x64", "win-arm64")) {
    $package = Join-Path $outRoot $rid
    $appPublish = Join-Path $root "src\SpeedOFreq.App\bin\Release\net10.0-windows\$rid\publish"
    $cliPublish = Join-Path $root "src\SpeedOFreq.Cli\bin\Release\net10.0-windows\$rid\publish"
    if (Test-Path $package) { Remove-Item $package -Recurse -Force }
    if (Test-Path $appPublish) { Remove-Item $appPublish -Recurse -Force }
    if (Test-Path $cliPublish) { Remove-Item $cliPublish -Recurse -Force }

    dotnet publish $app -c Release -r $rid --self-contained true
    if ($LASTEXITCODE -ne 0) { throw "$rid GUI publish failed with exit code $LASTEXITCODE" }
    dotnet publish $cli -c Release -r $rid --self-contained true
    if ($LASTEXITCODE -ne 0) { throw "$rid CLI publish failed with exit code $LASTEXITCODE" }

    New-Item -ItemType Directory -Force -Path $package | Out-Null
    Copy-Item -Path (Join-Path $appPublish "*") -Destination $package -Recurse -Force
    $cliFolder = Join-Path $package "cli"
    New-Item -ItemType Directory -Force -Path $cliFolder | Out-Null
    Copy-Item -Path (Join-Path $cliPublish "*") -Destination $cliFolder -Recurse -Force
    Copy-Item (Join-Path $root "CLI_USAGE.md") (Join-Path $package "CLI_USAGE.md") -Force
    Write-Host "$rid package ready: $package"
}
Write-Host "Build complete. Run cli\SpeedOFreq.Cli.exe --help from either package folder."
