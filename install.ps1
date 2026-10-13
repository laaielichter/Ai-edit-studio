# AI Edit Studio installer for Windows (run via Install-AI-Edit-Studio.cmd). Safe to run again (upgrade/repair).
# -Unattended: no questions and no pause (scripts, CI); needs -DataRoot, never installs Node/FFmpeg itself.
# Extra arguments go to `node cli.mjs install` (e.g. -- --no-claude).
[CmdletBinding()]
param([string]$DataRoot, [switch]$Unattended, [Parameter(ValueFromRemainingArguments = $true)][string[]]$InstallArgs)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Write-Host ''
Write-Host 'AI Edit Studio - installer' -ForegroundColor Cyan
Write-Host 'Your footage stays on this computer. Nothing is uploaded.'
Write-Host ''

function Find-Node {
    $candidates = @((Join-Path $root 'vendor\node.exe'), (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1))
    $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

$node = Find-Node
if (-not $node -and -not $Unattended -and (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    if ((Read-Host 'Node.js 20+ is required. Install it now with winget? [Y/n]') -notmatch '^[nN]') {
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
        Refresh-Path; $node = Find-Node
    }
}
if (-not $node) {
    Write-Host 'Node.js 20 or newer is required: https://nodejs.org (LTS). Install it, then run this installer again.' -ForegroundColor Yellow
    if (-not $Unattended) { Start-Process 'https://nodejs.org/en/download'; Read-Host 'Press Enter to close' }
    exit 1
}

if (-not $Unattended -and -not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) -and (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    if ((Read-Host 'FFmpeg is required for analysis and rendering. Install it now with winget? [Y/n]') -notmatch '^[nN]') {
        winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
        Refresh-Path
    }
}

if (-not $DataRoot -and $Unattended) { Write-Host '-Unattended needs -DataRoot.' -ForegroundColor Yellow; exit 2 }
if (-not $DataRoot) {
    $default = if (Test-Path 'D:\') { 'D:\AI-Edit-Studio' } else { Join-Path $env:USERPROFILE 'AI-Edit-Studio' }
    $answer = Read-Host "Where should projects and renders be stored? (renders can be large) [$default]"
    $DataRoot = if ([string]::IsNullOrWhiteSpace($answer)) { $default } else { $answer.Trim().Trim('"') }
}

& $node (Join-Path $root 'cli.mjs') install --data-root $DataRoot @InstallArgs
$code = $LASTEXITCODE
if (-not $Unattended) { Write-Host ''; Read-Host 'Press Enter to close' }
exit $code
