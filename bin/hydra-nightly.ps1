<#
.SYNOPSIS
    Hydra Nightly Runner — PowerShell launcher for autonomous overnight work.

.DESCRIPTION
    Launches the Hydra nightly runner from the target project directory.
    Designed for Windows Task Scheduler or manual invocation.

    The runner:
    - Scans multiple sources (TODO comments, TODO.md, GitHub issues, config, AI discovery)
    - Routes tasks to the best agent (Claude, Gemini, Codex) via intelligent classification
    - Manages budget with configurable handoff thresholds
    - Generates morning reports for review
    - Works on isolated nightly/* branches

.EXAMPLE
    # Manual run
    .\bin\hydra-nightly.ps1

    # With overrides
    .\bin\hydra-nightly.ps1 -MaxTasks 2 -Project "C:\Dev\MyProject"

    # Skip AI discovery
    .\bin\hydra-nightly.ps1 -NoDiscovery

    # Dry run (scan + prioritize only)
    .\bin\hydra-nightly.ps1 -DryRun

    # Task Scheduler (create via taskschd.msc):
    #   Program: pwsh.exe
    #   Arguments: -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\Hydra\bin\hydra-nightly.ps1"
    #   Start in: C:\Dev\MyProject
    #   Trigger: Daily at 01:00
#>

param(
    [string]$Project = (Get-Location).Path,
    [int]$MaxTasks = 0,
    [float]$MaxHours = 0,
    [int]$HardLimit = 0,
    [switch]$NoDiscovery,
    [switch]$DryRun,
    [string]$Sources = ""
)

$ErrorActionPreference = "Stop"

# Paths
$HydraRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NightlyScript = Join-Path $HydraRoot "lib\hydra-nightly.mjs"
$LogDir = Join-Path $Project "docs\coordination\nightly"
$DateStr = Get-Date -Format "yyyy-MM-dd"
$LogFile = Join-Path $LogDir "nightly-console-$DateStr.log"

# Ensure log directory exists
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# Build args
$NodeArgs = @($NightlyScript, "project=$Project")

if ($MaxTasks -gt 0)  { $NodeArgs += "max-tasks=$MaxTasks" }
if ($MaxHours -gt 0)  { $NodeArgs += "max-hours=$MaxHours" }
if ($HardLimit -gt 0) { $NodeArgs += "hard-limit=$HardLimit" }
if ($NoDiscovery)     { $NodeArgs += "--no-discovery" }
if ($DryRun)          { $NodeArgs += "--dry-run" }
if ($Sources)         { $NodeArgs += "sources=$Sources" }

Write-Host ""
Write-Host "=== Hydra Nightly Runner ===" -ForegroundColor Cyan
Write-Host "  Project:   $Project"
Write-Host "  Script:    $NightlyScript"
Write-Host "  Log:       $LogFile"
Write-Host "  Date:      $DateStr"
Write-Host "  Args:      $($NodeArgs -join ' ')"
if ($NoDiscovery) { Write-Host "  Discovery: disabled" -ForegroundColor Yellow }
if ($DryRun)      { Write-Host "  Mode:      DRY RUN" -ForegroundColor Yellow }
Write-Host ""

# Change to project directory
Push-Location $Project

try {
    # Run the nightly script, tee output to log file
    & node @NodeArgs 2>&1 | Tee-Object -FilePath $LogFile -Append

    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Host ""
        Write-Host "Nightly runner exited with code $exitCode" -ForegroundColor Yellow
    } else {
        Write-Host ""
        Write-Host "Nightly run complete. Review with: npm run nightly:review" -ForegroundColor Green
    }
}
catch {
    Write-Host "Fatal error: $_" -ForegroundColor Red
    $_ | Out-File -Append $LogFile
}
finally {
    Pop-Location
}
