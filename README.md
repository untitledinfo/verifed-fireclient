# FireClient Windows Security Features (v9)

This update adds a Windows release-security check to the working signing workflow:

- Signs the installer with a more descriptive Authenticode description: `FireClient Launcher`.
- Reports the embedded publisher display name, organization, certificate subject, thumbprint, and Windows Authenticode trust status.
- Runs an on-demand Microsoft Defender custom scan against the signed `dist/FireClient-Setup.exe` before release publication.
- Fails the release if Defender is unavailable, reports a scan error, or returns a non-zero scan result.
- Writes `dist/verification-report.json` with the signed EXE's SHA-256/SHA-512, publisher identity, trust state, and Defender scan result; uploads it as a GitHub artifact and release asset.
- Runs PowerShell syntax validation on both scripts before attempting to sign.

## Important trust limitation

The currently configured FireClient certificate thumbprint (`BDF35D4B69863EB70590708C44D11E18C12AF2C5`) is a self-signed test certificate. This workflow can report its certificate identity and scan the installer, but must not label it as a Windows Verified Publisher. The published report will explicitly state when the Windows trust status is not `Valid`. Changing `/d` changes the Authenticode description shown for the signed program; it does not change the certificate's publisher identity or make Windows trust the certificate.

For genuine Verified Publisher status, replace the test certificate with a valid code-signing certificate issued to the actual legal entity by a CA trusted by Windows, then remove the test-only fallback and thumbprint pin from the workflow. SmartScreen reputation can still take time to develop even after using a trusted certificate. See Microsoft guidance:

- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus

## Install the changes

Replace these files in your repository with the matching files from this ZIP, commit to `main`, and run **Sign FireClient Setup and Publish**:

- `.github/workflows/sign-release.yml`
- `scripts/Sign-And-Generate-Yml.ps1`
- `scripts/Verify-Windows-Release.ps1` (new file)

No certificate secret changes are required for the current test-only workflow. Do not commit a PFX or certificate password to the repository.
