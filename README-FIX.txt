FireClient Signing Fix v7

This patch fixes SignTool verification failing with 'Untrusted-root error: False' during test releases.
SignTool prints certificate details to stdout and its error message across multiple lines to stderr. When stdout and stderr are merged with 2>&1 in PowerShell, stdout lines from the timestamp chain can interleave between the first and second line of the SignTool error message. This prevented the strict contiguous string match for the untrusted-root exception from succeeding even though the certificate, thumbprint, and timestamp were all valid.

The script now inspects dedicated stderr records and uses an interleaving-tolerant regex so the test fallback succeeds reliably without weakening security checks.

Files to replace in your repository (commit to main):
- scripts/Sign-And-Generate-Yml.ps1

Then trigger the workflow 'Sign FireClient Setup and Publish' again.

Security: this workflow's self-signed certificate setting is test-only. It does not provide Windows Verified Publisher status.
