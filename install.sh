#!/usr/bin/env bash
# ==============================================================================
# Dotfiles setup script
# ------------------------------------------------------------------------------
# One-shot bootstrap for a fresh machine (Arch/Debian Linux and macOS).
# Idempotent — safe to re-run.
#
#   ./install.sh              # choose applications/components, then install
#   ./install.sh --dry-run    # print what would happen, do nothing destructive
#   ./install.sh --no-pkgs    # skip package installs, do symlinks only
#   ./install.sh --yes        # use the common application set without a picker
#   ./install.sh --tui        # install terminal-only defaults without GUI apps
#   ./install.sh --uninstall  # select applications/components to remove
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
#   7. Install Herdr and its Sesh/Pi integrations
#   8. Build and install the custom tuicr fork
#   9. Install Zimfw and set Zsh as the default shell when selected
#  10. Print a summary of anything that needs manual follow-up
#
# Existing config conflicts are backed up automatically with timestamps.
# The only interactive choices are the application/component checklists.
# ==============================================================================

# Keep going after an independent command fails so later setup stages (notably
# Herdr) still run. `run` records failures and main exits non-zero after the
# summary, rather than aborting halfway through the bootstrap.
set -uo pipefail

# ---------------------------------------------------------------- args + flags
DRY_RUN=0
NO_PKGS=0
ASSUME_YES=0
TUI_MODE=0
UNINSTALL=0
declare -a FAILED_COMMANDS=()
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --no-pkgs) NO_PKGS=1 ;;
        --yes|-y) ASSUME_YES=1 ;;
        --tui) TUI_MODE=1 ;;
        --uninstall) UNINSTALL=1 ;;
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
# --------------------------------------------------------------- OS detection
DOTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Make freshly installed user-scoped toolchains visible to later steps in the
# same invocation.
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$PATH"
OS_RELEASE_ID=""
OS_RELEASE_LIKE=""
if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_RELEASE_ID=${ID:-}
    OS_RELEASE_LIKE=${ID_LIKE:-}
fi

if [[ $(uname) == Darwin ]]; then
    OS=macos
elif [[ -f /etc/arch-release || $OS_RELEASE_ID == arch || $OS_RELEASE_LIKE == *arch* ]]; then
    OS=arch
elif command -v apt-get >/dev/null 2>&1 && [[ $OS_RELEASE_ID == debian || $OS_RELEASE_ID == ubuntu || $OS_RELEASE_LIKE == *debian* ]]; then
    OS=apt
else
    err "unsupported OS. This script targets Arch Linux, Debian/Ubuntu, and macOS."
    exit 1
fi
say "detected OS: ${BOLD}$OS${RESET}, dotfiles at ${BOLD}$DOTS${RESET}"

# =============================================================================
# 1. Package installation
# =============================================================================
# Grouped so we can extend easily. Comments explain why each is needed.
# These are non-selectable headers. Each header presents exact package/tool
# entries in its own checklist.
declare -a APP_KEYS=(
    shell core nvim terminals desktop network fonts development herdr pi tuicr tuxedo go cast
)
# Indexed state keeps the installer compatible with the Bash 3.2 shipped by
# older macOS releases; do not require associative arrays or namerefs here.
declare -a SELECTED_APP_FLAGS=() SELECTED_COMPONENT_KEYS=() SELECTED_COMPONENT_FLAGS=()
declare -a CHECKLIST_KEYS=() CHECKLIST_LABELS=() CHECKLIST_DEFAULTS=()
declare -a PKGS_ARCH_SELECTED=() PKGS_APT_SELECTED=() PKGS_MAC_SELECTED=()
declare -a CASKS_MAC_SELECTED=() NPM_GLOBALS_SELECTED=()

declare -a PKGS_ARCH_AUR=()

app_index() {
    local wanted=$1 index
    for index in "${!APP_KEYS[@]}"; do
        [[ ${APP_KEYS[index]} == "$wanted" ]] && { printf '%s\n' "$index"; return 0; }
    done
    return 1
}

app_is_selected() {
    local index
    index=$(app_index "$1") || return 1
    [[ ${SELECTED_APP_FLAGS[index]:-0} == 1 ]]
}

set_app_selected() {
    local index
    index=$(app_index "$1") || return 1
    SELECTED_APP_FLAGS[index]=$2
}

component_index() {
    local wanted=$1 index
    for index in "${!SELECTED_COMPONENT_KEYS[@]}"; do
        [[ ${SELECTED_COMPONENT_KEYS[index]} == "$wanted" ]] && { printf '%s\n' "$index"; return 0; }
    done
    return 1
}

component_is_selected() {
    local index
    index=$(component_index "$1") || return 1
    [[ ${SELECTED_COMPONENT_FLAGS[index]:-0} == 1 ]]
}

set_component_selected() {
    local key=$1 value=$2 index
    if index=$(component_index "$key"); then
        SELECTED_COMPONENT_FLAGS[index]=$value
    else
        SELECTED_COMPONENT_KEYS+=("$key")
        SELECTED_COMPONENT_FLAGS+=("$value")
    fi
}

any_component_selected() {
    local key
    for key in "$@"; do
        component_is_selected "$key" && return 0
    done
    return 1
}

