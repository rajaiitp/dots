#!/usr/bin/env bash
set -euo pipefail

readonly SOURCE_URL="https://github.com/Gaurav-Gosain/tuios.git"
readonly BASE_COMMIT="3638a6f2093edfa7396b6233515786de4dbda683"
readonly VERSION="0.11.0"
readonly PATCH_SHA256="6eff88a51795514b9f1c6c9805b74497d4f56f4603013f89ef5e7de101c7c7c0"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PATCH_FILE="$SCRIPT_DIR/sidebar-unified-agents.patch"
readonly STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tuios-unified-sidebar"
readonly CANDIDATE="$STATE_DIR/tuios-$BASE_COMMIT"
readonly META="$STATE_DIR/tuios-$BASE_COMMIT.meta"
readonly BACKUP_DIR="$STATE_DIR/backups"
readonly ORIGINAL_BACKUP="$BACKUP_DIR/original-tuios"
readonly ORIGINAL_NONE="$BACKUP_DIR/original-none"
readonly BIN_DIR="${HOME}/.local/bin"
readonly TARGET="$BIN_DIR/tuios"
readonly LOCK_FILE="$STATE_DIR/install.lock"

usage() {
  printf 'usage: %s [--install|--stage-only|--activate|--rollback|--status]\n' "$0"
}

require() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

validate_patch() {
  local actual
  actual="$(sha256_file "$PATCH_FILE")"
  if [[ "$actual" != "$PATCH_SHA256" ]]; then
    printf 'patch checksum mismatch: got %s, want %s\n' "$actual" "$PATCH_SHA256" >&2
    exit 1
  fi
}

validate_runnable_binary() {
  local binary=$1 output
  [[ -x "$binary" ]] || {
    printf 'binary is not executable: %s\n' "$binary" >&2
    exit 1
  }
  output="$($binary --version 2>&1)"
  grep -Fq "tuios version " <<<"$output" || {
    printf 'unexpected binary identity:\n%s\n' "$output" >&2
    exit 1
  }
}

validate_binary() {
  local binary=$1 output
  validate_runnable_binary "$binary"
  output="$($binary --version 2>&1)"
  grep -Fq "tuios version $VERSION" <<<"$output" || {
    printf 'unexpected candidate version:\n%s\n' "$output" >&2
    exit 1
  }
  grep -Fq "Commit: $BASE_COMMIT" <<<"$output" || {
    printf 'unexpected candidate commit:\n%s\n' "$output" >&2
    exit 1
  }
}

meta_value() {
  local key=$1 file=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found=1; exit } END { if (!found) exit 1 }' "$file"
}

validate_candidate_bundle() {
  validate_patch
  [[ -f "$META" ]] || {
    printf 'candidate metadata is missing: %s\n' "$META" >&2
    exit 1
  }
  local meta_base meta_patch meta_binary actual_binary
  meta_base="$(meta_value base_commit "$META")"
  meta_patch="$(meta_value patch_sha256 "$META")"
  meta_binary="$(meta_value binary_sha256 "$META")"
  actual_binary="$(sha256_file "$CANDIDATE")"
  [[ "$meta_base" == "$BASE_COMMIT" ]] || {
    printf 'candidate metadata base mismatch: got %s, want %s\n' "$meta_base" "$BASE_COMMIT" >&2
    exit 1
  }
  [[ "$meta_patch" == "$PATCH_SHA256" ]] || {
    printf 'candidate metadata patch mismatch: got %s, want %s\n' "$meta_patch" "$PATCH_SHA256" >&2
    exit 1
  }
  [[ "$meta_binary" == "$actual_binary" ]] || {
    printf 'candidate binary checksum mismatch: got %s, want %s\n' "$actual_binary" "$meta_binary" >&2
    exit 1
  }
  validate_binary "$CANDIDATE"
}

