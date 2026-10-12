FireClient Signing Fix v3
========================

Replace these files in your GitHub repository:
- scripts/Sign-And-Generate-Yml.ps1
- .github/workflows/sign-release.yml

This version removes multiline here-strings used directly as function arguments, changes the latest.yml hash error string to a double-quoted literal, and adds a PowerShell AST syntax check before the signing script runs. This makes a future syntax problem fail early with the precise parser message.

Keep repository secrets:
- WINDOWS_CERTIFICATE_BASE64
- WINDOWS_CERTIFICATE_PASSWORD

This workflow contains a TEST-ONLY workaround for the pinned self-signed FireClient certificate. It does not make the app a trusted Windows publisher. For production releases use a certificate issued by a CA trusted by Windows. Do not commit PFX files or passwords.

Commit both replacement files to main, then run Actions > Sign FireClient Setup and Publish. Confirm the new run checks out the new commit SHA and shows the “Validate PowerShell script syntax” step passing.
