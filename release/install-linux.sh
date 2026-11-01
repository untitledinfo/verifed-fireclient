#!/usr/bin/env bash
# ==============================================================================
# FireClient Official Linux Installer (Ubuntu, Debian, Fedora, Arch, SteamOS)
# Supports x86_64 (amd64) and aarch64 (arm64) — .deb, .AppImage, or source build
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/untitledinfo/verifed-fireclient/main/scripts/install-linux.sh | bash
# ==============================================================================
set -euo pipefail

REPO="untitledinfo/verifed-fireclient"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
GIT_URL="https://github.com/${REPO}.git"
ICON_URL="https://raw.githubusercontent.com/${REPO}/main/assets/icon.png"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log()  { printf "${CYAN}[FireClient]${RESET} %s\n" "$*"; }
ok()   { printf "${GREEN}[FireClient ✓]${RESET} %s\n" "$*"; }
err()  { printf "${RED}[FireClient ✗]${RESET} %s\n" "$*" >&2; }

if [[ "$(uname -s)" != "Linux" ]]; then
  err "This installer is for Linux. For macOS, run scripts/install-macos.sh."
  exit 1
fi

ARCH_RAW="$(uname -m)"
case "${ARCH_RAW}" in
  x86_64|amd64)
    ARCH="x64"
    DEB_ARCH="amd64"
    APPIMAGE_ARCH="x86_64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    DEB_ARCH="arm64"
    APPIMAGE_ARCH="arm64"
    ;;
  *)
    err "Unsupported CPU architecture: ${ARCH_RAW} (supported: x86_64, aarch64/arm64)"
    exit 1
    ;;
esac

FORCE_APPIMAGE=0
for arg in "$@"; do
  [[ "${arg}" == "--appimage" ]] && FORCE_APPIMAGE=1
done

printf "\n${BOLD}🔥 FireClient Linux Installer${RESET} — Detected ${BOLD}Linux %s${RESET}\n\n" "${ARCH_RAW}"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fireclient-linux.XXXXXX")"
trap 'rm -rf "${WORK_DIR}" >/dev/null 2>&1 || true' EXIT

mkdir -p "${HOME}/.fireclient" \
         "${HOME}/.local/bin" \
         "${HOME}/.local/opt/fireclient" \
         "${HOME}/.local/share/applications" \
         "${HOME}/.local/share/icons/hicolor/512x512/apps"

log "Checking latest verified release on github.com/${REPO}..."
RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" "${API_URL}" 2>/dev/null || true)"

extract_asset_url() {
  local pattern="$1"
  printf "%s" "${RELEASE_JSON}" | grep -Eo '"browser_download_url"\s*:\s*"[^"]+"' | cut -d'"' -f4 | grep -Ei "${pattern}" | head -n 1 || true
}

DEB_URL=""
APPIMAGE_URL=""
SUMS_URL=""
if [[ -n "${RELEASE_JSON}" ]]; then
  DEB_URL="$(extract_asset_url "(${DEB_ARCH}|${ARCH}).*\\.deb$")"
  [[ -z "${DEB_URL}" && "${ARCH}" == "x64" ]] && DEB_URL="$(extract_asset_url "\\.deb$")"
  APPIMAGE_URL="$(extract_asset_url "(${APPIMAGE_ARCH}|${ARCH}).*\\.AppImage$")"
  [[ -z "${APPIMAGE_URL}" && "${ARCH}" == "x64" ]] && APPIMAGE_URL="$(extract_asset_url "\\.AppImage$")"
  SUMS_URL="$(extract_asset_url "SHA256SUMS(\\.txt)?$")"
fi

verify_sha256_if_listed() {
  local file_path="$1"
  local asset_name="$2"
  [[ -z "${SUMS_URL}" ]] && return 0
  local sums_file="${WORK_DIR}/SHA256SUMS.txt"
  if curl -fsSL "${SUMS_URL}" -o "${sums_file}" 2>/dev/null; then
    local expected
    expected="$(grep -F "${asset_name}" "${sums_file}" | awk '{print tolower($1)}' | head -n 1 || true)"
    if [[ -n "${expected}" ]]; then
      local actual
      actual="$(sha256sum "${file_path}" | awk '{print tolower($1)}')"
      if [[ "${expected}" != "${actual}" ]]; then
        err "SHA-256 verification failed for ${asset_name}!"
        exit 1
      fi
      ok "SHA-256 verified (${actual:0:16}...)"
    fi
  fi
}

