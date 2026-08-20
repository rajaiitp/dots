#!/usr/bin/env bash
# ==============================================================================
# Dotfiles setup script
# ------------------------------------------------------------------------------
# One-shot bootstrap for a fresh machine (Arch and Debian/Ubuntu Linux, with a
# macOS fallback for the cross-platform bits). Idempotent — safe to re-run.
#
#   ./install.sh              # everything, interactive on conflicts
#   ./install.sh --dry-run    # print what would happen, do nothing destructive
#   ./install.sh --no-pkgs    # skip package installs, do symlinks only
#   ./install.sh --yes        # non-interactive: back up conflicts automatically
#
# What it does, in order:
#   1. Detect OS
#   2. Symlink tracked configs into $HOME / $HOME/.config (done first so a
#      later package/install failure never leaves configs unlinked)
#   3. Per-file symlinks (herdr's config.toml — logs/sockets stay outside git)
#   4. Install packages (pacman + AUR on Arch, APT on Debian/Ubuntu, or brew
#      on macOS); bootstrap yay when needed
#   5. Install language toolchains (rustup, node/bun, uv)
#   6. Delegate to .pi/install.sh for the pi agent
#   7. Install the Herdr Sesh plugin and Pi integration
#   8. Build and install the custom tuicr fork
#   9. Install Zimfw and set Zsh as the default shell (with confirmation)
#  10. Enable user systemd services (Arch only)
#  11. Print a summary of anything that needs manual follow-up
# ==============================================================================

# Keep going after an independent command fails so later setup stages (notably
# Herdr) still run. `run` records failures and main exits non-zero after the
# summary, rather than aborting halfway through the bootstrap.
set -uo pipefail

# ---------------------------------------------------------------- args + flags
DRY_RUN=0
NO_PKGS=0
ASSUME_YES=0
declare -a FAILED_COMMANDS=()
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --no-pkgs) NO_PKGS=1 ;;
        --yes|-y) ASSUME_YES=1 ;;
        --help|-h)
            grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//' | head -25
            exit 0
            ;;
        *) echo "unknown flag: $arg (use --help)"; exit 1 ;;
    esac
done

# ------------------------------------------------------------------- pretty io
readonly BOLD=$'\e[1m' DIM=$'\e[2m' RESET=$'\e[0m'
readonly BLUE=$'\e[34m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m'
say()   { printf "%s\n" "${BLUE}${BOLD}▸${RESET} $*"; }
ok()    { printf "%s\n" "${GREEN}✓${RESET} $*"; }
warn()  { printf "%s\n" "${YELLOW}!${RESET} $*"; }
err()   { printf "%s\n" "${RED}✗${RESET} $*" >&2; }
step()  { printf "\n%s\n" "${BOLD}${BLUE}== $* ==${RESET}"; }
run() {
    # Print + run (or just print on --dry-run). Failures are collected so one
    # unavailable package or network hiccup cannot prevent later stages.
    printf "%s\n" "${DIM}\$ $*${RESET}"
    [[ $DRY_RUN -eq 1 ]] && return 0
    if ! eval "$@"; then
        err "command failed (continuing): $*"
        FAILED_COMMANDS+=("$*")
        return 1
    fi
}
ask_yn() {
    # ask_yn "Prompt?" [default_y|default_n]
    local prompt=$1 default=${2:-default_y} ans
    [[ $ASSUME_YES -eq 1 ]] && return 0
    if [[ $default == default_y ]]; then
        read -r -p "$prompt [Y/n] " ans; ans=${ans:-y}
    else
        read -r -p "$prompt [y/N] " ans; ans=${ans:-n}
    fi
    [[ $ans =~ ^[Yy]$ ]]
}

# --------------------------------------------------------------- OS detection
DOTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f /etc/arch-release ]]; then
    OS=arch
elif [[ $(uname) == Darwin ]]; then
    OS=macos
elif command -v apt-get &>/dev/null; then
    OS=apt
else
    err "unsupported OS. This script targets Arch, Debian/Ubuntu, and macOS."
    exit 1
fi
say "detected OS: ${BOLD}$OS${RESET}, dotfiles at ${BOLD}$DOTS${RESET}"

