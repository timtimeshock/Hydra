# Hydra Restart
Write-Host "Restartuji Hydra..." -ForegroundColor Cyan

# Zastav Node procesy
Write-Host "Zastavuji procesy..." -ForegroundColor Gray
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Spust daemon
Write-Host "Spoustim daemon..." -ForegroundColor Green
Set-Location C:\hydra
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd C:\hydra; npm start"

Write-Host "Hotovo!" -ForegroundColor Green
