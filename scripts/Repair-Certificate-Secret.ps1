$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TargetPattern = '(?i)(CN\s*=\s*FireClient LLC|O\s*=\s*FireClient LLC)'
$CodeSigningOid = '1.3.6.1.5.5.7.3.3'
$PfxContentType = [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx
$Flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor
         [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet

function Convert-SecureStringToPlainText([Security.SecureString]$Value) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Test-FireClientSigningCertificate($Certificate) {
    if ($null -eq $Certificate -or -not $Certificate.HasPrivateKey) { return $false }
    if ($Certificate.Subject -notmatch $TargetPattern) { return $false }
    if ($Certificate.Subject -eq $Certificate.Issuer) { return $false } # Reject self-signed certificates for a verified publisher.
    $now = Get-Date
    if ($Certificate.NotBefore -gt $now -or $Certificate.NotAfter -lt $now) { return $false }
    $ekuExtension = $Certificate.Extensions |
        Where-Object { $_.Oid.Value -eq '2.5.29.37' } |
        Select-Object -First 1
    if ($null -eq $ekuExtension) { return $false }
    $eku = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]$ekuExtension
    return @($eku.EnhancedKeyUsages | ForEach-Object { $_.Value }) -contains $CodeSigningOid
}

Write-Host ''
Write-Host 'FireClient certificate recovery helper' -ForegroundColor Cyan
Write-Host 'This helper never prints the PFX password or the Base64 certificate value.'
Write-Host 'It cannot recover a forgotten PFX password. It can re-export a matching certificate' -ForegroundColor Yellow
Write-Host 'if its private key is already installed in your Windows certificate store and exportable.' -ForegroundColor Yellow
Write-Host ''

$certificate = $null
$sourceDescription = $null
$storeCerts = @()
foreach ($storePath in @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\My')) {
    if (Test-Path $storePath) {
        foreach ($candidate in (Get-ChildItem -Path $storePath -ErrorAction SilentlyContinue)) {
            if (Test-FireClientSigningCertificate $candidate) {
                $storeCerts += $candidate
            }
        }
    }
}

# De-duplicate the same cert if installed in both stores, preferring CurrentUser\My.
$storeCerts = @($storeCerts | Sort-Object Thumbprint -Unique)
if ($storeCerts.Count -gt 0) {
    Write-Host 'Found eligible, non-self-signed FireClient LLC code-signing certificate(s):' -ForegroundColor Green
    for ($i = 0; $i -lt $storeCerts.Count; $i++) {
        $c = $storeCerts[$i]
        Write-Host ("[{0}] Subject: {1}" -f ($i + 1), $c.Subject)
        Write-Host ("    Issuer: {0}" -f $c.Issuer)
        Write-Host ("    Expires: {0:u} | Thumbprint: {1}" -f $c.NotAfter, $c.Thumbprint)
    }
    $pick = Read-Host 'Choose certificate number to re-export, or press Enter to use an existing PFX instead'
    if (-not [string]::IsNullOrWhiteSpace($pick)) {
        $index = 0
        if (-not [int]::TryParse($pick, [ref]$index) -or $index -lt 1 -or $index -gt $storeCerts.Count) {
            throw 'Invalid certificate selection.'
        }
        $certificate = $storeCerts[$index - 1]
        $sourceDescription = 'Windows certificate store'
    }
}

if ($null -eq $certificate) {
    $pfxPath = Read-Host 'Full path to your existing codesign.pfx (leave blank to cancel)'
    if ([string]::IsNullOrWhiteSpace($pfxPath)) {
        throw 'No usable certificate was selected. No files or secrets were changed.'
    }
    if (-not (Test-Path -LiteralPath $pfxPath -PathType Leaf)) {
        throw 'PFX file not found. Enter the full path to the actual .pfx file.'
    }
    $pfxPath = (Resolve-Path -LiteralPath $pfxPath).Path
    $pfxBytes = [IO.File]::ReadAllBytes($pfxPath)
    if ($pfxBytes.Length -lt 128 -or $pfxBytes[0] -ne 0x30) {
        throw 'The chosen file does not look like a binary PFX file.'
    }
    $oldPasswordSecure = Read-Host 'Current PFX password (input hidden)' -AsSecureString
    $oldPassword = Convert-SecureStringToPlainText $oldPasswordSecure
    try {
        $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxBytes, $oldPassword, $Flags)
    } catch {
        throw 'Windows could not open this PFX with the password provided. If you have forgotten the password and the private key is not installed in Windows, it cannot be reset; obtain a replacement/export from the certificate provider.'
    } finally {
        $oldPassword = $null
        $oldPasswordSecure.Dispose()
        if ($null -ne $pfxBytes) { [Array]::Clear($pfxBytes, 0, $pfxBytes.Length) }
    }
    if (-not (Test-FireClientSigningCertificate $certificate)) {
        $subject = $certificate.Subject
        $issuer = $certificate.Issuer
        $certificate.Dispose()
        throw "The PFX is not an eligible currently-valid, non-self-signed FireClient LLC code-signing certificate with a private key. Subject='$subject'; Issuer='$issuer'. Use the actual CA-issued code-signing certificate."
    }
    $sourceDescription = 'existing PFX'
}

