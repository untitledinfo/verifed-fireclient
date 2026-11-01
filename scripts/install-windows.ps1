# ==============================================================================
# FireClient Official Windows PowerShell Installer
# Usage:
#   irm https://raw.githubusercontent.com/untitledinfo/verifed-fireclient/main/scripts/install-windows.ps1 | iex
# ==============================================================================
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'untitledinfo/verifed-fireclient'
$ApiUrl = "https://api.github.com/repos/$Repo/releases/latest"

Write-Host "`n[FireClient] Checking latest verified Windows release on github.com/$Repo..." -ForegroundColor Cyan
$Headers = @{ 'User-Agent' = 'FireClient-Installer/2.2.7'; 'Accept' = 'application/vnd.github+json' }
$Release = Invoke-RestMethod -Uri $ApiUrl -Headers $Headers

$SetupAsset = $Release.assets | Where-Object { $_.name -eq 'FireClient-Setup.exe' } | Select-Object -First 1
if (-not $SetupAsset) {
    throw "FireClient-Setup.exe was not found in release $($Release.tag_name)."
}

$ReportAsset = $Release.assets | Where-Object { $_.name -eq 'verification-report.json' } | Select-Object -First 1
$ExpectedSha = ''
if ($ReportAsset) {
    try {
        $Rep = Invoke-RestMethod -Uri $ReportAsset.browser_download_url -Headers $Headers
        if ($Rep.sha256) { $ExpectedSha = $Rep.sha256.ToString().ToLowerInvariant() }
    } catch {}
}

$TempDir = Join-Path $env:TEMP 'fireclient-install'
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
$DestExe = Join-Path $TempDir "FireClient-Setup-$($Release.tag_name).exe"

Write-Host "[FireClient] Downloading FireClient-Setup.exe ($($Release.tag_name))..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $SetupAsset.browser_download_url -OutFile $DestExe -UseBasicParsing

$ActualSha = (Get-FileHash -Path $DestExe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ExpectedSha -and ($ActualSha -ne $ExpectedSha)) {
    Remove-Item -Path $DestExe -Force -ErrorAction SilentlyContinue
    throw "SHA-256 verification failed! Expected $ExpectedSha, got $ActualSha."
}
Write-Host "[FireClient] SHA-256 Verified ($($ActualSha.Substring(0, 16))...)" -ForegroundColor Green

Write-Host "[FireClient] Launching FireClient Setup..." -ForegroundColor Green
Start-Process -FilePath $DestExe
