#!/usr/bin/env bash
# Bittune bootstrap: the only shell in the install path. It prepares a runnable
# pinned Node.js and hands off to the component-driven installer inside the
# release bundle (`node dist/bittune.js install ...`).
#
# Usage:
#   sudo ./bittune-bootstrap.sh --package <bittune-runtime.tgz> <linux-user> [--yes] [--json] [--check-only]
#   sudo ./bittune-bootstrap.sh --offline <bundle-dir>    <linux-user> [--yes] [--json]
# Legacy habit is accepted: ./bittune-bootstrap.sh <tgz-or-bundle-dir> <linux-user>
#
# NODE_VERSION/NODE_SHA256 must stay identical to install/offline-manifest.env
# and packages/bittune-runtime/src/cli/install/components.ts.
set -euo pipefail

readonly NODE_VERSION="v22.22.2"
readonly NODE_SHA256="88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a"
readonly INSTALL_ROOT="${BITTUNE_INSTALL_ROOT:-/opt/bittune}"

die() { echo "bittune-bootstrap: $*" >&2; exit 1; }
log() { echo "[bittune-bootstrap] $*"; }

MODE=""          # package | offline | ""
SOURCE=""
USER_ARG=""
FORWARD=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package|--offline)
      [[ -z ${MODE} ]] || die "只能提供一次安装来源。"
      MODE="${1#--}"; SOURCE="${2:-}"
      [[ -n ${SOURCE} ]] || die "$1 需要一个路径参数。"
      shift 2 ;;
    --user)
      USER_ARG="${2:-}"; shift 2 ;;
    -*)
      FORWARD+=("$1"); shift ;;
    *)
      if [[ -z ${SOURCE} ]]; then
        SOURCE="$1"
        if [[ -d ${SOURCE} ]]; then MODE="offline";
        elif [[ ${SOURCE} == *.tgz || ${SOURCE} == *.tar.gz ]]; then MODE="package";
        fi
      elif [[ -z ${USER_ARG} ]]; then
        USER_ARG="$1"
      else
        FORWARD+=("$1")
      fi
      shift ;;
  esac
done

CHECK_ONLY=false
for flag in "${FORWARD[@]+${FORWARD[@]}}"; do
  if [[ ${flag} == "--check-only" ]]; then CHECK_ONLY=true; fi
done

[[ $(uname -s) == "Linux" ]] || die "仅支持 Linux 宿主机。"
[[ $(uname -m) == "x86_64" ]] || die "发行包仅包含 linux-x64 运行时，需要 x86_64 主机。"

if [[ ${CHECK_ONLY} != true ]]; then
  [[ ${EUID} -eq 0 ]] || die "请使用 sudo 运行（需要写入 ${INSTALL_ROOT} 与 /usr/local/bin）。"
fi

prepare_network_tools() {
  if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 && command -v sha256sum >/dev/null 2>&1; then
    return 0
  fi
  log "补充系统基础工具 ca-certificates/curl/tar…"
  apt-get update >/dev/null
  apt-get install -y --no-install-recommends ca-certificates curl tar
}

