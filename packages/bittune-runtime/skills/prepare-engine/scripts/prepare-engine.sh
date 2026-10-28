#!/usr/bin/env sh
# Prepare the default image or an approved exact digest from the official repo.
set -eu

usage() {
	echo "usage: prepare-engine.sh <vllm|sglang> [official-repository@sha256:digest]" >&2
	exit 2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
	usage
fi

KIND=$1
VLLM_IMAGE="vllm/vllm-openai:v0.8.5.post1"
SGLANG_IMAGE="lmsysorg/sglang:v0.4.6.post1"

case "$KIND" in
	vllm)
		IMAGE=$VLLM_IMAGE
		REPOSITORY="vllm/vllm-openai"
		;;
	sglang)
		IMAGE=$SGLANG_IMAGE
		REPOSITORY="lmsysorg/sglang"
		;;
	*)
		echo "prepare-engine: engine must be vllm or sglang" >&2
		exit 2
		;;
esac

if [ "$#" -eq 2 ]; then
	case "$2" in
		"$REPOSITORY"@sha256:*) ;;
		*) echo "prepare-engine: exact digest must use the engine's official repository" >&2; exit 2 ;;
	esac
	DIGEST=${2##*@sha256:}
	case "$DIGEST" in
		*[!a-f0-9]* | "") echo "prepare-engine: invalid sha256 digest" >&2; exit 2 ;;
	esac
	if [ "${#DIGEST}" -ne 64 ] || [ "$DIGEST" = "0000000000000000000000000000000000000000000000000000000000000000" ]; then
		echo "prepare-engine: invalid sha256 digest" >&2
		exit 2
	fi
	IMAGE=$2
fi

if ! command -v docker >/dev/null 2>&1; then
	echo "prepare-engine: docker is not installed" >&2
	exit 1
fi

docker pull "$IMAGE"
echo "prepare-engine: $IMAGE is present on this host"
