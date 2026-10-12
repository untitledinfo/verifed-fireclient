$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Stop-WithError([string]$Message) {
    Write-Error $Message
    exit 1
}

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_BASE64)) {
    Stop-WithError 'Missing GitHub Actions secret WINDOWS_CERTIFICATE_BASE64. Add a valid code-signing PFX certificate as a Base64 secret.'
}
if ($null -eq $env:WINDOWS_CERTIFICATE_PASSWORD) {
    Stop-WithError 'Missing GitHub Actions secret WINDOWS_CERTIFICATE_PASSWORD.'
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

if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    Stop-WithError "Installer not found: $sourceExe"
}

try {
    $pfxBytes = [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64.Trim())
    [IO.File]::WriteAllBytes($certPath, $pfxBytes)
} catch {
    Stop-WithError 'WINDOWS_CERTIFICATE_BASE64 is not valid Base64-encoded PFX data.'
}

$securePassword = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
try {
    $certificate = Get-PfxCertificate -FilePath $certPath -Password $securePassword
} catch {
    Stop-WithError 'Could not open the PFX certificate. Check the certificate file and password.'
}

$subject = [string]$certificate.Subject
if ($subject -notmatch '(?i)(CN\s*=\s*FireClient LLC|O\s*=\s*FireClient LLC)') {
    Stop-WithError "Certificate subject is '$subject', not a certificate identifying FireClient LLC. Use the correct organization code-signing certificate."
}
if (-not $certificate.HasPrivateKey) {
    Stop-WithError 'The PFX does not contain a private signing key.'
}
$now = Get-Date
if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -lt $now) {
    Stop-WithError "Certificate is not currently valid. Valid from $($certificate.NotBefore) through $($certificate.NotAfter)."
}

$sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$signtool = Get-ChildItem -LiteralPath $sdkBin -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '[\\/]x64[\\/]signtool\.exe$' } |
    Sort-Object { try { [version]$_.Directory.Parent.Name } catch { [version]'0.0' } } -Descending |
    Select-Object -First 1
if ($null -eq $signtool) {
    Stop-WithError 'Windows SDK SignTool was not found on this runner.'
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
Copy-Item -LiteralPath $sourceExe -Destination $distExe -Force

Write-Host "Signing installer with certificate subject: $subject"
& $signtool.FullName sign /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 /f $certPath /p $env:WINDOWS_CERTIFICATE_PASSWORD /d 'FireClient' /du 'https://www.fireclient.net' $distExe
if ($LASTEXITCODE -ne 0) {
    Stop-WithError "SignTool sign failed with exit code $LASTEXITCODE."
}

Write-Host 'Verifying Authenticode signature...'
& $signtool.FullName verify /pa /all /v $distExe
if ($LASTEXITCODE -ne 0) {
    Stop-WithError "SignTool verification failed with exit code $LASTEXITCODE."
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
$releaseDate = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
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
    Stop-WithError 'Generated latest.yml hash verification failed.'
}

Write-Host "Successfully signed and verified: $distExe"
Write-Host "Generated updater metadata: $latestYml"
Write-Host "Version: $version | Size: $size bytes | SHA-512: $sha512"
Remove-Item -LiteralPath $certPath -Force -ErrorAction SilentlyContinue