append_forward() {
  if [[ ${#FORWARD[@]} -gt 0 ]]; then FORWARD+=("$@"); else FORWARD=("$@"); fi
}

resolve_existing_pinned_node() {
  local candidate="${INSTALL_ROOT}/node/bin/node"
  if [[ -x ${candidate} ]] && [[ "$("${candidate}" --version 2>/dev/null || true)" == "${NODE_VERSION}" ]]; then
    echo "${candidate}"; return 0
  fi
  if command -v node >/dev/null 2>&1 && [[ "$(node --version 2>/dev/null || true)" == "${NODE_VERSION}" ]]; then
    command -v node; return 0
  fi
  return 1
}

fetch_and_install_node() {
  prepare_network_tools
  local stage archive digest extracted
  stage="$(mktemp -d "${INSTALL_ROOT}/.bootstrap-node.XXXXXX")"
  archive="${stage}/node.tar.xz"
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" --output "${archive}"
  digest="$(sha256sum "${archive}" | awk '{print $1}')"
  [[ ${digest} == "${NODE_SHA256}" ]] || { rm -rf "${stage}"; die "Node.js SHA-256 校验失败（期望 ${NODE_SHA256:0:12}…，实际 ${digest:0:12}…）。"; }
  tar -xJf "${archive}" -C "${stage}"
  extracted="${stage}/node-${NODE_VERSION}-linux-x64"
  [[ -x ${extracted}/bin/node ]] || { rm -rf "${stage}"; die "Node.js 解压结果不完整。"; }
  mkdir -p "${INSTALL_ROOT}/backups"
  if [[ -d ${INSTALL_ROOT}/node ]]; then mv "${INSTALL_ROOT}/node" "${INSTALL_ROOT}/backups/node-$(date -u +%Y%m%dT%H%M%S)"; fi
  mv "${extracted}" "${INSTALL_ROOT}/node"
  rm -rf "${stage}"
  echo "${INSTALL_ROOT}/node/bin/node"
}

resolve_node() {
  local resolved
  if resolved="$(resolve_existing_pinned_node)"; then echo "${resolved}"; return 0; fi
  if [[ ${MODE} == "offline" ]]; then
    local bundled="${SOURCE}/node-${NODE_VERSION}-linux-x64/bin/node"
    [[ -x ${bundled} ]] || die "离线包缺少 node-${NODE_VERSION}-linux-x64/bin/node。"
    echo "${bundled}"; return 0
  fi
  if [[ ${MODE} == "package" ]]; then
    fetch_and_install_node; return 0
  fi
  die "--check-only 需要一个 Node ${NODE_VERSION}：请先完成一次安装，或提供 --package/--offline 来源。"
}

stage_agent_dist() {
  if [[ ${MODE} == "offline" ]]; then
    [[ -f "${SOURCE}/agent/dist/bittune.js" ]] || die "离线包缺少 agent/dist/bittune.js。"
    if [[ -f "${SOURCE}/SHA256SUMS" ]]; then
      (cd "${SOURCE}" && sha256sum --check --status SHA256SUMS) || die "离线包完整性校验失败。"
    fi
    echo "${SOURCE}/agent/dist/bittune.js"
    echo ""
    return 0
  fi
  prepare_network_tools
  local stage
  stage="$(mktemp -d "${INSTALL_ROOT}/.bootstrap-dist.XXXXXX")"
  tar -xzf "${SOURCE}" --strip-components=1 -C "${stage}"
  if [[ ! -f "${stage}/dist/bittune.js" ]]; then rm -rf "${stage}"; die "发行包缺少 dist/bittune.js。"; fi
  echo "${stage}/dist/bittune.js"
  echo "${stage}"
}

main() {
  if [[ -z ${SOURCE} && ${CHECK_ONLY} != true ]]; then
    die "必须通过 --package <tgz> 或 --offline <bundle目录> 提供安装来源。"
  fi
  if [[ -n ${MODE} && ${MODE} != package && ${MODE} != offline ]]; then
    die "无法识别来源类型：${SOURCE}；请显式使用 --package 或 --offline。"
  fi

  local node_bin dist_file="" dist_stage=""
  node_bin="$(resolve_node)"
  if [[ -n ${SOURCE} ]]; then
    local parts=()
    mapfile -t parts < <(stage_agent_dist)
    dist_file="${parts[0]}"
    dist_stage="${parts[1]:-}"
  fi
  if [[ -z ${dist_file} ]]; then
    dist_file="${INSTALL_ROOT}/agent/dist/bittune.js"
    [[ -f ${dist_file} ]] || die "未找到已安装的 Bittune；check-only 需要 --package/--offline 来源或已完成的基础安装。"
  fi

  [[ -n ${USER_ARG} ]] || USER_ARG="${SUDO_USER:-}"

  append_forward --user "${USER_ARG}"
  if [[ ${MODE} == "package" ]]; then append_forward --package "${SOURCE}"; fi
  if [[ ${MODE} == "offline" ]]; then append_forward --offline "${SOURCE}"; fi

  local rc=0
  "${node_bin}" "${dist_file}" install ${FORWARD[@]+"${FORWARD[@]}"} || rc=$?
  if [[ -n ${dist_stage} ]]; then rm -rf "${dist_stage}"; fi
  exit "${rc}"
}

main "$@"
