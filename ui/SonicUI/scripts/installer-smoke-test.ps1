param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$PreviousInstallerPath
)
$ErrorActionPreference = 'Stop'
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content (Join-Path $root 'electron-builder.yml') -Raw
$nsis = Get-Content (Join-Path $root 'build\installer.nsh') -Raw
$supervisorSource = Join-Path $root 'build\update-supervisor.ps1'
$supervisor = Get-Content -LiteralPath $supervisorSource -Raw
$updaterSource = Get-Content -LiteralPath (Join-Path $root 'src\main\updater.ts') -Raw
$supervisorTokens = $null
$supervisorErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($supervisorSource, [ref]$supervisorTokens, [ref]$supervisorErrors) | Out-Null
if ($supervisorErrors.Count -gt 0) { throw ('Update supervisor PowerShell syntax error: ' + ($supervisorErrors.Message -join '; ')) }
foreach ($contract in @(
  @{ Name = 'machine-wide installer permits elevation'; Pattern = '(?m)^\s*perMachine:\s*true\s*$' },
  @{ Name = 'installer finish page launches the app'; Pattern = '(?m)^\s*runAfterFinish:\s*true\s*$' },
  @{ Name = 'desktop shortcut creation is configured'; Pattern = '(?m)^\s*createDesktopShortcut:\s*always\s*$' },
  @{ Name = 'update supervisor is bundled as a resource'; Pattern = '(?s)extraResources:\s+- from: build/update-supervisor\.ps1\s+to: update-supervisor\.ps1' }
)) {
  if ($config -notmatch $contract.Pattern) { throw "Installer contract failed: $($contract.Name)" }
}
foreach ($contract in @(
  @{ Name = 'updater launches the packaged script using -File'; Pattern = "'-File',\s*supervisorPath" },
  @{ Name = 'updater waits for its unique startup marker'; Pattern = 'log\.includes\(startupMarker\)' },
  @{ Name = 'updater quits only after startup acknowledgement'; Pattern = '(?s)log\.includes\(startupMarker\)[\s\S]*?setTimeout\(\(\) => app\.quit\(\), 700\)' },
  @{ Name = 'missing supervisor is reported before launch'; Pattern = 'await access\(supervisorPath\)' }
)) {
  if ($updaterSource -notmatch $contract.Pattern) { throw "Updater contract failed: $($contract.Name)" }
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
  $packagedSupervisor = Join-Path $installDir 'resources\update-supervisor.ps1'
  if (-not (Test-Path -LiteralPath $packagedSupervisor -PathType Leaf)) { throw 'Installer did not package resources\update-supervisor.ps1.' }
  $packedTokens = $null
  $packedErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($packagedSupervisor, [ref]$packedTokens, [ref]$packedErrors) | Out-Null
  if ($packedErrors.Count -gt 0) { throw ('Packaged update supervisor has PowerShell syntax errors: ' + ($packedErrors.Message -join '; ')) }
  if ($supervisor -notmatch 'SUPERVISOR STARTED operation=') { throw 'Update supervisor startup handshake marker is missing.' }
  if ($supervisor -notmatch 'UPDATE SUCCESS: installed version verified and a visible Sonic main window is running') { throw 'Update supervisor startup verification is missing.' }
  if ($supervisor -notmatch 'ExpectedSha256|Get-FileHash') { throw 'Update supervisor does not re-check the downloaded installer hash.' }
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
  Write-Host "PASS: clean installer installed Sonic $actualVersion, created a valid desktop shortcut, and launched a visible main window (PID $($mainProcess.Id))." -ForegroundColor Green

  if (-not $PreviousInstallerPath) {
    throw 'The previous release installer is required to test the real upgrade path.'
  }
  $previousInstaller = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
  $upgradeDir = Join-Path $env:TEMP 'SonicInstallerUpgradeSmoke'
  $upgradeProfileDir = Join-Path $env:TEMP 'SonicInstallerUpgradeProfile'
  if (Test-Path $upgradeDir) { Remove-Item -LiteralPath $upgradeDir -Recurse -Force }
  if (Test-Path $upgradeProfileDir) { Remove-Item -LiteralPath $upgradeProfileDir -Recurse -Force }

  # First prove the clean-install copy includes the exact supervisor script
  # that will be used to upgrade a separately installed older release.
  $sourceSupervisorHash = (Get-FileHash -LiteralPath $supervisorSource -Algorithm SHA256).Hash
  $packagedSupervisorHash = (Get-FileHash -LiteralPath $packagedSupervisor -Algorithm SHA256).Hash
  if ($sourceSupervisorHash -ne $packagedSupervisorHash) {
    throw 'The packaged updater supervisor differs from the source script.'
  }

  & taskkill.exe /PID $mainProcess.Id /T /F *> $null
  try { $mainProcess.WaitForExit(10000) } catch {}
  $mainProcess = $null
  Start-Sleep -Seconds 1

  Write-Host "Installing previous Sonic release for an actual upgrade test: $previousInstaller"
  $previousInstall = Start-Process -FilePath $previousInstaller -ArgumentList @('/S', "/D=$upgradeDir") -Wait -PassThru
  if ($previousInstall.ExitCode -ne 0) { throw "Previous-version installation failed with exit code $($previousInstall.ExitCode)." }
  $upgradeExe = Join-Path $upgradeDir 'Sonic.exe'
  if (-not (Test-Path -LiteralPath $upgradeExe -PathType Leaf)) { throw 'Previous release installer did not create Sonic.exe.' }
  $previousVersion = (Get-Item -LiteralPath $upgradeExe).VersionInfo.ProductVersion
  if ($previousVersion -notmatch '^1\.1\.1(\.|$)') {
    throw "Upgrade test did not start from an older version: $previousVersion"
  }

  $env:SONIC_ISOLATED_USER_DATA_DIR = $upgradeProfileDir
  $mainProcess = Start-Process -FilePath $upgradeExe -WorkingDirectory $upgradeDir -PassThru
  $deadline = (Get-Date).AddSeconds(30)
  $windowFound = $false
  do {
    Start-Sleep -Milliseconds 500
    $mainProcess.Refresh()
    if ($mainProcess.HasExited) { throw "Previous Sonic exited during startup (exit code $($mainProcess.ExitCode))." }
    if ($mainProcess.MainWindowHandle -ne 0) { $windowFound = $true; break }
  } while ((Get-Date) -lt $deadline)
  if (-not $windowFound) { throw 'Previous Sonic did not show a main window before the update test.' }
  Write-Host "PASS: previous Sonic $previousVersion launches in the isolated upgrade profile."

  & taskkill.exe /PID $mainProcess.Id /T /F *> $null
  try { $mainProcess.WaitForExit(10000) } catch {}
  $mainProcess = $null
  Start-Sleep -Seconds 1

  $supervisorOperationId = [guid]::NewGuid().ToString()
  $supervisorLog = Join-Path $env:TEMP ("SonicInstallerSmoke-update-" + $supervisorOperationId + '.log')
  $installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  $supervisorArguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', $packagedSupervisor,
    '-InstallerPath', $installer,
    '-ApplicationPath', $upgradeExe,
    '-InstallDirectory', $upgradeDir,
    '-ExpectedVersion', $ExpectedVersion,
    '-ExpectedSha256', $installerHash,
    '-OldProcessId', '2147483647',
    '-OperationId', $supervisorOperationId,
    '-LogPath', $supervisorLog,
    '-SkipElevation', '-NoDialog'
  )
  Write-Host "Testing in-app update handoff from $previousVersion to $ExpectedVersion..."
  # Use ProcessStartInfo.ArgumentList so Windows receives each argument exactly;
  # Start-Process -ArgumentList string-joining/quoting caused powershell.exe -File
  # to receive an invalid script path (exit code -196608) and never run the supervisor.
  $supervisorStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $supervisorStartInfo.FileName = (Get-Command 'powershell.exe').Source
  $supervisorStartInfo.UseShellExecute = $false
  $supervisorStartInfo.CreateNoWindow = $true
  $supervisorStartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $supervisorStartInfo.RedirectStandardOutput = $true
  $supervisorStartInfo.RedirectStandardError = $true
  foreach ($argument in $supervisorArguments) {
    [void]$supervisorStartInfo.ArgumentList.Add($argument)
  }
  $supervisorProcess = [System.Diagnostics.Process]::Start($supervisorStartInfo)
  $stdoutTask = $supervisorProcess.StandardOutput.ReadToEndAsync()
  $stderrTask = $supervisorProcess.StandardError.ReadToEndAsync()
  $supervisorProcess.WaitForExit()
  $supervisorStdout = $stdoutTask.GetAwaiter().GetResult()
  $supervisorStderr = $stderrTask.GetAwaiter().GetResult()
  $supervisorExitCode = $supervisorProcess.ExitCode
  $supervisorOutput = if (Test-Path -LiteralPath $supervisorLog) { Get-Content -LiteralPath $supervisorLog -Raw } else { '' }
  if ($supervisorExitCode -ne 0 -or $supervisorOutput -notmatch 'UPDATE SUCCESS: installed version verified and a visible Sonic main window is running') {
    throw ("In-app upgrade supervisor smoke test failed (exit code $supervisorExitCode)." + [Environment]::NewLine + "Script stdout: $supervisorStdout" + [Environment]::NewLine + "Script stderr: $supervisorStderr" + [Environment]::NewLine + "Log: $supervisorLog" + [Environment]::NewLine + $supervisorOutput)
  }
  $upgradedVersion = (Get-Item -LiteralPath $upgradeExe).VersionInfo.ProductVersion
  if ($upgradedVersion -ne $ExpectedVersion -and $upgradedVersion -notlike "$ExpectedVersion.*") {
    throw "Upgrade ended with the wrong executable version: expected $ExpectedVersion; found $upgradedVersion."
  }

  $deadline = (Get-Date).AddSeconds(30)
  $windowFound = $false
  do {
    $runningInfo = Get-CimInstance Win32_Process -Filter "Name = 'Sonic.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $upgradeExe } |
      Select-Object -First 1
    if ($runningInfo) {
      $candidate = Get-Process -Id $runningInfo.ProcessId -ErrorAction SilentlyContinue
      if ($candidate) {
        $candidate.Refresh()
        if ($candidate.MainWindowHandle -ne 0) {
          $mainProcess = $candidate
          $windowFound = $true
          break
        }
      }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  if (-not $windowFound) { throw 'Updater supervisor reported success, but the upgraded Sonic window was not visible.' }
  Write-Host "PASS: in-app update upgraded Sonic $previousVersion to $upgradedVersion, verified the installer hash, and relaunched a visible window (PID $($mainProcess.Id)). Log: $supervisorLog" -ForegroundColor Green
} finally {
  Remove-Item Env:SONIC_ISOLATED_USER_DATA_DIR -ErrorAction SilentlyContinue
  if ($mainProcess) {
    & taskkill.exe /PID $mainProcess.Id /T /F *> $null
  }
  $upgradeUninstaller = Join-Path (Join-Path $env:TEMP 'SonicInstallerUpgradeSmoke') 'Uninstall Sonic.exe'
  if (Test-Path -LiteralPath $upgradeUninstaller) {
    try { Start-Process -FilePath $upgradeUninstaller -ArgumentList '/S' -Wait -PassThru | Out-Null } catch { Write-Warning "Upgrade smoke-test uninstall cleanup failed: $($_.Exception.Message)" }
  }
  $uninstaller = Join-Path $installDir 'Uninstall Sonic.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    try { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru | Out-Null } catch { Write-Warning "Smoke-test uninstall cleanup failed: $($_.Exception.Message)" }
  }
  if (Test-Path $profileDir) { Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path (Join-Path $env:TEMP 'SonicInstallerUpgradeProfile')) { Remove-Item -LiteralPath (Join-Path $env:TEMP 'SonicInstallerUpgradeProfile') -Recurse -Force -ErrorAction SilentlyContinue }
  Get-ChildItem $env:TEMP -Filter 'SonicInstallerSmoke-update-*.log' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  if (Test-Path $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path (Join-Path $env:TEMP 'SonicInstallerUpgradeSmoke')) { Remove-Item -LiteralPath (Join-Path $env:TEMP 'SonicInstallerUpgradeSmoke') -Recurse -Force -ErrorAction SilentlyContinue }
}