ensure_original_backup() {
  if [[ -e "$ORIGINAL_BACKUP" && -e "$ORIGINAL_NONE" ]]; then
    printf 'conflicting original backup markers in %s\n' "$BACKUP_DIR" >&2
    exit 1
  fi
  [[ -e "$ORIGINAL_BACKUP" || -e "$ORIGINAL_NONE" ]] && return

  local legacy legacy_name temp
  legacy="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'tuios-*' -printf '%T@ %p\n' | sort -n | head -1 | cut -d' ' -f2-)"
  if [[ -n "$legacy" ]]; then
    legacy_name="$(basename "$legacy")"
    if [[ "$legacy_name" == tuios-none-* ]]; then
      temp="$ORIGINAL_NONE.tmp"
      : >"$temp"
      mv -f "$temp" "$ORIGINAL_NONE"
      return
    fi
    validate_runnable_binary "$legacy"
    install -m 0755 "$legacy" "$ORIGINAL_BACKUP.tmp"
    mv -f "$ORIGINAL_BACKUP.tmp" "$ORIGINAL_BACKUP"
    return
  fi

  if [[ -e "$TARGET" ]]; then
    validate_runnable_binary "$TARGET"
    install -m 0755 "$TARGET" "$ORIGINAL_BACKUP.tmp"
    mv -f "$ORIGINAL_BACKUP.tmp" "$ORIGINAL_BACKUP"
  else
    temp="$ORIGINAL_NONE.tmp"
    : >"$temp"
    mv -f "$temp" "$ORIGINAL_NONE"
  fi
}

