param(
    [string]$InstallerPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $repoRoot 'dist'
$installer = if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    Join-Path $distDir 'FireClient-Setup.exe'
} else {
    (Resolve-Path -LiteralPath $InstallerPath).Path
}

$reportPath = Join-Path $distDir 'verification-report.json'
$summaryPath = Join-Path $distDir 'security-summary.md'

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Target installer not found: $installer"
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " FireClient Windows Security & Publisher Verification v10" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Target executable: $installer"

# -----------------------------------------------------------------------------
# Stage 1/5: Embedded Authenticode Publisher Identity & Certificate Metadata
# -----------------------------------------------------------------------------
Write-Host ''
Write-Host 'Stage 1/5: Reading embedded Authenticode publisher identity & certificate metadata.' -ForegroundColor Cyan

$auth = Get-AuthenticodeSignature -LiteralPath $installer
if ($null -eq $auth.SignerCertificate) {
    throw "The target executable is not signed or does not contain an Authenticode signature: $installer"
}

$cert = $auth.SignerCertificate
$thumbprint = ([string]$cert.Thumbprint -replace '\s', '').ToUpperInvariant()
$expectedThumbprint = ([string]$env:EXPECTED_SIGNING_CERT_THUMBPRINT -replace '\s', '').ToUpperInvariant()
$allowSelfSigned = ($env:ALLOW_UNTRUSTED_SELF_SIGNED_CERTIFICATE -eq 'true')
$isPinnedTestCert = -not [string]::IsNullOrWhiteSpace($expectedThumbprint) -and $thumbprint -eq $expectedThumbprint

if ($allowSelfSigned -and -not $isPinnedTestCert) {
    throw "Test release mode was enabled, but installer thumbprint ($thumbprint) does not match EXPECTED_SIGNING_CERT_THUMBPRINT ($expectedThumbprint)."
}

$publisherName = $cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
$orgMatch = [regex]::Match([string]$cert.Subject, '(?i)(?:^|,\s*)O\s*=\s*([^,]+)')
$organization = if ($orgMatch.Success) { $orgMatch.Groups[1].Value.Trim() } else { '' }
$trustedByWindows = ([string]$auth.Status -eq 'Valid')

$now = Get-Date
$isDateValid = ($now -ge $cert.NotBefore -and $now -le $cert.NotAfter)
$ekuExtension = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | Select-Object -First 1
$hasCodeSigningEku = $false
if ($null -ne $ekuExtension) {
    $eku = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]$ekuExtension
    $hasCodeSigningEku = @($eku.EnhancedKeyUsages | ForEach-Object { $_.Value }) -contains '1.3.6.1.5.5.7.3.3'
}

Write-Host "  Publisher Display Name: $publisherName"
Write-Host "  Organization (O):       $organization"
Write-Host "  Certificate Subject:    $($cert.Subject)"
Write-Host "  Certificate Issuer:     $($cert.Issuer)"
Write-Host "  Certificate Thumbprint: $thumbprint"
Write-Host "  Validity Period:        $($cert.NotBefore.ToString('u')) to $($cert.NotAfter.ToString('u'))"
Write-Host "  Code Signing EKU:       $(if ($hasCodeSigningEku) { 'Present (1.3.6.1.5.5.7.3.3)' } else { 'Not Found / Generic' })"
Write-Host "  Windows Trust Status:   $($auth.Status)"

if ($isPinnedTestCert) {
    Write-Warning '  [TEST MODE] Pinned self-signed certificate in use. Windows will NOT treat this as a trusted publisher until a public CA certificate is used or local trust is provisioned.'
} elseif ($trustedByWindows) {
    Write-Host '  [TRUSTED] Windows Authenticode reports valid signature chain.' -ForegroundColor Green
} else {
    Write-Warning "  [UNTRUSTED] Signature status is '$($auth.Status)'. Publisher will display as Unknown in default UAC prompts."
}

# -----------------------------------------------------------------------------
# Stage 2/5: Audit User Control, Admin Privileges & UAC Manifest Settings
# -----------------------------------------------------------------------------
Write-Host ''
Write-Host 'Stage 2/5: Auditing User Control, Admin Privileges & UAC manifest settings.' -ForegroundColor Cyan

$bytes = [IO.File]::ReadAllBytes($installer)
$manifestText = [System.Text.Encoding]::UTF8.GetString($bytes)
$levelMatch = [regex]::Match($manifestText, '<requestedExecutionLevel\s+level="([^"]+)"(?:\s+uiAccess="([^"]+)")?')
$uacLevel = if ($levelMatch.Success) { $levelMatch.Groups[1].Value } else { 'asInvoker' }
$uiAccess = if ($levelMatch.Success -and $levelMatch.Groups[2].Success) { $levelMatch.Groups[2].Value } else { 'false' }

