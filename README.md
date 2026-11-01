# FireClient Multi-Platform Release & Security Suite

Official verified release feed, Authenticode signing pipeline, cross-platform desktop packaging, and one-line installers for **FireClient** across **Windows 10/11**, **macOS 12+ (Apple Silicon & Intel)**, and **Linux (`x86_64`)**.

---

## Quick One-Line Installers

### Windows 10 / 11 (PowerShell)
```powershell
irm https://raw.githubusercontent.com/untitledinfo/verifed-fireclient/main/scripts/install-windows.ps1 | iex
```

### macOS 12+ (Apple Silicon M1–M4 & Intel)
```bash
curl -fsSL https://raw.githubusercontent.com/untitledinfo/verifed-fireclient/main/scripts/install-macos.sh | bash
```

### Linux (Ubuntu / Debian / Fedora / Arch / Mint / SteamOS)
```bash
curl -fsSL https://raw.githubusercontent.com/untitledinfo/verifed-fireclient/main/scripts/install-linux.sh | bash
```

---

## Multi-Platform Release Artifacts

| Platform | Artifact | Architecture | Notes |
|---|---|---|---|
| **Windows** | `FireClient-Setup.exe` | `x64` | Authenticode-signed NSIS installer (`asInvoker`, installs to `%LocalAppData%\Programs\FireClient`) |
| **Windows** | `FireClient-portable.zip` | `x64` | Zero-install portable Windows bundle |
| **macOS** | `FireClient-macOS-universal.dmg` | Universal (`arm64` + `x64`) | Native Apple Silicon & Intel disk image, built and published by GitHub Actions |
| **Linux** | `FireClient-Linux-x86_64.AppImage` | `x86_64` | Portable AppImage, built and published by GitHub Actions |
| **Linux** | `FireClient-Linux-amd64.deb` | `amd64` | Debian / Ubuntu package, built and published by GitHub Actions |

The macOS universal DMG supports both Apple Silicon and Intel. macOS and Linux installers are built by GitHub Actions and uploaded as release assets; they are not committed into the source tree. All published releases include **`SHA256SUMS.txt`**, **`SHA512SUMS.txt`**, **`FireClient-Setup.exe.sha256`**, and **`latest.yml`** for automatic cryptographic verification by the FireClient Updater.

---

## Security & Publisher Verification Pipeline

### 1. User Account Control (UAC) & Least-Privilege Execution
- **Manifest Execution Level Analysis:** Automatically parses and verifies the PE application manifest (`<requestedExecutionLevel level="asInvoker" uiAccess="false"/>`).
- **Elevation Policy Checks:** Confirms the Windows installer runs cleanly with standard user rights (`asInvoker`) into `%LOCALAPPDATA%`, avoiding unnecessary administrator privilege escalation (`uiAccess="false"`).
- **OS-Native Credential Encryption:** Microsoft OAuth refresh tokens are encrypted locally via **Windows DPAPI**, **macOS Keychain**, or **Linux `libsecret`** (`safeStorage`).

### 2. Publisher Verification & Digital Signature Auditing
- **Unified Publisher Branding:** Aligned `CompanyName` and `LegalCopyright` to `FireClient LLC` across `installer.nsi`, `app.rc`, and Authenticode certificates.
- **RFC 3161 Timestamp Redundancy:** Automated fallback across DigiCert, Sectigo, and Microsoft timestamp authorities.
- **Deep Certificate Health Check:** Audits validity dates, Subject/Issuer, Serial Number, Thumbprint, and Code Signing Extended Key Usage (EKU `1.3.6.1.5.5.7.3.3`).

### 3. Binary Exploit Mitigations & Microsoft Defender Scan
- **PE Security Header Auditing:** Verifies `NX_COMPAT` (DEP/NX), `DYNAMIC_BASE` (ASLR), `NO_SEH` (SafeSEH), and `TERMINAL_SERVER_AWARE`.
- **Microsoft Defender Antivirus Gate:** Runs `MpCmdRun.exe -ScanType 3 -DisableRemediation` against the signed Windows artifact before release publication.

---

## Repository Structure

| Path | Purpose |
|---|---|
| `.github/workflows/sign-release.yml` | Multi-platform CI/CD: signs & audits Windows `.exe`/`.zip`, builds a universal macOS `.dmg` and Linux `.AppImage`/`.deb`, merges `SHA256SUMS.txt`, and publishes GitHub Releases on version tags |
| `desktop/` | Cross-platform macOS & Linux Electron Desktop Host (`main.js`, `preload.js`, `package.json`, `entitlements.mac.plist`) |
| `web/` | Shared Launcher UI & Standalone Glassmorphic Multi-OS Updater (`updater.html`, `index.html`, `css/`, `js/`) |
| `scripts/install-macos.sh` | Official 1-line macOS installer (DMG mount, `/Applications` or `~/Applications` copy, SHA-256 check, Gatekeeper quarantine cleanup) |
| `scripts/install-linux.sh` | Official 1-line Linux installer (`.deb` / `.AppImage`, SHA-256 check, desktop entry & `~/.local/bin/fireclient` symlink) |
| `scripts/install-windows.ps1` | Official 1-line Windows PowerShell installer (SHA-256 check, Authenticode verification, silent `/S` upgrade) |
| `scripts/Sign-And-Generate-Yml.ps1` | Signs `FireClient-Setup.exe`, stages `FireClient-portable.zip`, generates `latest.yml`, `FireClient-Setup.exe.sha256`, `SHA256SUMS.txt`, and `SHA512SUMS.txt` |
| `scripts/Verify-Windows-Release.ps1` | Audits Authenticode publisher, UAC manifest, PE exploit mitigations, and Microsoft Defender scan |
| `scripts/Inspect-Release-Security.ps1` | Standalone CLI inspector for any Windows binary's UAC, signature, and mitigation profile |
| `scripts/Install-Local-Publisher-Trust.ps1` | Imports test publisher certificate into local Windows Trust Store (`Install-Publisher-Trust.cmd`) |
| `release/` | Windows installer inputs for the signing workflow; macOS/Linux installers and generated release metadata stay out of source history and are attached to GitHub Releases by CI |
