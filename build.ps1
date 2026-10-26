param(
  [switch]$Release,
  [switch]$SkipDependencyInstall,
  [string]$OutputDirectory = 'dist-sonic-release'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ui = Join-Path $root 'ui\SonicUI'
$backend = Join-Path $root 'artifacts\sonic-backend-current\win-x64'
$cliOutput = Join-Path $root 'artifacts\sonic-cli-win-x64'
$releaseOutput = Join-Path $ui $OutputDirectory

# npm/npx PowerShell shims can emit routine "npm notice" lines on stderr. With
# ErrorActionPreference=Stop those become terminating PowerShell errors even when npm succeeds.
function Invoke-Npm {
  param([string[]]$NpmArguments)
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & npm.cmd @NpmArguments
    $commandExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($commandExitCode -ne 0) {
    throw "npm $($NpmArguments -join ' ') failed with exit code $commandExitCode."
  }
}

function Invoke-Npx {
  param([string[]]$NpxArguments)
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & npx.cmd @NpxArguments
    $commandExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($commandExitCode -ne 0) {
    throw "npx $($NpxArguments -join ' ') failed with exit code $commandExitCode."
  }
}

foreach ($tool in @('dotnet', 'node', 'npm')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required build tool is missing from PATH: $tool" }
}
foreach ($required in @(
  'src\SpeedOFreq.App\SpeedOFreq.App.csproj',
  'src\SpeedOFreq.Cli\SpeedOFreq.Cli.csproj',
  'ui\SonicUI\package.json',
  'ui\SonicUI\package-lock.json'
)) {
  if (-not (Test-Path (Join-Path $root $required))) { throw "Required project input is missing: $required" }
}

if (-not $SkipDependencyInstall) {
  Push-Location $ui
  try {
    Invoke-Npm -NpmArguments @('ci')
  } finally { Pop-Location }
}

Push-Location $ui
try {
  Invoke-Npm -NpmArguments @('run', 'generate:notices')
} finally { Pop-Location }

if ($Release) {
  $noticeFile = Join-Path $ui 'THIRD_PARTY_NOTICES.md'
  if (-not (Test-Path $noticeFile)) { throw 'Release blocked: third-party notices are missing.' }
  if (Select-String -Path $noticeFile -Pattern 'OWNER REVIEW REQUIRED|UPSTREAM BRANCH FILE; exact release correspondence requires owner verification|CONFLICTING LICENSE METADATA|Local license/notice file: not found' -Quiet) {
    throw 'Release blocked: third-party license/notice provenance is unresolved. Review THIRD_PARTY_NOTICES.md before release.'
  }
  if (-not (@('CSC_LINK','WIN_CSC_LINK','CSC_NAME','WIN_CSC_NAME') | Where-Object { [Environment]::GetEnvironmentVariable($_) })) {
    throw 'Release blocked: configure a trusted Windows Authenticode signing certificate. Run without -Release for a local unsigned build.'
  }
  $previousRequireCodeSigning = $env:SONIC_REQUIRE_CODE_SIGNING
  $env:SONIC_REQUIRE_CODE_SIGNING = '1'
  Push-Location $ui
  try {
    & node scripts/security-audit-gate.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Release blocked: the security audit gate failed.' }
  } finally {
    Pop-Location
    if ($null -eq $previousRequireCodeSigning) {
      Remove-Item Env:SONIC_REQUIRE_CODE_SIGNING -ErrorAction SilentlyContinue
    } else {
      $env:SONIC_REQUIRE_CODE_SIGNING = $previousRequireCodeSigning
    }
  }
  Invoke-Npm -NpmArguments @('audit', '--omit=dev', '--audit-level=high', '--prefix', $ui)
}

Write-Host 'Publishing the self-contained Windows x64 backend...' -ForegroundColor Cyan
& dotnet publish (Join-Path $root 'src\SpeedOFreq.App\SpeedOFreq.App.csproj') -c Release -r win-x64 --self-contained true -o $backend
if ($LASTEXITCODE -ne 0) { throw 'The .NET backend publish failed.' }
foreach ($name in @('SpeedOFreq.exe','SpeedOFreq.dll','SpeedOFreq.Core.dll')) {
  if (-not (Test-Path (Join-Path $backend $name))) { throw "Backend output is missing $name." }
}

Write-Host 'Publishing the self-contained Windows x64 CLI...' -ForegroundColor Cyan
& dotnet publish (Join-Path $root 'src\SpeedOFreq.Cli\SpeedOFreq.Cli.csproj') -c Release -r win-x64 --self-contained true -o $cliOutput
if ($LASTEXITCODE -ne 0) { throw 'The CLI publish failed.' }
if (-not (Test-Path (Join-Path $cliOutput 'SpeedOFreq.Cli.exe'))) { throw 'CLI output is missing SpeedOFreq.Cli.exe.' }

Push-Location $ui
try {
  Write-Host 'Building and type-checking Sonic...' -ForegroundColor Cyan
  Invoke-Npm -NpmArguments @('run', 'build')
  $builderArgs = @('--win', 'nsis', "--config.directories.output=$OutputDirectory")
  if (-not $Release) { $builderArgs += '--config.win.forceCodeSigning=false' }
  Invoke-Npx -NpxArguments (@('electron-builder') + $builderArgs)
} finally { Pop-Location }

$installer = Join-Path $releaseOutput 'Sonic-Setup-x64.exe'
$exe = Join-Path $releaseOutput 'win-unpacked\Sonic.exe'
$packagedBackend = Join-Path $releaseOutput 'win-unpacked\resources\sonic-backend\SpeedOFreq.exe'
if (-not (Test-Path $installer)) { throw "Expected installer was not created: $installer" }
if (-not (Test-Path $exe)) { throw "Packaged application executable is missing: $exe" }
if (-not (Test-Path $packagedBackend)) { throw "Packaged backend is missing: $packagedBackend" }
$legalDirectory = Join-Path $releaseOutput 'win-unpacked\resources\legal'
foreach ($legalFile in @('LICENSE','THIRD_PARTY_NOTICES.md')) {
  if (-not (Test-Path (Join-Path $legalDirectory $legalFile))) {
    throw "Packaged legal resources are missing $legalFile."
  }
}
foreach ($browser in @('chromium','firefox')) {
  $manifest = Join-Path $releaseOutput "win-unpacked\resources\browser-extensions\$browser\manifest.json"
  if (-not (Test-Path $manifest)) { throw "Packaged $browser extension manifest is missing: $manifest" }
}
$xpiPackage = Join-Path $releaseOutput 'win-unpacked\resources\browser-extensions\SDMFFE.xpi'
if (-not (Test-Path $xpiPackage)) { throw "Packaged Firefox XPI is missing: $xpiPackage" }
if ($Release) {
  $signature = Get-AuthenticodeSignature -LiteralPath $installer
  if ($signature.Status -ne 'Valid') { throw "Release installer signature is not valid: $($signature.Status)" }
}

$cliZip = Join-Path $releaseOutput 'Sonic-CLI-win-x64.zip'
if (Test-Path $cliZip) { Remove-Item -LiteralPath $cliZip -Force }
Compress-Archive -Path (Join-Path $cliOutput '*') -DestinationPath $cliZip -CompressionLevel Optimal
foreach ($browser in @('chromium','firefox')) {
  $extensionSource = Join-Path $ui "extension\dist\$browser"
  $extensionLabel = if ($browser -eq 'chromium') { 'Chrome' } else { 'Firefox' }
  $extensionZip = Join-Path $releaseOutput "Sonic-Extension-$extensionLabel.zip"
  if (-not (Test-Path $extensionSource)) { throw "Browser extension build output is missing: $extensionSource" }
  if (Test-Path $extensionZip) { Remove-Item -LiteralPath $extensionZip -Force }
  Compress-Archive -Path (Join-Path $extensionSource '*') -DestinationPath $extensionZip -CompressionLevel Optimal
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($browser in @('chromium','firefox')) {
  $extensionLabel = if ($browser -eq 'chromium') { 'Chrome' } else { 'Firefox' }
  $extensionZip = Join-Path $releaseOutput "Sonic-Extension-$extensionLabel.zip"
  $archive = [IO.Compression.ZipFile]::OpenRead($extensionZip)
  try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace([char]92, [char]47) })
    foreach ($requiredEntry in @('manifest.json','icons/icon-16.png','icons/icon-32.png','icons/icon-48.png','icons/icon-128.png')) {
      if ($entries -notcontains $requiredEntry) { throw "$browser extension ZIP is missing $requiredEntry." }
    }
    $manifestEntry = $archive.GetEntry('manifest.json')
    $reader = [IO.StreamReader]::new($manifestEntry.Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if (-not $manifest.name -or -not $manifest.version) { throw "$browser extension ZIP has an invalid manifest." }
    Write-Host "Verified $browser extension ZIP manifest v$($manifest.version) and icon assets." -ForegroundColor Green
  } finally { $archive.Dispose() }
}

# Keep the hand-off folder limited to user-facing artifacts; unpacked files and the
# intermediate NSIS archive are only needed while packaging is in progress.
$unpackedOutput = Join-Path $releaseOutput 'win-unpacked'
if (Test-Path $unpackedOutput) { Remove-Item -LiteralPath $unpackedOutput -Recurse -Force }
Remove-Item -LiteralPath (Join-Path $releaseOutput 'builder-debug.yml') -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $releaseOutput -File -Filter '*.nsis.7z' -ErrorAction SilentlyContinue |
  Remove-Item -Force

Write-Host ''
Write-Host 'Sonic build completed.' -ForegroundColor Green
Write-Host "Installer: $installer"
Write-Host "CLI archive: $cliZip"
Write-Host "Chrome extension: $(Join-Path $releaseOutput 'Sonic-Extension-Chrome.zip')"
Write-Host "Firefox extension: $(Join-Path $releaseOutput 'Sonic-Extension-Firefox.zip')"
if (-not $Release) { Write-Warning 'This is a local build. It is not a release certification and may be unsigned.' }
