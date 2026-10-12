FireClient Signing Fix v5

Parser-error fix:
- Removed a typographic (curly) apostrophe from a single-quoted PowerShell string. PowerShell can interpret smart quotation characters as delimiters, causing a missing-string-terminator error reported later in the file.
- Changed the release-date format argument to double quotes for clarity.

Apply:
1. Replace scripts/Sign-And-Generate-Yml.ps1 in your GitHub repository with this file.
2. Keep .github/workflows/sign-release.yml in sync with this package.
3. Commit to main, then run Actions again. Confirm the run checks out the new commit SHA and reports "Signing script syntax validation passed." before signing.

Note: this package supports a pinned, self-signed certificate only for test artifacts on an ephemeral CI runner. It does not make the publisher trusted on customer PCs. A publicly trusted code-signing certificate is required for a Windows Verified Publisher trust chain.
