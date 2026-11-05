#!/usr/bin/env bash
set -euo pipefail

DOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
AGENT_DIR="$DOT_DIR/agent"

if [[ -L "$HOME/.pi" ]]; then
    current="$(readlink "$HOME/.pi")"
    if [[ "$current" != "$DOT_DIR" ]]; then
        ln -sfn "$DOT_DIR" "$HOME/.pi"
    fi
elif [[ -e "$HOME/.pi" ]]; then
    printf 'ERROR: ~/.pi exists and is not a symlink; move it aside first.\n' >&2
    exit 1
else
    ln -s "$DOT_DIR" "$HOME/.pi"
fi

mkdir -p "$AGENT_DIR/npm"

install_selected_pi_extensions() {
    local npm_dir="$AGENT_DIR/npm" tmp_dir
    local -a selected=()
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-npm.XXXXXX")"
    read -r -a selected <<<"${PI_NPM_PACKAGES:-}"
    if ! node - "$npm_dir/package.json" "$tmp_dir/package.json" "${selected[@]}" <<'NODE'
const fs = require("node:fs");
const source = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const wanted = process.argv.slice(4);
const dependencies = {};
for (const name of wanted) {
    if (!source.dependencies?.[name]) throw new Error(`Unknown Pi extension: ${name}`);
    dependencies[name] = source.dependencies[name];
}
source.dependencies = dependencies;
fs.writeFileSync(process.argv[3], `${JSON.stringify(source, null, 2)}\n`);
NODE
    then
        rm -rf "$tmp_dir"
        return 1
    fi
    if ! (cd "$tmp_dir" && npm install --ignore-scripts --no-audit --no-fund); then
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
        if [[ -e "$package_path" || -L "$package_path" ]]; then
            rm -rf "$package_path"
            printf 'Removed Pi extension: %s\n' "$package_name"
        fi
    done
}

if [[ -n ${PI_REMOVE_NPM_PACKAGES:-} ]]; then
    remove_selected_pi_extensions
fi
if [[ ${PI_SKIP_NPM:-0} == 1 ]]; then
    printf 'Skipping Pi extension installation\n'
elif command -v npm >/dev/null 2>&1; then
    if [[ -n ${PI_NPM_PACKAGES:-} ]]; then
        install_selected_pi_extensions
    else
        (cd "$AGENT_DIR/npm" && npm install --ignore-scripts --no-audit --no-fund)
    fi
else
    printf 'WARNING: npm is unavailable; Pi extensions were not installed.\n' >&2
    exit 1
fi

printf 'Pi configuration installed.\n'
