FIRECLIENT SIGNING BUILD FIX

Replace these two paths in the GitHub repository:
  scripts/Sign-And-Generate-Yml.ps1
  .github/workflows/sign-release.yml

The workflow must retain these two environment variables for your known self-signed test certificate:
  ALLOW_UNTRUSTED_SELF_SIGNED_CERTIFICATE: 'true'
  EXPECTED_SIGNING_CERT_THUMBPRINT: 'BDF35D4B69863EB70590708C44D11E18C12AF2C5'

This allows testing/release metadata generation only. It temporarily trusts the exact pinned self-signed certificate on the ephemeral CI runner. It does NOT make FireClient a trusted Verified Publisher on end-user PCs. For production, obtain a publicly trusted code-signing certificate and remove the self-signed test setting/pin.

After replacing both files and committing them, rerun Actions > Sign FireClient Setup and Publish.
