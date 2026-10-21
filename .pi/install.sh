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

pi_herdr_previous_overlay_sha256() {
    local state="$1"
    local file="$2"

    case "$state:$file" in
        v4:herdr-action-context.ts) printf '%s\n' 614b6ace2bdfdcf2a54a5d15af5c2f4b2aa48a7eae4f3c56ddd789f30b9cf800 ;;
        v4:herdr-client.ts) printf '%s\n' 6387104cf59213354b68a30070301dd0f6071289e1eb9db021036bb18fcc7bf6 ;;
        v4:herdr-pane-actions.ts) printf '%s\n' d4480cfb440a676fe1bd871988135d281c1fe8643783532999087d650fceaa8a ;;
        v4:herdr-render.ts) printf '%s\n' ca5077ef617baf3044b708b0c8e7b09c0ef71db036711997d2cab88cf09527e1 ;;
        v4:herdr-run-protocol.ts) printf '%s\n' e54b1ca384e8112484d6c48b98eeff8cc51a32126050bf2a12da3196969aa446 ;;
        v4:herdr-types.ts) printf '%s\n' 005bb686a79761a1049c3d0c40813a69f90b04a84e5d7e4c91244a6e6585b0cf ;;
        v4:herdr.ts) printf '%s\n' 4c014d9930a1f553e1396e935ae4accce6b01a8ea84c86b2ece06a548bd572fd ;;
        v2:herdr-pane-actions.ts) printf '%s\n' 47e6b827c13c8a3c4bb0cc6c3c03cb5db0e3dffbd5f8a15ed3adb33b35c842f2 ;;
        v2:herdr-action-context.ts|v3:herdr-action-context.ts) printf '%s\n' 614b6ace2bdfdcf2a54a5d15af5c2f4b2aa48a7eae4f3c56ddd789f30b9cf800 ;;
        v2:herdr-client.ts|v3:herdr-client.ts) printf '%s\n' fc0d148fb75081e76d1a369c40eba2f3dc9856b4a2b153a5c8c6e7837aef57ea ;;
        v3:herdr-pane-actions.ts) printf '%s\n' 7e38989fdbc5c71617d6e92f174ff6e5be7e09fd3b943170f862d270fc57df6f ;;
        v2:herdr-render.ts|v3:herdr-render.ts) printf '%s\n' ca5077ef617baf3044b708b0c8e7b09c0ef71db036711997d2cab88cf09527e1 ;;
        v2:herdr-run-protocol.ts|v3:herdr-run-protocol.ts) printf '%s\n' d62468385e9b66d2be4d5d01c9795bf1bcd4b5fdfbcba196f97b47cfc92eced2 ;;
        v2:herdr-types.ts|v3:herdr-types.ts) printf '%s\n' 714c427fdb4aaa82264794b6e864be80c2c4e713a4730447c3d5701abc9e2ead ;;
        v2:herdr.ts|v3:herdr.ts) printf '%s\n' 4c014d9930a1f553e1396e935ae4accce6b01a8ea84c86b2ece06a548bd572fd ;;
        *) return 1 ;;
    esac
}

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
    if [[ $overlay_version != 4 ]]; then
        echo "ERROR: unsupported Pi-Herdr overlay version '$overlay_version'" >&2
        return 1
    fi

    package_version="$(node -p "require('$package_dir/package.json').version" 2>/dev/null || true)"
    if [[ $package_version != 0.1.0 ]]; then
        echo "ERROR: Pi-Herdr overlay supports @weshipwork/pi-herdr@0.1.0, found '${package_version:-unknown}'" >&2
        return 1
    fi
    if ! herdr pane run-command --help >/dev/null 2>&1; then
        echo "ERROR: Herdr runtime lacks 'pane run-command'; update Herdr before installing the Pi-Herdr overlay" >&2
        return 1
    fi

    state="installed"
    for file in herdr-action-context.ts herdr-client.ts herdr-pane-actions.ts herdr-render.ts herdr-run-protocol.ts herdr-types.ts herdr.ts; do
        if ! cmp -s "$overlay_dir/$file" "$package_dir/extensions/$file"; then
            state="unknown"
            break
        fi
    done

    if [[ $state == unknown ]]; then
        local current_pane_actions_sha256
        local expected_sha256
        current_pane_actions_sha256="$(sha256sum "$package_dir/extensions/herdr-pane-actions.ts" 2>/dev/null | awk '{print $1}')"
        if [[ $current_pane_actions_sha256 == "$(pi_herdr_previous_overlay_sha256 v4 herdr-pane-actions.ts)" ]]; then
            state="v4"
        elif [[ $current_pane_actions_sha256 == "$(pi_herdr_previous_overlay_sha256 v3 herdr-pane-actions.ts)" ]]; then
            state="v3"
        elif [[ $current_pane_actions_sha256 == "$(pi_herdr_previous_overlay_sha256 v2 herdr-pane-actions.ts)" ]]; then
            state="v2"
        fi
        if [[ $state == v2 || $state == v3 || $state == v4 ]]; then
            for file in herdr-action-context.ts herdr-client.ts herdr-pane-actions.ts herdr-render.ts herdr-run-protocol.ts herdr-types.ts herdr.ts; do
                if ! expected_sha256="$(pi_herdr_previous_overlay_sha256 "$state" "$file")"; then
                    state="unknown"
                    break
                fi
                if [[ $(sha256sum "$package_dir/extensions/$file" 2>/dev/null | awk '{print $1}') != "$expected_sha256" ]]; then
                    state="unknown"
                    break
                fi
            done
        elif grep -q 'CommandCompletionRegistry\|completion: "follow_up"' "$package_dir/extensions/herdr-pane-actions.ts" 2>/dev/null; then
            state="legacy"
        elif grep -q 'await sleep(800' "$package_dir/extensions/herdr-pane-actions.ts" 2>/dev/null; then
            state="pristine"
        fi
    fi

    if [[ $state == unknown ]]; then
        echo "ERROR: unknown Pi-Herdr source state; refusing to overwrite local changes" >&2
        return 1
    fi

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
    NODE_PATH="$agent_package_dir/node_modules${NODE_PATH:+:$NODE_PATH}" \
        PI_CODING_AGENT_PACKAGE_DIR="$agent_package_dir" \
        PI_HERDR_PACKAGE_DIR="$package_dir" \
        PI_JITI_MODULE="$jiti_module" \
        node "$test_file"
}

apply_pi_herdr_run_protocol_overlay

echo "Done."
