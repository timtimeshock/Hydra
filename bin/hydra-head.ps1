param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("gemini", "codex", "claude")]
  [string]$Agent,
  [string]$Url = $(if ($env:AI_ORCH_URL) { $env:AI_ORCH_URL } else { "http://127.0.0.1:4173" }),
  [int]$PollIntervalMs = 1200
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Use cwd as the project directory (set by the launcher)
$repoPath = (Get-Location).Path

# ── ANSI Color Setup ─────────────────────────────────────────────────────────
$ESC = [char]27
$RESET   = "$ESC[0m"
$BOLD    = "$ESC[1m"
$DIM     = "$ESC[90m"
$RED     = "$ESC[91m"
$ORANGE  = "$ESC[38;2;232;134;58m"  # Claude Code orange (#E8863A)
$GREEN   = "$ESC[92m"
$YELLOW  = "$ESC[93m"
$MAGENTA = "$ESC[95m"
$CYAN    = "$ESC[96m"

$AgentColors = @{
  gemini = $CYAN
  codex  = $GREEN
  claude = $ORANGE
}

$AgentIcons = @{
  gemini = [char]0x2726  # ✦
  codex  = [char]0x58E   # ֎
  claude = [char]0x274B  # ❋
}

$AgentTaglines = @{
  gemini = "Analyst $([char]0x00B7) Critic $([char]0x00B7) Reviewer"
  codex  = "Implementer $([char]0x00B7) Builder $([char]0x00B7) Executor"
  claude = "Architect $([char]0x00B7) Planner $([char]0x00B7) Coordinator"
}

$Color = $AgentColors[$Agent]
$Icon  = $AgentIcons[$Agent]

try {
  $Host.UI.RawUI.WindowTitle = "Hydra Head - $($Agent.ToUpper())"
} catch {
  # ignore
}

function Get-HydraHeaders {
  $headers = @{
    "Accept" = "application/json"
  }

  if ($env:AI_ORCH_TOKEN) {
    $headers["x-ai-orch-token"] = $env:AI_ORCH_TOKEN
  }

  return $headers
}

function Invoke-HydraGet {
  param([string]$Route)
  return Invoke-RestMethod -Method Get -Uri "$Url$Route" -Headers (Get-HydraHeaders) -TimeoutSec 5
}

function Invoke-HydraPost {
  param(
    [string]$Route,
    [hashtable]$Body
  )

  $json = $Body | ConvertTo-Json -Depth 8
  return Invoke-RestMethod -Method Post -Uri "$Url$Route" -Headers (Get-HydraHeaders) -Body $json -ContentType "application/json" -TimeoutSec 10
}

function Build-HandoffPrompt {
  param($Handoff)

  $summary = [string]$Handoff.summary
  $nextStep = [string]$Handoff.nextStep
  $from = [string]$Handoff.from
  $id = [string]$Handoff.id

return @"
Hydra handoff id: $id
From: $from
Summary: $summary
Next step: $nextStep

Work this now. Ask follow-up questions in this terminal if needed.
If cross-head discussion is needed, run:
npm run hydra:council -- prompt="Council request from $($Agent): <question or conflict>" rounds=2
"@
}

function Get-ModelFlags {
  $hydraRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
  $configPath = Join-Path $hydraRoot "hydra.config.json"

  if (-not (Test-Path $configPath)) { return @() }

  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    $agentModels = $config.models.$Agent
    if (-not $agentModels) { return @() }

    $activeKey = if ($agentModels.active) { $agentModels.active } else { "default" }

    if ($activeKey -eq "default") {
      # Resolve through mode tiers
      $modeName = if ($config.mode) { $config.mode } else { "performance" }
      $modeTiers = $config.modeTiers
      if ($modeTiers -and $modeTiers.$modeName) {
        $tierPreset = $modeTiers.$modeName.$Agent
        if ($tierPreset -and $tierPreset -ne "default" -and $agentModels.$tierPreset) {
          $modelId = $agentModels.$tierPreset
          $defaultId = $agentModels.default
          if ($modelId -ne $defaultId -or $Agent -eq "codex") {
            return @("--model", $modelId)
          }
        }
      }
      # Codex always needs explicit --model (its own config may differ from Hydra's)
      if ($Agent -eq "codex") {
        $defaultId = $agentModels.default
        if ($defaultId) { return @("--model", $defaultId) }
      }
      return @()
    }

    # Per-agent override: resolve preset key to full model ID
    $modelId = if ($agentModels.$activeKey) { $agentModels.$activeKey } else { $activeKey }
    $defaultId = $agentModels.default

    if ($modelId -ne $defaultId -or $Agent -eq "codex") {
      return @("--model", $modelId)
    }
    return @()
  } catch {
    return @()
  }
}