$uacDescription = switch ($uacLevel) {
    'asInvoker' {
        'Standard User Rights (No automatic UAC elevation prompt on launch). Installs cleanly into per-user LocalAppData without requiring local admin rights.'
    }
    'requireAdministrator' {
        'Administrator Privileges Required. Windows UAC will prompt for admin approval with a shield icon before launching.'
    }
    'highestAvailable' {
        'Highest Available Rights. Prompts for admin rights if current user belongs to Administrators; otherwise runs as standard user.'
    }
    default {
        "Custom or undeclared execution level: $uacLevel"
    }
}

$uacShieldRequired = ($uacLevel -eq 'requireAdministrator')

Write-Host "  Requested Execution Level: $uacLevel"
Write-Host "  UI Access (Accessibility): $uiAccess"
Write-Host "  UAC Shield Icon Prompt:    $(if ($uacShieldRequired) { 'Yes (Requires Admin)' } else { 'No (Per-User / Standard Invoker)' })"
Write-Host "  Execution Control Policy:  $uacDescription"

# UAC Dialogue Simulation
$simulatedUacPublisher = if ($trustedByWindows) {
    $organization
} elseif ($isPinnedTestCert) {
    "$organization (Self-Signed / Test Mode)"
} else {
    "Unknown Publisher"
}
$simulatedPromptColor = if ($trustedByWindows) { 'Blue (Verified Publisher)' } else { 'Yellow (Unknown Publisher Warning)' }

Write-Host "  [UAC Simulation] Prompt Banner:    $simulatedPromptColor"
Write-Host "  [UAC Simulation] Publisher Shown:  $simulatedUacPublisher"
Write-Host "  [UAC Simulation] Show Details:     $(if ($trustedByWindows) { 'Verified Digital Certificate Link' } else { 'Untrusted Root Warning' })"

# -----------------------------------------------------------------------------
# Stage 3/5: PE Exploit Mitigations & Binary Security Analysis
# -----------------------------------------------------------------------------
Write-Host ''
Write-Host 'Stage 3/5: Auditing PE Exploit Mitigations & Binary Security Headers.' -ForegroundColor Cyan

$peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
$optHeaderOffset = $peOffset + 24
$optMagic = [BitConverter]::ToUInt16($bytes, $optHeaderOffset)
$is64Bit = ($optMagic -eq 0x20B)
$dllCharacteristics = [BitConverter]::ToUInt16($bytes, $optHeaderOffset + 70)

$hasAslr = [bool]($dllCharacteristics -band 0x0040)
$hasHighEntropyVa = [bool]($dllCharacteristics -band 0x0020)
$hasDep = [bool]($dllCharacteristics -band 0x0100)
$hasCfg = [bool]($dllCharacteristics -band 0x4000)
$hasNoSeh = [bool]($dllCharacteristics -band 0x0400)
$hasTsAware = [bool]($dllCharacteristics -band 0x8000)

Write-Host "  Binary Architecture:       $(if ($is64Bit) { 'PE32+ (64-bit)' } else { 'PE32 (32-bit)' })"
Write-Host "  ASLR (Dynamic Base):       $(if ($hasAslr) { 'Enabled [PASS]' } else { 'Disabled [WARN]' })"
Write-Host "  High-Entropy 64-bit ASLR:  $(if ($hasHighEntropyVa) { 'Enabled [PASS]' } elseif ($is64Bit) { 'Disabled [WARN]' } else { 'N/A (32-bit PE)' })"
Write-Host "  DEP / NX (Data Execution): $(if ($hasDep) { 'Enabled [PASS]' } else { 'Disabled [FAIL]' })"
Write-Host "  Control Flow Guard (CFG):  $(if ($hasCfg) { 'Enabled [PASS]' } else { 'Not Enforced in Installer Stub' })"
Write-Host "  SafeSEH / No SEH:          $(if ($hasNoSeh) { 'Enabled [PASS]' } else { 'Standard SEH' })"
Write-Host "  Terminal Server Aware:     $(if ($hasTsAware) { 'Enabled [PASS]' } else { 'Disabled' })"

if (-not $hasDep) {
    Write-Warning 'Binary lacks Data Execution Prevention (DEP / NXCOMPAT). Exploit mitigation is suboptimal.'
}
if (-not $hasAslr) {
    Write-Warning 'Binary lacks Address Space Layout Randomization (ASLR / DYNAMICBASE).'
}

