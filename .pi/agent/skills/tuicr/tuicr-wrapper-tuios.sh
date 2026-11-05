#!/usr/bin/env bash
set -euo pipefail

TUIOS_BIN="${TUIOS_BIN:-tuios}"
JQ_BIN="${JQ_BIN:-jq}"
REVIEW_TIMEOUT_MS="${TUICR_TIMEOUT_MS:-3600000}"
window_id=""

cleanup() {
    local status=$?
    if [[ -n "$window_id" ]]; then
        "$TUIOS_BIN" close-window --session "$TUIOS_SESSION" "$window_id" >/dev/null 2>&1 || true
    fi
    return "$status"
}

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
    printf 'Usage: %s [directory] [-- tuicr arguments]\n' "$(basename "$0")"
    exit 0
fi
if [[ ${TUIOS_ENV:-} != 1 || -z ${TUIOS_SESSION:-} ]]; then
    printf 'Run this wrapper inside a tuios session.\n' >&2
    exit 1
fi
for program in "$TUIOS_BIN" "$JQ_BIN" tuicr; do
    command -v "$program" >/dev/null 2>&1 || { printf 'Missing program: %s\n' "$program" >&2; exit 1; }
done

target="${1:-.}"
if (( $# )); then shift; fi
if [[ ${1:-} == -- ]]; then shift; fi
target="$(cd "$target" && pwd -P)"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

response="$("$TUIOS_BIN" new-window "tuicr-$$" --session "$TUIOS_SESSION" --cwd "$target" --keep-open --json -- "$(command -v tuicr)" "$@")"
window_id="$(printf '%s\n' "$response" | "$JQ_BIN" -er '.window_id | select(type == "string" and length > 0)')"
printf 'tuicr is running in tuios pane %s\n' "$window_id"
response="$("$TUIOS_BIN" wait-for window-exit --session "$TUIOS_SESSION" --window "$window_id" --timeout "$REVIEW_TIMEOUT_MS" --json)"
status="$(printf '%s\n' "$response" | "$JQ_BIN" -er '.exit_code | select(type == "number")')"
if [[ $status -lt 0 ]]; then
    signal="$(printf '%s\n' "$response" | "$JQ_BIN" -er '.signal | select(type == "number")')"
    status=$((128 + signal))
fi
exit "$status"
