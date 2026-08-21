#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PATCH_FILE="${SCRIPT_DIR}/sidebar-bottom-bar.patch"
REPO_URL="${HERDR_REPO_URL:-https://github.com/herdrdev/herdr.git}"
HERDR_REF="${HERDR_REF:-8fe09d5ddf77da5c377760682b33b386ebc37640}"
RUST_TOOLCHAIN="${HERDR_RUST_TOOLCHAIN:-1.96.1}"
DEST="${HERDR_BIN:-${HOME}/.local/bin/herdr}"

fail() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

[[ -f "$PATCH_FILE" ]] || fail "patch not found: $PATCH_FILE"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v rustup >/dev/null 2>&1 || fail "rustup is required"

if [[ -z "${ZIG:-}" ]]; then
    if [[ -x /opt/homebrew/opt/zig@0.15/bin/zig ]]; then
        ZIG=/opt/homebrew/opt/zig@0.15/bin/zig
    elif command -v zig >/dev/null 2>&1; then
        ZIG=$(command -v zig)
    else
        fail "Zig 0.15.2 is required; install Homebrew zig@0.15 or set ZIG"
    fi
fi
[[ -x "$ZIG" ]] || fail "Zig executable not found: $ZIG"
case "$($ZIG version)" in
    0.15.*) ;;
    *) fail "Zig 0.15.x is required; found $($ZIG version)" ;;
esac

if ! rustup run "$RUST_TOOLCHAIN" cargo --version >/dev/null 2>&1; then
    rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --component rustfmt
fi

BUILD_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/herdr-patch.XXXXXXXX")
SOURCE_DIR="${BUILD_ROOT}/source"
cleanup() {
    rm -rf "$BUILD_ROOT"
}
trap cleanup EXIT

printf 'Fetching Herdr %s\n' "$HERDR_REF"
git clone --filter=blob:none --no-checkout "$REPO_URL" "$SOURCE_DIR"
git -C "$SOURCE_DIR" fetch --depth 1 origin "$HERDR_REF"
git -C "$SOURCE_DIR" checkout --detach FETCH_HEAD

printf 'Applying %s\n' "$PATCH_FILE"
git -C "$SOURCE_DIR" apply --check "$PATCH_FILE"
git -C "$SOURCE_DIR" apply "$PATCH_FILE"

printf 'Building with Rust %s and %s\n' "$RUST_TOOLCHAIN" "$ZIG"
(
    cd "$SOURCE_DIR"
    ZIG="$ZIG" rustup run "$RUST_TOOLCHAIN" cargo build --release --locked
)

BINARY="${SOURCE_DIR}/target/release/herdr"
[[ -x "$BINARY" ]] || fail "build did not produce $BINARY"
mkdir -p "$(dirname -- "$DEST")"
install -m 755 "$BINARY" "$DEST"
printf 'Installed %s\n' "$DEST"
"$DEST" --version