# =============================================================================
# 1. Package installation
# =============================================================================
# Grouped so we can extend easily. Comments explain why each is needed.
declare -a PKGS_ARCH_CORE=(
    # shells + editors
    zsh neovim ghostty git
    # cli productivity used by zsh/nvim
    fzf ripgrep fd bat jq eza starship
    openssh
    # image/video for nvim image.nvim + hyprshot + magick color analysis
    imagemagick ffmpeg
    # networking + audio
    networkmanager pipewire wireplumber pavucontrol
    # fonts
    ttf-jetbrains-mono-nerd noto-fonts noto-fonts-emoji
    # GTK theme deps
    gtk3 gtk4 python-gobject adwaita-icon-theme
)
declare -a PKGS_ARCH_WAYLAND=(
    # compositor + tools referenced by ~/.config/hypr/*
    hyprland hyprlock hyprpaper hypridle
    xdg-desktop-portal-hyprland xdg-desktop-portal-gtk
    waybar dunst
    fuzzel
    grim slurp hyprshot swappy
    wl-clipboard wl-clip-persist
    hyprsunset
    polkit hyprpolkitagent
    # file managers referenced in windowrules
    pcmanfm gvfs
)
declare -a PKGS_ARCH_AUR=(
    # Currently empty. Add AUR-only packages here.
    # (`hunk` is installed via npm, not AUR — see install_npm_globals below.)
)
declare -a NPM_GLOBALS=(
    # `hunk` (binary is `hunk`, package is `hunkdiff`) — TUI diff review
    hunkdiff
    # herdr's ecosystem tools would go here if any
)
# Debian/Ubuntu package names. Entries missing from the configured APT sources
# are skipped individually, allowing the rest of the setup to proceed.
declare -a PKGS_APT=(
    zsh neovim git
    fzf ripgrep fd-find bat jq eza starship
    openssh-client
    imagemagick ffmpeg
    network-manager pipewire wireplumber pavucontrol
    fonts-jetbrains-mono fonts-noto fonts-noto-color-emoji
    libgtk-3-0 libgtk-4-1 python3-gi adwaita-icon-theme
    nodejs npm
    hyprland hyprlock hyprpaper hypridle
    xdg-desktop-portal-hyprland xdg-desktop-portal-gtk
    waybar dunst fuzzel grim slurp hyprshot swappy
    wl-clipboard wl-clip-persist hyprsunset policykit-1
    pcmanfm gvfs
)
# macOS gets only the cross-platform pieces
declare -a PKGS_MAC=(
    zsh neovim ghostty git
    fzf ripgrep fd bat jq eza starship
    openssh
    imagemagick ffmpeg
    # node/npm needed to build pi extensions (node-pty) in .pi/install.sh.
    node
    # tuxedo: todo.txt TUI (aliased `notes`). Homebrew has a formula; on Linux
    # it is installed from git via cargo in install_toolchains.
    tuxedo
)
# macOS fonts installed as casks (Nerd Font needed for the pi powerline footer
# separators + nvim/ghostty glyphs — this is the Arch `ttf-jetbrains-mono-nerd`
# equivalent). Without this the footer renders garbled "extra symbols".
declare -a CASKS_MAC=(
    font-jetbrains-mono-nerd-font
)

