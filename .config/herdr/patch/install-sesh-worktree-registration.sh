#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO=${SESH_SOURCE_REPO:-https://github.com/fullerzz/herdr-plugin-sesh.git}
SOURCE_COMMIT=ed6d355933923c2c150fc3b466bafb619c0af7ea
PATCH_SHA256=b2b6d4c74edd0b2e91208c3ce8591d98dabf351a6621ebca19593310a1acb41d
VERSION=0.14.0
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PATCH_PATH=$SCRIPT_DIR/sesh-worktree-registration.patch
BACKUP_ROOT=${SESH_BACKUP_ROOT:-$HOME/.local/state/herdr-sesh/install-backups}
PLUGIN_STATE=${HERDR_PLUGINS_JSON:-$HOME/.config/herdr/plugins.json}

usage() {
  printf 'Usage: %s --stage PATH | --activate CANDIDATE | --install\n' "$0" >&2
  exit 2
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

plugin_target() {
  local root
  root=$(jq -er '.[] | select(.plugin_id == "fullerzz.sesh" and .enabled == true) | .plugin_root' "$PLUGIN_STATE")
  printf '%s/bin/herdr-sesh\n' "$root"
}

validate_binary() {
  local binary=$1
  [[ -x $binary ]] || { printf 'Candidate is not executable: %s\n' "$binary" >&2; exit 1; }
  [[ $($binary version) == "herdr-sesh $VERSION" ]] || {
    printf 'Unexpected candidate version: %s\n' "$($binary version 2>&1)" >&2
    exit 1
  }
  "$binary" config validate >/dev/null
}

atomic_copy() {
  local source=$1 destination=$2 directory temporary
  directory=$(dirname "$destination")
  [[ ! -d $destination ]] || { printf 'Destination is a directory: %s\n' "$destination" >&2; return 1; }
  mkdir -p "$directory"
  temporary=$(mktemp "$directory/.herdr-sesh-install.XXXXXX")
  if ! install -m 0755 "$source" "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  if ! mv -f "$temporary" "$destination"; then
    rm -f "$temporary"
    return 1
  fi
}

stage() (
  local destination=$1 workdir source
  if [[ $(uname) == Darwin ]]; then
    # Go's filepath.EvalSymlinks canonicalizes /var to /private/var on macOS.
    # Keep test-created paths canonical so worktree resolution assertions agree.
    export TMPDIR=/private/tmp
  fi
  [[ -f $PATCH_PATH ]] || { printf 'Missing patch: %s\n' "$PATCH_PATH" >&2; exit 1; }
  [[ $(sha256_file "$PATCH_PATH") == "$PATCH_SHA256" ]] || {
    printf 'Patch hash mismatch: %s\n' "$PATCH_PATH" >&2
    exit 1
  }
  command -v git >/dev/null
  command -v go >/dev/null
  workdir=$(mktemp -d)
  trap 'rm -rf -- "$workdir"' EXIT
  source=$workdir/herdr-sesh
  git clone --quiet --no-checkout -- "$SOURCE_REPO" "$source"
  git -C "$source" checkout --quiet --detach "$SOURCE_COMMIT"
  git -C "$source" apply --check "$PATCH_PATH"
  git -C "$source" apply "$PATCH_PATH"
  git -C "$source" diff --check
  [[ -z $(find "$source/internal" -type f -name '*.go' -print0 | xargs -0 gofmt -l) ]]
  (cd "$source" && go test ./...)
  (cd "$source" && go build -ldflags="-X=github.com/fullerzz/herdr-plugin-sesh/internal/app.Version=$VERSION" -o "$destination" ./cmd/herdr-sesh)
  validate_binary "$destination"
  printf 'Staged %s (%s)\n' "$destination" "$(sha256_file "$destination")"
)

activate() {
  local candidate=$1 target timestamp backup_dir
  validate_binary "$candidate"
  target=$(plugin_target)
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_dir=$BACKUP_ROOT/$timestamp-worktree-registration
  mkdir -p -- "$backup_dir"
  if [[ -e $target ]]; then
    cp -a -- "$target" "$backup_dir/herdr-sesh"
  fi
  {
    printf 'source_commit=%s\n' "$SOURCE_COMMIT"
    printf 'patch_sha256=%s\n' "$PATCH_SHA256"
    printf 'candidate_sha256=%s\n' "$(sha256_file "$candidate")"
    printf 'target=%s\n' "$target"
    printf 'installed_at=%s\n' "$timestamp"
  } >"$backup_dir/metadata.txt"
  atomic_copy "$candidate" "$target"
  validate_binary "$target"
  cmp -s -- "$candidate" "$target"
  printf 'Installed %s; backup: %s\n' "$target" "$backup_dir"
}

install_all() (
  local candidate
  candidate=$(mktemp /tmp/herdr-sesh-worktree-registration.XXXXXX)
  trap 'rm -f -- "$candidate"' EXIT
  stage "$candidate"
  activate "$candidate"
)

case ${1:-} in
  --stage) [[ $# == 2 ]] || usage; stage "$2" ;;
  --activate) [[ $# == 2 ]] || usage; activate "$2" ;;
  --install) [[ $# == 1 ]] || usage; install_all ;;
  *) usage ;;
esac
