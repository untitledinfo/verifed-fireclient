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

For the safer guided route, run `scripts/Prepare-Certificate-Secret.ps1` locally in Windows PowerShell or PowerShell on Windows. It prompts for the PFX path and password, confirms Windows can open it, checks the publisher subject and validity dates, and copies the Base64-encoded PFX bytes to your clipboard without printing them. Then paste the clipboard into `WINDOWS_CERTIFICATE_BASE64`.

Alternatively, run this locally in PowerShell (adjust the path):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\path\to\codesign.pfx')) | Set-Clipboard
```

`WINDOWS_CERTIFICATE_BASE64` must be the Base64 text of the PFX file bytes—not the file path, certificate password, raw PFX file, or a `.cer`/`.pem` certificate. The workflow now removes whitespace, validates that the secret decodes to PFX-shaped data, and shows a more actionable error when it does not. Do not share the PFX or password in chat, issues, source code, or a public repository. If your certificate uses a different subject naming format, inspect it and adjust the subject check only after confirming the certificate is genuinely issued to the intended publisher.

## 3. Fixing `WINDOWS_CERTIFICATE_BASE64 is not valid Base64-encoded PFX data`

This error is a GitHub secret-format problem: the workflow did not receive Base64 text representing the PFX bytes. It does not mean the installer itself failed. Run `scripts/Prepare-Certificate-Secret.ps1` on your computer, then replace the `WINDOWS_CERTIFICATE_BASE64` secret with the clipboard value. Replace `WINDOWS_CERTIFICATE_PASSWORD` separately with the PFX password. Re-run the workflow. If it then reports that the PFX cannot be opened, check the password; if it reports a publisher-subject or trust error, check that the certificate is the correct valid code-signing certificate.

## 4. Run a release

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
