# Skapar en deploybar ZIP och öppnar Netlify Drop.
# Användning: powershell -File deploy.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$zip  = Join-Path $env:TEMP 'terrarium-deploy.zip'

$exclude = @('deploy.ps1', 'tests', 'node_modules', 'package.json', 'serve.js')
$items = Get-ChildItem -Path $root -Force | Where-Object { $exclude -notcontains $_.Name }

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $items.FullName -DestinationPath $zip -CompressionLevel Optimal

Write-Host "🌿 Deploy-zip skapad: $zip" -ForegroundColor Green
Write-Host "Öppnar Netlify Drop – dra in ZIP:en där så får du en gratis länk." -ForegroundColor Cyan
Start-Process 'https://app.netlify.com/drop'