checklist() {
    local target=$1 title=$2
    local key label answer selection index token default_bind initial fzf_status=0
    local -a effective_defaults=() picker_lines=()
    selection=""

    for index in "${!CHECKLIST_KEYS[@]}"; do
        key=${CHECKLIST_KEYS[index]}
        initial=${CHECKLIST_DEFAULTS[index]}
        [[ $UNINSTALL -eq 1 ]] && initial=0
        effective_defaults[index]=$initial
        if [[ $target == apps ]]; then
            set_app_selected "$key" "$initial"
        else
            set_component_selected "$key" "$initial"
        fi
    done

    if [[ $ASSUME_YES -eq 1 || $TUI_MODE -eq 1 || ! -t 0 ]]; then
        return 0
    fi

    if [[ ${DOTFILES_NO_FZF:-0} != 1 ]] && command -v fzf >/dev/null 2>&1; then
        for index in "${!CHECKLIST_KEYS[@]}"; do
            label=${CHECKLIST_LABELS[index]}
            [[ ${effective_defaults[index]} == 1 ]] && label="[default] $label"
            picker_lines+=("${CHECKLIST_KEYS[index]}\t$label")
        done
        default_bind='start:'
        for index in "${!CHECKLIST_KEYS[@]}"; do
            [[ ${effective_defaults[index]} == 1 ]] && default_bind+='toggle+'
            default_bind+='down'
            (( index + 1 < ${#CHECKLIST_KEYS[@]} )) && default_bind+='+'
        done
        selection=$(printf '%s\n' "${picker_lines[@]}" | fzf --multi --height=80% --layout=reverse --border \
            --delimiter=$'\t' --with-shell=bash --prompt="$title > " \
            --header='TAB toggles, ENTER confirms; Ctrl-A selects all, Ctrl-D clears' \
            --bind="$default_bind,ctrl-a:select-all,ctrl-d:deselect-all" | cut -f1-1) || fzf_status=$?
        if [[ $fzf_status -eq 0 ]]; then
            for key in "${CHECKLIST_KEYS[@]}"; do
                [[ $target == apps ]] && set_app_selected "$key" 0 || set_component_selected "$key" 0
            done
            while IFS= read -r key; do
                [[ -z $key ]] && continue
                [[ $target == apps ]] && set_app_selected "$key" 1 || set_component_selected "$key" 1
            done <<<"$selection"
        else
            warn "fzf was cancelled or failed for $title; keeping its defaults"
        fi
        return 0
    fi

    while true; do
        printf '\n%s\n' "${BOLD}$title (toggle numbers, then press Enter):${RESET}"
        for index in "${!CHECKLIST_KEYS[@]}"; do
            key=${CHECKLIST_KEYS[index]}
            if [[ $target == apps ]]; then
                app_is_selected "$key" && answer='x' || answer=' '
            else
                component_is_selected "$key" && answer='x' || answer=' '
            fi
            printf '  [%s] %2d) %s\n' "$answer" "$((index + 1))" "${CHECKLIST_LABELS[index]}"
        done
        printf '  a) all   n) none   Enter) continue\n'
        read -r -p '> ' selection
        [[ -z $selection ]] && break
        case $selection in
            a|all)
                for key in "${CHECKLIST_KEYS[@]}"; do
                    [[ $target == apps ]] && set_app_selected "$key" 1 || set_component_selected "$key" 1
                done
                ;;
            n|none)
                for key in "${CHECKLIST_KEYS[@]}"; do
                    [[ $target == apps ]] && set_app_selected "$key" 0 || set_component_selected "$key" 0
                done
                ;;
            *)
                for token in $selection; do
                    if [[ $token =~ ^[0-9]+$ ]] && (( token >= 1 && token <= ${#CHECKLIST_KEYS[@]} )); then
                        key=${CHECKLIST_KEYS[token - 1]}
                        if [[ $target == apps ]]; then
                            app_is_selected "$key" && set_app_selected "$key" 0 || set_app_selected "$key" 1
                        else
                            component_is_selected "$key" && set_component_selected "$key" 0 || set_component_selected "$key" 1
                        fi
                    else
                        warn "unknown selection: $token"
                    fi
                done
                ;;
        esac
    done
    return 0
}

select_subselections() {
    local group=$1 title
    local -a keys labels defaults
    case $group in
        shell)
            title="Shell"
            keys=(shell_zsh shell_zimfw shell_default)
            labels=("zsh — interactive shell; not a terminal emulator" "Zimfw — Zsh plugin/module manager" "Make Zsh the login/default shell")
            defaults=(1 1 1)
            ;;
        core)
            title="CLI tools"
            keys=(core_git core_fzf core_ripgrep core_fd core_bat core_jq core_eza core_zoxide core_lazygit core_expect core_openssh core_curl core_ca_certs core_libnotify core_worktrunk core_worktrunk_shell)
            labels=("git — version control and worktree backend" "fzf — fuzzy finder for interactive filtering" "ripgrep — fast recursive text search (rg)" "fd — friendly fast file finder (fd/fdfind)" "bat — syntax-highlighted cat replacement/pager" "jq — query and transform JSON" "eza — modern ls with Git/tree information" "zoxide — smarter cd that learns frequently used directories" "lazygit — terminal UI for Git" "expect — automate interactive command-line prompts" "OpenSSH — ssh/scp/sftp client" "curl — HTTP and download client" "CA certificates — validate HTTPS/TLS certificates" "libnotify — desktop notifications via notify-send" "Worktrunk (wt) — create/switch/manage Git worktrees" "Worktrunk shell integration — completions and directory-changing wt switch")
            defaults=(1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1)
            ;;
        nvim)
            title="Neovim"
            keys=(nvim_editor nvim_prettier)
            labels=("Neovim — terminal text editor" "Prettier — formatter for JavaScript/JSON/Markdown and editor files")
            defaults=(1 1)
            ;;
        terminals)
            title="Terminal emulator"
            keys=(terminal_wezterm)
            labels=("WezTerm — plain outer terminal emulator")
            defaults=(1)
            ;;
        desktop)
            title="Wayland desktop and macOS desktop tools"
            keys=(desktop_hyprland desktop_hyprlock desktop_hyprpaper desktop_hypridle desktop_hyprpicker desktop_hyprsunset desktop_xdg_portal_hyprland desktop_xdg_portal_gtk desktop_xdg_portal_wlr desktop_waybar desktop_dunst desktop_fuzzel desktop_grim desktop_slurp desktop_hyprshot desktop_swappy desktop_wl_clipboard desktop_wl_clip_persist desktop_polkit desktop_hyprpolkitagent desktop_pcmanfm desktop_gvfs desktop_xwayland desktop_autoraise desktop_aerospace desktop_karabiner)
            labels=("hyprland — Wayland compositor/window manager" "hyprlock — screen locker" "hyprpaper — wallpaper daemon" "hypridle — idle manager" "hyprpicker — screen color picker" "hyprsunset — screen color-temperature daemon" "xdg-desktop-portal-hyprland — Hyprland portal backend" "xdg-desktop-portal-gtk — GTK portal backend" "xdg-desktop-portal-wlr — wlroots portal backend (APT/alternative)" "waybar — status bar" "dunst — notification daemon" "fuzzel — application launcher" "grim — Wayland screenshot capture" "slurp — Wayland region selector" "hyprshot — Hyprland screenshot helper" "swappy — screenshot annotation tool" "wl-clipboard — Wayland clipboard commands" "wl-clip-persist — persist clipboard after source exits" "polkit/polkitd — privilege authorization service" "hyprpolkitagent — graphical polkit agent" "pcmanfm — graphical file manager" "gvfs — virtual filesystem and removable-device support" "xorg-xwayland/xwayland — X11 application compatibility" "AutoRaise — macOS focus-follows-mouse" "AeroSpace — macOS tiling window manager" "Karabiner-Elements — macOS keyboard remapping")
            defaults=(1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1)
            ;;
        network)
            title="Network and audio"
            keys=(network_networkmanager network_applet network_pipewire network_wireplumber network_pavucontrol network_brightnessctl network_playerctl network_tailscale network_firewalld)
            labels=("networkmanager/network-manager — network service" "network-manager-applet/network-manager-gnome — network tray UI" "pipewire — audio/video server" "wireplumber — PipeWire session manager" "pavucontrol — PulseAudio/PipeWire mixer" "brightnessctl — laptop backlight control" "playerctl — media-player playback controls" "tailscale — mesh VPN" "firewalld — firewall service")
            defaults=(1 1 1 1 1 1 1 1 1)
            ;;
        fonts)
            title="Fonts and GTK"
            keys=(fonts_jetbrains fonts_noto fonts_noto_emoji fonts_gtk3 fonts_gtk4 fonts_python_gobject fonts_adwaita_icons)
            labels=("ttf-jetbrains-mono-nerd/fonts-jetbrains-mono — terminal/editor font" "noto-fonts/fonts-noto — general Unicode font coverage" "noto-fonts-emoji/fonts-noto-color-emoji — emoji font" "gtk3 — GTK 3 toolkit" "gtk4/libgtk-4 — GTK 4 toolkit" "python-gobject/python3-gi — Python GTK bindings" "adwaita-icon-theme — GTK icon theme")
            defaults=(1 1 1 1 1 1 1)
            ;;
        development)
            title="Development and runtimes"
            keys=(dev_base dev_pkgconf dev_libssl dev_rust dev_nodejs dev_npm dev_python dev_imagemagick dev_ffmpeg dev_bun dev_uv)
            labels=("base-devel/build-essential — compiler and build tools" "pkgconf/pkg-config — compiler dependency metadata" "libssl-dev — OpenSSL headers for APT builds" "Rust/Cargo — Rust compiler and package manager" "nodejs/node — JavaScript runtime" "npm — Node package manager" "python/python3 — Python runtime" "imagemagick — image processing" "ffmpeg — audio/video processing" "Bun — alternative JavaScript runtime/package manager" "uv — fast Python package/tool manager")
            defaults=(1 1 1 1 1 1 1 1 1 1 1)
            ;;
        herdr)
            title="Herdr integrations"
            keys=(herdr_binary herdr_sesh herdr_pi_integration)
            labels=("Herdr — persistent terminal multiplexer/session daemon" "fullerzz/herdr-plugin-sesh — session/workspace picker" "Herdr Pi integration — agent-state hooks for Pi panes")
            defaults=(1 1 1)
            ;;
        pi)
            title="Pi agent and extensions"
            keys=(pi_agent pi_ext_pi_ask pi_ext_hypa pi_ext_rpiv_todo pi_ext_pi_subagent pi_ext_pi_herdr pi_ext_pi_model_router pi_ext_observational_memory pi_ext_powerline_footer pi_ext_quota_status pi_ext_web_access)
            labels=("Pi configuration — install ~/.pi and tracked agent settings/skills" "@eko24ive/pi-ask — approval/requirements UI" "@hypabolic/pi-hypa — Hypa-compressed tools" "@juicesharp/rpiv-todo — todo integration" "@mystilleef/pi-subagent — subagent support" "@weshipwork/pi-herdr — Herdr integration tools" "@yeliu84/pi-model-router — model routing" "pi-observational-memory — persistent observations" "pi-powerline-footer — powerline status footer" "pi-quota-status — quota/status display" "pi-web-access — web access extension")
            defaults=(1 1 1 1 1 1 1 1 1 1 1)
            ;;
        tuicr)
            title="tuicr review tool"
            keys=(tuicr_binary tuicr_skill)
            labels=("Custom tuicr — build/install the rajaiitp fork" "tuicr config/Pi skill — link review settings and skill/wrappers")
            defaults=(1 1)
            ;;
        tuxedo)
            title="Tuxedo notes"
            keys=(tuxedo_binary)
            labels=("Tuxedo — terminal todo.txt notes application")
            defaults=(1)
            ;;
        go)
            title="Go development"
            keys=(go_binary)
            labels=("go — Go compiler and tooling")
            defaults=(0)
            ;;
        cast)
            title="Google Cast"
            keys=(cast_catt)
            labels=("catt — Google Cast playback/volume CLI")
            defaults=(0)
            ;;
    esac
    CHECKLIST_KEYS=("${keys[@]}")
    CHECKLIST_LABELS=("${labels[@]}")
    CHECKLIST_DEFAULTS=("${defaults[@]}")
    checklist components "$title"
}