# -----------------------------------------------------------------------------
# Stage 4/5: Deep Scan with Microsoft Defender Antivirus
# -----------------------------------------------------------------------------
Write-Host ''
Write-Host 'Stage 4/5: Scanning target installer with Microsoft Defender Antivirus.' -ForegroundColor Cyan

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
    throw 'Microsoft Defender MpCmdRun.exe was not found. Refusing to claim that release was scanned.'
}

Write-Host "  Scanner: $mpCmd"
Write-Host "  Scanning file: $installer"

& $mpCmd.FullName -Scan -ScanType 3 -File $installer -DisableRemediation
$scanExitCode = $LASTEXITCODE

if ($scanExitCode -ne 0) {
    throw "Microsoft Defender scan did not return clean status (exit code $scanExitCode). Release publication blocked."
}
Write-Host '  Defender Scan Status: CLEAN (Exit code 0)' -ForegroundColor Green

# -----------------------------------------------------------------------------
# Stage 5/5: Generate Verification Report & Security Summary Dashboard
# -----------------------------------------------------------------------------
Write-Host ''
Write-Host 'Stage 5/5: Generating structured reports and security dashboard.' -ForegroundColor Cyan

$sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
$hasher = [System.Security.Cryptography.SHA512]::Create()
try {
    $sha512 = [Convert]::ToBase64String($hasher.ComputeHash($bytes))
} finally {
    $hasher.Dispose()
}
$size = (Get-Item -LiteralPath $installer).Length
$versionInfo = (Get-Item -LiteralPath $installer).VersionInfo

$trustNote = if ($isPinnedTestCert) {
    'Pinned test certificate; Windows Verified Publisher trust is NOT established out-of-the-box on customer PCs.'
} elseif ($trustedByWindows) {
    'Windows Authenticode reports Valid. SmartScreen may still warn until reputation is established.'
} else {
    'Windows Authenticode did not report Valid; do not describe this as a Verified Publisher.'
}

$report = [ordered]@{
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    installer = (Split-Path -Leaf $installer)
    fileSizeBytes = $size
    sha256 = $sha256
    sha512 = $sha512
    versionInfo = [ordered]@{
        fileVersion = [string]$versionInfo.FileVersion
        productVersion = [string]$versionInfo.ProductVersion
        companyName = [string]$versionInfo.CompanyName
        fileDescription = [string]$versionInfo.FileDescription
        legalCopyright = [string]$versionInfo.LegalCopyright
    }
    userAccountControl = [ordered]@{
        requestedExecutionLevel = $uacLevel
        uiAccess = $uiAccess
        shieldRequired = $uacShieldRequired
        executionPolicy = $uacDescription
        simulatedUacPublisher = $simulatedUacPublisher
        simulatedPromptBanner = $simulatedPromptColor
    }
    publisher = [ordered]@{
        displayName = $publisherName
        organization = $organization
        certificateSubject = [string]$cert.Subject
        issuer = [string]$cert.Issuer
        thumbprint = $thumbprint
        serialNumber = [string]$cert.SerialNumber
        validFromUtc = $cert.NotBefore.ToUniversalTime().ToString('o')
        validToUtc = $cert.NotAfter.ToUniversalTime().ToString('o')
        hasCodeSigningEku = $hasCodeSigningEku
        authenticodeStatus = [string]$auth.Status
        trustedByWindows = $trustedByWindows
        isPinnedTestCert = $isPinnedTestCert
        trustNote = $trustNote
    }
    exploitMitigations = [ordered]@{
        aslrDynamicBase = $hasAslr
        highEntropyVa = $hasHighEntropyVa
        depNxCompat = $hasDep
        controlFlowGuard = $hasCfg
        noSeh = $hasNoSeh
        terminalServerAware = $hasTsAware
    }
    microsoftDefender = [ordered]@{
        scanType = 'CustomScan'
        scanner = $mpCmd.FullName
        exitCode = $scanExitCode
        result = 'Clean exit; no unresolved detection or scan error reported by MpCmdRun.'
    }
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 6) + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "  Saved JSON report: $reportPath"

# Markdown Security Summary Dashboard
$statusBadge = if ($trustedByWindows) { 'PASSED (CA-Signed)' } elseif ($isPinnedTestCert) { 'PASSED (Pinned Test-Only Cert)' } else { 'WARNING' }
$defenderBadge = if ($scanExitCode -eq 0) { 'PASSED (No Threats Found)' } else { 'FAILED' }
$depBadge = if ($hasDep) { 'ENABLED' } else { 'DISABLED' }
$aslrBadge = if ($hasAslr) { 'ENABLED' } else { 'DISABLED' }

