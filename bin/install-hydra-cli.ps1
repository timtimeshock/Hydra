param(
  [switch]$Uninstall,
  [string]$PackagePath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-CommandAvailable {
  param([string]$CommandName)
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Required command not found in PATH: $CommandName"
  }
}

Assert-CommandAvailable -CommandName "npm"
Assert-CommandAvailable -CommandName "node"

$hydraRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$installTarget = if ($PackagePath) { $PackagePath } else { $hydraRoot }

if (-not $Uninstall) {
  if (Test-Path -LiteralPath $installTarget) {
    $installTarget = (Resolve-Path -LiteralPath $installTarget).Path
  }

  Write-Output "Installing Hydra globally from: $installTarget"
  & npm install -g $installTarget
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE"
  }

  $hydraCmd = Get-Command hydra -ErrorAction SilentlyContinue
  Write-Output ""
  if ($hydraCmd) {
    Write-Output "Hydra CLI installed: $($hydraCmd.Source)"
  } else {
    Write-Output "Hydra installed, but 'hydra' is not in PATH yet."
    Write-Output "Restart your terminal and ensure npm global bin is in PATH."
  }
  Write-Output ""
  Write-Output "Try:"
  Write-Output "hydra --help"
  exit 0
}

Write-Output "Uninstalling Hydra global package..."
& npm uninstall -g hydra
if ($LASTEXITCODE -ne 0) {
  throw "npm uninstall failed with exit code $LASTEXITCODE"
}
Write-Output ""
Write-Output "Hydra global CLI removed."