sync_selected_apps() {
    local app
    for app in "${APP_KEYS[@]}"; do set_app_selected "$app" 0; done
    any_component_selected shell_zsh shell_zimfw shell_default && set_app_selected shell 1
    any_component_selected core_git core_fzf core_ripgrep core_fd core_bat core_jq core_eza core_zoxide core_lazygit core_expect core_openssh core_curl core_ca_certs core_libnotify core_worktrunk core_worktrunk_shell && set_app_selected core 1
    any_component_selected nvim_editor nvim_prettier && set_app_selected nvim 1
    any_component_selected terminal_wezterm && set_app_selected terminals 1
    any_component_selected desktop_hyprland desktop_hyprlock desktop_hyprpaper desktop_hypridle desktop_hyprpicker desktop_hyprsunset desktop_xdg_portal_hyprland desktop_xdg_portal_gtk desktop_xdg_portal_wlr desktop_waybar desktop_dunst desktop_fuzzel desktop_grim desktop_slurp desktop_hyprshot desktop_swappy desktop_wl_clipboard desktop_wl_clip_persist desktop_polkit desktop_hyprpolkitagent desktop_pcmanfm desktop_gvfs desktop_xwayland desktop_autoraise desktop_aerospace desktop_karabiner && set_app_selected desktop 1
    any_component_selected network_networkmanager network_applet network_pipewire network_wireplumber network_pavucontrol network_brightnessctl network_playerctl network_tailscale network_firewalld && set_app_selected network 1
    any_component_selected fonts_jetbrains fonts_noto fonts_noto_emoji fonts_gtk3 fonts_gtk4 fonts_python_gobject fonts_adwaita_icons && set_app_selected fonts 1
    any_component_selected dev_base dev_pkgconf dev_libssl dev_rust dev_nodejs dev_npm dev_python dev_imagemagick dev_ffmpeg dev_bun dev_uv && set_app_selected development 1
    any_component_selected herdr_binary herdr_sesh herdr_pi_integration && set_app_selected herdr 1
    any_component_selected pi_agent pi_ext_pi_ask pi_ext_hypa pi_ext_rpiv_todo pi_ext_pi_subagent pi_ext_pi_herdr pi_ext_pi_model_router pi_ext_observational_memory pi_ext_powerline_footer pi_ext_quota_status pi_ext_web_access && set_app_selected pi 1
    any_component_selected tuicr_binary tuicr_skill && set_app_selected tuicr 1
    any_component_selected tuxedo_binary && set_app_selected tuxedo 1
    any_component_selected go_binary && set_app_selected go 1
    any_component_selected cast_catt && set_app_selected cast 1
}

select_applications() {
    local app
    SELECTED_APP_FLAGS=()
    SELECTED_COMPONENT_KEYS=()
    SELECTED_COMPONENT_FLAGS=()
    if [[ $TUI_MODE -eq 1 && $UNINSTALL -eq 0 ]]; then
        for app in shell core nvim development herdr pi tuicr tuxedo; do
            select_subselections "$app"
        done
        # Terminal profile: keep runtime essentials, but omit GUI/media and
        # editor formatter extras unless explicitly selected in the full flow.
        set_component_selected nvim_prettier 0
        set_component_selected dev_imagemagick 0
        set_component_selected dev_ffmpeg 0
    else
        for app in "${APP_KEYS[@]}"; do
            select_subselections "$app"
        done
    fi

    if [[ $UNINSTALL -eq 0 ]]; then
        resolve_selected_dependencies
    fi
    sync_selected_apps
}

resolve_selected_dependencies() {
    if component_is_selected herdr_sesh || component_is_selected herdr_pi_integration; then
        set_component_selected herdr_binary 1
    fi
    if any_component_selected pi_ext_pi_ask pi_ext_hypa pi_ext_rpiv_todo pi_ext_pi_subagent pi_ext_pi_herdr pi_ext_pi_model_router pi_ext_observational_memory pi_ext_powerline_footer pi_ext_quota_status pi_ext_web_access || component_is_selected nvim_prettier; then
        set_component_selected dev_nodejs 1
        set_component_selected dev_npm 1
    fi
    if component_is_selected tuicr_skill || any_component_selected pi_ext_pi_ask pi_ext_hypa pi_ext_rpiv_todo pi_ext_pi_subagent pi_ext_pi_herdr pi_ext_pi_model_router pi_ext_observational_memory pi_ext_powerline_footer pi_ext_quota_status pi_ext_web_access; then
        set_component_selected pi_agent 1
    fi
    if component_is_selected tuicr_binary || component_is_selected tuxedo_binary || component_is_selected core_worktrunk || component_is_selected core_worktrunk_shell; then
        set_component_selected dev_rust 1
        set_component_selected dev_base 1
        set_component_selected dev_pkgconf 1
        set_component_selected dev_libssl 1
    fi
    if component_is_selected core_worktrunk_shell; then
        set_component_selected core_worktrunk 1
    fi
    if component_is_selected cast_catt; then
        set_component_selected dev_uv 1
    fi
    if component_is_selected herdr_binary || component_is_selected tuicr_binary; then
        set_component_selected core_git 1
        set_component_selected core_curl 1
        set_component_selected core_ca_certs 1
    fi
}

