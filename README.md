# FireClient Signing Fix v8

## Cause
The script is intentionally allowed to continue for a very narrow test-only case: SignTool verifies the timestamp but returns exit code 1 solely because the exact pinned self-signed development certificate is not trusted by Windows. GitHub Actions' PowerShell wrapper propagates the leftover native `$LASTEXITCODE`, so the step can generate `latest.yml` and still fail at the end.

## Apply
1. Download and extract this ZIP.
2. In `untitledinfo/verifed-fireclient`, open `scripts/Sign-And-Generate-Yml.ps1`.
3. Replace the full file with the included version and commit it to `main`.
4. Re-run **Sign FireClient Setup and Publish**.

No GitHub secret changes are required. The current workflow already supplies the test-only flag and expected thumbprint.

## Security limitation
This permits metadata generation only for the specifically pinned self-signed development certificate when the script sees exactly the expected untrusted-root error and a timestamp. It does not make FireClient a trusted publisher on end-user Windows PCs. For a production release, use a certificate issued by a Windows-trusted code-signing CA and remove the test-only fallback.
