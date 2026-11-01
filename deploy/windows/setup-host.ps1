#Requires -Version 5.1
# Lpcalas - pokretanje servera na Windows racunaru (privremeni hosting).
# Skripta je bezbjedna za ponovno pokretanje: koristi postojece kljuceve i podatke.
# (Tekst je namjerno bez kvacica da se ispravno prikaze u svakoj PowerShell verziji.)

$ErrorActionPreference = 'Stop'
$DeployDir = Split-Path -Parent $PSScriptRoot
Set-Location -Path $DeployDir

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    OK: $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    PAZNJA: $text" -ForegroundColor Yellow }
function Stop-WithError($text) {
    Write-Host "`nGRESKA: $text" -ForegroundColor Red
    Read-Host "`nPritisni Enter za izlaz"
    exit 1
}

# --- 1. Administratorska prava (potrebna samo za firewall pravila) ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Trazim administratorska prava (za Windows firewall)..." -ForegroundColor Yellow
    try {
        Start-Process powershell.exe -Verb RunAs -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
        exit 0
    } catch {
        Write-Warn2 "Bez admin prava - preskacem firewall pravila. Ako prijatelji ne mogu da se spoje, pokreni ponovo kao admin."
    }
}

# --- 2. Docker ---
function Test-DockerRunning {
    # U Windows PowerShell 5.1 preusmjeren stderr + 'Stop' baca gresku, zato privremeno 'Continue'.
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    docker info *> $null
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $old
    return $ok
}
Write-Step "Provjeravam Docker"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-WithError ("Docker nije instaliran.`n" +
        "Instaliraj Docker Desktop: https://www.docker.com/products/docker-desktop/`n" +
        "ili u PowerShellu: winget install Docker.DockerDesktop`n" +
        "Nakon instalacije restartuj racunar, pokreni Docker Desktop jednom i ponovo pokreni ovu skriptu.")
}
if (-not (Test-DockerRunning)) {
    $dd = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $dd) {
        Write-Host "    Pokrecem Docker Desktop, sacekaj..."
        Start-Process $dd
        $ready = $false
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 3
            if (Test-DockerRunning) { $ready = $true; break }
        }
        if (-not $ready) { Stop-WithError "Docker Desktop se nije pokrenuo za 3 minute. Pokreni ga rucno pa probaj opet." }
    } else {
        Stop-WithError "Docker nije pokrenut. Otvori Docker Desktop pa ponovo pokreni skriptu."
    }
}
Write-Ok "Docker radi"

# --- 3. Kljucevi i konfiguracija ---
Write-Step "Pripremam konfiguraciju"
$utf8 = New-Object System.Text.UTF8Encoding $false
function New-Secret([int]$bytes) {
    $b = New-Object byte[] $bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    return ([Convert]::ToBase64String($b) -replace '[+/=]', '')
}

$envPath = Join-Path $DeployDir '.env'
if (-not (Test-Path $envPath)) {
    $key = 'LP' + (New-Secret 9)
    $secret = New-Secret 32
    $envText = "LIVEKIT_API_KEY=$key`nLIVEKIT_API_SECRET=$secret`nSERVER_NAME=Lpcalas`nMAX_UPLOAD_MB=500`n"
    [IO.File]::WriteAllText($envPath, $envText, $utf8)
    Write-Ok "Napravljeni novi kljucevi (.env)"
} else {
    Write-Ok "Koristim postojeci .env"
}
$envMap = @{}
foreach ($line in [IO.File]::ReadAllLines($envPath)) {
    if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)\s*$') { $envMap[$Matches[1]] = $Matches[2] }
}
$template = [IO.File]::ReadAllText((Join-Path $DeployDir 'livekit.template.yaml'))
$lk = $template.Replace('__API_KEY__', $envMap['LIVEKIT_API_KEY']).Replace('__API_SECRET__', $envMap['LIVEKIT_API_SECRET'])
[IO.File]::WriteAllText((Join-Path $DeployDir 'livekit.yaml'), $lk, $utf8)
Write-Ok "livekit.yaml spreman"

# --- 4. Firewall ---
if ($isAdmin) {
    Write-Step "Otvaram portove u Windows firewallu"
    Get-NetFirewallRule -DisplayName 'Lpcalas*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName 'Lpcalas TCP' -Direction Inbound -Protocol TCP -LocalPort 8080, 7881 -Action Allow | Out-Null
    New-NetFirewallRule -DisplayName 'Lpcalas UDP' -Direction Inbound -Protocol UDP -LocalPort 7882 -Action Allow | Out-Null
    Write-Ok "TCP 8080, 7881 i UDP 7882 otvoreni"
}

# --- 5. Pokretanje ---
Write-Step "Pokrecem server (prvi put moze potrajati par minuta)"
$ErrorActionPreference = 'Continue'
# Povuci najnovije (sigurnosno zakrpljene) slike: LiveKit i Node osnovu backenda.
docker compose pull livekit
docker compose build --pull
$buildExit = $LASTEXITCODE
docker compose up -d
$composeExit = [Math]::Max($LASTEXITCODE, $buildExit)
$ErrorActionPreference = 'Stop'
if ($composeExit -ne 0) { Stop-WithError "docker compose nije uspio. Posalji Claudeu ispis iznad." }

$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $h = Invoke-RestMethod -Uri 'http://localhost:8080/api/health' -TimeoutSec 3
        if ($h.ok) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 2 }
}
if (-not $healthy) { Stop-WithError "Server se nije javio. Pokreni: docker compose logs --tail 100   i posalji ispis Claudeu." }
Write-Ok "Server radi"

# --- 6. Adrese ---
$publicIp = $null
try { $publicIp = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 5).ToString().Trim() } catch { }
$localIp = $null
try {
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1
    $localIp = (Get-NetIPAddress -InterfaceIndex $route.ifIndex -AddressFamily IPv4 | Select-Object -First 1).IPAddress
} catch { }

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host " LPCALAS SERVER RADI" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
if ($localIp) {
    Write-Host " Na ovom racunaru (i u istoj kucnoj mrezi) upisi:  ${localIp}:8080"
} else {
    Write-Host " Na ovom racunaru u aplikaciji upisi:   localhost:8080"
}
if ($publicIp) {
    Write-Host " Prijatelji preko interneta upisuju:   ${publicIp}:8080"
}
$invitePath = Join-Path $DeployDir 'data\PRVA-POZIVNICA.txt'
if (Test-Path $invitePath) {
    $code = ([IO.File]::ReadAllText($invitePath) | Select-String -Pattern '[A-Z2-9]{5}-[A-Z2-9]{5}').Matches[0].Value
    Write-Host "`n Prvi pozivni kod (tvoj nalog postaje admin):  $code" -ForegroundColor Yellow
}
Write-Host "`n Na ruteru proslijedi (port forwarding) na IP ovog racunara: $localIp"
Write-Host "   TCP 8080   TCP 7881   UDP 7882"
Write-Host "`n Gasenje:    ZAUSTAVI-SERVER.bat"
Write-Host " Logovi:     docker compose logs -f   (u folderu deploy)"
Write-Host "============================================================`n"
Read-Host "Pritisni Enter za zatvaranje"
