#!/usr/bin/env sh
# Prepare local Hugging Face model weights. Only model_id and optional revision
# are accepted. Does not write under BitTune protected roots and does not deploy.
set -eu

usage() {
	echo "usage: prepare-model.sh <model_id> [revision]" >&2
	exit 2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
	usage
fi

MODEL_ID=$1
REVISION=${2-}

case "$MODEL_ID" in
	*[!A-Za-z0-9._/-]* | "" | /* | *..*)
		echo "prepare-model: invalid model id" >&2
		exit 2
		;;
esac
case "$MODEL_ID" in
	*/*)
		;;
	*)
		echo "prepare-model: model id must look like org/name" >&2
		exit 2
		;;
esac

if [ -n "$REVISION" ]; then
	case "$REVISION" in
		*[!A-Za-z0-9._/-]* | "" | *..*)
			echo "prepare-model: invalid revision" >&2
			exit 2
			;;
	esac
fi

HOME_DIR=${HOME:-}
BITTUNE_HOME=${BITTUNE_HOME:-$HOME_DIR/.bittune}
CACHE_DIR=${HF_HUB_CACHE:-${HF_HOME:-$HOME_DIR/.cache/huggingface}/hub}

case "$CACHE_DIR" in
	"$BITTUNE_HOME" | "$BITTUNE_HOME"/*)
		echo "prepare-model: model cache must not be under BitTune home" >&2
		exit 2
		;;
esac

if ! command -v hf >/dev/null 2>&1; then
	echo "prepare-model: Hugging Face CLI (hf) is not installed" >&2
	exit 1
fi

if [ -n "$REVISION" ]; then
	hf download "$MODEL_ID" --revision "$REVISION"
else
	hf download "$MODEL_ID"
fi
