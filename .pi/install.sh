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

apply_pi_herdr_run_protocol_overlay() {
    local package_dir="$AGENT_DIR/npm/node_modules/@weshipwork/pi-herdr"
    local overlay_dir="$DOT_DIR/patches/pi-herdr/overlay/extensions"
    local overlay_version_file="$DOT_DIR/patches/pi-herdr/VERSION"
    local test_file="$DOT_DIR/patches/pi-herdr/run-protocol.test.cjs"
    local overlay_version
    local package_version
    local state
    local agent_package_dir
    local jiti_module
    local file

    [[ -d "$package_dir" ]] || return 0
    [[ -d "$overlay_dir" && -f "$overlay_version_file" && -f "$test_file" ]] || {
        echo "ERROR: Pi-Herdr run-protocol overlay is incomplete" >&2
        return 1
    }
    overlay_version="$(<"$overlay_version_file")"
    if [[ $overlay_version != 2 ]]; then
        echo "ERROR: unsupported Pi-Herdr overlay version '$overlay_version'" >&2
        return 1
    fi

    package_version="$(node -p "require('$package_dir/package.json').version" 2>/dev/null || true)"
    if [[ $package_version != 0.1.0 ]]; then
        echo "ERROR: Pi-Herdr overlay supports @weshipwork/pi-herdr@0.1.0, found '${package_version:-unknown}'" >&2
        return 1
    fi
    if ! herdr pane wait-output --help >/dev/null 2>&1; then
        echo "ERROR: Herdr runtime lacks 'pane wait-output'; update Herdr before installing the Pi-Herdr overlay" >&2
        return 1
    fi

    if grep -q 'createCommandProtocol' "$package_dir/extensions/herdr-pane-actions.ts" 2>/dev/null; then
        state="installed"
    elif grep -q 'CommandCompletionRegistry\|completion: "follow_up"\|await sleep(800' "$package_dir/extensions/herdr-pane-actions.ts" 2>/dev/null; then
        state="legacy"
    elif grep -q 'case HERDR_ACTION.RUN' "$package_dir/extensions/herdr-pane-actions.ts" 2>/dev/null; then
        state="pristine"
    else
        echo "ERROR: unknown Pi-Herdr source state; refusing to overwrite local changes" >&2
        return 1
    fi

    for file in herdr-action-context.ts herdr-client.ts herdr-pane-actions.ts herdr-render.ts herdr-run-protocol.ts herdr-types.ts herdr.ts; do
        if [[ $state == installed ]] && ! cmp -s "$overlay_dir/$file" "$package_dir/extensions/$file"; then
            echo "ERROR: Pi-Herdr run-protocol source drift in $file; refusing to overwrite local changes" >&2
            return 1
        fi
    done

    if [[ $state != installed ]]; then
        for file in herdr-action-context.ts herdr-client.ts herdr-pane-actions.ts herdr-render.ts herdr-run-protocol.ts herdr-types.ts herdr.ts; do
            install -m 0644 "$overlay_dir/$file" "$package_dir/extensions/$file"
        done
        rm -f "$package_dir/extensions/herdr-command-completion.ts"
        echo "Installed Pi-Herdr completion-gated run overlay v$overlay_version (migrated $state source)"
    else
        echo "Pi-Herdr completion-gated run overlay v$overlay_version already installed"
    fi

    agent_package_dir="$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent"
    jiti_module="$agent_package_dir/node_modules/jiti"
    if [[ ! -d $jiti_module ]]; then
        echo "ERROR: cannot find Pi's jiti runtime at $jiti_module" >&2
        return 1
    fi
    PI_HERDR_PACKAGE_DIR="$package_dir" PI_JITI_MODULE="$jiti_module" node "$test_file"
}

apply_pi_herdr_run_protocol_overlay

echo "Done."
