param(
    [string]$Thumbprint = '91CECD221349B375AF5CBE1FC138015705C9FBC7'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 1. Require Administrator elevation
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator elevation to remove certificate from Windows Trust Store..." -ForegroundColor Yellow
    Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Thumbprint', "`"$Thumbprint`"") -Verb RunAs
    exit 0
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Remove FireClient Publisher Certificate from Windows" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Target Thumbprint: $Thumbprint"
Write-Host ''

$targetThumb = ($Thumbprint -replace '\s', '').ToUpperInvariant()
$stores = @('Root', 'TrustedPublisher')
$removedCount = 0

foreach ($storeName in $stores) {
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new($storeName, [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try {
        $matches = $store.Certificates | Where-Object { $_.Thumbprint.ToUpperInvariant() -eq $targetThumb -or $_.Subject -match 'CN=FireClient' }
        foreach ($cert in $matches) {
            Write-Host "  [-] Removing from LocalMachine\$storeName : $($cert.Subject) ($($cert.Thumbprint))" -ForegroundColor Yellow
            $store.Remove($cert)
            $removedCount++
        }
    } finally {
        $store.Close()
    }
}

if ($removedCount -gt 0) {
    Write-Host ''
    Write-Host "Removed $removedCount certificate(s) from Windows store." -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host "No matching certificates were found in Windows LocalMachine store." -ForegroundColor Gray
}

Write-Host "==========================================================" -ForegroundColor Cyan
