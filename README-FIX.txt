FIRECLIENT SIGNING FIX v2

Your current Actions run still checks out commit 124c05eb4b591b4934b87dfa3879117193b48948, whose script is the old version. This patch replaces the committed files at these exact repository paths:

  scripts/Sign-And-Generate-Yml.ps1
  .github/workflows/sign-release.yml

Apply both files on the main branch, commit them, and check that the next Actions run checks out a NEW commit SHA. The workflow adds ALLOW_UNTRUSTED_SELF_SIGNED_CERTIFICATE=true and pins the exact test certificate thumbprint BDF35D4B69863EB70590708C44D11E18C12AF2C5. The script adds that exact certificate to CurrentUser\Root on the ephemeral CI runner before verification. If SignTool still reports solely an untrusted root, a strict fallback permits test artifact metadata only when the signer thumbprint matches the pinned certificate and the timestamp is present/verified. Other signature errors remain failures.

IMPORTANT: this is a test-build workaround only. It does not make the certificate trusted by customers' Windows installations or create a genuinely trusted Verified Publisher. For production use a publicly trusted code-signing certificate. Never upload the PFX or password to the repository.