build_selected_packages() {
    PKGS_ARCH_SELECTED=()
    PKGS_APT_SELECTED=()
    PKGS_MAC_SELECTED=()
    CASKS_MAC_SELECTED=()
    NPM_GLOBALS_SELECTED=()

    component_is_selected shell_zsh && { PKGS_ARCH_SELECTED+=(zsh); PKGS_APT_SELECTED+=(zsh); PKGS_MAC_SELECTED+=(zsh); }

    component_is_selected core_git && { PKGS_ARCH_SELECTED+=(git); PKGS_APT_SELECTED+=(git); PKGS_MAC_SELECTED+=(git); }
    component_is_selected core_fzf && { PKGS_ARCH_SELECTED+=(fzf); PKGS_APT_SELECTED+=(fzf); PKGS_MAC_SELECTED+=(fzf); }
    component_is_selected core_ripgrep && { PKGS_ARCH_SELECTED+=(ripgrep); PKGS_APT_SELECTED+=(ripgrep); PKGS_MAC_SELECTED+=(ripgrep); }
    component_is_selected core_fd && { PKGS_ARCH_SELECTED+=(fd); PKGS_APT_SELECTED+=(fd-find); PKGS_MAC_SELECTED+=(fd); }
    component_is_selected core_bat && { PKGS_ARCH_SELECTED+=(bat); PKGS_APT_SELECTED+=(bat); PKGS_MAC_SELECTED+=(bat); }
    component_is_selected core_jq && { PKGS_ARCH_SELECTED+=(jq); PKGS_APT_SELECTED+=(jq); PKGS_MAC_SELECTED+=(jq); }
    component_is_selected core_eza && { PKGS_ARCH_SELECTED+=(eza); PKGS_APT_SELECTED+=(eza); PKGS_MAC_SELECTED+=(eza); }
    component_is_selected core_zoxide && { PKGS_ARCH_SELECTED+=(zoxide); PKGS_APT_SELECTED+=(zoxide); PKGS_MAC_SELECTED+=(zoxide); }
    component_is_selected core_lazygit && { PKGS_ARCH_SELECTED+=(lazygit); PKGS_APT_SELECTED+=(lazygit); PKGS_MAC_SELECTED+=(lazygit); }
    component_is_selected core_expect && { PKGS_ARCH_SELECTED+=(expect); PKGS_APT_SELECTED+=(expect); PKGS_MAC_SELECTED+=(expect); }
    component_is_selected core_openssh && { PKGS_ARCH_SELECTED+=(openssh); PKGS_APT_SELECTED+=(openssh-client); PKGS_MAC_SELECTED+=(openssh); }
    component_is_selected core_curl && { PKGS_ARCH_SELECTED+=(curl); PKGS_APT_SELECTED+=(curl); }
    component_is_selected core_ca_certs && { PKGS_ARCH_SELECTED+=(ca-certificates); PKGS_APT_SELECTED+=(ca-certificates); }
    component_is_selected core_libnotify && { PKGS_ARCH_SELECTED+=(libnotify); PKGS_APT_SELECTED+=(libnotify-bin); }
    component_is_selected core_worktrunk && { PKGS_ARCH_SELECTED+=(worktrunk); PKGS_MAC_SELECTED+=(worktrunk); }

    component_is_selected nvim_editor && { PKGS_ARCH_SELECTED+=(neovim); PKGS_APT_SELECTED+=(neovim); PKGS_MAC_SELECTED+=(neovim); }
    component_is_selected nvim_prettier && NPM_GLOBALS_SELECTED+=(prettier)

    component_is_selected terminal_wezterm && { PKGS_ARCH_SELECTED+=(wezterm); PKGS_APT_SELECTED+=(wezterm); CASKS_MAC_SELECTED+=(wezterm); }

    component_is_selected desktop_hyprland && { PKGS_ARCH_SELECTED+=(hyprland); PKGS_APT_SELECTED+=(hyprland); }
    component_is_selected desktop_hyprlock && { PKGS_ARCH_SELECTED+=(hyprlock); PKGS_APT_SELECTED+=(hyprlock); }
    component_is_selected desktop_hyprpaper && { PKGS_ARCH_SELECTED+=(hyprpaper); PKGS_APT_SELECTED+=(hyprpaper); }
    component_is_selected desktop_hypridle && { PKGS_ARCH_SELECTED+=(hypridle); PKGS_APT_SELECTED+=(hypridle); }
    component_is_selected desktop_hyprpicker && { PKGS_ARCH_SELECTED+=(hyprpicker); PKGS_APT_SELECTED+=(hyprpicker); }
    component_is_selected desktop_hyprsunset && { PKGS_ARCH_SELECTED+=(hyprsunset); PKGS_APT_SELECTED+=(hyprsunset); }
    component_is_selected desktop_xdg_portal_hyprland && { PKGS_ARCH_SELECTED+=(xdg-desktop-portal-hyprland); PKGS_APT_SELECTED+=(xdg-desktop-portal-hyprland); }
    component_is_selected desktop_xdg_portal_gtk && { PKGS_ARCH_SELECTED+=(xdg-desktop-portal-gtk); PKGS_APT_SELECTED+=(xdg-desktop-portal-gtk); }
    component_is_selected desktop_xdg_portal_wlr && { PKGS_ARCH_SELECTED+=(xdg-desktop-portal-wlr); PKGS_APT_SELECTED+=(xdg-desktop-portal-wlr); }
    component_is_selected desktop_waybar && { PKGS_ARCH_SELECTED+=(waybar); PKGS_APT_SELECTED+=(waybar); }
    component_is_selected desktop_dunst && { PKGS_ARCH_SELECTED+=(dunst); PKGS_APT_SELECTED+=(dunst); }
    component_is_selected desktop_fuzzel && { PKGS_ARCH_SELECTED+=(fuzzel); PKGS_APT_SELECTED+=(fuzzel); }
    component_is_selected desktop_grim && { PKGS_ARCH_SELECTED+=(grim); PKGS_APT_SELECTED+=(grim); }
    component_is_selected desktop_slurp && { PKGS_ARCH_SELECTED+=(slurp); PKGS_APT_SELECTED+=(slurp); }
    component_is_selected desktop_hyprshot && { PKGS_ARCH_SELECTED+=(hyprshot); PKGS_APT_SELECTED+=(hyprshot); }
    component_is_selected desktop_swappy && { PKGS_ARCH_SELECTED+=(swappy); PKGS_APT_SELECTED+=(swappy); }
    component_is_selected desktop_wl_clipboard && { PKGS_ARCH_SELECTED+=(wl-clipboard); PKGS_APT_SELECTED+=(wl-clipboard); }
    component_is_selected desktop_wl_clip_persist && { PKGS_ARCH_SELECTED+=(wl-clip-persist); PKGS_APT_SELECTED+=(wl-clip-persist); }
    component_is_selected desktop_polkit && { PKGS_ARCH_SELECTED+=(polkit); PKGS_APT_SELECTED+=(polkitd); }
    component_is_selected desktop_hyprpolkitagent && { PKGS_ARCH_SELECTED+=(hyprpolkitagent); PKGS_APT_SELECTED+=(hyprpolkitagent); }
    component_is_selected desktop_pcmanfm && { PKGS_ARCH_SELECTED+=(pcmanfm); PKGS_APT_SELECTED+=(pcmanfm); }
    component_is_selected desktop_gvfs && { PKGS_ARCH_SELECTED+=(gvfs); PKGS_APT_SELECTED+=(gvfs); }
    component_is_selected desktop_xwayland && [[ $OS == arch ]] && PKGS_ARCH_SELECTED+=(xorg-xwayland)
    component_is_selected desktop_xwayland && [[ $OS == apt ]] && PKGS_APT_SELECTED+=(xwayland)
    component_is_selected desktop_autoraise && [[ $OS == macos ]] && CASKS_MAC_SELECTED+=(dimentium/autoraise/autoraiseapp)
    component_is_selected desktop_aerospace && [[ $OS == macos ]] && CASKS_MAC_SELECTED+=(nikitabobko/tap/aerospace)
    component_is_selected desktop_karabiner && [[ $OS == macos ]] && CASKS_MAC_SELECTED+=(karabiner-elements)

    component_is_selected network_networkmanager && { PKGS_ARCH_SELECTED+=(networkmanager); PKGS_APT_SELECTED+=(network-manager); }
    component_is_selected network_applet && { PKGS_ARCH_SELECTED+=(network-manager-applet); PKGS_APT_SELECTED+=(network-manager-gnome); }
    component_is_selected network_pipewire && { PKGS_ARCH_SELECTED+=(pipewire); PKGS_APT_SELECTED+=(pipewire); }
    component_is_selected network_wireplumber && { PKGS_ARCH_SELECTED+=(wireplumber); PKGS_APT_SELECTED+=(wireplumber); }
    component_is_selected network_pavucontrol && { PKGS_ARCH_SELECTED+=(pavucontrol); PKGS_APT_SELECTED+=(pavucontrol); }
    component_is_selected network_brightnessctl && { PKGS_ARCH_SELECTED+=(brightnessctl); PKGS_APT_SELECTED+=(brightnessctl); }
    component_is_selected network_playerctl && { PKGS_ARCH_SELECTED+=(playerctl); PKGS_APT_SELECTED+=(playerctl); }
    component_is_selected network_tailscale && { PKGS_ARCH_SELECTED+=(tailscale); PKGS_APT_SELECTED+=(tailscale); PKGS_MAC_SELECTED+=(tailscale); }
    component_is_selected network_firewalld && { PKGS_ARCH_SELECTED+=(firewalld); PKGS_APT_SELECTED+=(firewalld); }

    component_is_selected fonts_jetbrains && { PKGS_ARCH_SELECTED+=(ttf-jetbrains-mono-nerd); PKGS_APT_SELECTED+=(fonts-jetbrains-mono); CASKS_MAC_SELECTED+=(font-jetbrains-mono-nerd-font); }
    component_is_selected fonts_noto && { PKGS_ARCH_SELECTED+=(noto-fonts); PKGS_APT_SELECTED+=(fonts-noto); }
    component_is_selected fonts_noto_emoji && { PKGS_ARCH_SELECTED+=(noto-fonts-emoji); PKGS_APT_SELECTED+=(fonts-noto-color-emoji); }
    component_is_selected fonts_gtk3 && { PKGS_ARCH_SELECTED+=(gtk3); PKGS_APT_SELECTED+=(libgtk-3-0); }
    component_is_selected fonts_gtk4 && { PKGS_ARCH_SELECTED+=(gtk4); PKGS_APT_SELECTED+=(libgtk-4-1); }
    component_is_selected fonts_python_gobject && { PKGS_ARCH_SELECTED+=(python-gobject); PKGS_APT_SELECTED+=(python3-gi); }
    component_is_selected fonts_adwaita_icons && { PKGS_ARCH_SELECTED+=(adwaita-icon-theme); PKGS_APT_SELECTED+=(adwaita-icon-theme); }

    component_is_selected dev_base && { PKGS_ARCH_SELECTED+=(base-devel); PKGS_APT_SELECTED+=(build-essential); }
    component_is_selected dev_pkgconf && { PKGS_ARCH_SELECTED+=(pkgconf); PKGS_APT_SELECTED+=(pkg-config); PKGS_MAC_SELECTED+=(pkg-config); }
    component_is_selected dev_libssl && PKGS_APT_SELECTED+=(libssl-dev)
    component_is_selected dev_nodejs && { PKGS_ARCH_SELECTED+=(nodejs); PKGS_APT_SELECTED+=(nodejs); PKGS_MAC_SELECTED+=(node); }
    component_is_selected dev_npm && { PKGS_ARCH_SELECTED+=(npm); PKGS_APT_SELECTED+=(npm); }
    component_is_selected dev_python && { PKGS_ARCH_SELECTED+=(python); PKGS_APT_SELECTED+=(python3); PKGS_MAC_SELECTED+=(python); }
    component_is_selected dev_imagemagick && { PKGS_ARCH_SELECTED+=(imagemagick); PKGS_APT_SELECTED+=(imagemagick); PKGS_MAC_SELECTED+=(imagemagick); }
    component_is_selected dev_ffmpeg && { PKGS_ARCH_SELECTED+=(ffmpeg); PKGS_APT_SELECTED+=(ffmpeg); PKGS_MAC_SELECTED+=(ffmpeg); }

    component_is_selected herdr_binary && [[ $OS == macos ]] && PKGS_MAC_SELECTED+=(herdr)
    component_is_selected tuxedo_binary && [[ $OS == macos ]] && PKGS_MAC_SELECTED+=(tuxedo)
    component_is_selected go_binary && { PKGS_ARCH_SELECTED+=(go); PKGS_APT_SELECTED+=(golang-go); PKGS_MAC_SELECTED+=(go); }

    return 0
}

