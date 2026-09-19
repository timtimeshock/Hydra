param(
  [switch]$SkipDaemon,
  [switch]$DryRun,
  [int]$WaitTimeoutSec = 30,
  [int]$PollIntervalMs = 500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Escape-SingleQuote {
  param([string]$Value)
  return $Value -replace "'", "''"
}

$hydraRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoPath = (Get-Location).Path
$repoPathEscaped = Escape-SingleQuote -Value $repoPath
$hydraHost = if ($env:AI_ORCH_HOST) { $env:AI_ORCH_HOST } else { "127.0.0.1" }
$hydraPort = if ($env:AI_ORCH_PORT) { $env:AI_ORCH_PORT } else { "4173" }
$healthUrl = "http://$hydraHost`:$hydraPort/health"

$pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
if ($pwshCommand) {
  $shellExe = $pwshCommand.Source
} else {
  $powershellCommand = Get-Command powershell -ErrorAction SilentlyContinue
  if (-not $powershellCommand) {
    throw "Could not find pwsh or powershell in PATH."
  }
  $shellExe = $powershellCommand.Source
}

function Start-HydraTerminal {
  param(
    [string]$Title,
    [string]$Command
  )

  $titleEscaped = Escape-SingleQuote -Value $Title
  $bootstrap = "Set-Location -LiteralPath '$repoPathEscaped'; try { `$Host.UI.RawUI.WindowTitle = '$titleEscaped' } catch {}; $Command"

  if ($DryRun) {
    Write-Output "[DryRun] $Title :: $Command"
    return
  }

  Start-Process -FilePath $shellExe -WorkingDirectory $repoPath -ArgumentList @(
    "-NoExit",
    "-Command",
    $bootstrap
  ) | Out-Null
}

function Test-HydraHealth {
  param(
    [string]$Url
  )

  try {
    $response = Invoke-RestMethod -Method Get -Uri $Url -TimeoutSec 2
    return ($response.ok -eq $true -and $response.running -eq $true)
  } catch {
    return $false
  }
}

function Wait-HydraHealthy {
  param(
    [string]$Url,
    [int]$TimeoutSec,
    [int]$IntervalMs
  )

  if ($DryRun) {
    Write-Output "[DryRun] Wait for Hydra health at $Url (timeout=${TimeoutSec}s, interval=${IntervalMs}ms)"
    return
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-HydraHealth -Url $Url) {
      Write-Output "Hydra is healthy at $Url"
      return
    }
    Start-Sleep -Milliseconds $IntervalMs
  }

  throw "Hydra did not become healthy at $Url within ${TimeoutSec}s. Check daemon terminal output."
}

if (-not $SkipDaemon) {
  Start-HydraTerminal -Title "Hydra Daemon" -Command "node '$hydraRoot\lib\orchestrator-daemon.mjs' start"
}

Wait-HydraHealthy -Url $healthUrl -TimeoutSec $WaitTimeoutSec -IntervalMs $PollIntervalMs

$headScript = Join-Path $hydraRoot "bin\hydra-head.ps1"
Start-HydraTerminal -Title "Hydra Gemini" -Command "node '$hydraRoot\lib\orchestrator-client.mjs' next agent=gemini; gemini"
Start-HydraTerminal -Title "Hydra Codex" -Command "node '$hydraRoot\lib\orchestrator-client.mjs' next agent=codex; codex"
Start-HydraTerminal -Title "Hydra Claude" -Command "node '$hydraRoot\lib\orchestrator-client.mjs' next agent=claude; claude"

if ($DryRun) {
  Write-Output "Dry run complete."
} else {
  Write-Output "Hydra launch started. New terminals should now be opening."
}
