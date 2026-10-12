$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Write-Host 'FireClient code-signing PFX preflight' -ForegroundColor Cyan
Write-Host 'The PFX and its password stay on this computer. This script does not print or save the Base64 value.'

$pfxPath = Read-Host 'Full path to your password-protected .pfx file'
if ([string]::IsNullOrWhiteSpace($pfxPath) -or -not (Test-Path -LiteralPath $pfxPath -PathType Leaf)) {
    throw 'PFX file not found. Enter the full path to the actual .pfx file.'
}
$pfxPath = (Resolve-Path -LiteralPath $pfxPath).Path
$pfxBytes = [IO.File]::ReadAllBytes($pfxPath)
if ($pfxBytes.Length -lt 128 -or $pfxBytes[0] -ne 0x30) {
    throw 'The selected file does not look like a binary PKCS#12/PFX file.'
}

$password = Read-Host 'PFX password (input is hidden)' -AsSecureString
try {
    $certificate = Get-PfxCertificate -FilePath $pfxPath -Password $password -ErrorAction Stop
} catch {
    throw 'Windows could not open the PFX. Check the password and confirm the file is a valid PFX.'
}
if ($null -eq $certificate) { throw 'No certificate was found in the PFX.' }

Write-Host ("Certificate subject: {0}" -f $certificate.Subject)
Write-Host ("Valid from: {0:u}" -f $certificate.NotBefore)
Write-Host ("Valid until: {0:u}" -f $certificate.NotAfter)
if ($certificate.Subject -notmatch '(?i)(CN\s*=\s*FireClient LLC|O\s*=\s*FireClient LLC)') {
    throw 'The certificate subject does not identify FireClient LLC. Use a certificate legitimately issued to your publishing entity.'
}
$now = Get-Date
if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -lt $now) {
    throw 'The certificate is not currently valid.'
}

$base64 = [Convert]::ToBase64String($pfxBytes)
try {
    Set-Clipboard -Value $base64
} catch {
    throw 'Could not copy to clipboard. Run this script in Windows PowerShell or PowerShell on Windows.'
}
Write-Host ''
Write-Host 'PFX opened and Base64 copied to clipboard. The secret was not printed.' -ForegroundColor Green
Write-Host 'In GitHub, open Settings > Secrets and variables > Actions.'
Write-Host 'Replace WINDOWS_CERTIFICATE_BASE64 with the clipboard contents.'
Write-Host 'Set WINDOWS_CERTIFICATE_PASSWORD separately to the PFX password.'
Write-Host 'Never put either value into a repository file, commit, issue, or workflow log.' -ForegroundColor Yellow