install_packages_arch() {
    say "refreshing pacman"
    run "sudo pacman -Syu --noconfirm"

    say "installing pacman packages"
    # only install what's not already there — pacman is fast but idempotency reads better
    local missing=()
    for p in "${PKGS_ARCH_SELECTED[@]}"; do
        pacman -Qi "$p" &>/dev/null || missing+=("$p")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        run "sudo pacman -S --noconfirm --needed ${missing[*]}"
    else
        ok "all pacman packages already installed"
    fi

    # AUR: bootstrap yay only when this setup actually declares AUR packages.
    if [[ ${#PKGS_ARCH_AUR[@]} -gt 0 ]]; then
        if ! command -v yay &>/dev/null && ! command -v paru &>/dev/null; then
            say "bootstrapping yay from AUR (no AUR helper found)"
            run "sudo pacman -S --noconfirm --needed base-devel"
            run "mkdir -p /tmp/yay-bootstrap && cd /tmp/yay-bootstrap && \
                 git clone https://aur.archlinux.org/yay-bin.git && \
                 cd yay-bin && makepkg -si --noconfirm"
        fi
        local aur=${AUR_HELPER:-$(command -v yay || command -v paru)}
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
    for p in "${PKGS_APT_SELECTED[@]}"; do
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

load_brew() {
    command -v brew >/dev/null 2>&1 && return 0
    local candidate
    for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
        if [[ -x $candidate ]]; then
            eval "$(\"$candidate\" shellenv)"
            return 0
        fi
    done
    return 1
}

install_packages_mac() {
    load_brew || true
    if ! command -v brew &>/dev/null; then
        say "bootstrapping Homebrew"
        run '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
        load_brew || true
    fi
    if ! command -v brew &>/dev/null; then
        warn "Homebrew is unavailable; skipping macOS package installation"
        return
    fi
    say "installing brew packages"
    local failed=()
    for p in "${PKGS_MAC_SELECTED[@]}"; do
        if brew list --formula "$p" &>/dev/null; then
            ok "already installed: $p"
        elif ! run "brew install --quiet $p"; then
            warn "brew formula failed: $p (skipping)"
            failed+=("$p")
        fi
    done
    if [[ ${#CASKS_MAC_SELECTED[@]} -gt 0 ]]; then
        say "installing brew casks (fonts and host applications)"
        for c in "${CASKS_MAC_SELECTED[@]}"; do
            if brew list --cask "$c" &>/dev/null; then
                ok "already installed: $c"
            elif ! run "brew install --quiet --cask $c"; then
                warn "brew cask failed: $c (skipping)"
                failed+=("$c (cask)")
            fi
        done
    fi
    if [[ ${#failed[@]} -gt 0 ]]; then
        warn "brew items that need manual attention: ${failed[*]}"
    fi
}

herdr_bin() {
    if command -v herdr >/dev/null 2>&1; then
        command -v herdr
    elif [[ -x "$HOME/.local/bin/herdr" ]]; then
        printf '%s\\n' "$HOME/.local/bin/herdr"
    elif load_brew; then
        local brew_herdr
        brew_herdr="$(brew --prefix herdr 2>/dev/null || true)/bin/herdr"
        [[ -x $brew_herdr ]] && printf '%s\\n' "$brew_herdr"
    fi
}

install_herdr() {
    if [[ -n "$(herdr_bin || true)" ]]; then
        ok "Herdr already installed"
        return
    fi
    if [[ $OS == macos ]] && command -v brew >/dev/null 2>&1; then
        say "installing Herdr via Homebrew"
        run "brew install herdr"
    else
        say "installing Herdr via the official installer"
        run 'curl -fsSL https://herdr.dev/install.sh | sh'
    fi
}

# =============================================================================
# 2. Toolchains (Rust / Node / Python / Go / Bun)
# =============================================================================
install_toolchains() {
    if component_is_selected dev_rust; then
        if ! command -v rustup &>/dev/null; then
            say "installing rustup + stable Rust"
            run 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable'
        else ok "rustup already present"; fi
        if [[ -r "$HOME/.cargo/env" ]]; then
            # shellcheck disable=SC1091
            source "$HOME/.cargo/env" || warn "could not source Cargo environment"
        fi
    fi

    if component_is_selected core_worktrunk && ! command -v wt >/dev/null 2>&1; then
        if command -v cargo >/dev/null 2>&1; then
            say "installing Worktrunk (wt) with Cargo"
            run "cargo install worktrunk --locked"
        else
            warn "Worktrunk is unavailable and cargo is not in PATH; skipping wt"
        fi
    fi

    if component_is_selected dev_bun; then
        if ! command -v bun &>/dev/null; then
            say "installing bun (JavaScript runtime)"
            run 'curl -fsSL https://bun.sh/install | bash'
        else ok "bun already present"; fi
    fi

    if component_is_selected dev_uv; then
        if ! command -v uv &>/dev/null; then
            say "installing uv (Python package manager)"
            run 'curl -LsSf https://astral.sh/uv/install.sh | sh'
        else ok "uv already present"; fi
    fi

    if component_is_selected cast_catt && [[ $OS != macos ]] && ! command -v catt &>/dev/null; then
        say "installing catt (Google Cast CLI)"
        run "uv tool install catt"
    fi

    # Package selection remains exact: do not silently add npm when only
    # nodejs was selected. These fallbacks only retry the exact selected item
    # after a package-manager failure.
    if component_is_selected dev_nodejs && [[ $OS == arch ]] && ! pacman -Qi nodejs &>/dev/null; then
        run "sudo pacman -S --noconfirm --needed nodejs"
    elif component_is_selected dev_nodejs && [[ $OS == apt ]] && ! command -v node &>/dev/null; then
        run "sudo apt-get install --yes nodejs"
    fi

    if (component_is_selected dev_npm || [[ ${#NPM_GLOBALS_SELECTED[@]} -gt 0 ]]) && command -v npm >/dev/null 2>&1; then
        local npm_prefix="$HOME/.npm-global"
        if [[ "$(npm config get prefix 2>/dev/null)" != "$npm_prefix" ]]; then
            say "pointing npm global prefix at $npm_prefix (sudo-free installs)"
            run "npm config set prefix \"$npm_prefix\""
            run "mkdir -p \"$npm_prefix/bin\""
        fi
        if [[ ${#NPM_GLOBALS_SELECTED[@]} -gt 0 ]]; then
            say "installing npm globals: ${NPM_GLOBALS_SELECTED[*]}"
            run "npm install -g ${NPM_GLOBALS_SELECTED[*]}"
        fi
    elif [[ ${#NPM_GLOBALS_SELECTED[@]} -gt 0 ]]; then
        warn "npm is unavailable; skipping npm globals"
    fi

    if component_is_selected tuxedo_binary && [[ $OS != macos ]] && ! command -v tuxedo &>/dev/null; then
        say "installing tuxedo from git (cargo)"
        run "cargo install --git https://github.com/webstonehq/tuxedo"
    fi
}

# =============================================================================
# 3. Worktrunk shell integration
# =============================================================================
setup_worktrunk() {
    if ! component_is_selected core_worktrunk_shell; then
        return 0
    fi
    local wt_bin
    wt_bin="$(command -v wt || true)"
    if [[ -z $wt_bin ]]; then
        warn "Worktrunk (wt) is unavailable; skipping shell integration"
        return 0
    fi
    say "installing Worktrunk shell integration"
    run "$wt_bin config shell install"
}

# =============================================================================
# 4. Symlink engine (automatic timestamped conflict backups)
# =============================================================================
# link SRC DST → creates DST as a symlink to SRC.
# If DST already exists and isn't the right symlink, create a timestamped backup.
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
        local backup="${dst}.bak.$(date +%s)"
        say "backing up existing $dst → $backup"
        run "mv \"$dst\" \"$backup\""
    fi
    run "mkdir -p \"$(dirname "$dst")\""
    run "ln -sfn \"$src\" \"$dst\""
    ok "linked: $dst → $src"
}

# =============================================================================
# 5. Symlink layout — declared as (src_relative_to_dots, dst_absolute) pairs
# =============================================================================
setup_symlinks() {
    step "symlinks: root-level files"
    # Link only the configuration belonging to the selected applications.
    if app_is_selected desktop && [[ $OS != macos ]]; then
        link "$DOTS/.gtkrc-2.0"          "$HOME/.gtkrc-2.0"
        link "$DOTS/mimeapps.list"       "$HOME/.config/mimeapps.list"
    fi
    if component_is_selected shell_zsh; then
        link "$DOTS/.zshrc"              "$HOME/.zshrc"
    fi
    if component_is_selected shell_zimfw; then
        link "$DOTS/.zimrc"              "$HOME/.zimrc"
    fi

    step "symlinks: whole ~/.config/* directories"
    # Everything under .config/ except herdr (per-file below).
    # opencode is intentionally excluded — the live version is a dev tree
    # with node_modules, not something to check in.
    #
    # Split by OS so a Mac doesn't get dead Wayland symlinks and Linux doesn't
    # get dead aerospace/karabiner symlinks.
    local -a dirs=()
    component_is_selected core_git && dirs+=(git)
    component_is_selected nvim_editor && dirs+=(nvim)
    if app_is_selected desktop || app_is_selected network || app_is_selected cast; then
        dirs+=(scripts)
    fi
    component_is_selected herdr_sesh && dirs+=(sesh)
    component_is_selected tuicr_skill && dirs+=(tuicr)
    component_is_selected terminal_wezterm && dirs+=(wezterm)
    component_is_selected shell_zsh && dirs+=(zsh)
    if [[ $OS == macos ]]; then
        # macOS window manager + key remapper
        if any_component_selected desktop_autoraise desktop_aerospace desktop_karabiner; then
            dirs+=(AutoRaise aerospace karabiner)
        fi
    elif app_is_selected desktop; then
        # Linux/Wayland desktop
        dirs+=(fuzzel hypr waybar)
        [[ -d "$DOTS/.config/dunst" ]] && dirs+=(dunst)
    fi

    for d in "${dirs[@]}"; do
        [[ -d "$DOTS/.config/$d" ]] || { warn "not in dotfiles yet: .config/$d"; continue; }
        link "$DOTS/.config/$d" "$HOME/.config/$d"
    done

    if component_is_selected terminal_wezterm && [[ -f "$DOTS/.local/share/applications/wezterm.desktop" ]]; then
        link "$DOTS/.local/share/applications/wezterm.desktop" "$HOME/.local/share/applications/wezterm.desktop"
    fi

    # active.ini is intentionally ignored because it is generated from a
    # preset. Seed it after linking so a fresh checkout has a working fuzzel.
    if app_is_selected desktop && [[ $OS != macos && -x "$DOTS/.config/scripts/desktop/fuzzel_theme.sh" ]]; then
        run "\"$DOTS/.config/scripts/desktop/fuzzel_theme.sh\" gruvbox-dark"
    fi

    step "symlinks: single-file (herdr keeps runtime state outside git)"
    # herdr's ~/.config/herdr/ has config.toml (tracked) + logs, session.json,
    # and sockets (runtime, must NOT be under git). So we symlink just the file.
    if app_is_selected herdr; then
        if [[ -f "$DOTS/.config/herdr/config.toml" ]]; then
            run "mkdir -p \"$HOME/.config/herdr\""
            link "$DOTS/.config/herdr/config.toml" "$HOME/.config/herdr/config.toml"
            # Notification sound assets referenced by config.toml (ui.sound.*).
            [[ -d "$DOTS/.config/herdr/sounds" ]] && link "$DOTS/.config/herdr/sounds" "$HOME/.config/herdr/sounds"
            # Keybinding helper scripts referenced by [[keys.command]].
            [[ -d "$DOTS/.config/herdr/scripts" ]] && link "$DOTS/.config/herdr/scripts" "$HOME/.config/herdr/scripts"
        else
            warn "no $DOTS/.config/herdr/config.toml yet — skipping"
        fi
    fi

    # fullerzz/herdr-plugin-sesh currently resolves this compatibility path;
    # keep the tracked config available there as well as ~/.config/sesh.
    if component_is_selected herdr_sesh && [[ -f "$DOTS/.config/sesh/sesh.toml" ]]; then
        link "$DOTS/.config/sesh/sesh.toml" "$HOME/.config/herdr-sesh/sesh.toml"
    fi
}

# =============================================================================
# 6. Pi agent (delegates to the existing sub-installer)
# =============================================================================
setup_pi_agent() {
    if ! component_is_selected pi_agent; then
        warn "Pi configuration was not selected; skipping Pi agent setup"
    elif [[ ! -x "$DOTS/.pi/install.sh" ]]; then
        warn "no $DOTS/.pi/install.sh found — skipping pi agent setup"
    else
        step "pi agent (.pi/install.sh)"
        local -a pi_packages=()
        component_is_selected pi_ext_pi_ask && pi_packages+=("@eko24ive/pi-ask")
        component_is_selected pi_ext_hypa && pi_packages+=("@hypabolic/pi-hypa")
        component_is_selected pi_ext_rpiv_todo && pi_packages+=("@juicesharp/rpiv-todo")
        component_is_selected pi_ext_pi_subagent && pi_packages+=("@mystilleef/pi-subagent")
        component_is_selected pi_ext_pi_herdr && pi_packages+=("@weshipwork/pi-herdr")
        component_is_selected pi_ext_pi_model_router && pi_packages+=("@yeliu84/pi-model-router")
        component_is_selected pi_ext_observational_memory && pi_packages+=("pi-observational-memory")
        component_is_selected pi_ext_powerline_footer && pi_packages+=("pi-powerline-footer")
        component_is_selected pi_ext_quota_status && pi_packages+=("pi-quota-status")
        component_is_selected pi_ext_web_access && pi_packages+=("pi-web-access")
        if [[ $NO_PKGS -eq 1 || ${#pi_packages[@]} -eq 0 ]]; then
            run "PI_SKIP_NPM=1 \"$DOTS/.pi/install.sh\""
        else
            run "PI_SKIP_NPM=1 PI_NPM_PACKAGES=\"${pi_packages[*]}\" \"$DOTS/.pi/install.sh\""
        fi
    fi
}

# =============================================================================
# 8. Herdr and integrations
# =============================================================================
setup_herdr() {
    if ! app_is_selected herdr; then
        warn "Herdr was not selected; skipping Herdr integrations"
        return
    fi
    if [[ $NO_PKGS -eq 1 ]]; then
        warn "--no-pkgs: skipping Herdr binary and plugin installation"
        return
    fi
    if component_is_selected herdr_binary; then
        install_herdr
    fi
    local bin
    bin="$(herdr_bin || true)"
    if [[ -z $bin ]]; then
        warn "Herdr is unavailable; skipping selected Herdr integrations"
        return
    fi

    if component_is_selected herdr_sesh; then
        local plugin_status
        plugin_status="$($bin plugin list 2>/dev/null || true)"
        if grep -q 'fullerzz.sesh.*enabled' <<<"$plugin_status"; then
            ok "Herdr Sesh plugin is installed and enabled"
        elif grep -q 'fullerzz.sesh' <<<"$plugin_status"; then
            say "enabling Herdr Sesh plugin"
            run "$bin plugin enable fullerzz.sesh"
        else
            say "installing Herdr Sesh plugin"
            run "$bin plugin install fullerzz/herdr-plugin-sesh --yes"
        fi
    fi

    if component_is_selected herdr_pi_integration; then
        local integration_status
        integration_status="$($bin integration status 2>/dev/null || true)"
        if grep -qE '^pi: current ' <<<"$integration_status"; then
            ok "Herdr Pi integration is current"
        else
            say "installing/updating Herdr Pi integration"
            run "$bin integration install pi"
        fi
    fi
}

# =============================================================================
# 9. Custom tuicr build
# =============================================================================
# Install the custom fork so the review TUI includes persistent worktree
# tracking and the matching agent integrations.
setup_tuicr() {
    if ! component_is_selected tuicr_binary; then
        warn "custom tuicr binary was not selected; skipping custom build"
        return
    fi
    local rebuild="$DOTS/patches/tuicr/rebuild.sh"
    if ! command -v cargo &>/dev/null && [[ -r "$HOME/.cargo/env" ]]; then
        # shellcheck disable=SC1091
        source "$HOME/.cargo/env" || warn "could not source Cargo environment"
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
    say "building and installing custom tuicr from rajaiitp/tuicr"
    run "\"$rebuild\""
}

# =============================================================================
# 10. Shell — migrate history, bootstrap Zimfw, and set Zsh as default
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
    if [[ ${SHELL:-} == "$zsh_bin" ]]; then
        ok "zsh is already the default shell"
        return
    fi
    say "setting zsh ($zsh_bin) as the default shell"
    # macOS ships zsh as a supported login shell; Linux may need it
    # registered before chsh accepts it.
    if [[ $OS != macos ]] && ! grep -qxF "$zsh_bin" /etc/shells; then
        run "echo \"$zsh_bin\" | sudo tee -a /etc/shells"
    fi
    run "chsh -s \"$zsh_bin\""
}

# =============================================================================
# 10. Uninstaller — remove only explicitly selected managed items
# =============================================================================
unlink_managed() {
    local src=$1 dst=$2
    if [[ -L $dst ]] && [[ $(readlink "$dst") == "$src" ]]; then
        run "rm -f \"$dst\""
    elif [[ -e $dst || -L $dst ]]; then
        warn "preserving unmanaged path: $dst"
    fi
}

uninstall_symlinks() {
    local -a dirs=()
    local desktop=0 network=0

    if component_is_selected shell_zsh; then unlink_managed "$DOTS/.zshrc" "$HOME/.zshrc"; fi
    if component_is_selected shell_zimfw; then unlink_managed "$DOTS/.zimrc" "$HOME/.zimrc"; fi
    if component_is_selected terminal_wezterm; then
        unlink_managed "$DOTS/.local/share/applications/wezterm.desktop" "$HOME/.local/share/applications/wezterm.desktop"
    fi
    if app_is_selected desktop; then
        unlink_managed "$DOTS/.gtkrc-2.0" "$HOME/.gtkrc-2.0"
        unlink_managed "$DOTS/mimeapps.list" "$HOME/.config/mimeapps.list"
        desktop=1
    fi
    component_is_selected core_git && dirs+=(git)
    component_is_selected nvim_editor && dirs+=(nvim)
    component_is_selected terminal_wezterm && dirs+=(wezterm)
    component_is_selected shell_zsh && dirs+=(zsh)
    component_is_selected tuicr_skill && dirs+=(tuicr)
    component_is_selected herdr_sesh && dirs+=(sesh)
    if app_is_selected network; then
        network=1
    fi
    if (( desktop || network )) || component_is_selected cast_catt; then dirs+=(scripts); fi
    if [[ $OS == macos ]] && (( desktop )); then dirs+=(AutoRaise aerospace karabiner); fi
    if [[ $OS != macos ]] && (( desktop )); then dirs+=(fuzzel hypr waybar dunst); fi

    local d
    for d in "${dirs[@]}"; do
        unlink_managed "$DOTS/.config/$d" "$HOME/.config/$d"
    done

    if app_is_selected herdr && (component_is_selected herdr_binary || component_is_selected herdr_sesh || component_is_selected herdr_pi_integration); then
        unlink_managed "$DOTS/.config/herdr/config.toml" "$HOME/.config/herdr/config.toml"
        unlink_managed "$DOTS/.config/herdr/sounds" "$HOME/.config/herdr/sounds"
        unlink_managed "$DOTS/.config/herdr/scripts" "$HOME/.config/herdr/scripts"
    fi
    if component_is_selected herdr_sesh; then
        unlink_managed "$DOTS/.config/sesh/sesh.toml" "$HOME/.config/herdr-sesh/sesh.toml"
    fi
    if component_is_selected pi_agent; then
        unlink_managed "$DOTS/.pi" "$HOME/.pi"
    fi
}

uninstall_herdr() {
    local bin
    bin="$(herdr_bin || true)"
    [[ -n $bin ]] || return 0
    if component_is_selected herdr_sesh; then
        run "$bin plugin uninstall fullerzz.sesh"
    fi
    if component_is_selected herdr_pi_integration; then
        run "$bin integration uninstall pi"
    fi
    if component_is_selected herdr_binary && [[ $bin == "$HOME/.local/bin/herdr" ]]; then
        run "rm -f \"$bin\""
    elif component_is_selected herdr_binary; then
        warn "Herdr is outside the managed user path ($bin); preserving it"
    fi
}

uninstall_worktrunk() {
    local wt_bin
    wt_bin="$(command -v wt || true)"
    if component_is_selected core_worktrunk_shell; then
        if [[ -n $wt_bin ]]; then
            run "$wt_bin config shell uninstall"
        else
            warn "Worktrunk (wt) is unavailable; skipping shell-integration removal"
        fi
    fi
    if component_is_selected core_worktrunk && [[ -n $wt_bin && $wt_bin == "$HOME/.cargo/bin/"* ]] && command -v cargo >/dev/null 2>&1; then
        run "cargo uninstall worktrunk"
    fi
}

uninstall_pi_extensions() {
    local -a pi_remove=()
    component_is_selected pi_ext_pi_ask && pi_remove+=("@eko24ive/pi-ask")
    component_is_selected pi_ext_hypa && pi_remove+=("@hypabolic/pi-hypa")
    component_is_selected pi_ext_rpiv_todo && pi_remove+=("@juicesharp/rpiv-todo")
    component_is_selected pi_ext_pi_subagent && pi_remove+=("@mystilleef/pi-subagent")
    component_is_selected pi_ext_pi_herdr && pi_remove+=("@weshipwork/pi-herdr")
    component_is_selected pi_ext_pi_model_router && pi_remove+=("@yeliu84/pi-model-router")
    component_is_selected pi_ext_observational_memory && pi_remove+=("pi-observational-memory")
    component_is_selected pi_ext_powerline_footer && pi_remove+=("pi-powerline-footer")
    component_is_selected pi_ext_quota_status && pi_remove+=("pi-quota-status")
    component_is_selected pi_ext_web_access && pi_remove+=("pi-web-access")
    if [[ ${#pi_remove[@]} -gt 0 && -x "$DOTS/.pi/install.sh" ]]; then
        run "PI_SKIP_NPM=1 PI_REMOVE_NPM_PACKAGES=\"${pi_remove[*]}\" \"$DOTS/.pi/install.sh\""
    fi
}

uninstall_external_tools() {
    uninstall_pi_extensions
    if component_is_selected tuicr_binary; then
        [[ -e "$HOME/.local/bin/tuicr" || -L "$HOME/.local/bin/tuicr" ]] && run "rm -f \"$HOME/.local/bin/tuicr\""
    fi
    if component_is_selected tuxedo_binary; then
        if command -v cargo >/dev/null 2>&1; then run "cargo uninstall tuxedo"; fi
        [[ -e "$HOME/.cargo/bin/tuxedo" ]] && run "rm -f \"$HOME/.cargo/bin/tuxedo\""
        [[ -e "$HOME/.local/bin/tuxedo" ]] && run "rm -f \"$HOME/.local/bin/tuxedo\""
    fi
    if component_is_selected cast_catt && command -v uv >/dev/null 2>&1; then
        run "uv tool uninstall catt"
    fi
    if component_is_selected nvim_prettier; then
        if command -v npm >/dev/null 2>&1; then
            local -a npm_remove=()
            component_is_selected nvim_prettier && npm_remove+=(prettier)
            [[ ${#npm_remove[@]} -gt 0 ]] && run "npm uninstall -g ${npm_remove[*]}"
        fi
    fi
}

uninstall_packages_arch() {
    local -a installed=() p
    for p in "${PKGS_ARCH_SELECTED[@]}"; do
        pacman -Q "$p" &>/dev/null && installed+=("$p")
    done
    if [[ ${#installed[@]} -gt 0 ]]; then
        run "sudo pacman -R --noconfirm ${installed[*]}"
    else
        ok "no selected Arch packages are installed"
    fi
}

uninstall_packages_apt() {
    local -a installed=() p
    for p in "${PKGS_APT_SELECTED[@]}"; do
        dpkg-query -W -f='${db:Status-Status}' "$p" 2>/dev/null | grep -qx installed && installed+=("$p")
    done
    if [[ ${#installed[@]} -gt 0 ]]; then
        run "sudo apt-get remove --yes ${installed[*]}"
    else
        ok "no selected APT packages are installed"
    fi
}

uninstall_packages_mac() {
    load_brew || true
    if ! command -v brew >/dev/null 2>&1; then
        warn "Homebrew is unavailable; skipping package removal"
        return
    fi
    local p c
    for p in "${PKGS_MAC_SELECTED[@]}"; do
        brew list --formula "$p" &>/dev/null && run "brew uninstall --quiet $p"
    done
    for c in "${CASKS_MAC_SELECTED[@]}"; do
        brew list --cask "$c" &>/dev/null && run "brew uninstall --quiet --cask $c"
    done
}

uninstall_selected() {
    step "uninstall: managed symlinks and integrations"
    # Remove Worktrunk's shell hook before unlinking the managed shell files.
    uninstall_worktrunk
    uninstall_symlinks
    uninstall_herdr
    uninstall_external_tools
    if [[ $NO_PKGS -eq 1 ]]; then
        warn "--no-pkgs: skipping package removal"
    else
        step "uninstall: packages"
        case $OS in
            arch) uninstall_packages_arch ;;
            apt) uninstall_packages_apt ;;
            macos) uninstall_packages_mac ;;
        esac
    fi
}

# =============================================================================
# 11. Post-install summary — what's left for the user to do manually
# =============================================================================
summary() {
    step "manual follow-up"
    cat <<'EOF'
Some things this script cannot do for you:

  • Fonts: after install run \`fc-cache -fv\` if new fonts don't show up in nvim/waybar
  • Hyprland: log out and back into a Hyprland session (SDDM/greetd/tuigreet)
  • GTK theme: Linux uses the available Adwaita dark theme; adjust it if your
    host provides a preferred GTK theme
  • Firefox: userChrome.css must be manually copied into your Firefox profile
    at ~/.mozilla/firefox/<profile>/chrome/userChrome.css and toolkit.legacyUserProfileCustomizations.stylesheets
    enabled in about:config
  • Wallpapers: \`~/.config/hypr/hyprpaper.conf\` references paths under
    ~/Documents/wallpaper/ — copy your wallpaper collection there or adjust
  • Wezterm: fully close and reopen to pick up any config changes
  • tuicr: the custom fork installs to ~/.local/bin/tuicr and is built from rajaiitp/tuicr
  • Herdr Sesh: the installer adds fullerzz/herdr-plugin-sesh when Herdr is available

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
    step "0. applications"
    select_applications
    build_selected_packages

    if [[ $UNINSTALL -eq 1 ]]; then
        local any_selected=0 app
        for app in "${APP_KEYS[@]}"; do
            if app_is_selected "$app"; then any_selected=1; break; fi
        done
        if [[ $any_selected -eq 0 ]]; then
            warn "no applications selected; nothing to uninstall"
            return 0
        fi
        uninstall_selected
        step "done"
        if [[ ${#FAILED_COMMANDS[@]} -gt 0 ]]; then
            warn "${#FAILED_COMMANDS[@]} command(s) failed; continuing completed selections"
            return 1
        fi
        ok "selected dotfiles components uninstalled"
        return 0
    fi

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
    elif component_is_selected dev_rust || component_is_selected dev_nodejs || component_is_selected dev_npm || component_is_selected dev_bun || component_is_selected dev_uv || component_is_selected tuxedo_binary || component_is_selected cast_catt; then
        install_toolchains
    else
        ok "no toolchain-dependent applications selected"
    fi

    step "4. Worktrunk shell integration"
    setup_worktrunk

    step "5. pi agent"
    setup_pi_agent

    step "6. Herdr and integrations"
    setup_herdr

    step "7. tuicr (custom fork)"
    setup_tuicr

    step "8. Zsh migration and default shell"
    if ! component_is_selected shell_zsh && ! component_is_selected shell_zimfw && ! component_is_selected shell_default; then
        warn "No shell components were selected; skipping shell setup"
    elif [[ $NO_PKGS -eq 1 ]]; then
        warn "--no-pkgs: skipping shell migration, Zimfw, and default-shell changes"
    else
        component_is_selected shell_zsh && migrate_fish_history
        component_is_selected shell_zimfw && install_zimfw
        component_is_selected shell_default && set_default_shell
    fi

    summary
    if [[ ${#FAILED_COMMANDS[@]} -gt 0 ]]; then
        warn "${#FAILED_COMMANDS[@]} command(s) failed; rerun the recorded commands after fixing their cause"
        return 1
    fi
    step "done"
    ok "dotfiles setup complete"
}

main "$@"
