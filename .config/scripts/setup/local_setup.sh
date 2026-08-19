#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Installing required packages..."
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
sudo apt update
sudo apt install -y "${APT_PACKAGES[@]}"

ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"
AUTOSUGGESTIONS_REPO="https://github.com/zsh-users/zsh-autosuggestions.git"
SYNTAX_HIGHLIGHTING_REPO="https://github.com/zsh-users/zsh-syntax-highlighting.git"

if [ ! -d "$HOME/.oh-my-zsh" ]; then
    echo "Installing Oh My Zsh"
    RUNZSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
else
    echo "Oh My Zsh already installed"
fi

echo "Adding zsh plugins"
mkdir -p "$ZSH_CUSTOM/plugins"
if [ ! -d "$ZSH_CUSTOM/plugins/zsh-autosuggestions" ]; then
    git clone "$AUTOSUGGESTIONS_REPO" "$ZSH_CUSTOM/plugins/zsh-autosuggestions"
fi
if [ ! -d "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting" ]; then
    git clone "$SYNTAX_HIGHLIGHTING_REPO" "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting"
fi

if [ ! -d "$HOME/.fzf" ]; then
    echo "Installing fzf"
    git clone --depth 1 https://github.com/junegunn/fzf.git ~/.fzf
    ~/.fzf/install || true
else
    echo "fzf already present"
fi

if command -v opencode >/dev/null 2>&1; then
    echo "OpenCode CLI already installed"
else
    echo "Installing OpenCode CLI"
    curl -fsSL https://opencode.ai/install | bash || true
fi

if command -v snap >/dev/null 2>&1; then
    if snap list nvim >/dev/null 2>&1; then
        echo "Neovim already installed via snap"
    else
        echo "Installing Neovim via snap"
        sudo snap install nvim --classic
    fi
else
    echo "snap not available; install Neovim manually"
fi

if command -v npm >/dev/null 2>&1; then
    echo "Installing npm global tools"
    sudo npm install -g prettier eslint_d
else
    echo "npm not found; skipping global tools"
fi

if command -v Rscript >/dev/null 2>&1; then
    R_LIBS_USER="${R_LIBS_USER:-$HOME/R/library}"
    echo "Installing R styler into $R_LIBS_USER"
    Rscript -e "dir.create('$R_LIBS_USER', recursive=TRUE, showWarnings=FALSE)"
    if Rscript -e "requireNamespace('styler', quietly=TRUE, lib.loc='$R_LIBS_USER')" >/dev/null 2>&1; then
        echo "styler already installed"
    else
        Rscript -e "install.packages('styler', repos='https://cloud.r-project.org', lib='$R_LIBS_USER', quiet=TRUE)"
    fi
else
    echo "Rscript missing; skipping styler install"
fi

echo "Local setup complete. To apply the dotfiles you still need to run scripts/apply_configs.sh from this repo."
