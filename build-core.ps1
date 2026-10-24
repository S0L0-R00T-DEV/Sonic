$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$core = Join-Path $root "src\SpeedOFreq.Core\SpeedOFreq.Core.csproj"
$smoke = Join-Path $root "tests\SpeedOFreq.Core.Smoke\SpeedOFreq.Core.Smoke.csproj"

dotnet build $core -c Release
if ($LASTEXITCODE -ne 0) { throw "Core build failed with exit code $LASTEXITCODE" }
dotnet run --project $smoke -c Release
if ($LASTEXITCODE -ne 0) { throw "Core smoke tests failed with exit code $LASTEXITCODE" }
