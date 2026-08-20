#!/usr/bin/env bash
# ==============================================================================
# SSH / terminal-only bootstrap for Debian and Ubuntu systems.
#
# This deliberately excludes graphical desktop, Wayland, terminal-emulator, and
# macOS configuration. It installs the remote agent workflow: CLI tools, Pi,
# Herdr's Sesh/Pi extensions (when Herdr is already installed), tuicr, Tuxedo,
# and Zsh/Zimfw.
#
#   ./install-tui.sh              # interactive on config conflicts
#   ./install-tui.sh --dry-run    # print actions without changing anything
#   ./install-tui.sh --yes        # non-interactive; back up config conflicts
# ==============================================================================

# Continue through independent failures so Pi and Herdr setup still run. The
# script returns non-zero only after printing a full failure summary.
set -uo pipefail

DRY_RUN=0
ASSUME_YES=0
declare -a FAILED_COMMANDS=()

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --yes|-y) ASSUME_YES=1 ;;
        --help|-h)
            grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//' | head -18
            exit 0
            ;;
        *) echo "unknown flag: $arg (use --help)" >&2; exit 1 ;;
    esac
done

readonly BOLD=$'\e[1m' DIM=$'\e[2m' RESET=$'\e[0m'
readonly BLUE=$'\e[34m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m'
say()  { printf "%s\n" "${BLUE}${BOLD}▸${RESET} $*"; }
ok()   { printf "%s\n" "${GREEN}✓${RESET} $*"; }
warn() { printf "%s\n" "${YELLOW}!${RESET} $*"; }
err()  { printf "%s\n" "${RED}✗${RESET} $*" >&2; }
step() { printf "\n%s\n" "${BOLD}${BLUE}== $* ==${RESET}"; }
run() {
    printf "%s\n" "${DIM}\$ $*${RESET}"
    [[ $DRY_RUN -eq 1 ]] && return 0
    if ! eval "$@"; then
        err "command failed (continuing): $*"
        FAILED_COMMANDS+=("$*")
        return 1
    fi
}
ask_yn() {
    local prompt=$1 default=${2:-default_y} ans
    [[ $ASSUME_YES -eq 1 ]] && return 0
    if [[ $default == default_y ]]; then
        read -r -p "$prompt [Y/n] " ans; ans=${ans:-y}
    else
        read -r -p "$prompt [y/N] " ans; ans=${ans:-n}
    fi
    [[ $ans =~ ^[Yy]$ ]]
}

DOTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $(uname) != Linux ]] || ! command -v apt-get &>/dev/null; then
    err "install-tui.sh supports Debian/Ubuntu-style Linux systems with apt-get."
    exit 1
fi
say "detected APT Linux, dotfiles at ${BOLD}$DOTS${RESET}"

# Keep this list deliberately terminal-only. APT names differ from the Arch
# equivalents: fd-find provides `fdfind`, and bat provides `batcat`.
declare -a PKGS_APT_TUI=(
    ca-certificates curl
    zsh git neovim
    fzf ripgrep fd-find bat jq
    openssh-client
    build-essential pkg-config python3
    nodejs npm
)
declare -a NPM_GLOBALS=(hunkdiff)

actionable_apt_packages() {
    local p
    for p in "${PKGS_APT_TUI[@]}"; do
        if dpkg-query -W -f='${db:Status-Status}' "$p" 2>/dev/null | grep -qx installed; then
            continue
        elif apt-cache show "$p" &>/dev/null; then
            printf '%s\n' "$p"
        else
            # This function feeds package names through process substitution;
            # keep diagnostics off stdout so they are not treated as packages.
            warn "not available from the configured APT sources (skipping): $p" >&2
        fi
    done
}

install_packages() {
    step "APT terminal packages"
    run "sudo apt-get update"

    local p
    while IFS= read -r p; do
        [[ -n $p ]] || continue
        # Install individually so a broken optional package cannot hold up the
        # rest of the terminal environment or the later Herdr setup.
        if run "sudo apt-get install --yes --no-install-recommends $p"; then
            ok "installed: $p"
        else
            warn "APT package failed: $p (continuing)"
        fi
    done < <(actionable_apt_packages)
}

link() {
    local src=$1 dst=$2
    if [[ ! -e $src ]]; then
        warn "source missing, skipping: $src"
        return
    fi
    if [[ -L $dst ]] && [[ "$(readlink "$dst")" == "$src" ]]; then
        ok "already linked: $dst"
        return
    fi
    if [[ -e $dst || -L $dst ]]; then
        printf "  ${YELLOW}conflict${RESET}: %s exists\n" "$dst"
        if ask_yn "  → back it up to ${dst}.bak.$(date +%s) and replace?" default_y; then
            run "mv \"$dst\" \"${dst}.bak.$(date +%s)\""
        else
            warn "  → kept existing $dst (no symlink created)"
            return
        fi
    fi
    run "mkdir -p \"$(dirname "$dst")\""
    run "ln -sfn \"$src\" \"$dst\""
    ok "linked: $dst → $src"
}

setup_terminal_configs() {
    step "terminal configuration symlinks"
    link "$DOTS/.zshrc" "$HOME/.zshrc"
    link "$DOTS/.zimrc" "$HOME/.zimrc"

    local d
    local -a dirs=(git nvim scripts sesh tuicr zsh)
    for d in "${dirs[@]}"; do
        [[ -d "$DOTS/.config/$d" ]] || { warn "not in dotfiles yet: .config/$d"; continue; }
        link "$DOTS/.config/$d" "$HOME/.config/$d"
    done

    # Herdr runtime state remains outside git, so link only the tracked config
    # and helper scripts needed by the Sesh workflow.
    if [[ -f "$DOTS/.config/herdr/config.toml" ]]; then
        run "mkdir -p \"$HOME/.config/herdr\""
        link "$DOTS/.config/herdr/config.toml" "$HOME/.config/herdr/config.toml"
        [[ -d "$DOTS/.config/herdr/scripts" ]] && link "$DOTS/.config/herdr/scripts" "$HOME/.config/herdr/scripts"
    fi
}

