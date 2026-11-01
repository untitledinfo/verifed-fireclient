#!/usr/bin/env bash
# ==============================================================================
# FireClient Official macOS Installer (Apple Silicon arm64 & Intel x86_64)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/untitledinfo/verifed-fireclient/main/scripts/install-macos.sh | bash
# ==============================================================================
set -euo pipefail

REPO="untitledinfo/verifed-fireclient"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
GIT_URL="https://github.com/${REPO}.git"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log()  { printf "${CYAN}[FireClient]${RESET} %s\n" "$*"; }
ok()   { printf "${GREEN}[FireClient ✓]${RESET} %s\n" "$*"; }
err()  { printf "${RED}[FireClient ✗]${RESET} %s\n" "$*" >&2; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "This installer is for macOS (Darwin). For Linux, run scripts/install-linux.sh."
  exit 1
fi

ARCH_RAW="$(uname -m)"
if [[ "${ARCH_RAW}" == "arm64" || "${ARCH_RAW}" == "aarch64" ]]; then
  ARCH="arm64"
  ARCH_LABEL="Apple Silicon (arm64)"
else
  ARCH="x64"
  ARCH_LABEL="Intel (x86_64)"
fi

printf "\n${BOLD}🔥 FireClient macOS Installer${RESET} — Detected ${BOLD}%s${RESET}\n\n" "${ARCH_LABEL}"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fireclient-macos.XXXXXX")"
MOUNT_DIR=""
cleanup() {
  if [[ -n "${MOUNT_DIR}" && -d "${MOUNT_DIR}" ]]; then
    hdiutil detach "${MOUNT_DIR}" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK_DIR}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

DEST_APPS="/Applications"
if [[ ! -w "/Applications" ]]; then
  DEST_APPS="${HOME}/Applications"
  mkdir -p "${DEST_APPS}"
fi

log "Checking latest verified release on github.com/${REPO}..."
RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" "${API_URL}" 2>/dev/null || true)"

extract_asset_url() {
  local pattern="$1"
  printf "%s" "${RELEASE_JSON}" | grep -Eo '"browser_download_url"\s*:\s*"[^"]+"' | cut -d'"' -f4 | grep -Ei "${pattern}" | head -n 1 || true
}

DMG_URL=""
if [[ -n "${RELEASE_JSON}" ]]; then
  DMG_URL="$(extract_asset_url "FireClient-macOS-${ARCH}\\.dmg$")"
  [[ -z "${DMG_URL}" ]] && DMG_URL="$(extract_asset_url "FireClient-macOS-universal\\.dmg$")"
  [[ -z "${DMG_URL}" ]] && DMG_URL="$(extract_asset_url "\\.dmg$")"
fi

SUMS_URL=""
[[ -n "${RELEASE_JSON}" ]] && SUMS_URL="$(extract_asset_url "SHA256SUMS(\\.txt)?$")"

install_app_bundle() {
  local src_app="$1"
  local target_app="${DEST_APPS}/FireClient.app"
  log "Installing FireClient.app to ${target_app}..."
  rm -rf "${target_app}"
  cp -R "${src_app}" "${target_app}"
  xattr -dr com.apple.quarantine "${target_app}" >/dev/null 2>&1 || true
  chmod +x "${target_app}/Contents/MacOS/"* >/dev/null 2>&1 || true

  mkdir -p "${HOME}/.fireclient" "${HOME}/.local/bin"
  cat > "${HOME}/.local/bin/fireclient" <<EOF
#!/usr/bin/env bash
open -a "${target_app}" "\$@"
EOF
  chmod +x "${HOME}/.local/bin/fireclient"

  ok "FireClient installed to ${target_app}"
  ok "Launch from Spotlight / Launchpad or run: open -a \"${target_app}\""
}

if [[ -n "${DMG_URL}" ]]; then
  DMG_FILE="${WORK_DIR}/$(basename "${DMG_URL}")"
  log "Downloading $(basename "${DMG_URL}")..."
  curl -fL --progress-bar "${DMG_URL}" -o "${DMG_FILE}"

  if [[ -n "${SUMS_URL}" ]]; then
    SUMS_FILE="${WORK_DIR}/SHA256SUMS.txt"
    if curl -fsSL "${SUMS_URL}" -o "${SUMS_FILE}" 2>/dev/null; then
      EXPECTED="$(grep -F "$(basename "${DMG_URL}")" "${SUMS_FILE}" | awk '{print tolower($1)}' | head -n 1 || true)"
      if [[ -n "${EXPECTED}" ]]; then
        ACTUAL="$(shasum -a 256 "${DMG_FILE}" | awk '{print tolower($1)}')"
        if [[ "${EXPECTED}" != "${ACTUAL}" ]]; then
          err "SHA-256 mismatch! Expected ${EXPECTED}, got ${ACTUAL}"
          exit 1
        fi
        ok "SHA-256 verified (${ACTUAL:0:16}...)"
      fi
    fi
  fi

  log "Mounting disk image..."
  MOUNT_OUT="$(hdiutil attach "${DMG_FILE}" -nobrowse -readonly)"
  MOUNT_DIR="$(printf "%s\n" "${MOUNT_OUT}" | grep -Eo '/Volumes/.*' | head -n 1)"
  APP_FOUND="$(find "${MOUNT_DIR}" -maxdepth 2 -name "*.app" | head -n 1)"
  if [[ -z "${APP_FOUND}" ]]; then
    err "Could not locate FireClient.app inside mounted DMG."
    exit 1
  fi
  install_app_bundle "${APP_FOUND}"
  exit 0
fi

log "Prebuilt macOS DMG not yet attached to latest tag — building native macOS bundle locally..."
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  err "Node.js 18+ and npm are required to build from source (brew install node)."
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  err "git is required (xcode-select --install)."
  exit 1
fi

SRC_DIR="${WORK_DIR}/src"
git clone --depth 1 "${GIT_URL}" "${SRC_DIR}"
pushd "${SRC_DIR}/desktop" >/dev/null
npm install --no-audit --no-fund
npx electron-builder --mac dir --${ARCH} --publish never
BUILT_APP="$(find dist -maxdepth 3 -name "FireClient.app" | head -n 1)"
if [[ -z "${BUILT_APP}" ]]; then
  err "Local macOS app build did not produce FireClient.app."
  exit 1
fi
install_app_bundle "${BUILT_APP}"
popd >/dev/null
