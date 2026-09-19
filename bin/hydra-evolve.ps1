<#
.SYNOPSIS
    Hydra Evolve Runner — PowerShell launcher for autonomous self-improvement.

.DESCRIPTION
    Launches the Hydra evolve runner from the target project directory.
    Designed for Windows Task Scheduler or manual invocation.

    The runner:
    - Runs deliberative research-implement-analyze rounds
    - Creates isolated evolve/* branches for each improvement
    - Accumulates knowledge across sessions
    - Never touches dev/staging/main

.EXAMPLE
    # Manual run
    .\bin\hydra-evolve.ps1

    # With overrides
    .\bin\hydra-evolve.ps1 -MaxRounds 1 -Project "C:\Dev\MyProject"

    # Task Scheduler (create via taskschd.msc):
    #   Program: pwsh.exe
    #   Arguments: -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\Hydra\bin\hydra-evolve.ps1"
    #   Start in: C:\Dev\MyProject
    #   Trigger: Weekly, Sunday at 02:00
#>

param(
    [string]$Project = (Get-Location).Path,
    [int]$MaxRounds = 0,
    [float]$MaxHours = 0,
    [int]$HardLimit = 0,
    [string]$Focus = "",
    [switch]$ResumeSession,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Paths
$HydraRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EvolveScript = Join-Path $HydraRoot "lib\hydra-evolve.mjs"
$LogDir = Join-Path $Project "docs\coordination\evolve"
$DateStr = Get-Date -Format "yyyy-MM-dd"
$LogFile = Join-Path $LogDir "evolve-console-$DateStr.log"

# Ensure log directory exists
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# Build args
$NodeArgs = @($EvolveScript, "project=$Project")

if ($MaxRounds -gt 0) { $NodeArgs += "max-rounds=$MaxRounds" }
if ($MaxHours -gt 0)  { $NodeArgs += "max-hours=$MaxHours" }
if ($HardLimit -gt 0) { $NodeArgs += "hard-limit=$HardLimit" }
if ($Focus)           { $NodeArgs += "focus=$Focus" }
if ($ResumeSession)   { $NodeArgs += "resume=1" }

if ($ResumeSession) {
    Write-Host ""
    Write-Host "Resuming evolve session..." -ForegroundColor Yellow
    Write-Host "  Project:   $Project"
    Write-Host "  Log:       $LogFile"
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "=== Hydra Evolve Runner ===" -ForegroundColor Magenta
    Write-Host "  Project:   $Project"
    Write-Host "  Script:    $EvolveScript"
    Write-Host "  Log:       $LogFile"
    Write-Host "  Date:      $DateStr"
    Write-Host "  Args:      $($NodeArgs -join ' ')"
    Write-Host ""
}

if ($DryRun) {
    Write-Host "[DRY RUN] Would execute: node $($NodeArgs -join ' ')" -ForegroundColor Yellow
    exit 0
}

# Change to project directory
Push-Location $Project

try {
    # Run the evolve script, tee output to log file
    & node @NodeArgs 2>&1 | Tee-Object -FilePath $LogFile -Append

    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Host ""
        Write-Host "Evolve runner exited with code $exitCode" -ForegroundColor Yellow
    } else {
        Write-Host ""
        Write-Host "Evolve session complete. Review with: npm run evolve:review" -ForegroundColor Green
    }
}
catch {
    Write-Host "Fatal error: $_" -ForegroundColor Red
    $_ | Out-File -Append $LogFile
}
finally {
    Pop-Location
}
