[CmdletBinding()]
param([string]$DataRoot, [ValidateRange(1,65535)][int]$Port=32146)

$ErrorActionPreference = 'Stop'
$studioRoot = $PSScriptRoot
$server = Join-Path $studioRoot 'server.mjs'
$uri = "http://127.0.0.1:$Port"
$env:GAME_TRAILER_STUDIO_PORT = [string]$Port
if ($DataRoot) {
    if (-not [IO.Path]::IsPathRooted($DataRoot) -or $DataRoot.StartsWith('\\')) { throw 'Kies een absoluut lokaal pad.' }
    $env:GAME_TRAILER_STUDIO_DATA_ROOT = [IO.Path]::GetFullPath($DataRoot)
    $env:GAME_TRAILER_STUDIO_ALLOW_CUSTOM_DRIVE = '1'
}
$nodeCandidates = @(
    (Join-Path $studioRoot 'vendor\node.exe'),
    (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
)
$node = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $node) {
    throw 'Node.js is niet gevonden. Installeer Node 20+ of herstel de gebundelde Codex-runtime.'
}

$online = $false
$health = $null
try {
    $health = Invoke-RestMethod -Uri "$uri/api/health" -TimeoutSec 1
} catch {
    # Er is nog geen bereikbare health-route; probeer de eigen server te starten.
}
if ($null -ne $health) {
    if (-not ($health.ok -and ($health.service -in @('AI Edit Studio', 'Game Trailer Studio')) -and $health.schemaVersion -ge 2)) {
        throw 'Deze poort heeft een andere/oudere server. Kies een vrije -Port.'
    }
    $online = $true
}

if (-not $online) {
    Start-Process -FilePath $node -ArgumentList @('"'+$server+'"') -WorkingDirectory $studioRoot -WindowStyle Hidden
    foreach ($attempt in 1..50) {
        Start-Sleep -Milliseconds 200
        try {
            $health = Invoke-RestMethod -Uri "$uri/api/health" -TimeoutSec 1
            if ($health.ok -and ($health.service -in @('AI Edit Studio', 'Game Trailer Studio')) -and $health.schemaVersion -ge 2) {
                $online = $true
                break
            }
        } catch {
            # De lokale server is nog aan het opstarten.
        }
    }
}

if (-not $online) {
    throw 'AI Edit Studio kon niet tijdig starten. Controleer of de poort vrij is en Node beschikbaar is.'
}

Start-Process $uri
