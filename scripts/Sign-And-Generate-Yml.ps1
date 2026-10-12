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

# The supplied workflow log identifies a self-signed development certificate.
# SignTool correctly rejects that chain on a clean GitHub runner. For build-only
# testing, temporarily trust ONLY this exact pinned self-signed certificate in
# the current user's root store. This trust exists only on the ephemeral runner;
# it does not make the EXE trusted on users' PCs or create a Verified Publisher.
$temporaryRootCertificateAdded = $false
$allowSelfSigned = $env:ALLOW_UNTRUSTED_SELF_SIGNED_CERTIFICATE -eq 'true'
$expectedThumbprint = ([string]$env:EXPECTED_SIGNING_CERT_THUMBPRINT -replace '\s', '').ToUpperInvariant()

# The observed FireClient development certificate reports the signer name as
# "FireClient" while its full subject also contains O=FireClient LLC and C=US.
# Comparing the complete Subject and Issuer strings therefore is not a reliable
# self-signed test. In this workflow, trust is allowed ONLY when the actual PFX
# thumbprint exactly matches the hard-pinned value and the opt-in is enabled.
Write-Host 'Stage 3/5: Checking certificate trust configuration.'
if ($allowSelfSigned) {
    if ([string]::IsNullOrWhiteSpace($expectedThumbprint) -or $certificateThumbprint -ne $expectedThumbprint) {
        Stop-WithError "Refusing to trust certificate thumbprint $certificateThumbprint because it does not exactly match EXPECTED_SIGNING_CERT_THUMBPRINT."
    }

    $publicCert = $null
    $rootStore = $null
    try {
        $publicCertBytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
        $publicCert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([byte[]]$publicCertBytes)
        $rootStore = [System.Security.Cryptography.X509Certificates.X509Store]::new(
            [System.Security.Cryptography.X509Certificates.StoreName]::Root,
            [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
        )
        $rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $alreadyTrusted = $rootStore.Certificates.Find(
            [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
            $certificateThumbprint,
            $false
        )
        if ($alreadyTrusted.Count -eq 0) {
            $rootStore.Add($publicCert)
            $temporaryRootCertificateAdded = $true
            Write-Warning 'Temporarily trusted the exact pinned FireClient test certificate in the disposable GitHub runner. This does NOT make the publisher trusted on end-user devices.'
        } else {
            Write-Host 'Exact pinned FireClient test certificate is already in the current-user root store.'
        }
    } catch {
        Stop-WithError "Could not temporarily trust the exact pinned certificate on this runner: $($_.Exception.Message)"
    } finally {
        if ($null -ne $rootStore) { $rootStore.Close() }
        if ($null -ne $publicCert) { $publicCert.Dispose() }
    }
} elseif ($certificateThumbprint -eq $expectedThumbprint -and -not [string]::IsNullOrWhiteSpace($expectedThumbprint)) {
    Stop-WithError 'This is the pinned self-signed FireClient test certificate, but ALLOW_UNTRUSTED_SELF_SIGNED_CERTIFICATE is not enabled. Do not use this test setting for production releases.'
}
if ($certificate -is [System.IDisposable]) { $certificate.Dispose() }
Write-Host 'Certificate trust configuration checked.'

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
& $signtool.FullName sign /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 /f $certPath /p $env:WINDOWS_CERTIFICATE_PASSWORD /d 'FireClient' /du 'https://www.fireclient.net' $distExe
if ($LASTEXITCODE -ne 0) {
    Stop-WithError "SignTool sign failed with exit code $LASTEXITCODE."
}

Write-Host 'Verifying Authenticode signature...'
$verifyOutput = @(& $signtool.FullName verify /pa /all /v $distExe 2>&1)
$verifyExitCode = $LASTEXITCODE
$verifyText = (($verifyOutput -join "`n") -replace '\s+', ' ')
$verifyOutput | ForEach-Object { Write-Host $_ }

if ($verifyExitCode -ne 0) {
    # Fail closed except for the one narrowly permitted case: an authentic,
    # timestamped signature from the exact pinned self-signed PFX certificate,
    # where SignTool reports only the untrusted-root chain error, after attempting
    # to trust the exact pinned development certificate in the runner's root store.
    $authenticode = Get-AuthenticodeSignature -FilePath $distExe
    $actualSignerThumbprint = ''
    if ($null -ne $authenticode.SignerCertificate) {
        $actualSignerThumbprint = ([string]$authenticode.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
    }
    $onlyUntrustedRoot = $verifyText -match '(?i)A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider'
    $signToolErrorCount = [regex]::Matches($verifyText, '(?i)SignTool Error:').Count
    $singleReportedError = $verifyText -match '(?i)Number of errors:\s*1' -and $signToolErrorCount -eq 1
    # Exact thumbprint pin below is the test-certificate identity check; do not
    # compare Subject and Issuer text because X.500 name formatting may differ.
    $signerMatchesPfx = $actualSignerThumbprint -eq $certificateThumbprint
    $thumbprintIsPinned = -not [string]::IsNullOrWhiteSpace($expectedThumbprint) -and $actualSignerThumbprint -eq $expectedThumbprint
    $timestampPresent = $verifyText -match '(?i)The signature is timestamped' -and $verifyText -match '(?i)Timestamp Verified by:'
    $statusIsOnlyTrustIssue = ([string]$authenticode.Status -in @('NotTrusted', 'UnknownError')) -and ($authenticode.StatusMessage -match '(?i)not trusted|untrusted root|trust provider|certificate chain')

    if ($allowSelfSigned -and $onlyUntrustedRoot -and $singleReportedError -and $signerMatchesPfx -and $thumbprintIsPinned -and $timestampPresent -and $statusIsOnlyTrustIssue) {
        Write-Warning 'SignTool still reports only an untrusted-root issue for the exact pinned test certificate.'
        Write-Warning 'Proceeding with test-release metadata only; this installer is NOT trusted by default on end-user devices.'
    } else {
        $verificationError = "SignTool verification failed with exit code $verifyExitCode. Refusing to publish unless the only issue is the untrusted root for the exact pinned FireClient test certificate.`nSigner status: $($authenticode.Status) - $($authenticode.StatusMessage)`nPFX certificate thumbprint: $certificateThumbprint`nActual signer thumbprint: $actualSignerThumbprint`nExpected pinned thumbprint: $expectedThumbprint`nFallback enabled: $allowSelfSigned"
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

# Remove the temporary trust anchor after signature verification. GitHub-hosted
# runners are ephemeral as an additional cleanup boundary.
if ($temporaryRootCertificateAdded) {
    $cleanupStore = $null
    try {
        $cleanupStore = [System.Security.Cryptography.X509Certificates.X509Store]::new(
            [System.Security.Cryptography.X509Certificates.StoreName]::Root,
            [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
        )
        $cleanupStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $temporaryRoots = $cleanupStore.Certificates.Find(
            [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
            $certificateThumbprint,
            $false
        )
        foreach ($temporaryRoot in $temporaryRoots) {
            $cleanupStore.Remove($temporaryRoot)
            $temporaryRoot.Dispose()
        }
    } catch {
        Write-Warning "Could not remove temporary root certificate from runner: $($_.Exception.Message)"
    } finally {
        if ($null -ne $cleanupStore) { $cleanupStore.Close() }
    }
}

Write-Host "Installer signature checked; generated updater metadata for: $distExe"
Write-Host "Generated updater metadata: $latestYml"
Write-Host "Version: $version | Size: $size bytes | SHA-512: $sha512"
Remove-Item -LiteralPath $certPath -Force -ErrorAction SilentlyContinue
