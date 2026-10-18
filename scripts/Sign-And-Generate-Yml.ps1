$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Stop-WithError([string]$Message) {
    Write-Error $Message
    exit 1
}

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_BASE64)) {
    Stop-WithError 'Missing GitHub Actions secret WINDOWS_CERTIFICATE_BASE64. Add a valid code-signing PFX certificate as a Base64 secret.'
}
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)) {
    Stop-WithError 'WINDOWS_CERTIFICATE_PASSWORD is missing or empty. Set it to the exact password used to export the PFX; do not use your GitHub or Windows login password.'
}
if ([string]::IsNullOrWhiteSpace($env:RELEASE_VERSION) -or $env:RELEASE_VERSION -notmatch '^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$') {
    Stop-WithError "RELEASE_VERSION is missing or invalid: '$env:RELEASE_VERSION'"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceExe = Join-Path $repoRoot 'release/FireClient-Setup.exe'
$distDir = Join-Path $repoRoot 'dist'
$distExe = Join-Path $distDir 'FireClient-Setup.exe'
$latestYml = Join-Path $distDir 'latest.yml'
$certPath = Join-Path $env:RUNNER_TEMP 'fireclient-code-signing.pfx'

Write-Host 'Stage 1/5: Checking installer and certificate secret.'

if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    Stop-WithError "Installer not found: $sourceExe"
}

# GitHub Secrets must contain the Base64 text of the PFX FILE BYTES, not
# the PFX filename, password, or a PEM certificate. Remove line breaks/spaces
# to tolerate Base64 copied from tools that wrap long output.
$base64Text = $env:WINDOWS_CERTIFICATE_BASE64 -replace '\s', ''
if ([string]::IsNullOrWhiteSpace($base64Text)) {
    Stop-WithError 'WINDOWS_CERTIFICATE_BASE64 is empty. Encode the .pfx file bytes and save that text as the GitHub Actions secret.'
}
if ($base64Text -notmatch '^[A-Za-z0-9+/]*={0,2}$' -or ($base64Text.Length % 4) -ne 0) {
    $base64Error = "WINDOWS_CERTIFICATE_BASE64 is not valid standard Base64. The secret must contain the encoded bytes of the password-protected .pfx file, not the file path, PFX password, or a certificate PEM block.`nOn your own Windows computer, run: [Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\path\to\codesign.pfx')) | Set-Clipboard`nThen replace the GitHub Actions secret WINDOWS_CERTIFICATE_BASE64 with the clipboard contents. Do not commit or upload the PFX to your repository."
    Stop-WithError $base64Error
}
try {
    $pfxBytes = [Convert]::FromBase64String($base64Text)
} catch {
    Stop-WithError 'Could not decode WINDOWS_CERTIFICATE_BASE64. Recreate the secret from the actual .pfx file bytes.'
}
# PKCS#12/PFX files are DER-encoded ASN.1 sequences and normally start with 0x30.
if ($pfxBytes.Length -lt 128 -or $pfxBytes[0] -ne 0x30) {
    Stop-WithError 'The secret decoded, but does not look like a PKCS#12/PFX file. Re-encode the .pfx file itself, not a .cer/.pem file or its filename.'
}
[IO.File]::WriteAllBytes($certPath, $pfxBytes)
Write-Host 'Certificate PFX bytes decoded and written to the temporary runner directory.'

Write-Host 'Stage 2/5: Importing PFX and checking the private signing key.'
try {
    # Use .NET's explicit PFX import to validate the private key and surface a
    # more useful underlying error than Get-PfxCertificate's generic message.
    $pfxFlags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
        [byte[]]$pfxBytes,
        [string]$env:WINDOWS_CERTIFICATE_PASSWORD,
        $pfxFlags
    )
} catch {
    $reason = $_.Exception.Message
    $pfxImportError = "Could not open the PFX certificate. Most commonly WINDOWS_CERTIFICATE_PASSWORD is not the exact password used when the PFX was exported, or this PFX is damaged/incompatible. Re-export the certificate from its provider or run scripts/Repair-Certificate-Secret.ps1 locally if the matching private key is installed in Windows. Underlying import error: $reason"
    Stop-WithError $pfxImportError
}

$subject = [string]$certificate.Subject
$issuer = [string]$certificate.Issuer
$certificateThumbprint = ([string]$certificate.Thumbprint -replace '\s', '').ToUpperInvariant()
if ($subject -notmatch '(?i)(CN\s*=\s*FireClient LLC|O\s*=\s*FireClient LLC)') {
    Stop-WithError "Certificate subject is '$subject', not a certificate identifying FireClient LLC. Use the correct organization code-signing certificate."
}
if (-not $certificate.HasPrivateKey) {
    Stop-WithError 'The PFX does not contain a private signing key.'
}
Write-Host 'PFX imported successfully.'
$now = Get-Date
if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -lt $now) {
    Stop-WithError "Certificate is not currently valid. Valid from $($certificate.NotBefore) through $($certificate.NotAfter)."
}

