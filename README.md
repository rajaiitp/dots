# dots

Personal configuration for **Arch Linux + Hyprland**. The installer also supports
Debian/Ubuntu-style APT systems and macOS for cross-platform configuration.

## Quick start on a fresh machine

```bash
git clone git@github.com:rajaiitp/dots.git ~/dotfiles
cd ~/dotfiles
./install.sh
```

The install script is **idempotent** — safe to re-run any time to reconcile drift.

### Flags

```bash
./install.sh --dry-run     # print what would happen, do nothing
./install.sh --no-pkgs     # skip package install, only symlink configs
./install.sh --yes         # use the common application/component defaults
./install.sh --tui         # terminal-only defaults; no GUI or terminal emulator
./install.sh --uninstall   # select applications/components to remove
./install.sh --help
```

### SSH / terminal-only host

For a Debian/Ubuntu SSH host, use the same installer with its focused terminal
profile:

```bash
./install.sh --tui
```

It selects terminal tools, Pi, Herdr extensions, tuicr, Tuxedo, and Zsh/Zimfw;
it excludes Wayland, desktop, GUI, and terminal-emulator packages. `--tui`
uses its profile defaults without opening the application picker.

### What it does

1. Shows non-selectable application headers (Shell, CLI tools, Desktop, and so on)
2. Shows exact package/tool entries under each header; CLI tools include
   git, fzf, ripgrep, fd, bat, jq, eza, zoxide, lazygit, expect,
   OpenSSH, curl, CA certificates, libnotify, and Worktrunk (`wt`) for Git
   worktrees plus its optional shell integration
3. Installs only the selected packages/tools through `pacman`, APT, or `brew`
4. Symlinks only the selected applications' configurations
5. Installs selected toolchains, Pi, Herdr/Sesh, and custom tuicr integration
6. Imports Fish history and configures Zimfw when those shell components are selected
7. Backs up existing config conflicts automatically with timestamped `.bak` files
8. Records failures and continues through all independent setup stages

There are no repeated yes/no prompts. Press Enter in each checklist to accept
its defaults, toggle entries with numbers, or use `a`/`n` to select all/none.
Use `--uninstall` with the same checklists to remove selected managed items;
unmanaged files and directories are preserved.

## Layout

```
~/dotfiles/
├── install.sh              ← desktop-capable bootstrap
├── .gitignore              ← runtime state / secrets excluded
├── .gtkrc-2.0              ← linked → ~/.gtkrc-2.0
├── mimeapps.list           ← linked → ~/.config/mimeapps.list
├── userChrome.css          ← Firefox chrome (copy manually)
├── pyrightconfig.json      ← Python project marker
├── .zshrc / .zimrc         ← Zsh configuration and Zimfw modules
│
├── .config/                ← whole-dir symlinks into ~/.config/
│   ├── AutoRaise/          ← macOS focus-follows-mouse helper
│   ├── aerospace/
│   ├── dunst/              ← Gruvbox Dark notifications
│   ├── git/
│   ├── hypr/               ← Hyprland + hyprlock + hyprpaper + hypridle
│   ├── karabiner/          ← macOS keybinding remap
│   ├── nvim/               ← lazy.nvim managed
│   ├── scripts/
│   ├── tuicr/              ← custom review-TUI configuration
│   ├── waybar/             ← Gruvbox Dark palette
│   ├── wezterm/            ← kitty keyboard protocol on
│   ├── herdr/config.toml   ← single-file symlink (logs/state stay outside git)
│   └── sesh/sesh.toml      ← Herdr Sesh workspace/session configuration
│
├── .pi/                    ← pi coding agent
│   ├── install.sh          ← delegated by top-level install.sh
│   └── agent/
│       ├── settings.json
│       ├── mcp.json
│       ├── models.json
│       ├── AGENTS.md
│       ├── extensions/
│       └── skills/
│
└── patches/                ← source-build helpers for third-party tools
    └── tuicr/              ← custom rajaiitp/tuicr build
        └── rebuild.sh      ← install rajaiitp/tuicr into ~/.local/bin
```

## Themes & aesthetics

Everything is **Gruvbox Dark** with **sharp corners** across the stack:

| Surface | Where |
|---|---|
| Hyprland window borders | active `orange #fe8019` / inactive `gray #504945`, `rounding=0` |
| Hyprlock | iris outline, surface fill, rose time label, `rounding=0` |
| Waybar | Gruvbox Dark palette; semantic battery state ladder; no border-radius |
| Dunst | Gruvbox Dark backgrounds, orange (normal) / red (critical) frames, `corner_radius=0` |
| Nvim | see `.config/nvim/lua/plugins/theme.lua` |
| Wezterm | see `.config/wezterm/wezterm.lua` |

Wallpaper is set via `~/.config/hypr/hyprpaper.conf` and applied by
`~/.config/hypr/scripts/set-wallpaper.sh` (workaround for hyprpaper 0.8.4 not
auto-loading the config file).

## Multiplexer

**herdr** replaces tmux for this setup. tmux was fully purged in commit `f4d49fd1`.
Herdr's `config.toml` is symlinked; its logs, session state, and sockets stay
in `~/.config/herdr/` outside git.

The setup script installs Herdr and keeps it as the authoritative
workspace/worktree manager. WezTerm is retained only as a plain outer terminal
host with its native tab UI and tab keymap disabled. The Sesh-style Herdr
plugin provides a picker and configured startup tabs without introducing a
second multiplexer. `./install.sh` installs Herdr and reconciles its Sesh/Pi
integrations automatically.

`~/.config/sesh/sesh.toml` is linked from this repository. New worktree
workspaces under `~/Dev` start Pi in the root pane and `tuicr track` in a
separate `tuicr` tab. Press `prefix+shift+t` to open the picker or
`prefix+shift+b` to return to the previous workspace.

Key mapping cheat sheet (default prefix `ctrl+b`):
- `ctrl+h/j/k/l` → focus the neighboring pane
- `ctrl+tab` / `ctrl+shift+tab` → cycle between Pi/agent panes
- `ctrl+1..9` → jump to tab N
- `ctrl+shift+p` → open the workspace picker
- `prefix+shift+g` → create a new worktree
- `prefix+shift+t` → open the Sesh workspace picker

## tuicr review workflow

This setup builds the custom fork at
[`rajaiitp/tuicr`](https://github.com/rajaiitp/tuicr), which adds persistent
worktree tracking. Start or resume a tracked review with:

```bash
tuicr track
# start a fresh baseline when needed:
tuicr track --new
```

The Pi skill and its tmux, Zellij, cmux, and Herdr pane wrappers are synced from
the fork under `.pi/agent/skills/tuicr/`.

## Pi agent controls

- `shift+tab` → cycle Pi's native thinking level
- `ctrl+u` / `ctrl+d` → scroll the fixed chat viewport up/down
- `/term` or `ctrl+backtick` → open the persistent 30%-height terminal overlay
- `ctrl+q` → close the terminal while preserving its shell state

`.pi/install.sh` installs the declared Pi extension dependencies.

## What this repo intentionally does NOT track

- Runtime state: `.pi/agent/sessions/`, `~/.config/herdr/{session.json,*.log,*.sock,release-notes.json}`
- Secrets: `.pi/agent/auth.json`
- Lockfiles that regenerate: `nvim/lazy-lock.json`, `opencode/package-lock.json`
- Bytecode caches (`~/.cache/*`)

See `.gitignore` for the full list.
