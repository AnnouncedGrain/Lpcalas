#Requires -Version 5.1
# Lpcalas - azuriranje servera na najnoviju verziju s GitHuba.
# Podaci (deploy\data) i kljucevi (deploy\.env) se NE diraju.

$ErrorActionPreference = 'Stop'
$DeployDir = Split-Path -Parent $PSScriptRoot
$RootDir = Split-Path -Parent $DeployDir
$Zip = Join-Path $env:TEMP 'lpcalas-main.zip'
$Tmp = Join-Path $env:TEMP 'lpcalas-update'

Write-Host "`n==> Skidam najnoviju verziju s GitHuba..." -ForegroundColor Cyan
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri 'https://github.com/AnnouncedGrain/Lpcalas/archive/refs/heads/main.zip' -OutFile $Zip -UseBasicParsing

Write-Host "==> Raspakujem..." -ForegroundColor Cyan
if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
$Src = Get-ChildItem $Tmp -Directory | Select-Object -First 1

Write-Host "==> Kopiram nove fajlove (data i .env ostaju)..." -ForegroundColor Cyan
foreach ($item in Get-ChildItem $Src.FullName -Force) {
    Copy-Item -Path $item.FullName -Destination $RootDir -Recurse -Force
}
Remove-Item $Tmp -Recurse -Force
Remove-Item $Zip -Force

Write-Host "==> Pokrecem server s novom verzijom..." -ForegroundColor Cyan
& (Join-Path $DeployDir 'windows\setup-host.ps1')
