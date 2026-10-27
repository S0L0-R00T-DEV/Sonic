param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content (Join-Path $root 'electron-builder.yml') -Raw
$nsis = Get-Content (Join-Path $root 'build\installer.nsh') -Raw
foreach ($contract in @(
  @{ Name = 'machine-wide installer permits elevation'; Pattern = '(?m)^\s*perMachine:\s*true\s*$' },
  @{ Name = 'installer finish page launches the app'; Pattern = '(?m)^\s*runAfterFinish:\s*true\s*$' },
  @{ Name = 'desktop shortcut creation is configured'; Pattern = '(?m)^\s*createDesktopShortcut:\s*always\s*$' }
)) {
  if ($config -notmatch $contract.Pattern) { throw "Installer contract failed: $($contract.Name)" }
}
foreach ($contract in @(
  @{ Name = 'Run Sonic targets the executable directly'; Pattern = '\$appExe" "open"' },
  @{ Name = 'selected desktop shortcut is recreated'; Pattern = 'Delete "\$newDesktopLink"\s+CreateShortCut "\$newDesktopLink" "\$appExe"' },
  @{ Name = 'unchecked desktop shortcut is removed'; Pattern = 'RemoveDesktopShortcutIfUnchecked[\s\S]*?Delete "\$newDesktopLink"' }
)) {
  if ($nsis -notmatch $contract.Pattern) { throw "Installer contract failed: $($contract.Name)" }
}
if ($env:RUNNER_TEMP) {
  $installDir = Join-Path $env:RUNNER_TEMP 'SonicInstallerSmoke'
  $profileDir = Join-Path $env:RUNNER_TEMP 'SonicInstallerSmokeProfile'
} else {
  $installDir = Join-Path $env:TEMP 'SonicInstallerSmoke'
  $profileDir = Join-Path $env:TEMP 'SonicInstallerSmokeProfile'
}
if (Test-Path $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
if (Test-Path $profileDir) { Remove-Item -LiteralPath $profileDir -Recurse -Force }
$mainProcess = $null
try {
  Write-Host "Installing release to isolated smoke-test directory: $installDir"
  $install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "NSIS silent installation failed with exit code $($install.ExitCode)." }
  $exe = Join-Path $installDir 'Sonic.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Installer completed but Sonic.exe was not created.' }
  $actualVersion = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  if ($actualVersion -ne $ExpectedVersion -and $actualVersion -notlike "$ExpectedVersion.*") {
    throw "Installed version mismatch: expected $ExpectedVersion; found $actualVersion."
  }
  $shortcutPath = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Sonic.lnk'
  if (Test-Path $shortcutPath) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if ($shortcut.TargetPath -ne $exe) { throw "Desktop shortcut target mismatch: $($shortcut.TargetPath)" }
  } else { throw 'Silent installer did not create the configured desktop shortcut.' }
  $env:SONIC_ISOLATED_USER_DATA_DIR = $profileDir
  $mainProcess = Start-Process -FilePath $exe -WorkingDirectory $installDir -PassThru
  $deadline = (Get-Date).AddSeconds(30)
  $windowFound = $false
  do {
    Start-Sleep -Milliseconds 500
    $mainProcess.Refresh()
    if ($mainProcess.HasExited) { throw "Installed Sonic exited during startup (exit code $($mainProcess.ExitCode))." }
    if ($mainProcess.MainWindowHandle -ne 0) { $windowFound = $true; break }
  } while ((Get-Date) -lt $deadline)
  if (-not $windowFound) { throw 'Installed Sonic process stayed alive but did not show a main window within 30 seconds.' }
  Write-Host "PASS: installer installed Sonic $actualVersion, created a valid desktop shortcut, and launched a visible main window (PID $($mainProcess.Id))." -ForegroundColor Green
} finally {
  Remove-Item Env:SONIC_ISOLATED_USER_DATA_DIR -ErrorAction SilentlyContinue
  if ($mainProcess) {
    & taskkill.exe /PID $mainProcess.Id /T /F *> $null
  }
  $uninstaller = Join-Path $installDir 'Uninstall Sonic.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    try { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru | Out-Null } catch { Write-Warning "Smoke-test uninstall cleanup failed: $($_.Exception.Message)" }
  }
  if (Test-Path $profileDir) { Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue }
}