install_toolchains() {
    step "terminal toolchains"
    if ! command -v rustup &>/dev/null; then
        run 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable'
    else
        ok "rustup already present"
    fi
    if ! command -v cargo &>/dev/null && [[ -r "$HOME/.cargo/env" ]]; then
        # shellcheck disable=SC1091
        source "$HOME/.cargo/env"
    fi

    if ! command -v bun &>/dev/null; then
        run 'curl -fsSL https://bun.sh/install | bash'
    else
        ok "bun already present"
    fi
    if ! command -v uv &>/dev/null; then
        run 'curl -LsSf https://astral.sh/uv/install.sh | sh'
    else
        ok "uv already present"
    fi

    local npm_prefix="$HOME/.npm-global"
    if [[ "$(npm config get prefix 2>/dev/null)" != "$npm_prefix" ]]; then
        run "npm config set prefix \"$npm_prefix\""
        run "mkdir -p \"$npm_prefix/bin\""
    fi
    run "npm install -g ${NPM_GLOBALS[*]}"

    if ! command -v cargo &>/dev/null; then
        warn "cargo is unavailable — skipping Tuxedo (run the Rust installer again)"
    elif ! command -v tuxedo &>/dev/null; then
        run "cargo install --git https://github.com/webstonehq/tuxedo"
    else
        ok "tuxedo already present"
    fi
}

setup_pi_agent() {
    step "Pi agent"
    if [[ -x "$DOTS/.pi/install.sh" ]]; then
        run "\"$DOTS/.pi/install.sh\""
    else
        warn "no $DOTS/.pi/install.sh found — skipping Pi setup"
    fi
}

setup_herdr_extensions() {
    step "Herdr extensions"
    if ! command -v herdr &>/dev/null; then
        warn "herdr is not in PATH — skipping the Sesh plugin and Pi integration"
        return
    fi
    if run "herdr plugin install fullerzz/herdr-plugin-sesh --yes"; then
        ok "Herdr Sesh plugin installed"
    else
        warn "Herdr Sesh plugin failed; see the recorded command above"
    fi
    if run "herdr integration install pi"; then
        ok "Herdr Pi agent integration installed"
    else
        warn "Herdr Pi agent integration failed; see the recorded command above"
    fi
}

setup_tuicr() {
    step "tuicr (custom fork)"
    local rebuild="$DOTS/patches/tuicr/rebuild.sh"
    if [[ ! -x "$rebuild" ]]; then
        warn "no tuicr rebuild script at $rebuild — skipping"
    elif ! command -v cargo &>/dev/null; then
        warn "cargo is unavailable — skipping custom tuicr build"
    else
        run "\"$rebuild\""
    fi
}

setup_zsh() {
    step "Zsh and Zimfw"
    local zim_home="${ZIM_HOME:-${ZDOTDIR:-$HOME}/.zim}"
    if [[ ! -r "$zim_home/zimfw.zsh" ]]; then
        run "mkdir -p \"$zim_home\" && curl -fsSL https://raw.githubusercontent.com/zimfw/zimfw/master/zimfw.zsh -o \"$zim_home/zimfw.zsh\""
    fi
    if command -v zsh &>/dev/null && [[ -r "$zim_home/zimfw.zsh" ]]; then
        # Keep the setup non-interactive and set the zsh parameter explicitly;
        # merely passing ZIM_HOME through the environment is insufficient.
        run "zsh -c 'ZIM_HOME=\"${zim_home}\"; source \"\$ZIM_HOME/zimfw.zsh\" install'"
    else
        warn "Zimfw modules were not installed (zsh or $zim_home/zimfw.zsh is missing)"
    fi

    local zsh_bin
    zsh_bin=$(command -v zsh) || { warn "zsh not in PATH yet, skipping default-shell setup"; return; }
    if [[ $SHELL == "$zsh_bin" ]]; then
        ok "zsh is already the default shell"
    elif ask_yn "set zsh ($zsh_bin) as your default shell?" default_y; then
        if ! grep -qxF "$zsh_bin" /etc/shells; then
            run "echo \"$zsh_bin\" | sudo tee -a /etc/shells"
        fi
        run "chsh -s \"$zsh_bin\""
    fi
}

summary() {
    step "summary"
    cat <<'EOF'
Installed scope: terminal-only SSH agent workflow (no Wayland, desktop, GUI,
or terminal-emulator packages). Herdr itself is installed independently; when
it is on PATH this script installs the Sesh plugin and Pi integration.

Re-run with:
  ./install-tui.sh --dry-run
  ./install-tui.sh --yes
EOF
}

main() {
    setup_terminal_configs
    install_packages
    install_toolchains
    setup_pi_agent
    setup_herdr_extensions
    setup_tuicr
    setup_zsh
    summary

    if [[ ${#FAILED_COMMANDS[@]} -gt 0 ]]; then
        warn "${#FAILED_COMMANDS[@]} command(s) failed; rerun the recorded commands after fixing their cause"
        return 1
    fi
    ok "terminal-only SSH setup complete"
}

main "$@"