$MinSessionSeconds = 30  # sessions shorter than this trigger restart prompt

function Start-AgentSession {
  param([string]$Prompt)

  $modelFlags = Get-ModelFlags

  switch ($Agent) {
    "claude" {
      & claude $Prompt @modelFlags
      break
    }
    "gemini" {
      & gemini --prompt-interactive $Prompt @modelFlags
      break
    }
    "codex" {
      & codex $Prompt @modelFlags
      break
    }
    default {
      throw "Unsupported agent: $Agent"
    }
  }
}

function Read-TranscriptOutput {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return "" }
  try {
    $lines = Get-Content $Path -ErrorAction SilentlyContinue
    if (-not $lines -or $lines.Count -lt 6) { return "" }
    # Strip PowerShell transcript header (first 5 lines) and footer (last 4 lines)
    $body = $lines[5..($lines.Count - 5)] -join "`n"
    # Strip ANSI escape codes for cleaner storage
    $body = $body -replace "$([char]27)\[[0-9;]*[a-zA-Z]", ''
    return $body
  } catch { return "" }
}

function Run-TrackedSession {
  param(
    [string]$Prompt,
    [string]$TaskId,
    [string]$Label
  )

  $transcriptDir = Join-Path $env:TEMP "hydra-heads"
  if (-not (Test-Path $transcriptDir)) { New-Item -ItemType Directory -Path $transcriptDir -Force | Out-Null }
  $transcriptPath = Join-Path $transcriptDir "$Agent-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"

  $shouldRestart = $true
  while ($shouldRestart) {
    $shouldRestart = $false
    $startTime = Get-Date

    try { Start-Transcript -Path $transcriptPath -Force | Out-Null } catch {}
    Start-AgentSession -Prompt $Prompt
    try { Stop-Transcript | Out-Null } catch {}

    $elapsed = (Get-Date) - $startTime
    $durationMs = [int]$elapsed.TotalMilliseconds
    $durationSec = [int]$elapsed.TotalSeconds

    # Read transcript output
    $output = Read-TranscriptOutput -Path $transcriptPath

    # Determine result status
    $resultStatus = "completed"
    if ($durationSec -lt $MinSessionSeconds) {
      $resultStatus = "aborted"
    }

    # POST result back to daemon
    if ($TaskId) {
      try {
        Invoke-HydraPost -Route "/task/result" -Body @{
          taskId = $TaskId
          agent = $Agent
          output = if ($output.Length -gt 6000) { $output.Substring($output.Length - 6000) } else { $output }
          status = $resultStatus
          durationMs = $durationMs
        } | Out-Null
      } catch {
        Write-Output "  ${DIM}(could not post result: $($_.Exception.Message))${RESET}"
      }
    }

    # Clean up transcript
    try { Remove-Item $transcriptPath -ErrorAction SilentlyContinue } catch {}

    # Short session protection
    if ($durationSec -lt $MinSessionSeconds) {
      Write-Output ""
      Write-Output "  ${YELLOW}${Icon}${RESET} ${BOLD}Session ended after ${durationSec}s${RESET} ${DIM}(< ${MinSessionSeconds}s threshold)${RESET}"
      Write-Output "  ${DIM}This may have been an accidental keypress.${RESET}"
      Write-Output ""
      Write-Output "  ${Color}[R]${RESET}estart this task    ${DIM}[S]${RESET}kip to listen mode"
      $choice = Read-Host "  "
      if ($choice -match '^[Rr]') {
        Write-Output "  ${Color}${Icon}${RESET} ${DIM}Restarting session for ${Label}...${RESET}"
        $shouldRestart = $true
      } else {
        Write-Output "  ${DIM}Skipping. Returning to listen mode...${RESET}"
      }
    } else {
      Write-Output "  ${DIM}Session exited after $([math]::Round($elapsed.TotalMinutes, 1))m. Returning to listen mode...${RESET}"
    }
  }
}

