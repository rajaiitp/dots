#!/usr/bin/env bash
# Install pi agent config on a new machine.
#
# Model: ~/.pi is a single symlink pointing at this dotfiles repo's .pi/
# directory, so every file under here (agent/settings.json, extensions/,
# skills/, themes/, ...) is live-edited in place and tracked by git. No
# per-file symlinks are needed (and would in fact be self-referential,
# since ~/.pi/agent and this directory are the same path).
#
# This script:
#   1. Ensures ~/.pi -> ~/dotfiles/.pi
#   2. Runs `npm install` for the extensions declared in agent/npm/package.json
#   3. Applies tracked patches to installed extensions

set -euo pipefail

DOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # .../dotfiles/.pi
AGENT_DIR="$DOT_DIR/agent"

# 1. Link ~/.pi -> this directory (whole-dir symlink).
if [ -L "$HOME/.pi" ]; then
    cur="$(readlink "$HOME/.pi")"
    if [ "$cur" = "$DOT_DIR" ]; then
        echo "linked: ~/.pi -> $DOT_DIR"
    else
        echo "relinking ~/.pi: $cur -> $DOT_DIR"
        ln -sfn "$DOT_DIR" "$HOME/.pi"
    fi
elif [ -e "$HOME/.pi" ]; then
    echo "ERROR: ~/.pi exists and is not a symlink. Move it aside first:" >&2
    echo "  mv ~/.pi ~/.pi.bak.$(date +%s)" >&2
    exit 1
else
    ln -s "$DOT_DIR" "$HOME/.pi"
    echo "linked: ~/.pi -> $DOT_DIR"
fi

mkdir -p "$AGENT_DIR/npm"

# 2. Install extensions declared in agent/npm/package.json.
echo "Installing pi extensions via npm..."
( cd "$AGENT_DIR/npm" && npm install --no-audit --no-fund )

apply_tracked_patch() {
    local name=$1 target=$2 patch_file=$3
    if patch --dry-run --batch --forward -p1 -d "$target" < "$patch_file" >/dev/null 2>&1; then
        patch --batch --forward -p1 -d "$target" < "$patch_file"
    elif patch --dry-run --batch --reverse --forward -p1 -d "$target" < "$patch_file" >/dev/null 2>&1; then
        echo "patched: $name already applied"
    else
        echo "ERROR: $name patch does not apply: $patch_file" >&2
        exit 1
    fi
}

# 3. Patch installed extensions without vendoring them, so npm reinstalls are
# reproducible.
apply_tracked_patch \
    "pi-powerline-footer thinking level" \
    "$AGENT_DIR/npm/node_modules/pi-powerline-footer" \
    "$DOT_DIR/patches/pi-powerline-footer/thinking-level.patch"

apply_tracked_patch \
    "pi-quota-status deferred startup refresh" \
    "$AGENT_DIR/npm/node_modules/pi-quota-status" \
    "$DOT_DIR/patches/pi-quota-status/defer-startup-refresh.patch"

apply_tracked_patch \
    "pi-model-router context-aware orchestration" \
    "$AGENT_DIR/npm/node_modules/@yeliu84/pi-model-router" \
    "$DOT_DIR/patches/pi-model-router/context-aware.patch"

echo "Done."