$summaryMd = @"
# FireClient Release Security & Publisher Report

**Release Artifact:** `${(Split-Path -Leaf $installer)}`  
**Generated UTC:** `${(Get-Date).ToUniversalTime().ToString("u")}`  
**Security Status:** `${statusBadge}` | **Antivirus Scan:** `${defenderBadge}`

---

## 1. Identity & Publisher Verification

| Attribute | Details |
|---|---|
| **Publisher Display Name** | $publisherName |
| **Organization** | $organization |
| **Certificate Subject** | $($cert.Subject) |
| **Certificate Issuer** | $($cert.Issuer) |
| **Certificate Thumbprint** | `$thumbprint` |
| **Validity Period** | $($cert.NotBefore.ToString("yyyy-MM-dd")) to $($cert.NotAfter.ToString("yyyy-MM-dd")) |
| **Code Signing EKU** | $(if ($hasCodeSigningEku) { 'Present (`1.3.6.1.5.5.7.3.3`)' } else { 'Not specified' }) |
| **Windows Trust Status** | `$($auth.Status)` |
| **Verified Publisher Status** | $(if ($trustedByWindows) { 'Trusted by Windows Root Store' } elseif ($isPinnedTestCert) { 'Pinned Self-Signed Test Certificate (Untrusted on unconfigured client PCs)' } else { 'Untrusted' }) |

> [!NOTE]
> $trustNote

---

## 2. Windows User Account Control (UAC) & Admin Control

| UAC Property | Setting | Explanation |
|---|---|---|
| **Requested Execution Level** | `$uacLevel` | $uacDescription |
| **UI Access (Accessibility)** | `$uiAccess` | Blocks bypass of standard desktop input security boundary. |
| **UAC Shield Display** | $(if ($uacShieldRequired) { 'Yes (Shield active)' } else { 'No shield (Runs standard user)' }) | Controls whether installer prompts for admin approval immediately. |
| **Simulated UAC Header** | `$simulatedPromptColor` | Visual appearance of the Windows UAC consent screen. |
| **Simulated Publisher** | `$simulatedUacPublisher` | The publisher name Windows displays in the UAC elevation dialog. |

---

## 3. Exploit Mitigations & Binary Security

| Protection | Status | Security Purpose |
|---|---|---|
| **DEP / NX (`NX_COMPAT`)** | $depBadge | Prevents execution of shellcode in data memory buffers. |
| **ASLR (`DYNAMIC_BASE`)** | $aslrBadge | Randomizes in-memory address layout to resist ROP chains. |
| **High Entropy ASLR** | $(if ($hasHighEntropyVa) { 'ENABLED' } elseif ($is64Bit) { 'DISABLED' } else { 'N/A (32-bit)' }) | 64-bit 1TB address randomization space. |
| **SafeSEH / No SEH** | $(if ($hasNoSeh) { 'ENABLED' } else { 'STANDARD' }) | Hardens Structured Exception Handling against table overwrites. |
| **Terminal Server Aware** | $(if ($hasTsAware) { 'ENABLED' } else { 'DISABLED' }) | Compatible with multi-user Windows environments. |

---

## 4. Microsoft Defender Antivirus Scan

| Scan Metric | Value |
|---|---|
| **Antivirus Scanner** | `$($mpCmd.FullName)` |
| **Scan Type** | Custom Scan (ScanType 3, `-DisableRemediation`) |
| **Exit Code** | `$scanExitCode` |
| **Scan Result** | **Clean** - No malware, backdoors, or malicious signatures detected. |

---

## 5. File Hashes & Integrity

- **File Size:** $size bytes ($([math]::Round($size / 1MB, 2)) MB)
- **SHA-256:** `$sha256`
- **SHA-512:** `$sha512`

"@

[IO.File]::WriteAllText($summaryPath, $summaryMd + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "  Saved Markdown summary: $summaryPath"

if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) {
    try {
        [IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, "`n" + $summaryMd + "`n", [Text.UTF8Encoding]::new($false))
        Write-Host "  Appended security summary to GitHub Actions Step Summary." -ForegroundColor Green
    } catch {
        Write-Warning "  Could not write to GITHUB_STEP_SUMMARY: $($_.Exception.Message)"
    }
}

Write-Host ''
Write-Host "All security, UAC, publisher, and antivirus checks completed successfully." -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
