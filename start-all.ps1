# start-all.ps1 — Start all Stexio services in parallel
# Usage: .\start-all.ps1
# Press Enter to stop all processes

$Root = $PSScriptRoot

Write-Host "Starting Stexio services..." -ForegroundColor White

$jobs = @()

# Proxy — port 3006
$jobs += Start-Process -NoNewWindow -PassThru `
  -FilePath "pnpm" `
  -ArgumentList "--filter=proxy dev" `
  -WorkingDirectory $Root

# App (frontend) — port 3000
$jobs += Start-Process -NoNewWindow -PassThru `
  -FilePath "pnpm" `
  -ArgumentList "--filter=app dev" `
  -WorkingDirectory $Root

# Test client — port 3001
$jobs += Start-Process -NoNewWindow -PassThru `
  -FilePath "npm" `
  -ArgumentList "run dev -- -p 3001" `
  -WorkingDirectory "$Root\test-client"

Write-Host ""
Write-Host "proxy       -> http://localhost:3006" -ForegroundColor Green
Write-Host "app         -> http://localhost:3000" -ForegroundColor Yellow
Write-Host "test-client -> http://localhost:3001" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press Enter to stop all services..."
$null = Read-Host

Write-Host "Stopping all services..." -ForegroundColor Yellow
$jobs | ForEach-Object {
  if (-not $_.HasExited) {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
}
Write-Host "Done." -ForegroundColor White
