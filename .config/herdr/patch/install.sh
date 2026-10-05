#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO=${HERDR_SOURCE_REPO:-https://github.com/herdrdev/herdr.git}
SOURCE_COMMIT=7b116c05bfda646af39d2524c54e70c751f57ee8
PATCH_SHA256=b60af98ce93028358133962af8f4cdf3989cbb199b07aa25eefbc7705fa5c81d
RUST_TOOLCHAIN=1.96.1
ZIG_VERSION=0.16.0
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PATCH_PATH=$SCRIPT_DIR/sidebar-unified-agents.patch
TARGET_PATH=${HERDR_INSTALL_PATH:-$HOME/.local/bin/herdr}
BACKUP_ROOT=${HERDR_BACKUP_ROOT:-$HOME/.local/state/herdr/install-backups}
CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$HOME/.cache/herdr-unified-sidebar-target}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s --stage PATH | --activate CANDIDATE\n' "$0" >&2
  exit 2
}

require_file() {
  [[ -f $1 ]] || fail "missing file: $1"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail 'sha256sum or shasum is required'
  fi
}

find_zig() {
  local candidate
  if [[ -n ${ZIG:-} && -x $ZIG ]]; then
    printf '%s\n' "$ZIG"
    return
  fi
  for candidate in \
    "$HOME/.local/share/mise/installs/zig/$ZIG_VERSION/zig" \
    "/opt/homebrew/opt/zig@$ZIG_VERSION/bin/zig" \
    "/usr/local/opt/zig@$ZIG_VERSION/bin/zig" \
    /opt/homebrew/bin/zig \
    /usr/local/bin/zig; do
    if [[ -x $candidate ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  command -v zig 2>/dev/null || return 1
}

atomic_copy() {
  local source=$1 destination=$2 directory temporary
  directory=$(dirname "$destination")
  [[ ! -d $destination ]] || fail "destination is a directory: $destination"
  mkdir -p "$directory"
  temporary=$(mktemp "$directory/.herdr-install.XXXXXX")
  if ! install -m 0755 "$source" "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  if ! mv -f "$temporary" "$destination"; then
    rm -f "$temporary"
    return 1
  fi
}

validate_binary() {
  local binary=$1 version
  [[ -x $binary ]] || fail "candidate is not executable: $binary"
  version=$($binary --version 2>&1) || fail "candidate version check failed: $binary"
  [[ $version == 'herdr 0.9.3' ]] || fail "unexpected candidate version: $version"
  "$binary" config check >/dev/null || fail "candidate config check failed: $binary"
}

stage() (
  local destination=$1 zig_bin workdir source
  require_file "$PATCH_PATH"
  [[ $(sha256_file "$PATCH_PATH") == "$PATCH_SHA256" ]] || fail "patch hash mismatch: $PATCH_PATH"
  command -v git >/dev/null 2>&1 || fail 'git is required'
  command -v rustup >/dev/null 2>&1 || fail 'rustup is required'
  rustup run "$RUST_TOOLCHAIN" cargo --version >/dev/null 2>&1 || fail "Rust $RUST_TOOLCHAIN is required"
  rustup run "$RUST_TOOLCHAIN" cargo clippy --version >/dev/null 2>&1 || fail "Clippy for Rust $RUST_TOOLCHAIN is required"
  zig_bin=$(find_zig) || fail "Zig $ZIG_VERSION is required"
  [[ $($zig_bin version) == "$ZIG_VERSION" ]] || fail "Zig $ZIG_VERSION is required; found $($zig_bin version)"

  workdir=$(mktemp -d "${TMPDIR:-/tmp}/herdr-unified-sidebar.XXXXXX")
  trap 'rm -rf "$workdir"' EXIT
  source=$workdir/herdr
  git clone --quiet --no-checkout "$SOURCE_REPO" "$source"
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
  printf 'Staged %s (%s)\n' "$destination" "$(sha256_file "$destination")"
)

activate() {
  local candidate=$1 timestamp backup_dir metadata
  validate_binary "$candidate"
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_dir=$BACKUP_ROOT/$timestamp-unified-sidebar
  [[ ! -e $backup_dir ]] || fail "backup already exists: $backup_dir"
  mkdir -p "$backup_dir"
  if [[ -e $TARGET_PATH || -L $TARGET_PATH ]]; then
    install -m 0755 "$TARGET_PATH" "$backup_dir/herdr"
  fi
  metadata=$backup_dir/metadata.txt
  {
    printf 'source_commit=%s\n' "$SOURCE_COMMIT"
    printf 'patch_sha256=%s\n' "$PATCH_SHA256"
    printf 'candidate_sha256=%s\n' "$(sha256_file "$candidate")"
    if [[ -f $backup_dir/herdr ]]; then
      printf 'previous_sha256=%s\n' "$(sha256_file "$backup_dir/herdr")"
    fi
    printf 'target=%s\n' "$TARGET_PATH"
    printf 'installed_at=%s\n' "$timestamp"
  } >"$metadata"
  atomic_copy "$candidate" "$TARGET_PATH"
  validate_binary "$TARGET_PATH"
  cmp -s "$candidate" "$TARGET_PATH"
  printf 'Installed %s; backup: %s\n' "$TARGET_PATH" "$backup_dir"
  printf 'The running server was not restarted. Reopen Herdr clients to use the patched sidebar.\n'
}

[[ $# -eq 2 ]] || usage
case $1 in
  --stage) stage "$2" ;;
  --activate) activate "$2" ;;
  *) usage ;;
esac
