$ErrorActionPreference = 'Stop'

$projectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectPath

docker compose up -d --build
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Compose deployment failed.'
}

$health = $null
for ($attempt = 1; $attempt -le 15; $attempt += 1) {
    try {
        $health = Invoke-RestMethod -Uri 'http://localhost:3100/healthz' -TimeoutSec 2
        if ($health.ok -eq $true) { break }
    } catch {
        Start-Sleep -Seconds 1
    }
}

if ($health.ok -ne $true) {
    docker compose logs --tail 80
    throw 'Container started but health check failed: http://localhost:3100/healthz'
}

Write-Host '部署成功: http://localhost:3100'
Write-Host '响度接口: GET /analyze?url=<encoded-audio-url>'