# ── Branded Startup ──────────────────────────────────────────────────────────
Write-Output ""
Write-Output "  ${Color}${Icon} $($Agent.ToUpper())${RESET}"
Write-Output "  ${DIM}$($AgentTaglines[$Agent])${RESET}"
Write-Output "  ${Color}$([string]::new([char]0x2500, 42))${RESET}"
Write-Output "  ${DIM}Listening on ${RESET}$Url"
Write-Output "  ${DIM}Project: ${RESET}$repoPath"
Write-Output "  ${DIM}Press Ctrl+C to close${RESET}"
Write-Output ""

$lastNoticeKey = ""

while ($true) {
  try {
    $nextResponse = Invoke-HydraGet -Route "/next?agent=$Agent"
    $next = $nextResponse.next
    $action = [string]$next.action

    if ($action -eq "pickup_handoff" -and $next.handoff) {
      $handoff = $next.handoff
      $handoffId = [string]$handoff.id
      $promptText = Build-HandoffPrompt -Handoff $handoff

      # Resolve task ID from handoff (for result tracking)
      $relatedTaskId = ""
      if ($next.relatedTask) { $relatedTaskId = [string]$next.relatedTask.id }
      elseif ($handoff.tasks -and $handoff.tasks.Count -gt 0) { $relatedTaskId = [string]$handoff.tasks[0] }

      Invoke-HydraPost -Route "/handoff/ack" -Body @{
        handoffId = $handoffId
        agent = $Agent
      } | Out-Null

      Write-Output ""
      Write-Output "  ${Color}${Icon}${RESET} ${BOLD}Picked up handoff ${YELLOW}$handoffId${RESET} ${DIM}$([char]0x2192) launching session...${RESET}"
      Run-TrackedSession -Prompt $promptText -TaskId $relatedTaskId -Label "handoff $handoffId"

      $lastNoticeKey = ""
    } elseif ($action -eq "claim_owned_task" -and $next.task) {
      $task = $next.task
      $taskId = [string]$task.id
      $taskTitle = [string]$task.title
      $taskNotes = [string]$task.notes

      # Claim the task (move to in_progress)
      Invoke-HydraPost -Route "/task/claim" -Body @{
        taskId = $taskId
        agent = $Agent
      } | Out-Null

      # Build prompt from task data
      $promptText = "Hydra task: $taskId`nTitle: $taskTitle"
      if ($taskNotes) { $promptText += "`nNotes: $taskNotes" }
      $promptText += "`n`nWork this now. If cross-head discussion is needed, run:`nnpm run hydra:council -- prompt=`"Council request from $($Agent): <question or conflict>`" rounds=2"

      Write-Output ""
      Write-Output "  ${Color}${Icon}${RESET} ${BOLD}Claimed task ${YELLOW}$taskId${RESET} ${DIM}($taskTitle)${RESET} ${DIM}$([char]0x2192) launching session...${RESET}"
      Run-TrackedSession -Prompt $promptText -TaskId $taskId -Label "task $taskId"

      $lastNoticeKey = ""
    } elseif ($action -eq "continue_task" -and $next.task) {
      $taskId = [string]$next.task.id
      $key = "continue:$taskId"
      if ($key -ne $lastNoticeKey) {
        Write-Output "  ${Color}${Icon}${RESET} Continue task ${BOLD}$taskId${RESET} ${DIM}($($next.task.title))${RESET}"
        $lastNoticeKey = $key
      }
    } elseif ($action -eq "idle") {
      if ($lastNoticeKey -ne "idle") {
        Write-Output "  ${DIM}${Icon} Waiting for new handoff...${RESET}"
        $lastNoticeKey = "idle"
      }
    } else {
      $lastNoticeKey = ""
    }
  } catch {
    Write-Output "  ${RED}[error]${RESET} ${DIM}$($_.Exception.Message)${RESET}"
    $lastNoticeKey = ""
    Start-Sleep -Milliseconds 1500
  }

  Start-Sleep -Milliseconds $PollIntervalMs
}
