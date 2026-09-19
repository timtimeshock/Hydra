<#
.SYNOPSIS
    Hydra Audit Runner — Fan-out codebase audit across agents, collect into punch list.

.DESCRIPTION
    Dispatches focused analysis prompts to each agent by specialty,
    collects structured findings, and assembles a prioritized markdown
    punch list in the target project's docs/audit/ directory.

    NO code changes. NO branches. NO commits. Just a report.

    Agent roles:
    - Gemini (Analyst):  Dead code, unused exports, inconsistencies, duplication
    - Claude (Architect): Architecture gaps, security issues, design smells
    - Codex (Implementer): Test coverage gaps, missing error handling, type safety

.EXAMPLE
    # Audit current directory
    .\bin\hydra-audit.ps1

    # Audit a specific project
    .\bin\hydra-audit.ps1 -Project "C:\path\to\YourProject"

    # Only run specific categories
    .\bin\hydra-audit.ps1 -Categories "security,tests"

    # Economy mode (use fast/cheap models)
    .\bin\hydra-audit.ps1 -Economy

    # Skip a specific agent
    .\bin\hydra-audit.ps1 -Agents "claude,gemini"
#>

param(
    [string]$Project = (Get-Location).Path,
    [string]$Categories = "all",
    [string]$Agents = "gemini,claude,codex",
    [switch]$Economy,
    [int]$MaxFiles = 200,
    [int]$TimeoutMs = 0,
    [string]$Report = "",
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"

# Paths
$HydraRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AuditScript = Join-Path $HydraRoot "lib\hydra-audit.mjs"
$HydraConfigPath = Join-Path $HydraRoot "hydra.config.json"
$DateStr = Get-Date -Format "yyyy-MM-dd"
$TimeStr = Get-Date -Format "HH-mm"
$ConfiguredReportDir = "docs\audit"
if (Test-Path -LiteralPath $HydraConfigPath) {
    try {
        $cfg = Get-Content -Raw -LiteralPath $HydraConfigPath | ConvertFrom-Json
        if ($cfg.audit.reportDir) {
            $ConfiguredReportDir = ($cfg.audit.reportDir -replace "/", "\")
        }
    }
    catch {
        # Fallback to docs\audit if config parse fails
    }
}
$AuditDir = Join-Path $Project $ConfiguredReportDir
$ReportFile = Join-Path $AuditDir "$DateStr.md"
$LogFile = Join-Path $AuditDir "audit-console-$DateStr-$TimeStr.log"

# Ensure audit directory exists
if (-not (Test-Path $AuditDir)) {
    New-Item -ItemType Directory -Path $AuditDir -Force | Out-Null
}

# Build args
$NodeArgs = @($AuditScript, "project=$Project")
$NodeArgs += "categories=$Categories"
$NodeArgs += "agents=$Agents"
$NodeArgs += "max-files=$MaxFiles"
if ($Report) { $NodeArgs += "report=$Report" }
if ($TimeoutMs -gt 0) { $NodeArgs += "timeout=$TimeoutMs" }

if ($Economy) { $NodeArgs += "--economy" }
if ($Verbose) { $NodeArgs += "--verbose" }

Write-Host ""
Write-Host "=== Hydra Audit Runner ===" -ForegroundColor Magenta
Write-Host "  Project:    $Project"
Write-Host "  Agents:     $Agents"
Write-Host "  Categories: $Categories"
if ($Report) {
    Write-Host "  Report:     $Report"
} else {
    Write-Host "  Report:     $ReportFile (config/default)"
}
Write-Host "  Log:        $LogFile"
if ($Economy) { Write-Host "  Models:     economy tier" -ForegroundColor Yellow }
if ($TimeoutMs -gt 0) { Write-Host "  Timeout:    $TimeoutMs ms" }
Write-Host ""

# Change to project directory
Push-Location $Project

try {
    & node @NodeArgs 2>&1 | Tee-Object -FilePath $LogFile -Append

    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Host ""
        Write-Host "Audit exited with code $exitCode" -ForegroundColor Yellow
    } else {
        Write-Host ""
        if ($Report) {
            Write-Host "Audit complete. Report: $Report" -ForegroundColor Green
            Write-Host "Review with:  code `"$Report`"" -ForegroundColor Cyan
        } else {
            Write-Host "Audit complete. Report: $ReportFile" -ForegroundColor Green
            Write-Host "Review with:  code `"$ReportFile`"" -ForegroundColor Cyan
        }
    }
}
catch {
    Write-Host "Fatal error: $_" -ForegroundColor Red
    $_ | Out-File -Append $LogFile
}
finally {
    Pop-Location
}
