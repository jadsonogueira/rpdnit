param(
  [string]$AppDir = "C:\apps\rpdnit",
  [string]$Pm2Name = "rpdnit",
  [int]$Port = 8080
)

Set-Location $AppDir

Write-Host "==> Pull latest"
git fetch --all
git reset --hard origin/main

Write-Host "==> Install deps"
npm install --legacy-peer-deps

Write-Host "==> Start/Restart PM2 (node server.js)"
# Se já existir, remove e recria pra garantir o comando correto
try {
  pm2 describe $Pm2Name | Out-Null
  Write-Host "==> PM2 process exists, deleting to recreate..."
  pm2 delete $Pm2Name | Out-Null
} catch {
  # não existe, ok
}

pm2 start "server.js" --name $Pm2Name
pm2 save

Write-Host "==> Health check"
curl.exe -I "http://localhost:$Port" | Select-Object -First 1

Write-Host "==> Done"
pm2 ls
