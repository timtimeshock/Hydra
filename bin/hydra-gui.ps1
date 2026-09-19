param()
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$hydraRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:HYDRA_PROJECT = $hydraRoot
# Local GUI/daemon must start without WAN (system proxy must not capture loopback).
$env:NO_PROXY = if ($env:NO_PROXY) { "$env:NO_PROXY,127.0.0.1,localhost,::1" } else { "127.0.0.1,localhost,::1" }
$env:no_proxy = $env:NO_PROXY
Set-Location -LiteralPath $hydraRoot

$guiUrl = "http://127.0.0.1:4176/?v=11"
$alreadyUp = $false
try {
  $null = Invoke-RestMethod -Uri "$guiUrl`api/snapshot" -TimeoutSec 1
  $alreadyUp = $true
} catch {
  $alreadyUp = $false
}

if (-not $alreadyUp) {
  $env:HYDRA_GUI_NO_OPEN = "1"
  Start-Process -FilePath "node" -ArgumentList "`"$hydraRoot\lib\hydra-gui.mjs`"" -WorkingDirectory $env:HYDRA_PROJECT -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(8)
  do {
    Start-Sleep -Milliseconds 250
    try {
      $null = Invoke-RestMethod -Uri "$guiUrl`api/snapshot" -TimeoutSec 1
      $alreadyUp = $true
    } catch { $alreadyUp = $false }
  } while (-not $alreadyUp -and (Get-Date) -lt $deadline)
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
