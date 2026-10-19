# FireClient Windows Security & Publisher Suite (v10)

This release upgrades the security, User Account Control (UAC), Authenticode publisher verification, and build integrity pipeline across FireClient.

---

## What's New & Upgraded

### 1. User Account Control (UAC) & Admin Privileges Audit
- **Manifest Execution Level Analysis:** Automatically parses and verifies the PE application manifest (`<requestedExecutionLevel level="asInvoker" uiAccess="false"/>`).
- **Elevation Policy Checks:** Confirms the installer runs cleanly with standard user rights (`asInvoker`) into `%LOCALAPPDATA%`, avoiding unnecessary administrator privilege escalation while auditing against accessibility boundaries (`uiAccess="false"`).
- **UAC Dialogue Simulation:** Previews exactly how the Windows User Account Control consent prompt will appear on client PCs (Prompt Banner Color, Verified Publisher name, and Shield Icon status).

### 2. Publisher Verification & Digital Signature Upgrades
- **Unified Publisher Branding:** Aligned `CompanyName` and `LegalCopyright` to `FireClient LLC` across the NSIS installer (`installer.nsi`), Windows resource file (`app.rc`), and Authenticode certificate.
- **Enhanced Authenticode Signing:** Signs using SHA-256 with descriptive application name (`FireClient Launcher`) and support URL (`https://www.fireclient.net`).
- **RFC 3161 Timestamp Redundancy:** Added automated fallback between DigiCert, Sectigo, and Microsoft timestamp authorities to prevent build failures during third-party timestamp server downtime.
- **Deep Certificate Health Check:** Audits validity dates, Subject/Issuer, Serial Number, Thumbprint, and Code Signing Extended Key Usage (EKU `1.3.6.1.5.5.7.3.3`).

### 3. Binary Exploit Mitigations & Hardening
- **PE Security Header Auditing:** Automatically inspects the PE Optional Header `DllCharacteristics` for:
  - **DEP / NX (`NX_COMPAT`):** Enforces non-executable stack and heap memory buffers.
  - **ASLR (`DYNAMIC_BASE`):** Address Space Layout Randomization to mitigate ROP exploits.
  - **SafeSEH / No SEH (`NO_SEH`):** Structured Exception Handling overwrite protections.
  - **Terminal Server Awareness (`TERMINAL_SERVER_AWARE`):** Multi-user Windows session support.

### 4. Microsoft Defender Antivirus Verification
- Runs an automated custom scan (`MpCmdRun.exe -ScanType 3 -DisableRemediation`) against the signed artifact before release.
- Blocks publication if Defender is unavailable, encounters a scan error, or flags any malicious detection.

### 5. Standardized Release Hashes & Summaries
- Automatically produces `dist/SHA256SUMS.txt` and `dist/SHA512SUMS.txt` alongside `latest.yml`.
- Generates `dist/security-summary.md` and populates GitHub Actions Step Summary (`$env:GITHUB_STEP_SUMMARY`) with a visual security dashboard on every build.

### 6. Local Publisher Trust Tools (Test & Development PCs)
- **`Install-Publisher-Trust.cmd` / `scripts/Install-Local-Publisher-Trust.ps1`:** Installs the FireClient public certificate into the Windows `Trusted Root Certification Authorities` and `Trusted Publishers` store.
  - Switches Windows UAC from a **Yellow ("Unknown Publisher")** banner to a **Blue ("Verified Publisher: FireClient LLC")** banner.
  - Fixes SmartScreen warnings on the local machine without waiting for cloud reputation.
- **`scripts/Uninstall-Local-Publisher-Trust.ps1`:** Safely removes the test certificate from the Windows Certificate Store.
- **`Inspect-Release-Security.cmd` / `scripts/Inspect-Release-Security.ps1`:** Standalone tool to inspect any EXE file's UAC manifest, Authenticode signature, PE exploit mitigations, and Defender scan status locally.

---

## File Overview

| File | Purpose |
|---|---|
| `.github/workflows/sign-release.yml` | GitHub Actions workflow: signs, validates, audits, scans with Defender, and publishes releases. |
| `scripts/Sign-And-Generate-Yml.ps1` | Signs installer with timestamp fallback, verifies signature, produces `latest.yml`, `SHA256SUMS.txt`, `SHA512SUMS.txt`. |
| `scripts/Verify-Windows-Release.ps1` | Audits publisher, UAC settings, exploit mitigations, Defender scan, and generates security dashboard. |
| `scripts/Inspect-Release-Security.ps1` | Standalone CLI utility to inspect any binary's security and UAC profile anytime. |
| `scripts/Install-Local-Publisher-Trust.ps1` | One-click tool to import publisher certificate into Windows store for blue UAC prompt. |
| `scripts/Uninstall-Local-Publisher-Trust.ps1` | Removes local publisher certificate from Windows trust store. |
| `Install-Publisher-Trust.cmd` | Batch shortcut to run local trust installer as Administrator. |
| `Inspect-Release-Security.cmd` | Batch shortcut to inspect installer security with one click. |
| `Repair-FireClient-Certificate.cmd` | Repairs Base64 secret if installed in Windows certificate store. |

---

## Production vs. Test Mode

- **Test Releases:** Pinned thumbprints (`91CECD221349B375AF5CBE1FC138015705C9FBC7`, `BDF35D4B69863EB70590708C44D11E18C12AF2C5`) with `ALLOW_UNTRUSTED_SELF_SIGNED_CERTIFICATE: 'true'`.
- **Production Releases:** When ready for public distribution, purchase a standard EV/OV Code Signing certificate from a trusted public CA (DigiCert, Sectigo, etc.), replace the GitHub Actions secrets `WINDOWS_CERTIFICATE_BASE64` / `WINDOWS_CERTIFICATE_PASSWORD`, and remove the test fallback flag.
