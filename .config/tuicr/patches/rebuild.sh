#!/usr/bin/env bash
# Build and install the custom tuicr fork used by this dotfiles setup.
set -euo pipefail

repo_url="${TUICR_REPO_URL:-https://github.com/rajaiitp/tuicr.git}"
branch="${TUICR_REPO_BRANCH:-main}"
install_root="${CARGO_INSTALL_ROOT:-$HOME/.local}"

# A fresh rustup install may not have been sourced into this shell yet.
if ! command -v cargo >/dev/null 2>&1 && [[ -r "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
fi

if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo is required to build custom tuicr" >&2
    exit 1
fi
if ! command -v git >/dev/null 2>&1; then
    echo "git is required to fetch custom tuicr" >&2
    exit 1
fi

build_dir=$(mktemp -d "${TMPDIR:-/tmp}/tuicr-build.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT

printf 'Fetching custom tuicr from %s (%s)\n' "$repo_url" "$branch"
git clone --depth=1 --branch "$branch" "$repo_url" "$build_dir/source"

# The fork is based on upstream and retains agavra/tuicr in Cargo metadata.
# Rewrite it in the throw-away checkout so `tuicr update` cannot silently
# replace the custom binary with an upstream release.
metadata="$build_dir/source/Cargo.toml"
awk '{ gsub("https://github.com/agavra/tuicr", "https://github.com/rajaiitp/tuicr"); print }' \
    "$metadata" > "$metadata.tmp"
mv "$metadata.tmp" "$metadata"

mkdir -p "$install_root/bin"
printf 'Installing custom tuicr into %s/bin\n' "$install_root"
cargo install \
    --path "$build_dir/source" \
    --locked \
    --root "$install_root" \
    --force

"$install_root/bin/tuicr" --version
