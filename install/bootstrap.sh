#!/usr/bin/env bash
set -euo pipefail

# Single-command installer. The extracted release directory is its source.
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly INSTALL_ROOT="${BITTUNE_INSTALL_ROOT:-/opt/bittune}"
readonly NODE_VERSION="v22.22.2"
readonly NODE_SHA256="88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a"
die() { printf 'bittune installer: %s\n' "$*" >&2; exit 1; }
log() { printf '[bittune] %s\n' "$*"; }
[[ "$(uname -s)" == Linux ]] || die "Linux is required."
[[ "$(uname -m)" == x86_64 ]] || die "This release supports Linux x86_64 only."
[[ ${EUID} -eq 0 ]] || die "Run the installer with sudo: sudo ./install.sh"
[[ -f "${SCRIPT_DIR}/manifest.json" ]] || die "manifest.json is missing from the release package."
[[ -f "${SCRIPT_DIR}/agent/dist/bittune.js" ]] || die "Bittune payload is missing from the release package."
grep -q '"architecture": "linux-x86_64"' "${SCRIPT_DIR}/manifest.json" || die "Unsupported or invalid package manifest."
if [[ -f "${SCRIPT_DIR}/SHA256SUMS" && -x "$(command -v sha256sum || true)" ]]; then (cd "${SCRIPT_DIR}" && sha256sum --check --status SHA256SUMS) || die "Package integrity verification failed."; fi

detect_user() {
  if [[ -n ${SUDO_USER:-} && ${SUDO_USER} != root ]] && id -u "${SUDO_USER}" >/dev/null 2>&1; then printf '%s' "${SUDO_USER}"; return; fi
  local candidates=() name uid home _rest
  while IFS=: read -r name _ uid _ _ home _rest; do
    [[ ${uid} -ge 1000 && ${uid} -lt 60000 && -d ${home} ]] && candidates+=("${name}")
  done < /etc/passwd
  if [[ ${#candidates[@]} -eq 1 ]]; then printf '%s' "${candidates[0]}"; return; fi
  [[ -n ${BITTUNE_USER:-} ]] && id -u "${BITTUNE_USER}" >/dev/null 2>&1 && printf '%s' "${BITTUNE_USER}" && return
  die "Cannot determine a non-root Linux user; set BITTUNE_USER and rerun."
}
has() { command -v "$1" >/dev/null 2>&1; }
install_system_tools() {
  local missing=() tool; for tool in tar gzip xz sha256sum; do has "${tool}" || missing+=("${tool}"); done; has curl || has wget || missing+=("curl or wget"); [[ ${#missing[@]} -eq 0 ]] && return
  local manager=""; for tool in apt-get dnf yum zypper pacman; do if has "${tool}"; then manager="${tool}"; break; fi; done
  [[ -n ${manager} ]] || die "Missing tools: ${missing[*]}; install them with your distribution package manager."
  log "Installing missing system tools with ${manager}..."
  case ${manager} in
    apt-get) apt-get update; apt-get install -y ca-certificates curl tar xz-utils gzip coreutils ;;
    dnf|yum) "${manager}" install -y ca-certificates curl tar xz gzip coreutils ;;
    zypper) zypper --non-interactive install ca-certificates curl tar xz gzip coreutils ;;
    pacman) pacman -Sy --noconfirm ca-certificates curl tar xz gzip coreutils ;;
  esac
}
check_offline_tools() {
  local missing=() tool; for tool in tar gzip xz sha256sum; do has "${tool}" || missing+=("${tool}"); done
  [[ ${#missing[@]} -eq 0 ]] || die "Offline installation requires: ${missing[*]}. Install them before disconnecting the host."
}
download_node() {
  local stage="$1"
  local archive="${stage}/node.tar.xz"
  local url="https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
  mkdir -p "${stage}"
  if has curl; then curl --fail --location --proto '=https' --tlsv1.2 "${url}" --output "${archive}"; else wget -O "${archive}" "${url}"; fi
  local digest; digest="$(sha256sum "${archive}" | awk '{print $1}')"; [[ ${digest} == "${NODE_SHA256}" ]] || die "Node.js SHA-256 verification failed."
  tar -xJf "${archive}" -C "${stage}"; [[ -x "${stage}/node-${NODE_VERSION}-linux-x64/bin/node" ]] || die "Node.js archive is incomplete."
  rm -rf "${INSTALL_ROOT}/node"; mv "${stage}/node-${NODE_VERSION}-linux-x64" "${INSTALL_ROOT}/node"; rm -rf "${stage}"
}
main() {
  local target_user; target_user="$(detect_user)"; mkdir -p "${INSTALL_ROOT}/staging" "${INSTALL_ROOT}/backups"
  local node_bin="${INSTALL_ROOT}/node/bin/node" offline=false
  if [[ -x "${SCRIPT_DIR}/node-${NODE_VERSION}-linux-x64/bin/node" ]]; then
    offline=true; if [[ ! -x ${node_bin} ]]; then rm -rf "${INSTALL_ROOT}/node"; cp -a "${SCRIPT_DIR}/node-${NODE_VERSION}-linux-x64" "${INSTALL_ROOT}/node"; fi
  elif [[ ! -x ${node_bin} || "$("${node_bin}" --version 2>/dev/null || true)" != "${NODE_VERSION}" ]]; then
    install_system_tools
    download_node "${INSTALL_ROOT}/staging/node"
  fi
  if [[ ${offline} == true ]]; then
    check_offline_tools
  else
    install_system_tools
  fi
  if grep -q '"package_type": "offline"' "${SCRIPT_DIR}/manifest.json" && [[ ${offline} != true ]]; then die "Offline package is missing its bundled Node.js runtime."; fi
  if [[ ${offline} == true && ! -d "${SCRIPT_DIR}/agent/node_modules" ]]; then die "Offline package is missing production node_modules."; fi
  node_bin="${INSTALL_ROOT}/node/bin/node"
  if [[ ${offline} != true && ! -d "${SCRIPT_DIR}/agent/node_modules" ]]; then
    log "Installing Bittune production dependencies..."
    "${INSTALL_ROOT}/node/bin/npm" install --omit=dev --ignore-scripts --prefix "${SCRIPT_DIR}/agent" >/dev/null || die "npm dependency installation failed; check network or proxy settings."
  fi
  local args
  if [[ ${offline} == true ]]; then
    args=(install --offline "${SCRIPT_DIR}" --user "${target_user}" --yes --requirements "${SCRIPT_DIR}/requirements.txt")
  else
    local payload_dir="${INSTALL_ROOT}/staging/payload/package"
    rm -rf "${INSTALL_ROOT}/staging/payload"
    mkdir -p "${payload_dir}"
    cp -a "${SCRIPT_DIR}/agent/." "${payload_dir}/"
    tar -czf "${INSTALL_ROOT}/staging/bittune-payload.tar.gz" -C "${INSTALL_ROOT}/staging/payload" package
    args=(install --package "${INSTALL_ROOT}/staging/bittune-payload.tar.gz" --user "${target_user}" --yes --requirements "${SCRIPT_DIR}/requirements.txt")
  fi
  log "Installing Bittune for ${target_user}..."; "${node_bin}" "${SCRIPT_DIR}/agent/dist/bittune.js" "${args[@]}"
  rm -rf "${INSTALL_ROOT}/staging/bittune-payload.tar.gz" "${INSTALL_ROOT}/staging/payload"
  log "Installed. Run 'bittune version' from any directory."
}
main "$@"
