param(
  [string]$Url = $(if ($env:AI_ORCH_URL) { $env:AI_ORCH_URL } else { "http://127.0.0.1:4173" })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$hydraRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

# Try daemon /stats endpoint first
try {
  $response = Invoke-RestMethod -Method Get -Uri "$Url/stats" -TimeoutSec 3
  # Daemon is up — use the client for pretty rendering
  & node "$hydraRoot/lib/orchestrator-client.mjs" stats url=$Url
} catch {
  # Daemon is down — fall back to standalone usage monitor
  Write-Output "  (daemon not running — showing standalone usage)"
  & node "$hydraRoot/lib/hydra-usage.mjs"
}
