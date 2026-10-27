param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$ApplicationPath,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][int]$OldProcessId,
  [Parameter(Mandatory = $true)][string]$OperationId,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [switch]$SkipElevation,
  [switch]$NoDialog
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$updateFailed = $false

function Get-FileSha256([string]$Path) {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $stream = $null
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($stream) { $stream.Dispose() }
    $sha256.Dispose()
  }
}

function Write-UpdateLog([string]$Message) {
  $line = '[' + (Get-Date -Format o) + '] ' + $Message
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value $line
}

function Show-UpdateError([string]$Message) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $newLine = [Environment]::NewLine
    $dialogMessage = "Sonic could not finish updating to version $ExpectedVersion." + $newLine + $newLine + $Message + $newLine + $newLine + "Diagnostic log: $LogPath"
    [System.Windows.Forms.MessageBox]::Show(
      $dialogMessage,
      'Sonic update failed',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch {
    # The log remains the source of truth if a desktop dialog cannot be shown.
  }
}

try {
  Write-UpdateLog "SUPERVISOR STARTED operation=$OperationId"
  Write-UpdateLog "Requested version: $ExpectedVersion"
  Write-UpdateLog "Installer: $InstallerPath"
  Write-UpdateLog "Application: $ApplicationPath"
  Write-UpdateLog "Target directory: $InstallDirectory"
  Write-UpdateLog "Waiting for Sonic process $OldProcessId to exit"

  $exitDeadline = (Get-Date).AddSeconds(45)
  while ((Get-Process -Id $OldProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $exitDeadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process -Id $OldProcessId -ErrorAction SilentlyContinue) {
    throw "Sonic process $OldProcessId did not exit within 45 seconds; installer was not launched."
  }

  if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "Verified installer is missing: $InstallerPath"
  }
  $installerHash = Get-FileSha256 -Path $InstallerPath
  if ($installerHash -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "Installer SHA-256 changed before launch. Expected $ExpectedSha256; found $installerHash."
  }

  # NSIS requires /D=... to be the final argument and the directory value to be unquoted.
  $arguments = @('/S', "/D=$InstallDirectory")
  Write-UpdateLog "Requesting elevation and launching installer with arguments: $($arguments -join ' ')"
  if ($SkipElevation) {
    Write-UpdateLog 'Elevation skipped for the isolated release smoke test'
    $installerProcess = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -Wait -PassThru -ErrorAction Stop
  } else {
    $installerProcess = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -Verb RunAs -Wait -PassThru -ErrorAction Stop
  }
  Write-UpdateLog "Installer process returned exit code $($installerProcess.ExitCode)"
  if ($installerProcess.ExitCode -ne 0) {
    throw "Sonic installer failed with exit code $($installerProcess.ExitCode)."
  }

  if (-not (Test-Path -LiteralPath $ApplicationPath -PathType Leaf)) {
    throw "Sonic.exe was not found after installation at $ApplicationPath"
  }

  $versionDeadline = (Get-Date).AddSeconds(90)
  $installedVersion = ''
  do {
    $installedVersion = (Get-Item -LiteralPath $ApplicationPath).VersionInfo.ProductVersion
    if ($installedVersion -and ($installedVersion -eq $ExpectedVersion -or $installedVersion -like ($ExpectedVersion + '.*'))) {
      break
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $versionDeadline)

  if (-not $installedVersion -or -not ($installedVersion -eq $ExpectedVersion -or $installedVersion -like ($ExpectedVersion + '.*'))) {
    throw "Installed version verification failed. Expected $ExpectedVersion; found '$installedVersion'."
  }
  Write-UpdateLog "Verified installed version: $installedVersion"

  Write-UpdateLog 'Launching updated Sonic'
  $launch = Start-Process -FilePath $ApplicationPath -WorkingDirectory $InstallDirectory -PassThru -ErrorAction Stop
  Write-UpdateLog "Started Sonic process $($launch.Id); waiting for a visible main window"
  $windowDeadline = (Get-Date).AddSeconds(30)
  $windowReady = $false
  do {
    $launch.Refresh()
    if ($launch.HasExited) {
      throw "Sonic exited during startup after the update (exit code $($launch.ExitCode))."
    }
    if ($launch.MainWindowHandle -ne 0) {
      $windowReady = $true
      break
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $windowDeadline)

  if (-not $windowReady) {
    throw 'Sonic process remained alive but did not create a visible main window within 30 seconds.'
  }
  Write-UpdateLog 'UPDATE SUCCESS: installed version verified and a visible Sonic main window is running'
} catch {
$updateFailed = $true
  $failure = $_.Exception.Message
  try { Write-UpdateLog "UPDATE FAILED: $failure" } catch {}
  if (-not $NoDialog) { Show-UpdateError $failure }

  # Restore availability with the installed executable, even if the update failed.
  if (Test-Path -LiteralPath $ApplicationPath -PathType Leaf) {
    try {
      $recovery = Start-Process -FilePath $ApplicationPath -WorkingDirectory $InstallDirectory -PassThru -ErrorAction Stop
      Write-UpdateLog "Recovery launch requested for Sonic process $($recovery.Id)"
    } catch {
      try { Write-UpdateLog "Recovery launch failed: $($_.Exception.Message)" } catch {}
    }
  }
}
if ($updateFailed) { exit 1 }
