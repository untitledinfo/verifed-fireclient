param(
    [string]$TargetFile = '',
    [switch]$ExportJson,
    [switch]$ExportMarkdown
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($TargetFile)) {
    $candidates = @(
        (Join-Path $repoRoot 'dist/FireClient-Setup.exe'),
        (Join-Path $repoRoot 'release/FireClient-Setup.exe')
    )
    foreach ($cand in $candidates) {
        if (Test-Path -LiteralPath $cand -PathType Leaf) {
            $TargetFile = $cand
            break
        }
    }
}

if ([string]::IsNullOrWhiteSpace($TargetFile) -or -not (Test-Path -LiteralPath $TargetFile -PathType Leaf)) {
    throw "Target file not found. Provide a path using -TargetFile, for example: .\scripts\Inspect-Release-Security.ps1 -TargetFile .\release\FireClient-Setup.exe"
}

$targetPath = (Resolve-Path -LiteralPath $TargetFile).Path
$bytes = [IO.File]::ReadAllBytes($targetPath)
$size = (Get-Item -LiteralPath $targetPath).Length
$versionInfo = (Get-Item -LiteralPath $targetPath).VersionInfo
$sha256 = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLowerInvariant()
$hasher = [System.Security.Cryptography.SHA512]::Create()
try {
    $sha512 = [Convert]::ToBase64String($hasher.ComputeHash($bytes))
} finally {
    $hasher.Dispose()
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " FireClient Binary Security & Publisher Inspector" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "File:       $targetPath"
Write-Host "Size:       $size bytes ($([math]::Round($size / 1MB, 2)) MB)"
Write-Host "SHA-256:    $sha256"
Write-Host "Version:    $($versionInfo.FileVersion)"
Write-Host "Company:    $($versionInfo.CompanyName)"
Write-Host "Copyright:  $($versionInfo.LegalCopyright)"

# 1. UAC & Admin Privileges Audit
Write-Host ''
Write-Host "[1/4] Windows User Account Control (UAC) & Admin Privileges" -ForegroundColor Yellow
$manifestText = [System.Text.Encoding]::UTF8.GetString($bytes)
$levelMatch = [regex]::Match($manifestText, '<requestedExecutionLevel\s+level="([^"]+)"(?:\s+uiAccess="([^"]+)")?')
$uacLevel = if ($levelMatch.Success) { $levelMatch.Groups[1].Value } else { 'asInvoker (Implicit)' }
$uiAccess = if ($levelMatch.Success -and $levelMatch.Groups[2].Success) { $levelMatch.Groups[2].Value } else { 'false' }

$uacPolicy = switch ($uacLevel) {
    'asInvoker' { 'Per-User Install (No admin prompt on start; runs with caller privileges)' }
    'requireAdministrator' { 'All-Users / Administrator (Always prompts UAC admin elevation dialog with shield icon)' }
    'highestAvailable' { 'Highest Available (Elevates for administrators, runs standard for standard users)' }
    default { "Custom: $uacLevel" }
}

Write-Host "  Requested Execution Level: $uacLevel"
Write-Host "  UI Access Boundary:        $uiAccess"
Write-Host "  Elevation Mode:            $uacPolicy"
Write-Host "  UAC Shield Icon on Launch: $(if ($uacLevel -eq 'requireAdministrator') { 'YES' } else { 'NO' })"

# 2. Authenticode Publisher & Digital Signature Audit
Write-Host ''
Write-Host "[2/4] Authenticode Publisher & Digital Signature" -ForegroundColor Yellow
$auth = Get-AuthenticodeSignature -LiteralPath $targetPath
if ($null -ne $auth.SignerCertificate) {
    $cert = $auth.SignerCertificate
    $orgMatch = [regex]::Match([string]$cert.Subject, '(?i)(?:^|,\s*)O\s*=\s*([^,]+)')
    $org = if ($orgMatch.Success) { $orgMatch.Groups[1].Value.Trim() } else { '' }
    $dispName = $cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    $thumb = ([string]$cert.Thumbprint -replace '\s', '').ToUpperInvariant()
    $validFrom = $cert.NotBefore
    $validTo = $cert.NotAfter
    $isTrusted = ($auth.Status -eq 'Valid')

    Write-Host "  Publisher Display Name:    $dispName" -ForegroundColor $(if ($isTrusted) { 'Green' } else { 'Yellow' })
    Write-Host "  Organization:              $org"
    Write-Host "  Subject:                   $($cert.Subject)"
    Write-Host "  Issuer:                    $($cert.Issuer)"
    Write-Host "  Thumbprint:                $thumb"
    Write-Host "  Valid From/To:             $($validFrom.ToString('u')) to $($validTo.ToString('u'))"
    Write-Host "  Windows Trust Status:      $($auth.Status)" -ForegroundColor $(if ($isTrusted) { 'Green' } else { 'Red' })

    Write-Host "  [UAC Preview] Publisher:   $(if ($isTrusted) { "Verified publisher: $org" } else { "Publisher: Unknown (Untrusted root)" })"
    Write-Host "  [UAC Preview] Consent Bar: $(if ($isTrusted) { "BLUE (Verified Publisher)" } else { "YELLOW (Unknown Publisher Warning)" })"
} else {
    Write-Host "  Status:                    UNSIGNED (No Authenticode digital signature embedded)" -ForegroundColor Yellow
    Write-Host "  [UAC Preview] Consent Bar: YELLOW (Unknown Publisher Warning)"
}

# 3. PE Exploit Mitigations
Write-Host ''
Write-Host "[3/4] Exploit Mitigations & Hardening Headers" -ForegroundColor Yellow
$peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
$optHeaderOffset = $peOffset + 24
$optMagic = [BitConverter]::ToUInt16($bytes, $optHeaderOffset)
$is64 = ($optMagic -eq 0x20B)
$dllChar = [BitConverter]::ToUInt16($bytes, $optHeaderOffset + 70)

$hasAslr = [bool]($dllChar -band 0x0040)
$hasHighEntropy = [bool]($dllChar -band 0x0020)
$hasDep = [bool]($dllChar -band 0x0100)
$hasCfg = [bool]($dllChar -band 0x4000)
$hasNoSeh = [bool]($dllChar -band 0x0400)
$hasTs = [bool]($dllChar -band 0x8000)

Write-Host "  Binary Architecture:       $(if ($is64) { 'PE32+ (64-bit)' } else { 'PE32 (32-bit)' })"
Write-Host "  ASLR (DYNAMIC_BASE):       $(if ($hasAslr) { 'PASS (Enabled)' } else { 'FAIL (Disabled)' })"
Write-Host "  DEP / NX (NX_COMPAT):      $(if ($hasDep) { 'PASS (Enabled)' } else { 'FAIL (Disabled)' })"
Write-Host "  SafeSEH / NO_SEH:          $(if ($hasNoSeh) { 'PASS (Enabled)' } else { 'STANDARD' })"
Write-Host "  Terminal Server Aware:     $(if ($hasTs) { 'PASS (Enabled)' } else { 'DISABLED' })"

# 4. Microsoft Defender Scan
Write-Host ''
Write-Host "[4/4] Microsoft Defender Antivirus Real-time Check" -ForegroundColor Yellow
$mpCmd = $null
$platformRoot = Join-Path $env:ProgramData 'Microsoft/Windows Defender/Platform'
if (Test-Path -LiteralPath $platformRoot -PathType Container) {
    $platforms = Get-ChildItem -LiteralPath $platformRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending
    foreach ($platform in $platforms) {
        $cand = Join-Path $platform.FullName 'MpCmdRun.exe'
        if (Test-Path -LiteralPath $cand -PathType Leaf) { $mpCmd = Get-Item -LiteralPath $cand; break }
    }
}
if ($null -eq $mpCmd) {
    $fallback = Join-Path $env:ProgramFiles 'Windows Defender/MpCmdRun.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { $mpCmd = Get-Item -LiteralPath $fallback }
}

if ($null -ne $mpCmd) {
    & $mpCmd.FullName -Scan -ScanType 3 -File $targetPath -DisableRemediation | Out-Null
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        Write-Host "  Defender Antivirus Scan:   CLEAN (No threats detected)" -ForegroundColor Green
    } else {
        Write-Host "  Defender Antivirus Scan:   NON-ZERO EXIT CODE ($code)" -ForegroundColor Red
    }
} else {
    Write-Host "  Defender Antivirus Scan:   MpCmdRun.exe not found on system" -ForegroundColor Yellow
}

Write-Host "==========================================================" -ForegroundColor Cyan
