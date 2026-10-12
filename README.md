# FireClient Windows Signing + Update Metadata

This repository is a starter GitHub Actions project for producing a code-signed `FireClient-Setup.exe` and matching `latest.yml` release metadata.

## Important: a publisher name is not a certificate

The current `release/FireClient-Setup.exe` was supplied as an unsigned installer. The workflow can only make it show **FireClient LLC** as a trusted Windows publisher if you provide a valid, trusted Windows Authenticode code-signing certificate whose subject identifies **FireClient LLC**. The company name written in this repository, `/d` description, or YAML does not make a file signed or verified. A self-signed certificate will not create a generally trusted publisher identity.

## 1. Obtain the correct code-signing certificate

Get a Windows code-signing certificate from a trusted certificate authority for the legal entity that is authorized to publish FireClient. Export it as a password-protected PFX that includes the private key. Protect this certificate carefully; never commit the PFX or its password to Git.

## 2. Add GitHub Actions secrets

In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret** and create:

- `WINDOWS_CERTIFICATE_BASE64`: Base64-encoded contents of the PFX file, on one line.
- `WINDOWS_CERTIFICATE_PASSWORD`: the PFX password.

To encode a PFX on PowerShell (run locally on your own computer):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('.\FireClient-CodeSigning.pfx')) | Set-Clipboard
```

Paste that value directly into `WINDOWS_CERTIFICATE_BASE64`. Do not share the PFX or password in chat, issues, source code, or a public repository. If your certificate uses a different naming format, inspect its subject and adjust the subject check in `scripts/Sign-And-Generate-Yml.ps1` only after confirming the certificate is genuinely issued to the intended publisher.

## 3. Run a release

1. Upload your intended unsigned installer to `release/FireClient-Setup.exe` and commit it.
2. Open **Actions → Sign FireClient Setup and Publish → Run workflow**.
3. Enter a semantic version such as `1.2.3`.
4. If the certificate is valid and trusted, the workflow signs the EXE with SHA-256, timestamps it, runs SignTool verification, creates `dist/latest.yml` using the signed file's SHA-512 and size, uploads the outputs as an artifact, and creates/updates a GitHub Release.

Alternatively, push a tag such as `v1.2.3` to run the same release workflow.

## What the YAML does—and does not do

`latest.yml` uses the modern `files[]` format understood by current `electron-updater` clients. Its SHA-512 value lets the updater detect a downloaded EXE that does not match the manifest. The hash must be generated **after** Authenticode signing, which this workflow does.

A SHA-512 checksum is not the same as a cryptographic signature over the YAML itself. If your application uses a version of `electron-updater` configured to require signed update manifests, the release must also be signed with the matching Ed25519 update-manifest private key, and the app must already trust the corresponding public key. This standalone installer-signing project does not change your app's embedded updater configuration. For apps built with a supporting electron-builder release, configure `ELECTRON_BUILDER_UPDATE_SIGN_KEY` in the *application build/publish pipeline* so electron-builder generates the signed manifest and embeds the public key. Do not publish unsigned metadata to clients that already enforce manifest signatures.

## Output files

- `dist/FireClient-Setup.exe` — Authenticode-signed installer (only if the workflow completed successfully).
- `dist/latest.yml` — version, file URL, Base64 SHA-512 checksum, byte size, and release date.

## Notes

- The GitHub Actions workflow cannot be tested to completion without your private code-signing certificate and its password.
- A successful SignTool verification checks the Windows signature and certificate trust on the runner; always independently test the downloaded release on a clean Windows machine.
- Keep certificate private keys and update-manifest signing keys in GitHub Actions secrets, not in the repository.
