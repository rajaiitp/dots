#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO=${HERDR_SOURCE_REPO:-https://github.com/herdrdev/herdr.git}
SOURCE_COMMIT=7b116c05bfda646af39d2524c54e70c751f57ee8
PATCH_SHA256=e79d60d535518c0ffeee933a6336377574da1af445bb56bd742fcea4f69d821d
RUST_TOOLCHAIN=1.96.1
ZIG_VERSION=0.16.0
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PATCH_PATH=$SCRIPT_DIR/sidebar-unified-agents.patch
TARGET_PATH=${HERDR_INSTALL_PATH:-$HOME/.local/bin/herdr}
BACKUP_ROOT=${HERDR_BACKUP_ROOT:-$HOME/.local/state/herdr/install-backups}
CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$HOME/.cache/herdr-unified-sidebar-target}

usage() {
  printf 'Usage: %s --stage PATH | --activate CANDIDATE\n' "$0" >&2
  exit 2
}

require_file() {
  [[ -f $1 ]] || { printf 'Missing file: %s\n' "$1" >&2; exit 1; }
}

find_zig() {
  if [[ -n ${ZIG:-} && -x $ZIG ]]; then
    printf '%s\n' "$ZIG"
    return
  fi
  local mise_zig=$HOME/.local/share/mise/installs/zig/$ZIG_VERSION/zig
  if [[ -x $mise_zig ]]; then
    printf '%s\n' "$mise_zig"
    return
  fi
  command -v zig
}

atomic_copy() {
  local source=$1 destination=$2 directory temporary
  directory=$(dirname -- "$destination")
  mkdir -p -- "$directory"
  temporary=$(mktemp --tmpdir="$directory" .herdr-install.XXXXXX)
  if ! install -m 0755 -- "$source" "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  mv -fT -- "$temporary" "$destination"
}

validate_binary() {
  local binary=$1
  [[ -x $binary ]] || { printf 'Candidate is not executable: %s\n' "$binary" >&2; exit 1; }
  [[ $($binary --version) == 'herdr 0.9.3' ]] || {
    printf 'Unexpected candidate version: %s\n' "$($binary --version 2>&1)" >&2
    exit 1
  }
  "$binary" config check >/dev/null
}

stage() (
  local destination=$1 zig_bin workdir source
  require_file "$PATCH_PATH"
  [[ $(sha256sum "$PATCH_PATH" | awk '{print $1}') == "$PATCH_SHA256" ]] || {
    printf 'Patch hash mismatch: %s\n' "$PATCH_PATH" >&2
    exit 1
  }
  rustup run "$RUST_TOOLCHAIN" cargo --version >/dev/null
  rustup run "$RUST_TOOLCHAIN" cargo clippy --version >/dev/null
  zig_bin=$(find_zig)
  [[ $($zig_bin version) == "$ZIG_VERSION" ]] || {
    printf 'Zig %s is required; found %s\n' "$ZIG_VERSION" "$($zig_bin version)" >&2
    exit 1
  }

  workdir=$(mktemp -d)
  trap 'rm -rf -- "$workdir"' EXIT
  source=$workdir/herdr
  git clone --quiet --no-checkout -- "$SOURCE_REPO" "$source"
  git -C "$source" checkout --quiet --detach "$SOURCE_COMMIT"
  [[ $(git -C "$source" rev-parse HEAD) == "$SOURCE_COMMIT" ]]
  git -C "$source" apply --check "$PATCH_PATH"
  git -C "$source" apply "$PATCH_PATH"
  git -C "$source" diff --check

  export CARGO_TARGET_DIR
  export CARGO_INCREMENTAL=0
  export ZIG=$zig_bin
  rustup run "$RUST_TOOLCHAIN" cargo fmt --manifest-path "$source/Cargo.toml" --all --check
  rustup run "$RUST_TOOLCHAIN" cargo clippy --manifest-path "$source/Cargo.toml" --all-targets --locked -- -D warnings
  rustup run "$RUST_TOOLCHAIN" cargo test --manifest-path "$source/Cargo.toml" --locked 'client::shell::tests::'
  rustup run "$RUST_TOOLCHAIN" cargo build --manifest-path "$source/Cargo.toml" --release --locked

  atomic_copy "$CARGO_TARGET_DIR/release/herdr" "$destination"
  validate_binary "$destination"
  printf 'Staged %s (%s)\n' "$destination" "$(sha256sum "$destination" | awk '{print $1}')"
)

activate() {
  local candidate=$1 timestamp backup_dir metadata
  validate_binary "$candidate"
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_dir=$BACKUP_ROOT/$timestamp-unified-sidebar
  mkdir -p -- "$backup_dir"
  if [[ -e $TARGET_PATH ]]; then
    cp -a -- "$TARGET_PATH" "$backup_dir/herdr"
  fi
  metadata=$backup_dir/metadata.txt
  {
    printf 'source_commit=%s\n' "$SOURCE_COMMIT"
    printf 'patch_sha256=%s\n' "$PATCH_SHA256"
    printf 'candidate_sha256=%s\n' "$(sha256sum "$candidate" | awk '{print $1}')"
    if [[ -f $backup_dir/herdr ]]; then
      printf 'previous_sha256=%s\n' "$(sha256sum "$backup_dir/herdr" | awk '{print $1}')"
    fi
    printf 'target=%s\n' "$TARGET_PATH"
    printf 'installed_at=%s\n' "$timestamp"
  } >"$metadata"
  atomic_copy "$candidate" "$TARGET_PATH"
  validate_binary "$TARGET_PATH"
  cmp -s -- "$candidate" "$TARGET_PATH"
  printf 'Installed %s; backup: %s\n' "$TARGET_PATH" "$backup_dir"
  printf 'The running server was not restarted. Reopen Herdr clients to use the patched sidebar.\n'
}

[[ $# -eq 2 ]] || usage
case $1 in
  --stage) stage "$2" ;;
  --activate) activate "$2" ;;
  *) usage ;;
esac
