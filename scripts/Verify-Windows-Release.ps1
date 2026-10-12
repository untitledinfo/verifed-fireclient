$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repoRoot 'dist/FireClient-Setup.exe'
$reportPath = Join-Path $repoRoot 'dist/verification-report.json'

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Signed installer not found: $installer"
}

Write-Host 'Stage 1/3: Read the embedded Authenticode publisher identity.'
# Read the signer certificate and Windows Authenticode trust state separately.
# This never labels an untrusted/self-signed signer as a Verified Publisher.
$auth = Get-AuthenticodeSignature -LiteralPath $installer
if ($null -eq $auth.SignerCertificate) {
    throw 'The installer does not contain an Authenticode signer certificate.'
}
$cert = $auth.SignerCertificate
$thumbprint = ([string]$cert.Thumbprint -replace '\s', '').ToUpperInvariant()
$expectedThumbprint = ([string]$env:EXPECTED_SIGNING_CERT_THUMBPRINT -replace '\s', '').ToUpperInvariant()
$isPinnedTestCert = -not [string]::IsNullOrWhiteSpace($expectedThumbprint) -and $thumbprint -eq $expectedThumbprint
if ($env:ALLOW_UNTRUSTED_SELF_SIGNED_CERTIFICATE -eq 'true' -and -not $isPinnedTestCert) {
    throw "Test mode was enabled, but the signed installer thumbprint ($thumbprint) does not match the pinned test thumbprint."
}

$publisherName = $cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
$orgMatch = [regex]::Match([string]$cert.Subject, '(?i)(?:^|,\s*)O\s*=\s*([^,]+)')
$organization = if ($orgMatch.Success) { $orgMatch.Groups[1].Value.Trim() } else { '' }
$trustedByWindows = ([string]$auth.Status -eq 'Valid')
Write-Host "Publisher display name from certificate: $publisherName"
Write-Host "Organization in certificate subject: $organization"
Write-Host "Windows Authenticode trust status: $($auth.Status)"
if ($isPinnedTestCert) {
    Write-Warning 'This release uses the pinned test certificate. Windows does NOT consider it a Verified Publisher; a public CA-issued certificate is required.'
}

Write-Host 'Stage 2/3: Locate Microsoft Defender Antivirus scan utility.'
$mpCmd = $null
$platformRoot = Join-Path $env:ProgramData 'Microsoft/Windows Defender/Platform'
if (Test-Path -LiteralPath $platformRoot -PathType Container) {
    $platforms = Get-ChildItem -LiteralPath $platformRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending
    foreach ($platform in $platforms) {
        $candidate = Join-Path $platform.FullName 'MpCmdRun.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $mpCmd = Get-Item -LiteralPath $candidate
            break
        }
    }
}
if ($null -eq $mpCmd) {
    $fallback = Join-Path $env:ProgramFiles 'Windows Defender/MpCmdRun.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) {
        $mpCmd = Get-Item -LiteralPath $fallback
    }
}
if ($null -eq $mpCmd) {
    throw 'Microsoft Defender MpCmdRun.exe was not found. Refusing to claim that the release was scanned.'
}
Write-Host "Using Microsoft Defender scan utility: $($mpCmd.FullName)"

Write-Host 'Stage 3/3: Scan the signed installer with Microsoft Defender.'
Write-Host "Scanning: $installer"
# Custom scan (type 3) scans the specified installer. -DisableRemediation ensures
# CI reports detections without attempting to alter the build artifact; detections
# or scan errors produce a non-zero result and block publication.
& $mpCmd.FullName -Scan -ScanType 3 -File $installer -DisableRemediation
$scanExitCode = $LASTEXITCODE
if ($scanExitCode -ne 0) {
    throw "Microsoft Defender scan did not return clean status (exit code $scanExitCode). Release publication is blocked. Review the scan output and investigate any detection; do not blindly whitelist the installer."
}
Write-Host 'Microsoft Defender custom scan completed with exit code 0.'

$sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
$sha512 = [Convert]::ToBase64String([Security.Cryptography.SHA512]::HashData([IO.File]::ReadAllBytes($installer)))
$size = (Get-Item -LiteralPath $installer).Length
$trustNote = if ($isPinnedTestCert) {
    'Pinned test certificate; Windows Verified Publisher trust is NOT established.'
} elseif ($trustedByWindows) {
    'Windows Authenticode reports Valid. SmartScreen may still warn until reputation is established.'
} else {
    'Windows Authenticode did not report Valid; do not describe this as a Verified Publisher.'
}
$report = [ordered]@{
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    installer = 'FireClient-Setup.exe'
    fileSizeBytes = $size
    sha256 = $sha256
    sha512 = $sha512
    publisher = [ordered]@{
        displayName = $publisherName
        organization = $organization
        certificateSubject = [string]$cert.Subject
        issuer = [string]$cert.Issuer
        thumbprint = $thumbprint
        authenticodeStatus = [string]$auth.Status
        trustedByWindows = $trustedByWindows
        trustNote = $trustNote
    }
    microsoftDefender = [ordered]@{
        scanType = 'CustomScan'
        scanner = $mpCmd.FullName
        exitCode = $scanExitCode
        result = 'Clean exit; no unresolved detection or scan error reported by MpCmdRun.'
    }
}
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 6) + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "Security report generated: $reportPath"
Write-Host "SHA-256: $sha256"
Write-Host "SHA-512: $sha512"