stage() {
  require git
  require go
  require gofmt
  require sha256sum
  require nice
  require taskset
  validate_patch

  local work source built date
  work="$(mktemp -d "$STATE_DIR/build.XXXXXX")"
  trap "rm -rf -- '$work'" EXIT
  source="$work/source"
  built="$work/tuios"
  date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  git init -q "$source"
  git -C "$source" remote add origin "$SOURCE_URL"
  git -C "$source" fetch -q --depth 1 origin "$BASE_COMMIT"
  git -C "$source" checkout -q --detach FETCH_HEAD
  [[ "$(git -C "$source" rev-parse HEAD)" == "$BASE_COMMIT" ]] || {
    printf 'source checkout is not the pinned commit\n' >&2
    exit 1
  }
  git -C "$source" apply --check "$PATCH_FILE"
  git -C "$source" apply "$PATCH_FILE"

  mapfile -t go_files < <(git -C "$source" diff --name-only -- '*.go')
  if ((${#go_files[@]})); then
    (cd "$source" && gofmt -w "${go_files[@]}")
  fi
  git -C "$source" diff --check
  git -C "$source" apply --check --reverse "$PATCH_FILE"

  (
    cd "$source"
    nice -n 10 taskset -c 0-5 go test ./internal/config/...
    nice -n 10 taskset -c 0-5 go test ./internal/app/... -run 'TestOverview|TestCollapsedOverview|TestSidebarDock|TestClosingTheLastPane|TestTheNextSession|TestSectionEditorSwitches|TestCompactRail|TestSidebarFitsNarrowScreens|TestRailSectionsNeverOverlapAtAnyHeight|TestRailAddressingHoldsAcrossEveryCombination|TestTheRailKeepsItsWidthAcrossSessions|TestDraggedInactiveFlatWorkspaceTabUsesAccent|TestDetachConsumesKeyboardResetReply|TestDetachKeyboardResetWaitTimesOut' -count=1
    nice -n 10 taskset -c 0-5 go vet ./internal/config/... ./internal/app/...
    CGO_ENABLED=0 nice -n 10 taskset -c 0-5 go build -trimpath \
      -ldflags "-s -w -X main.version=$VERSION -X main.commit=$BASE_COMMIT -X main.date=$date -X main.builtBy=pi-overview-patch" \
      -o "$built" ./cmd/tuios
    (
      cd e2e/tui
      TUIOS_E2E=1 TUIOS_E2E_BIN="$built" nice -n 10 taskset -c 0-5 go test \
        -run '^Test(TopDockStaysBetweenSidebars|DockFlatTabsGrowWithLabels)$' -count=1 -timeout 180s .
    )
  )
  validate_binary "$built"

  install -m 0755 "$built" "$CANDIDATE.tmp"
  mv -f "$CANDIDATE.tmp" "$CANDIDATE"
  {
    printf 'base_commit=%s\n' "$BASE_COMMIT"
    printf 'patch_sha256=%s\n' "$PATCH_SHA256"
    printf 'binary_sha256=%s\n' "$(sha256_file "$CANDIDATE")"
    printf 'built_at=%s\n' "$date"
  } >"$META.tmp"
  mv -f "$META.tmp" "$META"
  rm -rf -- "$work"
  trap - EXIT
  printf 'staged %s\n' "$CANDIDATE"
}

activate() {
  validate_candidate_bundle
  mkdir -p "$BIN_DIR" "$BACKUP_DIR"
  ensure_original_backup

  if [[ -e "$TARGET" && "$(sha256_file "$TARGET")" == "$(sha256_file "$CANDIDATE")" ]]; then
    install -m 0644 "$META" "$STATE_DIR/active.meta.tmp"
    mv -f "$STATE_DIR/active.meta.tmp" "$STATE_DIR/active.meta"
    printf 'already active: %s\n' "$TARGET"
    printf 'the running daemon was not restarted\n'
    return
  fi

  local incoming
  incoming="$(mktemp "$BIN_DIR/.tuios.new.XXXXXX")"
  trap "rm -f -- '$incoming' '$STATE_DIR/active.meta.tmp'" EXIT
  install -m 0755 "$CANDIDATE" "$incoming"
  validate_binary "$incoming"
  [[ "$(sha256_file "$incoming")" == "$(sha256_file "$CANDIDATE")" ]] || {
    printf 'copied candidate checksum mismatch\n' >&2
    exit 1
  }
  install -m 0644 "$META" "$STATE_DIR/active.meta.tmp"
  mv -f "$incoming" "$TARGET"
  mv -f "$STATE_DIR/active.meta.tmp" "$STATE_DIR/active.meta"
  trap - EXIT
  printf 'activated %s\n' "$TARGET"
  printf 'the running daemon was not restarted\n'
}

rollback() {
  mkdir -p "$BIN_DIR" "$BACKUP_DIR"
  ensure_original_backup

  local incoming
  if [[ -e "$ORIGINAL_NONE" ]]; then
    rm -f -- "$TARGET"
    printf 'removed %s; the system binary is effective again\n' "$TARGET"
  else
    validate_runnable_binary "$ORIGINAL_BACKUP"
    incoming="$(mktemp "$BIN_DIR/.tuios.rollback.XXXXXX")"
    trap "rm -f -- '$incoming'" EXIT
    install -m 0755 "$ORIGINAL_BACKUP" "$incoming"
    mv -f "$incoming" "$TARGET"
    trap - EXIT
    printf 'restored %s from %s\n' "$TARGET" "$ORIGINAL_BACKUP"
  fi
  rm -f -- "$STATE_DIR/active.meta"
  printf 'the running daemon was not restarted\n'
}

status() {
  if [[ -x "$TARGET" ]]; then
    printf 'active: %s\n' "$TARGET"
    "$TARGET" --version
    printf 'sha256: %s\n' "$(sha256_file "$TARGET")"
  else
    printf 'active: none at %s\n' "$TARGET"
  fi
  if [[ -x "$CANDIDATE" ]]; then
    printf 'candidate: %s\n' "$CANDIDATE"
    printf 'sha256: %s\n' "$(sha256_file "$CANDIDATE")"
  else
    printf 'candidate: none\n'
  fi
}

main() {
  local mode=${1:---install}
  [[ $# -le 1 ]] || {
    usage >&2
    exit 2
  }
  mkdir -p "$STATE_DIR" "$BACKUP_DIR"
  require flock
  require sha256sum
  exec 9>"$LOCK_FILE"
  flock 9

  case "$mode" in
    --install) stage; activate ;;
    --stage-only) stage ;;
    --activate) activate ;;
    --rollback) rollback ;;
    --status) status ;;
    -h|--help) usage ;;
    *) usage >&2; exit 2 ;;
  esac
}

main "$@"
