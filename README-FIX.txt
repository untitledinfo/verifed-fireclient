FireClient Signing Fix v4
========================

Replace these files in your GitHub repository:
- scripts/Sign-And-Generate-Yml.ps1
- .github/workflows/sign-release.yml

This version keeps the PowerShell AST syntax check and uses a round-trip ISO-8601 (`o`) date format string for releaseDate, avoiding nested quote characters. Commit both replacement files, then rerun the workflow and verify the syntax-validation step passes before signing.

Keep repository secrets:
- WINDOWS_CERTIFICATE_BASE64
- WINDOWS_CERTIFICATE_PASSWORD

This workflow contains a TEST-ONLY workaround for the pinned self-signed FireClient certificate. It does not make the app a trusted Windows publisher. For production releases use a certificate issued by a CA trusted by Windows. Do not commit PFX files or passwords.

Commit both replacement files to main, then run Actions > Sign FireClient Setup and Publish. Confirm the new run checks out the new commit SHA and shows the “Validate PowerShell script syntax” step passing.