# Do not open or modify the Windows certificate stores in CI. Store access can
# block on hosted runners. Instead, validate the pinned test certificate here,
# then permit only the narrowly scoped SignTool untrusted-root fallback below.
$allowSelfSigned = $env:ALLOW_UNTRUSTED_SELF_SIGNED_CERTIFICATE -eq 'true'
$expectedThumbprint = ([string]$env:EXPECTED_SIGNING_CERT_THUMBPRINT -replace '\s', '').ToUpperInvariant()
$certificateThumbprint = ([string]$certificate.Thumbprint -replace '\s', '').ToUpperInvariant()

Write-Host 'Stage 3/5: Checking pinned certificate configuration without touching the Windows trust store.'
if ($allowSelfSigned) {
    if ([string]::IsNullOrWhiteSpace($expectedThumbprint) -or $certificateThumbprint -ne $expectedThumbprint) {
        Stop-WithError "Refusing test release: PFX thumbprint $certificateThumbprint does not match EXPECTED_SIGNING_CERT_THUMBPRINT."
    }
    Write-Warning 'Test-only mode enabled for the exact pinned self-signed certificate. This does NOT make FireClient trusted on customer PCs.'
} elseif (-not [string]::IsNullOrWhiteSpace($expectedThumbprint) -and $certificateThumbprint -eq $expectedThumbprint) {
    Stop-WithError 'The configured certificate is the pinned self-signed test certificate, but ALLOW_UNTRUSTED_SELF_SIGNED_CERTIFICATE is not enabled.'
}
if ($certificate -is [System.IDisposable]) { $certificate.Dispose() }
Write-Host 'Pinned certificate check passed.'

Write-Host 'Stage 4/5: Locating Windows SDK SignTool.'
$sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$signtool = $null
if (Test-Path -LiteralPath $sdkBin -PathType Container) {
    # SignTool normally lives directly in <SDK version>\x64\signtool.exe.
    # Search only version folders rather than recursively walking every SDK file.
    $sdkVersions = Get-ChildItem -LiteralPath $sdkBin -Directory -ErrorAction SilentlyContinue |
        Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending
    foreach ($sdkVersion in $sdkVersions) {
        foreach ($architecture in @('x64', 'x86')) {
            $candidate = Join-Path $sdkVersion.FullName (Join-Path $architecture 'signtool.exe')
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $signtool = Get-Item -LiteralPath $candidate
                break
            }
        }
        if ($null -ne $signtool) { break }
    }
}
if ($null -eq $signtool) {
    Stop-WithError "Windows SDK SignTool was not found in the SDK version folders under '$sdkBin'."
}
Write-Host "Found SignTool: $($signtool.FullName)"

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
Copy-Item -LiteralPath $sourceExe -Destination $distExe -Force

Write-Host 'Stage 5/5: Signing installer.'
Write-Host "Signing installer with certificate subject: $subject"
& $signtool.FullName sign /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 /f $certPath /p $env:WINDOWS_CERTIFICATE_PASSWORD /d 'FireClient Launcher' /du 'https://www.fireclient.net' $distExe
if ($LASTEXITCODE -ne 0) {
    Stop-WithError "SignTool sign failed with exit code $LASTEXITCODE."
}

Write-Host 'Verifying Authenticode signature...'
$verifyOutput = @(& $signtool.FullName verify /pa /all /v $distExe 2>&1)
$verifyExitCode = $LASTEXITCODE
$verifyText = (($verifyOutput -join "`n") -replace '\s+', ' ')
$verifyOutput | ForEach-Object { Write-Host $_ }

