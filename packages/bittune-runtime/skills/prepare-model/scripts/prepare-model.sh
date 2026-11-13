#!/usr/bin/env sh
# Prepare model weights with the selected provider's existing SDK/CLI.
set -eu

usage() {
	echo "usage: prepare-model.sh <model_id> [revision] [huggingface|modelscope]" >&2
	exit 2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
	usage
fi

MODEL_ID=$1
REVISION=${2-}
SOURCE=${3-${BITTUNE_MODEL_SOURCE:-huggingface}}
case "$SOURCE" in
	huggingface | modelscope) ;;
	*) echo "prepare-model: source must be huggingface or modelscope" >&2; exit 2 ;;
esac

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
if [ "$SOURCE" = modelscope ]; then
	CACHE_DIR=${MODELSCOPE_CACHE:-$HOME_DIR/.cache/modelscope/hub}
fi

for PROTECTED_DIR in "$BITTUNE_HOME" "${BITTUNE_CORE_HOME:-$BITTUNE_HOME/core}"; do
	case "$CACHE_DIR" in
		"$PROTECTED_DIR" | "$PROTECTED_DIR"/*)
			echo "prepare-model: model cache must not be under BitTune home or Core" >&2
			exit 2
			;;
	esac
done

if [ "$SOURCE" = modelscope ]; then
	SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
	echo "prepare-model: source=modelscope"
	exec "${BITTUNE_CORE_PYTHON:-python3}" "$SCRIPT_DIR/prepare-model-modelscope.py" "$MODEL_ID" "$REVISION" "$CACHE_DIR"
fi

if ! command -v hf >/dev/null 2>&1; then
	echo "prepare-model: Hugging Face CLI (hf) is not installed" >&2
	exit 1
fi

if [ -n "$REVISION" ]; then
	hf download "$MODEL_ID" --revision "$REVISION"
else
	hf download "$MODEL_ID"
fi
