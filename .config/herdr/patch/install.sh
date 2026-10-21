#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO=${HERDR_SOURCE_REPO:-https://github.com/herdrdev/herdr.git}
SOURCE_COMMIT=7b116c05bfda646af39d2524c54e70c751f57ee8
PATCH_SHA256=9338ac3ece2c77c1b3847ea867505f849eff0f2acb4d90ff8d5f7604eae6dce8
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

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    printf 'sha256sum or shasum is required\n' >&2
    exit 1
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
  command -v zig
}

atomic_copy() {
  local source=$1 destination=$2 directory temporary
  directory=$(dirname "$destination")
  [[ ! -d $destination ]] || { printf 'Destination is a directory: %s\n' "$destination" >&2; return 1; }
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

atomic_restore() {
  local source=$1 destination=$2 directory temporary
  directory=$(dirname "$destination")
  temporary=$(mktemp "$directory/.herdr-restore.XXXXXX")
  if ! cp -p "$source" "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  if ! mv -f "$temporary" "$destination"; then
    rm -f "$temporary"
    return 1
  fi
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

write_candidate_metadata() {
  local candidate metadata directory temporary
  candidate=$1
  metadata=$candidate.metadata
  directory=$(dirname "$metadata")
  temporary=$(mktemp "$directory/.herdr-candidate-metadata.XXXXXX")
  {
    printf 'format_version=1\n'
    printf 'source_commit=%s\n' "$SOURCE_COMMIT"
    printf 'patch_sha256=%s\n' "$PATCH_SHA256"
    printf 'candidate_sha256=%s\n' "$(sha256_file "$candidate")"
  } >"$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$metadata"
}

validate_candidate_provenance() {
  local candidate metadata candidate_sha
  candidate=$1
  metadata=$candidate.metadata
  require_file "$metadata"
  [[ $(grep -c '^format_version=' "$metadata") == 1 ]] || { printf 'Invalid candidate metadata format\n' >&2; return 1; }
  [[ $(grep -c '^source_commit=' "$metadata") == 1 ]] || { printf 'Invalid candidate source metadata\n' >&2; return 1; }
  [[ $(grep -c '^patch_sha256=' "$metadata") == 1 ]] || { printf 'Invalid candidate patch metadata\n' >&2; return 1; }
  [[ $(grep -c '^candidate_sha256=' "$metadata") == 1 ]] || { printf 'Invalid candidate hash metadata\n' >&2; return 1; }
  grep -Fxq 'format_version=1' "$metadata"
  grep -Fxq "source_commit=$SOURCE_COMMIT" "$metadata"
  grep -Fxq "patch_sha256=$PATCH_SHA256" "$metadata"
  candidate_sha=$(awk -F= '/^candidate_sha256=/{print $2}' "$metadata")
  [[ $candidate_sha == "$(sha256_file "$candidate")" ]] || {
    printf 'Candidate hash does not match its staged metadata\n' >&2
    return 1
  }
  printf '%s\n' "$candidate_sha"
}

stage() (
  local destination=$1 zig_bin workdir source
  require_file "$PATCH_PATH"
  [[ $(sha256_file "$PATCH_PATH") == "$PATCH_SHA256" ]] || {
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
  trap 'status=$?; rm -rf "$workdir"; exit "$status"' EXIT
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
  write_candidate_metadata "$destination"
  printf 'Staged %s (%s)\n' "$destination" "$(sha256_file "$destination")"
)

activate() (
  local candidate=$1 timestamp backup_dir metadata candidate_sha candidate_snapshot
  local target_directory target_name lock_file lock_token lock_owner
  local had_target=0 replaced_target=0 rollback_failed=0

  # This metadata is an accidental-integrity binding to this repository's pinned inputs,
  # not an authenticated signature. Reject mismatches before executing candidate code.
  candidate_sha=$(validate_candidate_provenance "$candidate")
  target_directory=$(dirname "$TARGET_PATH")
  target_name=$(basename "$TARGET_PATH")
  mkdir -p "$target_directory" "$BACKUP_ROOT"
  lock_file=$target_directory/.$target_name.install.lock
  lock_token="$$:$(date +%s):$RANDOM"

  cleanup() {
    local status=$?
    trap - EXIT INT TERM HUP
    if [[ $status -ne 0 && $replaced_target == 1 ]]; then
      if [[ $had_target == 1 ]]; then
        if atomic_restore "$backup_dir/herdr" "$TARGET_PATH"; then
          printf 'Activation failed; restored the previous Herdr binary from %s\n' "$backup_dir" >&2
        else
          rollback_failed=1
          printf 'CRITICAL: activation and rollback both failed; backup remains at %s\n' "$backup_dir" >&2
        fi
      elif ! rm -f "$TARGET_PATH"; then
        rollback_failed=1
        printf 'CRITICAL: activation failed and the newly created target could not be removed: %s\n' "$TARGET_PATH" >&2
      fi
    fi
    if [[ -f $lock_file ]] && [[ $(cat "$lock_file" 2>/dev/null) == "$lock_token" ]]; then
      rm -f "$lock_file"
    fi
    if [[ $rollback_failed == 1 ]]; then
      exit 1
    fi
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP

  if ! (set -o noclobber; printf '%s\n' "$lock_token" >"$lock_file") 2>/dev/null; then
    lock_owner=$(cat "$lock_file" 2>/dev/null || printf 'unknown')
    printf 'Another Herdr patch activation holds %s (%s). Remove a stale lock only after confirming that process is gone.\n' "$lock_file" "$lock_owner" >&2
    exit 1
  fi

  if [[ -L $TARGET_PATH ]]; then
    printf 'Refusing to replace symlink target: %s\n' "$TARGET_PATH" >&2
    exit 1
  fi
  if [[ -e $TARGET_PATH && ! -f $TARGET_PATH ]]; then
    printf 'Existing target is not a regular file: %s\n' "$TARGET_PATH" >&2
    exit 1
  fi

  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_dir=$(mktemp -d "$BACKUP_ROOT/${timestamp}-unified-sidebar.XXXXXX")
  candidate_snapshot=$backup_dir/candidate
  cp -p "$candidate" "$candidate_snapshot"
  cp -p "$candidate.metadata" "$backup_dir/candidate.metadata"
  [[ $(sha256_file "$candidate_snapshot") == "$candidate_sha" ]] || {
    printf 'Candidate changed while it was being snapshotted\n' >&2
    exit 1
  }
  validate_binary "$candidate_snapshot"

  if [[ -e $TARGET_PATH ]]; then
    cp -p "$TARGET_PATH" "$backup_dir/herdr"
    had_target=1
  fi
  metadata=$backup_dir/metadata.txt
  {
    printf 'source_commit=%s\n' "$SOURCE_COMMIT"
    printf 'patch_sha256=%s\n' "$PATCH_SHA256"
    printf 'candidate_sha256=%s\n' "$candidate_sha"
    if [[ $had_target == 1 ]]; then
      printf 'previous_sha256=%s\n' "$(sha256_file "$backup_dir/herdr")"
    fi
    printf 'target=%s\n' "$TARGET_PATH"
    printf 'installed_at=%s\n' "$timestamp"
  } >"$metadata"

  replaced_target=1
  atomic_copy "$candidate_snapshot" "$TARGET_PATH"
  validate_binary "$TARGET_PATH"
  [[ $(sha256_file "$TARGET_PATH") == "$candidate_sha" ]] || {
    printf 'Installed target hash does not match the staged candidate\n' >&2
    exit 1
  }
  printf 'Installed %s; backup: %s\n' "$TARGET_PATH" "$backup_dir"
  printf 'The running server was not restarted. Reopen Herdr clients to use the patched sidebar.\n'
)

[[ $# -eq 2 ]] || usage
case $1 in
  --stage) stage "$2" ;;
  --activate) activate "$2" ;;
  *) usage ;;
esac