$newPasswordSecure = Read-Host 'Choose a NEW strong PFX password. Remember it; you will save it as WINDOWS_CERTIFICATE_PASSWORD (input hidden)' -AsSecureString
if ($newPasswordSecure.Length -lt 1) { throw 'The new password cannot be empty.' }
$confirmPasswordSecure = Read-Host 'Type the NEW PFX password again (input hidden)' -AsSecureString
$newPassword = Convert-SecureStringToPlainText $newPasswordSecure
$confirmPassword = Convert-SecureStringToPlainText $confirmPasswordSecure
if ($newPassword -cne $confirmPassword) {
    $newPassword = $null; $confirmPassword = $null
    $newPasswordSecure.Dispose(); $confirmPasswordSecure.Dispose()
    throw 'The new passwords do not match. Run the helper again.'
}

$newPfxBytes = $null
$roundTrip = $null
$base64 = $null
try {
    if (-not $certificate.HasPrivateKey) { throw 'The selected certificate has no private key.' }
    $newPfxBytes = $certificate.Export($PfxContentType, $newPassword)
    if ($newPfxBytes.Length -lt 128 -or $newPfxBytes[0] -ne 0x30) { throw 'PFX export did not produce valid PFX bytes.' }
    $base64 = [Convert]::ToBase64String($newPfxBytes)
    # Round-trip check the encoded PFX format before copying it.
    $roundTrip = [Convert]::FromBase64String($base64)
    if ($roundTrip.Length -ne $newPfxBytes.Length -or $roundTrip[0] -ne 0x30) { throw 'Base64 round-trip validation failed.' }
    Set-Clipboard -Value $base64

    Write-Host ''
    Write-Host 'SUCCESS: a new password-protected PFX was generated in memory and its Base64 copied to the clipboard.' -ForegroundColor Green
    Write-Host ("Certificate subject: {0}" -f $certificate.Subject)
    Write-Host ("Certificate issuer:  {0}" -f $certificate.Issuer)
    Write-Host ("Certificate expires: {0:u}" -f $certificate.NotAfter)
    Write-Host ''
    Write-Host 'Next, in GitHub Settings > Secrets and variables > Actions:' -ForegroundColor Cyan
    Write-Host '1. Update WINDOWS_CERTIFICATE_BASE64 by pasting the clipboard contents.'
    Write-Host '2. Update WINDOWS_CERTIFICATE_PASSWORD with the NEW password you just typed.'
    Write-Host '3. Re-run Actions > Sign FireClient Setup and Publish.'
    Write-Host ''
    Write-Host 'The Base64 value is sensitive private-key material. Do not send it in chat or commit it to the repository.' -ForegroundColor Yellow
    Write-Host 'This helper does not upload secrets to GitHub or change any repository settings.'
} catch {
    throw ("Could not create the replacement PFX. {0} If this certificate came from the Windows certificate store, its private key may be marked non-exportable; contact the certificate provider for an exportable PFX or replacement certificate." -f $_.Exception.Message)
} finally {
    $newPassword = $null
    $confirmPassword = $null
    $newPasswordSecure.Dispose()
    $confirmPasswordSecure.Dispose()
    if ($null -ne $newPfxBytes) { [Array]::Clear($newPfxBytes, 0, $newPfxBytes.Length) }
    if ($null -ne $roundTrip) { [Array]::Clear($roundTrip, 0, $roundTrip.Length) }
    if ($null -ne $base64) { $base64 = $null }
    if ($null -ne $certificate -and $sourceDescription -eq 'existing PFX') { $certificate.Dispose() }
}
