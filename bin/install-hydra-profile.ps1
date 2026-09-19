param(
  [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$hydraRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$hydraScriptPath = Join-Path $hydraRoot "bin\hydra.ps1"

$startMarker = "# >>> Hydra >>>"
$endMarker = "# <<< Hydra <<<"
$oldStartMarker = "# >>> SideQuest Hydra >>>"
$oldEndMarker = "# <<< SideQuest Hydra <<<"

$hydraScriptEscaped = $hydraScriptPath -replace "'", "''"
$block = @"
$startMarker
function hydra {
  param(
    [switch]`$Full,
    [string]`$Prompt = "",
    [Parameter(ValueFromRemainingArguments = `$true)] [string[]]`$Rest
  )
  if (`$Full) {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File '$hydraScriptEscaped' -Full @Rest
  } elseif (`$Prompt) {
    & node "$($hydraRoot -replace '\\','/')/lib/hydra-operator.mjs" "prompt=`$Prompt" mode=auto @Rest
  } else {
    & node "$($hydraRoot -replace '\\','/')/lib/hydra-operator.mjs" mode=auto @Rest
  }
}
$endMarker
"@

# Collect all profile paths to update (pwsh 7+ and legacy WindowsPowerShell)
$profilePaths = @()

# Primary: current host profile (whichever PS is running this script)
$profilePaths += $PROFILE.CurrentUserCurrentHost

# Also check the other edition's profile
$docsDir = [Environment]::GetFolderPath('MyDocuments')
$pwsh7Profile = Join-Path $docsDir "PowerShell\Microsoft.PowerShell_profile.ps1"
$legacyProfile = Join-Path $docsDir "WindowsPowerShell\Microsoft.PowerShell_profile.ps1"

if ($profilePaths -notcontains $pwsh7Profile) { $profilePaths += $pwsh7Profile }
if ($profilePaths -notcontains $legacyProfile) { $profilePaths += $legacyProfile }

$updatedCount = 0

foreach ($profilePath in $profilePaths) {
  $profileDir = Split-Path -Parent $profilePath

  # Skip if profile dir doesn't exist and we're uninstalling
  if ($Uninstall -and -not (Test-Path -LiteralPath $profilePath)) {
    continue
  }

  if (-not (Test-Path -LiteralPath $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
  }

  if (-not (Test-Path -LiteralPath $profilePath)) {
    New-Item -ItemType File -Path $profilePath -Force | Out-Null
  }

  $existing = Get-Content -LiteralPath $profilePath -Raw
  if ($null -eq $existing) {
    $existing = ""
  }

  # Clean existing Hydra block
  $pattern = [regex]::Escape($startMarker) + "[\s\S]*?" + [regex]::Escape($endMarker)
  $cleaned = [regex]::Replace($existing, $pattern, "").TrimEnd()

  # Clean old SideQuest markers
  $oldPattern = [regex]::Escape($oldStartMarker) + "[\s\S]*?" + [regex]::Escape($oldEndMarker)
  $cleaned = [regex]::Replace($cleaned, $oldPattern, "").TrimEnd()

  if ($Uninstall) {
    Set-Content -LiteralPath $profilePath -Value ($cleaned + [Environment]::NewLine) -Encoding UTF8
    Write-Output "Removed Hydra from: $profilePath"
    $updatedCount++
    continue
  }

  $newContent = $cleaned
  if ($newContent.Length -gt 0) {
    $newContent += [Environment]::NewLine + [Environment]::NewLine
  }
  $newContent += $block + [Environment]::NewLine

  Set-Content -LiteralPath $profilePath -Value $newContent -Encoding UTF8
  Write-Output "Updated: $profilePath"
  $updatedCount++
}

if ($Uninstall) {
  Write-Output ""
  Write-Output "Removed Hydra from $updatedCount profile(s)."
  Write-Output "Restart terminal or run: . `$PROFILE"
  exit 0
}

Write-Output ""
Write-Output "Installed Hydra command into $updatedCount PowerShell profile(s)."
Write-Output "- Script: $hydraScriptPath"
Write-Output ""
Write-Output "Reload now with:"
Write-Output ". `$PROFILE"
Write-Output ""
Write-Output "Then run:"
Write-Output "hydra"
