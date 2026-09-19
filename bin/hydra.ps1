param(
  [string]$Url = $(if ($env:AI_ORCH_URL) { $env:AI_ORCH_URL } else { "http://127.0.0.1:4173" }),
  [switch]$Full,
  [switch]$SkipDaemon,
  [switch]$SkipHeads,
  [switch]$DryRun,
  [string]$Prompt = "",
  [int]$WaitTimeoutSec = 30,
  [int]$PollIntervalMs = 500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$hydraRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoPath = (Get-Location).Path

# ── Default mode: operator only (daemon auto-starts inside Node) ──────────

if (-not $Full) {
  # Simple mode — the operator handles daemon auto-start and welcome screen
  if ($DryRun) {
    Write-Output "[DryRun] node $hydraRoot\lib\hydra-operator.mjs mode=auto url=$Url"
    if ($Prompt) { Write-Output "[DryRun] prompt=$Prompt" }
    exit 0
  }

  try {
    $Host.UI.RawUI.WindowTitle = "Hydra"
  } catch {
    # ignore
  }

  if ($Prompt) {
    & node "$hydraRoot\lib\hydra-operator.mjs" "prompt=$Prompt" "url=$Url" "mode=auto"
  } else {
    & node "$hydraRoot\lib\hydra-operator.mjs" "url=$Url" "mode=auto"
  }
  exit $LASTEXITCODE
}

# ── Full mode: daemon + 3 agent head terminals + operator ─────────────────

function Escape-SingleQuote {
  param([string]$Value)
  return $Value -replace "'", "''"
}

$repoPathEscaped = Escape-SingleQuote -Value $repoPath
$hydraRootEscaped = Escape-SingleQuote -Value $hydraRoot
$urlEscaped = Escape-SingleQuote -Value $Url

$uri = [System.Uri]$Url
$healthUrl = "$($uri.Scheme)://$($uri.Host):$($uri.Port)/health"

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

function Test-HydraHealth {
  param([string]$TargetUrl)
  try {
    $response = Invoke-RestMethod -Method Get -Uri $TargetUrl -TimeoutSec 2
    return ($response.ok -eq $true -and $response.running -eq $true)
  } catch {
    return $false
  }
}

function Wait-HydraHealthy {
  param(
    [string]$TargetUrl,
    [int]$TimeoutSec,
    [int]$IntervalMs
  )

  if ($DryRun) {
    Write-Output "[DryRun] Wait for Hydra health at $TargetUrl (timeout=${TimeoutSec}s, interval=${IntervalMs}ms)"
    return
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-HydraHealth -TargetUrl $TargetUrl) {
      Write-Output "Hydra is healthy at $TargetUrl"
      return
    }
    Start-Sleep -Milliseconds $IntervalMs
  }

  throw "Hydra did not become healthy at $TargetUrl within ${TimeoutSec}s."
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

function Start-HydraDaemon {
  if ($DryRun) {
    Write-Output "[DryRun] Start daemon process: node $hydraRoot\lib\orchestrator-daemon.mjs start"
    return
  }

  Start-Process -FilePath "node" -WorkingDirectory $repoPath -ArgumentList @(
    "$hydraRoot\lib\orchestrator-daemon.mjs",
    "start"
  ) -WindowStyle Hidden | Out-Null
}

Set-Location -LiteralPath $repoPath

if (-not $SkipDaemon) {
  if (Test-HydraHealth -TargetUrl $healthUrl) {
    Write-Output "Hydra daemon already running at $healthUrl"
  } else {
    Start-HydraDaemon
  }
}

Wait-HydraHealthy -TargetUrl $healthUrl -TimeoutSec $WaitTimeoutSec -IntervalMs $PollIntervalMs

if (-not $SkipHeads) {
  $headScript = Join-Path $hydraRoot "bin\hydra-head.ps1"
  Start-HydraTerminal -Title "Hydra Head - GEMINI" -Command "pwsh -NoProfile -ExecutionPolicy Bypass -File '$headScript' -Agent gemini -Url '$urlEscaped'"
  Start-HydraTerminal -Title "Hydra Head - CODEX" -Command "pwsh -NoProfile -ExecutionPolicy Bypass -File '$headScript' -Agent codex -Url '$urlEscaped'"
  Start-HydraTerminal -Title "Hydra Head - CLAUDE" -Command "pwsh -NoProfile -ExecutionPolicy Bypass -File '$headScript' -Agent claude -Url '$urlEscaped'"
}

if ($DryRun) {
  if ($Prompt) {
    Write-Output "[DryRun] One-shot prompt: $Prompt"
  }
  Write-Output "[DryRun] Start operator console: node $hydraRoot\lib\hydra-operator.mjs mode=auto"
  exit 0
}

try {
  $Host.UI.RawUI.WindowTitle = "Hydra Command Center"
} catch {
  # ignore
}

if ($Prompt) {
  & node "$hydraRoot\lib\hydra-operator.mjs" "prompt=$Prompt" "url=$Url" "mode=auto" "welcome=false"
}

& node "$hydraRoot\lib\hydra-operator.mjs" "url=$Url" "mode=auto" "welcome=false"
