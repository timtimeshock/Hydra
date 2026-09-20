param()
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$hydraRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:HYDRA_PROJECT = $hydraRoot
# Local GUI/daemon must start without WAN (system proxy must not capture loopback).
$env:NO_PROXY = if ($env:NO_PROXY) { "$env:NO_PROXY,127.0.0.1,localhost,::1" } else { "127.0.0.1,localhost,::1" }
$env:no_proxy = $env:NO_PROXY
Set-Location -LiteralPath $hydraRoot

$guiBase = "http://127.0.0.1:4176"
$daemonHealth = "http://127.0.0.1:4173/health"
$guiUrl = "$guiBase/?v=12"
$snapshotUrl = "$guiBase/api/snapshot"

function Test-HydraGui {
  try {
    $null = Invoke-RestMethod -Uri $snapshotUrl -TimeoutSec 2
    return $true
  } catch {
    return $false
  }
}

function Test-HydraDaemon {
  try {
    $h = Invoke-RestMethod -Uri $daemonHealth -TimeoutSec 2
    return ($h.ok -eq $true -and $h.running -eq $true)
  } catch {
    return $false
  }
}

$guiUp = Test-HydraGui
$daemonUp = Test-HydraDaemon

if (-not $guiUp) {
  $env:HYDRA_GUI_NO_OPEN = "1"
  Start-Process -FilePath "node" -ArgumentList "`"$hydraRoot\lib\hydra-gui.mjs`"" -WorkingDirectory $env:HYDRA_PROJECT -WindowStyle Hidden
}

# Wait for GUI + daemon (cold boot after reboot can take >8s)
$deadline = (Get-Date).AddSeconds(25)
do {
  if (-not $guiUp) { $guiUp = Test-HydraGui }
  if (-not $daemonUp) { $daemonUp = Test-HydraDaemon }
  if ($guiUp -and $daemonUp) { break }
  Start-Sleep -Milliseconds 300
} while ((Get-Date) -lt $deadline)

if (-not $daemonUp) {
  Write-Warning "Hydra daemon is not healthy at $daemonHealth — opening GUI anyway (it will retry)."
}

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edge) {
  Start-Process -FilePath $edge -ArgumentList @(
    "--app=$guiUrl",
    "--new-window",
    "--window-size=1180,820",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-features=TranslateUI"
  )
} else {
  Start-Process $guiUrl
}
