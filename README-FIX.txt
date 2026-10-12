FireClient Signing Fix v6

This patch adds progress checkpoints and replaces the recursive Windows SDK SignTool search with a fast version-folder lookup. The screenshot showed that PowerShell syntax validation passed but the signing script stayed active without reaching its first signing message. This patch is intended to expose the stage where it pauses and avoid a slow recursive scan.

Files to replace in your repository (commit to main):
- scripts/Sign-And-Generate-Yml.ps1
- .github/workflows/sign-release.yml (included unchanged except the job timeout safeguard)

Then stop the currently running workflow and run a new workflow after committing. Keep the existing certificate secrets private.

Security: this workflow's self-signed certificate setting is test-only. It does not provide Windows Verified Publisher status.