if ($verifyExitCode -ne 0) {
    # Permit only the expected untrusted-root failure for this exact test signer.
    # Parse the signer SHA1 directly from SignTool output instead of calling
    # Get-AuthenticodeSignature, which can block during online chain/revocation checks.
    # SignTool error messages may be multi-line and can interleave with stdout verbose lines
    # when captured via 2>&1. We inspect pure ErrorRecord objects from stderr as well as
    # flexible regex patterns over the combined output.
    $errorRecords = @($verifyOutput | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() })
    $errorRecordText = (($errorRecords -join ' ') -replace '\s+', ' ')
    $hasUntrustedRootInStderr = $errorRecordText -match '(?i)A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider'
    $hasUntrustedRootInCombined = ($verifyText -match '(?i)A certificate chain processed,\s*but terminated in a root.*?certificate which is not trusted by the trust provider') -or
                                  (($verifyText -match '(?i)terminated in a root') -and ($verifyText -match '(?i)certificate which is not trusted by the trust provider'))
    $onlyUntrustedRoot = $hasUntrustedRootInStderr -or $hasUntrustedRootInCombined
    $signToolErrorCount = [regex]::Matches($verifyText, '(?i)SignTool Error:').Count
    $singleReportedError = $verifyText -match '(?i)Number of errors:\s*1' -and $signToolErrorCount -eq 1
    $signingChainMatch = [regex]::Match($verifyText, '(?i)Signing Certificate Chain:(.*?)(?:The signature is timestamped|Timestamp Verified by:|Number of signatures)')
    $signingChainSection = $signingChainMatch.Groups[1].Value
    $signingHashMatch = [regex]::Match($signingChainSection, '(?i)SHA1 hash:\s*([A-F0-9]{40})')
    $actualSignerThumbprint = $signingHashMatch.Groups[1].Value.ToUpperInvariant()
    $signerMatchesPfx = -not [string]::IsNullOrWhiteSpace($actualSignerThumbprint) -and $actualSignerThumbprint -eq $certificateThumbprint
    $thumbprintIsPinned = -not [string]::IsNullOrWhiteSpace($expectedThumbprint) -and $actualSignerThumbprint -eq $expectedThumbprint
    $timestampPresent = $verifyText -match '(?i)The signature is timestamped' -and $verifyText -match '(?i)Timestamp Verified by:'

    if ($allowSelfSigned -and $onlyUntrustedRoot -and $singleReportedError -and $signerMatchesPfx -and $thumbprintIsPinned -and $timestampPresent) {
        Write-Warning 'SignTool reports exactly one error: the untrusted root of the exact pinned self-signed test certificate.'
        Write-Warning 'Continuing with test-release metadata only. Windows will NOT treat this as a trusted publisher.'
        # SignTool's expected test-only verification failure leaves LASTEXITCODE=1.
        # GitHub Actions' PowerShell wrapper propagates the final LASTEXITCODE even
        # after this script has handled the one permitted condition. Clear it here
        # only after all pinned-certificate and timestamp checks have passed.
        $global:LASTEXITCODE = 0
        Write-Host 'Accepted the narrowly scoped test-only verification fallback; clearing native exit status.'
    } else {
        $verificationError = "SignTool verification failed with exit code $verifyExitCode.`nOnly expected untrusted-root fallback: $($allowSelfSigned -and $onlyUntrustedRoot -and $singleReportedError -and $signerMatchesPfx -and $thumbprintIsPinned -and $timestampPresent)`nUntrusted-root error: $onlyUntrustedRoot`nSingle error: $singleReportedError`nSigner SHA1: $actualSignerThumbprint`nPFX SHA1: $certificateThumbprint`nPinned SHA1: $expectedThumbprint`nTimestamp details found: $timestampPresent"
        Stop-WithError $verificationError
    }
}

# Generate the updater checksum only AFTER signing; Authenticode changes the EXE bytes.
$sha = [Security.Cryptography.SHA512]::Create()
try {
    $stream = [IO.File]::OpenRead($distExe)
    try { $sha512 = [Convert]::ToBase64String($sha.ComputeHash($stream)) }
    finally { $stream.Dispose() }
} finally {
    $sha.Dispose()
}
$size = (Get-Item -LiteralPath $distExe).Length
$releaseDate = [DateTime]::UtcNow.ToString("o")
$version = $env:RELEASE_VERSION

# Modern electron-updater files[] format. This YAML contains a SHA-512 integrity
# hash; it is not, by itself, an Ed25519-signed update manifest.
$manifest = @"
version: "$version"
files:
  - url: "FireClient-Setup.exe"
    sha512: "$sha512"
    size: $size
releaseDate: "$releaseDate"
"@
[IO.File]::WriteAllText($latestYml, $manifest + "`n", [Text.UTF8Encoding]::new($false))

# Read the output back and assert its SHA-512 is the hash of the signed EXE.
$check = [Convert]::ToBase64String([Security.Cryptography.SHA512]::HashData([IO.File]::ReadAllBytes($distExe)))
if ($check -ne $sha512) {
    Stop-WithError "Generated latest.yml hash verification failed."
}

Write-Host "Installer signature checked; generated updater metadata for: $distExe"
Write-Host "Generated updater metadata: $latestYml"
Write-Host "Version: $version | Size: $size bytes | SHA-512: $sha512"
Remove-Item -LiteralPath $certPath -Force -ErrorAction SilentlyContinue

# Ensure successful script completion is not marked failed by a handled native command.
$global:LASTEXITCODE = 0