install_packages_arch() {
    say "refreshing pacman"
    run "sudo pacman -Syu --noconfirm"

    say "installing pacman packages"
    # only install what's not already there — pacman is fast but idempotency reads better
    local missing=()
    for p in "${PKGS_ARCH_CORE[@]}" "${PKGS_ARCH_WAYLAND[@]}"; do
        pacman -Qi "$p" &>/dev/null || missing+=("$p")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        run "sudo pacman -S --noconfirm --needed ${missing[*]}"
    else
        ok "all pacman packages already installed"
    fi

    # AUR: bootstrap yay if missing, then install
    if ! command -v yay &>/dev/null && ! command -v paru &>/dev/null; then
        say "bootstrapping yay from AUR (no AUR helper found)"
        run "sudo pacman -S --noconfirm --needed base-devel"
        run "mkdir -p /tmp/yay-bootstrap && cd /tmp/yay-bootstrap && \
             git clone https://aur.archlinux.org/yay-bin.git && \
             cd yay-bin && makepkg -si --noconfirm"
    fi
    local aur=${AUR_HELPER:-$(command -v yay || command -v paru)}
    if [[ ${#PKGS_ARCH_AUR[@]} -gt 0 ]]; then
        say "installing AUR packages via $aur"
        local aur_missing=()
        for p in "${PKGS_ARCH_AUR[@]}"; do
            pacman -Qi "$p" &>/dev/null || aur_missing+=("$p")
        done
        if [[ ${#aur_missing[@]} -gt 0 ]]; then
            run "$aur -S --noconfirm --needed ${aur_missing[*]}"
        else
            ok "all AUR packages already installed"
        fi
    fi
}

install_packages_apt() {
    say "refreshing APT package index"
    run "sudo apt-get update"

    say "installing APT packages"
    # Query packages individually before a batch install: optional Wayland
    # components vary by Debian/Ubuntu release and must not block core tools.
    local missing=() unavailable=()
    for p in "${PKGS_APT[@]}"; do
        if dpkg-query -W -f='${db:Status-Status}' "$p" 2>/dev/null | grep -qx installed; then
            continue
        elif apt-cache show "$p" &>/dev/null; then
            missing+=("$p")
        else
            unavailable+=("$p")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        run "sudo apt-get install --yes --no-install-recommends ${missing[*]}"
    else
        ok "all available APT packages already installed"
    fi
    if [[ ${#unavailable[@]} -gt 0 ]]; then
        warn "not available from the configured APT sources (skipping): ${unavailable[*]}"
    fi
}

install_packages_mac() {
    if ! command -v brew &>/dev/null; then
        say "bootstrapping Homebrew"
        run '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    fi
    say "installing brew packages"
    # Install one-by-one so a single unavailable/broken formula just warns
    # instead of preventing the remaining setup.
    local failed=()
    for p in "${PKGS_MAC[@]}"; do
        if ! run "brew install --quiet $p"; then
            warn "brew formula failed: $p (skipping)"
            failed+=("$p")
        fi
    done
    if [[ ${#CASKS_MAC[@]} -gt 0 ]]; then
        say "installing brew casks (fonts)"
        for c in "${CASKS_MAC[@]}"; do
            if ! run "brew install --quiet --cask $c"; then
                warn "brew cask failed: $c (skipping)"
                failed+=("$c (cask)")
            fi
        done
    fi
    if [[ ${#failed[@]} -gt 0 ]]; then
        warn "brew items that need manual attention: ${failed[*]}"
    fi
}

# =============================================================================
# 2. Toolchains (Rust / Node / Python / Go / Bun)
# =============================================================================
install_toolchains() {
    if ! command -v rustup &>/dev/null; then
        say "installing rustup + stable Rust"
        run 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable'
    else ok "rustup already present"; fi

    if ! command -v bun &>/dev/null; then
        say "installing bun (node runtime + package manager)"
        run 'curl -fsSL https://bun.sh/install | bash'
    else ok "bun already present"; fi

    if ! command -v uv &>/dev/null; then
        say "installing uv (python package manager)"
        run 'curl -LsSf https://astral.sh/uv/install.sh | sh'
    else ok "uv already present"; fi

    # Google Cast playback/volume control used by the Waybar Google Home module.
    if [[ $OS != macos ]] && ! command -v catt &>/dev/null; then
        say "installing catt (Google Cast CLI)"
        run "uv tool install catt"
    fi

    # Node is listed for Homebrew and APT; ensure it is present on Arch too.
    if [[ $OS == arch ]] && ! pacman -Qi nodejs &>/dev/null; then
        run "sudo pacman -S --noconfirm --needed nodejs npm"
    elif [[ $OS == apt ]] && ! command -v node &>/dev/null; then
        run "sudo apt-get install --yes nodejs npm"
    fi

    # Configure npm to install globals under $HOME (no sudo required)
    local npm_prefix="$HOME/.npm-global"
    if [[ "$(npm config get prefix 2>/dev/null)" != "$npm_prefix" ]]; then
        say "pointing npm global prefix at $npm_prefix (sudo-free installs)"
        run "npm config set prefix \"$npm_prefix\""
        # Ensure the bin dir is on PATH going forward. Zsh handles this in its own config.
        run "mkdir -p \"$npm_prefix/bin\""
    fi

    # Install npm globals (hunk, etc.)
    if [[ ${#NPM_GLOBALS[@]} -gt 0 ]]; then
        say "installing npm globals: ${NPM_GLOBALS[*]}"
        run "npm install -g ${NPM_GLOBALS[*]}"
    fi

    # tuxedo (todo.txt TUI, aliased `notes`). Homebrew handles it on macOS via
    # PKGS_MAC; on Linux install it from git via cargo.
    if [[ $OS != macos ]] && ! command -v tuxedo &>/dev/null; then
        say "installing tuxedo from git (cargo)"
        run "cargo install --git https://github.com/webstonehq/tuxedo"
    fi

    # Go is optional; only install if referenced in your setup
    if ! command -v go &>/dev/null; then
        if ask_yn "install Go toolchain?" default_n; then
            [[ $OS == arch ]]  && run "sudo pacman -S --noconfirm --needed go"
            [[ $OS == apt ]]   && run "sudo apt-get install --yes golang-go"
            [[ $OS == macos ]] && run "brew install go"
        fi
    fi
}

# =============================================================================
# 3. Symlink engine (interactive conflict resolution)
# =============================================================================
# link SRC DST → creates DST as a symlink to SRC.
# If DST already exists and isn't the right symlink, prompt (or --yes: backup).
link() {
    local src=$1 dst=$2
    if [[ ! -e $src ]]; then
        warn "source missing, skipping: $src"; return
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

# =============================================================================
# 4. Symlink layout — declared as (src_relative_to_dots, dst_absolute) pairs
# =============================================================================
setup_symlinks() {
    step "symlinks: root-level files"
    # GTK + mimeapps are Linux-desktop only — skip on macOS.
    if [[ $OS != macos ]]; then
        link "$DOTS/.gtkrc-2.0"          "$HOME/.gtkrc-2.0"
        link "$DOTS/mimeapps.list"       "$HOME/.config/mimeapps.list"
    fi
    link "$DOTS/.zshrc"                  "$HOME/.zshrc"
    link "$DOTS/.zimrc"                  "$HOME/.zimrc"

    step "symlinks: whole ~/.config/* directories"
    # Everything under .config/ except herdr (per-file below).
    # opencode is intentionally excluded — the live version is a dev tree
    # with node_modules, not something to check in.
    #
    # Split by OS so a Mac doesn't get dead Wayland symlinks and Linux doesn't
    # get dead aerospace/karabiner symlinks.
    local -a dirs=(
        # cross-platform
        ghostty git hunk nvim scripts sesh tuicr tuxedo wezterm zsh
    )
    if [[ $OS == macos ]]; then
        # macOS window manager + key remapper
        dirs+=(aerospace karabiner)
    else
        # Linux/Wayland desktop
        dirs+=(fuzzel hypr waybar)
        [[ -d "$DOTS/.config/dunst" ]] && dirs+=(dunst)
    fi

    for d in "${dirs[@]}"; do
        [[ -d "$DOTS/.config/$d" ]] || { warn "not in dotfiles yet: .config/$d"; continue; }
        link "$DOTS/.config/$d" "$HOME/.config/$d"
    done

    step "symlinks: single-file (herdr keeps runtime state outside git)"
    # herdr's ~/.config/herdr/ has config.toml (tracked) + logs, session.json,
    # and sockets (runtime, must NOT be under git). So we symlink just the file.
    if [[ -f "$DOTS/.config/herdr/config.toml" ]]; then
        run "mkdir -p \"$HOME/.config/herdr\""
        link "$DOTS/.config/herdr/config.toml" "$HOME/.config/herdr/config.toml"
        # Notification sound assets referenced by config.toml (ui.sound.*).
        [[ -d "$DOTS/.config/herdr/sounds" ]] && link "$DOTS/.config/herdr/sounds" "$HOME/.config/herdr/sounds"
        # Keybinding helper scripts referenced by [[keys.command]] (workspace toggle).
        [[ -d "$DOTS/.config/herdr/scripts" ]] && link "$DOTS/.config/herdr/scripts" "$HOME/.config/herdr/scripts"
    else
        warn "no $DOTS/.config/herdr/config.toml yet — skipping"
    fi
}

# =============================================================================
# 5. Pi agent (delegates to the existing sub-installer)
# =============================================================================
setup_pi_agent() {
    if [[ -x "$DOTS/.pi/install.sh" ]]; then
        step "pi agent (.pi/install.sh)"
        run "\"$DOTS/.pi/install.sh\""
    else
        warn "no $DOTS/.pi/install.sh found — skipping pi agent setup"
    fi
}

# =============================================================================
# 5b. Herdr extensions
# =============================================================================
setup_herdr_extensions() {
    if ! command -v herdr &>/dev/null; then
        warn "herdr is not in PATH — skipping the Sesh plugin and Pi integration"
        return
    fi

    # GitHub-managed plugin installation is idempotent: reinstalling refreshes
    # Herdr's managed checkout. The integration writes the bundled Pi extension
    # to ~/.pi/agent/extensions (or $PI_CODING_AGENT_DIR/extensions).
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

# =============================================================================
# 5c. Custom tuicr build
# =============================================================================
# Install the custom fork so the review TUI includes persistent worktree
# tracking and the matching agent integrations.
setup_tuicr() {
    local rebuild="$DOTS/patches/tuicr/rebuild.sh"
    if ! command -v cargo &>/dev/null && [[ -r "$HOME/.cargo/env" ]]; then
        # shellcheck disable=SC1091
        source "$HOME/.cargo/env"
    fi
    if [[ ! -x "$rebuild" ]]; then
        warn "no tuicr rebuild script at $rebuild — skipping"
        return
    fi
    if [[ $NO_PKGS -eq 1 ]]; then
        warn "--no-pkgs: skipping custom tuicr build"
        return
    fi
    if ! command -v cargo &>/dev/null; then
        warn "cargo not in PATH — skipping custom tuicr build (run install_toolchains first)"
        return
    fi
    if ask_yn "build and install custom tuicr from rajaiitp/tuicr? (~2 min)" default_y; then
        run "\"$rebuild\""
    fi
}

# =============================================================================
# 6. Shell — migrate history, bootstrap Zimfw, and set Zsh as default
# =============================================================================
migrate_fish_history() {
    local source="$HOME/.local/share/fish/fish_history"
    local marker="$HOME/.local/state/zsh/fish-history-imported"
    local migrator="$DOTS/.config/scripts/setup/migrate_fish_history.py"

    [[ -f "$source" ]] || return
    if [[ -e "$marker" ]]; then
        ok "Fish history was already imported"
        return
    fi
    if [[ ! -x "$migrator" ]]; then
        warn "Fish history migrator is unavailable: $migrator"
        return
    fi

    say "importing Fish command history into Zsh"
    run "\"$migrator\" --source \"$source\" --destination \"$HOME/.zsh_history\""
    run "mkdir -p \"$(dirname "$marker")\" && touch \"$marker\""
}

install_zimfw() {
    local zim_home="${ZIM_HOME:-${ZDOTDIR:-$HOME}/.zim}"
    if [[ -r "$zim_home/zimfw.zsh" ]]; then
        ok "Zimfw is already installed"
    else
        say "installing Zimfw"
        run "mkdir -p \"$zim_home\" && curl -fsSL https://raw.githubusercontent.com/zimfw/zimfw/master/zimfw.zsh -o \"$zim_home/zimfw.zsh\""
    fi

    if command -v zsh &>/dev/null && [[ -r "$zim_home/zimfw.zsh" ]]; then
        # Set ZIM_HOME inside zsh explicitly: an environment-only assignment is
        # not available as a zsh parameter until it is assigned in that shell.
        run "zsh -c 'ZIM_HOME=\"${zim_home}\"; source \"\$ZIM_HOME/zimfw.zsh\" install'"
    else
        warn "Zimfw modules were not installed (zsh or $zim_home/zimfw.zsh is missing)"
    fi
}

set_default_shell() {
    local zsh_bin
    zsh_bin=$(command -v zsh) || { warn "zsh not in PATH yet, skipping"; return; }
    if [[ $SHELL == "$zsh_bin" ]]; then
        ok "zsh is already the default shell"
        return
    fi
    if ask_yn "set zsh ($zsh_bin) as your default shell?" default_y; then
        # ensure zsh is in /etc/shells
        if ! grep -qxF "$zsh_bin" /etc/shells; then
            run "echo \"$zsh_bin\" | sudo tee -a /etc/shells"
        fi
        run "chsh -s \"$zsh_bin\""
    fi
}

# =============================================================================
# 7. User services (Arch only)
# =============================================================================
enable_user_services() {
    [[ $OS == arch ]] || return
    step "user services (systemd --user)"
    # hypridle is autostarted from ~/.config/hypr/conf/autostart.conf so we
    # don't need a systemd unit for it — this section is intentionally
    # minimal. Add units here if you migrate anything to systemd.
    # hyprsunset is also handled by hyprland's exec.
    ok "nothing to enable (services live in Hyprland's exec-once)"
}

# =============================================================================
# 8. Post-install summary — what's left for the user to do manually
# =============================================================================
summary() {
    step "manual follow-up"
    cat <<'EOF'
Some things this script cannot do for you:

  • Fonts: after install run \`fc-cache -fv\` if new fonts don't show up in nvim/ghostty/waybar
  • Hyprland: log out and back into a Hyprland session (SDDM/greetd/tuigreet)
  • GTK theme: consider installing rose-pine-gtk-theme-full from AUR for full
    system theming (currently GTK apps still use whatever theme is default)
  • Firefox: userChrome.css must be manually copied into your Firefox profile
    at ~/.mozilla/firefox/<profile>/chrome/userChrome.css and toolkit.legacyUserProfileCustomizations.stylesheets
    enabled in about:config
  • Wallpapers: \`~/.config/hypr/hyprpaper.conf\` references paths under
    ~/Documents/wallpaper/ — copy your wallpaper collection there or adjust
  • Wezterm: fully close and reopen to pick up any config changes
  • tuicr: the custom fork installs to ~/.local/bin/tuicr and is built from rajaiitp/tuicr
  • Herdr: the Sesh plugin and Pi agent integration are reconciled automatically
    when `herdr` is available on PATH

If you hit issues, re-run with:
  ./install.sh --dry-run    # see what would happen
  ./install.sh --no-pkgs    # skip package install if it stalls
EOF
}

# =============================================================================
# main
# =============================================================================
main() {
    # Symlinks run FIRST: they're fast, safe, and the whole point of the repo.
    # Package/toolchain installs are slow and fragile (network, brew/pacman
    # hiccups, Ctrl-C). With `set -e` a failure there used to abort the script
    # before symlinks ever ran, leaving ~/.config unlinked. Doing links first
    # guarantees configs are in place regardless of what happens later.
    step "1. symlinks"
    setup_symlinks

    step "2. packages"
    if [[ $NO_PKGS -eq 1 ]]; then
        warn "--no-pkgs: skipping package install"
    else
        case $OS in
            arch)  install_packages_arch ;;
            apt)   install_packages_apt ;;
            macos) install_packages_mac ;;
        esac
    fi

    step "3. toolchains"
    if [[ $NO_PKGS -eq 1 ]]; then
        warn "--no-pkgs: skipping toolchains"
    else
        install_toolchains
    fi

    step "4. pi agent"
    setup_pi_agent

    step "5. Herdr extensions"
    setup_herdr_extensions

    step "6. tuicr (custom fork)"
    setup_tuicr

    step "7. Zsh migration and default shell"
    migrate_fish_history
    if [[ $NO_PKGS -eq 1 ]]; then
        warn "--no-pkgs: skipping Zimfw installation"
    else
        install_zimfw
    fi
    set_default_shell

    step "8. user services"
    enable_user_services

    summary
    if [[ ${#FAILED_COMMANDS[@]} -gt 0 ]]; then
        warn "${#FAILED_COMMANDS[@]} command(s) failed; rerun the recorded commands after fixing their cause"
        return 1
    fi
    step "done"
    ok "dotfiles setup complete"
}

main "$@"