install_desktop_entry() {
  local exec_cmd="$1"
  local icon_dest="${HOME}/.local/share/icons/hicolor/512x512/apps/fireclient.png"
  curl -fsSL "${ICON_URL}" -o "${icon_dest}" 2>/dev/null || true

  cat > "${HOME}/.local/share/applications/fireclient.desktop" <<EOF
[Desktop Entry]
Name=FireClient
Comment=High-Performance Minecraft Launcher & Server Host
Exec=${exec_cmd} %U
Icon=${icon_dest}
Terminal=false
Type=Application
Categories=Game;
StartupWMClass=FireClient
Keywords=minecraft;launcher;fabric;forge;modrinth;fireclient;
EOF
  chmod +x "${HOME}/.local/share/applications/fireclient.desktop"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "${HOME}/.local/share/applications" >/dev/null 2>&1 || true
}

# 1. Prefer .deb on Debian / Ubuntu when apt-get + sudo/root are available
if [[ "${FORCE_APPIMAGE}" -eq 0 && -n "${DEB_URL}" ]] && command -v apt-get >/dev/null 2>&1; then
  if [[ "${EUID:-$(id -u)}" -eq 0 ]] || command -v sudo >/dev/null 2>&1; then
    DEB_FILE="${WORK_DIR}/$(basename "${DEB_URL}")"
    log "Downloading Debian/Ubuntu package $(basename "${DEB_URL}")..."
    curl -fL --progress-bar "${DEB_URL}" -o "${DEB_FILE}"
    verify_sha256_if_listed "${DEB_FILE}" "$(basename "${DEB_URL}")"
    log "Installing via apt..."
    if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
      apt-get install -y "${DEB_FILE}"
    else
      sudo apt-get install -y "${DEB_FILE}"
    fi
    ok "FireClient installed! Run 'fireclient' or open FireClient from your Applications menu."
    exit 0
  fi
fi

# 2. Universal AppImage install (works on Ubuntu, Fedora, Arch, SteamOS, rootless!)
if [[ -n "${APPIMAGE_URL}" ]]; then
  DEST_APPIMAGE="${HOME}/.local/opt/fireclient/FireClient.AppImage"
  log "Downloading $(basename "${APPIMAGE_URL}")..."
  curl -fL --progress-bar "${APPIMAGE_URL}" -o "${DEST_APPIMAGE}.tmp"
  verify_sha256_if_listed "${DEST_APPIMAGE}.tmp" "$(basename "${APPIMAGE_URL}")"
  mv -f "${DEST_APPIMAGE}.tmp" "${DEST_APPIMAGE}"
  chmod +x "${DEST_APPIMAGE}"

  cat > "${HOME}/.local/bin/fireclient" <<EOF
#!/usr/bin/env bash
if ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then
  exec "${DEST_APPIMAGE}" "\$@"
else
  exec "${DEST_APPIMAGE}" --appimage-extract-and-run "\$@"
fi
EOF
  chmod +x "${HOME}/.local/bin/fireclient"
  install_desktop_entry "${HOME}/.local/bin/fireclient"

  ok "FireClient AppImage installed to ${DEST_APPIMAGE}"
  ok "CLI launcher installed to ${HOME}/.local/bin/fireclient"
  if [[ ":${PATH}:" != *":${HOME}/.local/bin:"* ]]; then
    log "Tip: add ~/.local/bin to your PATH or launch directly via: ${HOME}/.local/bin/fireclient"
  fi
  exit 0
fi

# 3. Clean source build fallback if prebuilt Linux asset is not yet attached to tag
log "Prebuilt Linux package not yet attached to latest tag — installing local Electron desktop runtime..."
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  err "Node.js 18+, npm, and git are required to build from source (e.g. sudo apt install -y nodejs npm git)."
  exit 1
fi

INSTALL_ROOT="${HOME}/.local/opt/fireclient/src"
rm -rf "${INSTALL_ROOT}"
git clone --depth 1 "${GIT_URL}" "${INSTALL_ROOT}"
pushd "${INSTALL_ROOT}/desktop" >/dev/null
npm install --no-audit --no-fund
popd >/dev/null

cat > "${HOME}/.local/bin/fireclient" <<EOF
#!/usr/bin/env bash
cd "${INSTALL_ROOT}/desktop" && exec npx electron . "\$@"
EOF
chmod +x "${HOME}/.local/bin/fireclient"
install_desktop_entry "${HOME}/.local/bin/fireclient"

ok "FireClient Linux runtime installed! Launch anytime with: ${HOME}/.local/bin/fireclient"
