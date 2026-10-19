param(
    [string]$SourcePath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot

# 1. Require Administrator elevation for LocalMachine certificate stores
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator elevation to install publisher certificate into Windows Trust Store..." -ForegroundColor Yellow
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if (-not [string]::IsNullOrWhiteSpace($SourcePath)) {
        $argList += @('-SourcePath', "`"$SourcePath`"")
    }
    Start-Process powershell.exe -ArgumentList $argList -Verb RunAs
    exit 0
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " FireClient Publisher Trust Installation (Local Machine)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 2. Locate certificate
$cert = $null

if (-not [string]::IsNullOrWhiteSpace($SourcePath) -and (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    $resolved = (Resolve-Path -LiteralPath $SourcePath).Path
    Write-Host "Inspecting provided source: $resolved"
    if ($resolved -match '(?i)\.exe$') {
        $auth = Get-AuthenticodeSignature -LiteralPath $resolved
        if ($null -ne $auth.SignerCertificate) {
            $cert = $auth.SignerCertificate
            Write-Host "Found embedded Authenticode certificate in executable."
        }
    } elseif ($resolved -match '(?i)\.(cer|crt)$') {
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($resolved)
        Write-Host "Loaded certificate from file."
    } elseif ($resolved -match '(?i)\.pfx$') {
        $pw = Read-Host 'Enter PFX password' -AsSecureString
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($resolved, $pw, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)
        Write-Host "Loaded certificate from PFX."
    }
}

if ($null -eq $cert) {
    # Check default locations: dist/FireClient-Setup.exe or release/FireClient-Setup.exe
    $candidates = @(
        (Join-Path $repoRoot 'dist\FireClient-Setup.exe'),
        (Join-Path $repoRoot 'release\FireClient-Setup.exe')
    )
    foreach ($cand in $candidates) {
        if (Test-Path -LiteralPath $cand -PathType Leaf) {
            $auth = Get-AuthenticodeSignature -LiteralPath $cand
            if ($null -ne $auth.SignerCertificate) {
                $cert = $auth.SignerCertificate
                Write-Host "Found embedded Authenticode certificate in: $cand"
                break
            }
        }
    }
}

# If still null and WINDOWS_CERTIFICATE_BASE64 exists in environment
if ($null -eq $cert -and -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_BASE64)) {
    try {
        $b64 = $env:WINDOWS_CERTIFICATE_BASE64 -replace '\s', ''
        $bytes = [Convert]::FromBase64String($b64)
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes, $env:WINDOWS_CERTIFICATE_PASSWORD, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
        Write-Host "Loaded certificate from environment Base64 secret."
    } catch {
        Write-Warning "Could not decode certificate from environment variable: $($_.Exception.Message)"
    }
}

if ($null -eq $cert) {
    Write-Host ''
    Write-Host "No signed executable or certificate file was automatically found." -ForegroundColor Yellow
    Write-Host "Options:"
    Write-Host "1. Build and sign dist\FireClient-Setup.exe first."
    Write-Host "2. Provide a path: .\scripts\Install-Local-Publisher-Trust.ps1 -SourcePath 'C:\path\to\codesign.cer'"
    Write-Host "3. Or run 'scripts\Repair-Certificate-Secret.ps1' to export your certificate."
    Write-Host ''
    pause
    exit 1
}

$thumbprint = ([string]$cert.Thumbprint -replace '\s', '').ToUpperInvariant()
$subject = $cert.Subject
$issuer = $cert.Issuer

Write-Host "Certificate Details:" -ForegroundColor Green
Write-Host "  Subject:    $subject"
Write-Host "  Issuer:     $issuer"
Write-Host "  Thumbprint: $thumbprint"
Write-Host "  Valid to:   $($cert.NotAfter.ToString('u'))"
Write-Host ''

# 3. Export public certificate bytes only (Never private keys)
$publicCertBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
$publicCert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($publicCertBytes)

# 4. Import into TrustedPublisher and Root
$stores = @(
    @{ Name = 'Root'; Path = 'Cert:\LocalMachine\Root'; Desc = 'Trusted Root Certification Authorities' },
    @{ Name = 'TrustedPublisher'; Path = 'Cert:\LocalMachine\TrustedPublisher'; Desc = 'Trusted Publishers' }
)

foreach ($s in $stores) {
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new($s.Name, [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try {
        $existing = $store.Certificates | Where-Object { $_.Thumbprint -eq $thumbprint }
        if ($existing.Count -eq 0) {
            $store.Add($publicCert)
            Write-Host "  [+] Added to $($s.Desc) ($($s.Name))" -ForegroundColor Green
        } else {
            Write-Host "  [=] Already present in $($s.Desc) ($($s.Name))" -ForegroundColor Gray
        }
    } finally {
        $store.Close()
    }
}

Write-Host ''
Write-Host "SUCCESS: FireClient publisher certificate is now trusted on this Windows computer!" -ForegroundColor Green
Write-Host ''
Write-Host "Effects on this PC:" -ForegroundColor Cyan
Write-Host "  - Windows UAC will show:   Verified publisher: FireClient LLC (Blue Banner)"
Write-Host "  - 'Show more details':     Displays valid certificate chain"
Write-Host "  - SmartScreen:             Allows immediate launch without unknown-publisher warning"
Write-Host ''
Write-Host "To remove trust later, run scripts\Uninstall-Local-Publisher-Trust.ps1"
Write-Host "==========================================================" -ForegroundColor Cyan
