#!/usr/bin/env bash
set -euo pipefail
# runtime_selection=runtime-free; GPU providers and Docker images are not part of this bundle.
ONLINE_PACKAGE="${1:?usage: build-offline-bundle.sh <online-package.tar.gz> <output-dir>}"
OUTPUT_DIR="${2:?usage: build-offline-bundle.sh <online-package.tar.gz> <output-dir>}"
VERSION="$(basename "${ONLINE_PACKAGE}" | sed -n 's/^bittune-\([0-9][0-9.]*\)-linux-x86_64\.tar\.gz$/\1/p')"
[[ -n ${VERSION} ]] || { echo "Online package name must be bittune-<version>-linux-x86_64.tar.gz" >&2; exit 1; }
NODE_VERSION="${NODE_VERSION:-v22.22.2}"
NODE_SHA256="${NODE_SHA256:-88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a}"
[[ "$(uname -m)" == x86_64 ]] || { echo "Linux x86_64 is required" >&2; exit 1; }
for command in tar curl sha256sum; do command -v "${command}" >/dev/null || { echo "Missing ${command}" >&2; exit 1; }; done
mkdir -p "${OUTPUT_DIR}"; STAGE="$(mktemp -d "${OUTPUT_DIR}/.offline.XXXXXX")"; trap 'rm -rf "${STAGE}"' EXIT
ROOT="${STAGE}/bittune-${VERSION}-linux-x86_64-offline"; mkdir -p "${ROOT}"
tar -xzf "${ONLINE_PACKAGE}" --strip-components=1 -C "${ROOT}"
[[ -f "${ROOT}/manifest.json" && -f "${ROOT}/agent/package.json" && -f "${ROOT}/agent/dist/bittune.js" ]] || { echo "Online package has invalid structure" >&2; exit 1; }
grep -q '"package_type": "online"' "${ROOT}/manifest.json" || { echo "Online package manifest is invalid" >&2; exit 1; }
ARCHIVE="${ROOT}/node-${NODE_VERSION}-linux-x64.tar.xz"
curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" -o "${ARCHIVE}"
echo "${NODE_SHA256}  ${ARCHIVE}" | sha256sum --check --status; tar -xJf "${ARCHIVE}" -C "${ROOT}"; rm -f "${ARCHIVE}"
NODE_BIN="${ROOT}/node-${NODE_VERSION}-linux-x64/bin/node"
PATH="$(dirname "${NODE_BIN}"):${PATH}" "${ROOT}/node-${NODE_VERSION}-linux-x64/bin/npm" install --omit=dev --ignore-scripts --prefix "${ROOT}/agent"
[[ -d "${ROOT}/agent/node_modules" ]] || { echo "Offline package is missing production node_modules" >&2; exit 1; }
sed -i 's/"package_type": "online"/"package_type": "offline",\n  "bundled_node": true,\n  "bundled_node_modules": true/' "${ROOT}/manifest.json"
(cd "${ROOT}" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
tar -C "${STAGE}" -czf "${OUTPUT_DIR}/bittune-${VERSION}-linux-x86_64-offline.tar.gz" "$(basename "${ROOT}")"
printf '%s\n' "${OUTPUT_DIR}/bittune-${VERSION}-linux-x86_64-offline.tar.gz"
