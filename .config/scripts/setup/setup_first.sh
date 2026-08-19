#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SSH_TARGET="${1:-}"

if [ -z "$SSH_TARGET" ]; then
    echo "Usage: $0 <ssh-config-alias>" >&2
    exit 1
fi

for cmd in ssh rsync git curl; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: $cmd is required to run this script." >&2
        exit 1
    fi
done

APT_PACKAGES=(
    zsh
    git
    curl
    tmux
    nodejs
    npm
    luarocks
    fzf
    zoxide
    eza
    ripgrep
    fd-find
    build-essential
    unzip
    wget
    gnupg
    lsb-release
    snapd
    r-base
)

readonly APT_PACKAGES_STR="${APT_PACKAGES[*]}"

echo "Bootstrapping $SSH_TARGET with required packages and dotfiles..."

ssh "$SSH_TARGET" "APT_PACKAGES='${APT_PACKAGES_STR}' bash -s" <<'EOF'
set -euo pipefail
ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"
AUTOSUGGESTIONS_REPO="https://github.com/zsh-users/zsh-autosuggestions.git"
SYNTAX_HIGHLIGHTING_REPO="https://github.com/zsh-users/zsh-syntax-highlighting.git"

echo "---"
echo "Updating apt database"
sudo apt update

echo "---"
echo "Installing apt packages"
sudo apt install -y $APT_PACKAGES

echo "---"
if [ ! -d "$HOME/.oh-my-zsh" ]; then
    echo "Installing Oh My Zsh"
    RUNZSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
else
    echo "Oh My Zsh already in place"
fi

echo "---"
echo "Adding zsh plugins"
if [ ! -d "${ZSH_CUSTOM}/plugins/zsh-autosuggestions" ]; then
    git clone "$AUTOSUGGESTIONS_REPO" "${ZSH_CUSTOM}/plugins/zsh-autosuggestions"
fi
if [ ! -d "${ZSH_CUSTOM}/plugins/zsh-syntax-highlighting" ]; then
    git clone "$SYNTAX_HIGHLIGHTING_REPO" "${ZSH_CUSTOM}/plugins/zsh-syntax-highlighting"
fi

echo "---"
if [ ! -d "$HOME/.fzf" ]; then
    echo "Installing fzf from source"
    git clone --depth 1 https://github.com/junegunn/fzf.git ~/.fzf
    ~/.fzf/install || true
else
    echo "fzf already present under ~/.fzf"
fi

echo "---"
if command -v opencode >/dev/null 2>&1; then
    echo "OpenCode CLI already installed on remote host."
else
    echo "Installing OpenCode CLI on remote host"
    curl -fsSL https://opencode.ai/install | bash || true
fi

echo "---"
if command -v snap >/dev/null 2>&1; then
    if snap list nvim >/dev/null 2>&1; then
        echo "Neovim already installed via snap"
    else
        echo "Installing Neovim via snap"
        sudo snap install nvim --classic
    fi
else
    echo "snap not available; please install Neovim manually"
fi

echo "---"
if command -v npm >/dev/null 2>&1; then
    echo "Installing npm globals (prettier, eslint_d)"
    sudo npm install -g prettier eslint_d
else
    echo "npm not found; skipping npm global tools"
fi

echo "---"
if command -v Rscript >/dev/null 2>&1; then
    R_LIBS_USER="${R_LIBS_USER:-$HOME/R/library}"
    echo "Installing R styling tool (styler) into $R_LIBS_USER"
    Rscript -e "dir.create('$R_LIBS_USER', recursive=TRUE, showWarnings=FALSE)"
    if Rscript -e "requireNamespace('styler', quietly=TRUE, lib.loc='$R_LIBS_USER')" >/dev/null 2>&1; then
        echo "styler already installed in $R_LIBS_USER"
    else
        Rscript -e "install.packages('styler', repos='https://cloud.r-project.org', lib='$R_LIBS_USER', quiet=TRUE)"
    fi
else
    echo "Rscript missing; skipping styler install"
fi

echo "---"
echo "Setting default shell to Zsh"
if chsh -s "$(command -v zsh)" "$(whoami)"; then
    echo "Default shell set to Zsh for the user session."
else
    echo "Failed to change shell inside session; it may already be Zsh or may require re-login."
fi

echo "---"
echo "Remote bootstrap finished"
EOF

echo "---"
echo "Copying config directories to $SSH_TARGET"
CONFIG_ROOT="$DOTFILES_ROOT/.config"
ssh "$SSH_TARGET" "mkdir -p ~/.config/nvim ~/.config/tmux"
rsync -a --delete "$CONFIG_ROOT/nvim/" "$SSH_TARGET:~/.config/nvim/"
rsync -a --delete "$CONFIG_ROOT/tmux/" "$SSH_TARGET:~/.config/tmux/"
rsync -a "$CONFIG_ROOT/../.zshrc" "$SSH_TARGET:~/.zshrc"

echo "---"
echo "Making tmux helper scripts executable and installing plugins"
ssh "$SSH_TARGET" <<'EOF'
set -euo pipefail
chmod +x ~/.config/tmux/scripts/*.sh || true
if [ ! -d ~/.local/share/tmux/plugins/tpm ]; then
    git clone https://github.com/tmux-plugins/tpm ~/.local/share/tmux/plugins/tpm
fi
~/.local/share/tmux/plugins/tpm/bin/install_plugins || true
EOF

echo "---"
echo "Attempting to set default shell to zsh on $SSH_TARGET"
if ssh -t "$SSH_TARGET" 'chsh -s "$(command -v zsh)"'; then
    echo "Default shell now zsh. Log out or reopen the session to activate it."
else
    echo "Could not change default shell non-interactively. Run:"
    echo "  ssh $SSH_TARGET 'chsh -s \"\$(command -v zsh)\"'"
fi

echo "---"
echo "Setup complete. Start a new shell or log in to $SSH_TARGET to pick up the new dotfiles."
