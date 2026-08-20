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
#   2. Installs the Pi extensions selected by PI_NPM_PACKAGES

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

# 2. Install only the Pi extensions selected by the parent installer. The
# tracked package.json remains untouched; a temporary manifest is installed
# into a temporary node_modules tree and then merged into the live tree.
install_selected_pi_extensions() {
    local npm_dir="$AGENT_DIR/npm"
    local source_json="$npm_dir/package.json"
    local tmp_dir
    local -a selected=()
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-npm.XXXXXX")"
    read -r -a selected <<<"${PI_NPM_PACKAGES:-}"

    if ! node - "$source_json" "$tmp_dir/package.json" "${selected[@]}" <<'NODE'
const fs = require("fs");
const source = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const destination = process.argv[3];
const wanted = process.argv.slice(4);
const dependencies = {};
const missing = [];
for (const name of wanted) {
  if (source.dependencies && source.dependencies[name]) dependencies[name] = source.dependencies[name];
  else missing.push(name);
}
if (missing.length) {
  console.error(`Unknown Pi extension package(s): ${missing.join(", ")}`);
  process.exit(1);
}
source.dependencies = dependencies;
fs.writeFileSync(destination, `${JSON.stringify(source, null, 2)}\n`);
NODE
    then
        rm -rf "$tmp_dir"
        return 1
    fi

    if ! (cd "$tmp_dir" && npm install --no-audit --no-fund); then
        rm -rf "$tmp_dir"
        return 1
    fi
    mkdir -p "$npm_dir/node_modules"
    if ! cp -a "$tmp_dir/node_modules/." "$npm_dir/node_modules/"; then
        rm -rf "$tmp_dir"
        return 1
    fi
    rm -rf "$tmp_dir"
}

remove_selected_pi_extensions() {
    local package_name package_path
    local -a selected=()
    read -r -a selected <<<"${PI_REMOVE_NPM_PACKAGES:-}"
    for package_name in "${selected[@]}"; do
        package_path="$AGENT_DIR/npm/node_modules/$package_name"
        if [[ -e $package_path || -L $package_path ]]; then
            rm -rf "$package_path"
            echo "Removed Pi extension: $package_name"
        fi
    done
}

if [[ -n ${PI_REMOVE_NPM_PACKAGES:-} ]]; then
    remove_selected_pi_extensions
fi

if [[ ${PI_SKIP_NPM:-0} == 1 ]]; then
    echo "Skipping Pi extension installation (--no-pkgs)"
elif command -v npm >/dev/null 2>&1; then
    if [[ -n ${PI_NPM_PACKAGES:-} ]]; then
        echo "Installing selected Pi extensions via npm: ${PI_NPM_PACKAGES}"
        install_selected_pi_extensions
    else
        echo "Installing all declared Pi extensions via npm..."
        ( cd "$AGENT_DIR/npm" && npm install --no-audit --no-fund )
    fi
else
    echo "WARNING: npm is unavailable; skipped Pi extension installation" >&2
fi

apply_pi_herdr_completion_patch() {
    local package_dir="$AGENT_DIR/npm/node_modules/@weshipwork/pi-herdr"
    local patch_file="$DOT_DIR/patches/pi-herdr/command-completion.patch"

    [[ -d "$package_dir" ]] || return 0
    if grep -q 'CommandCompletionRegistry' "$package_dir/extensions/herdr.ts" 2>/dev/null; then
        echo "Pi-Herdr completion callback already applied"
        return 0
    fi
    if ! git -C "$package_dir" apply --check "$patch_file" 2>/dev/null; then
        echo "ERROR: could not apply the Pi-Herdr completion callback patch" >&2
        return 1
    fi
    git -C "$package_dir" apply "$patch_file"
    echo "Applied Pi-Herdr completion callback patch"
}

apply_pi_herdr_completion_patch

echo "Done."
