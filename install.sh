#!/usr/bin/env bash
# Link the curated Omarchy configuration in this repository.
set -euo pipefail

DOTS=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
stamp=$(date +%Y%m%d-%H%M%S)

link() {
  local source=$1 destination=$2

  [[ -e $source ]] || { printf 'Missing source: %s\n' "$source" >&2; return 1; }
  if [[ -L $destination && $(readlink -f -- "$destination") == $(readlink -f -- "$source") ]]; then
    printf 'Linked: %s\n' "$destination"
    return
  fi

  if [[ -e $destination || -L $destination ]]; then
    mv -- "$destination" "${destination}.bak.${stamp}"
    printf 'Backed up: %s\n' "$destination"
  fi

  mkdir -p -- "$(dirname -- "$destination")"
  ln -s -- "$source" "$destination"
  printf 'Linked: %s -> %s\n' "$destination" "$source"
}

for file in .gitconfig .zimrc .zshrc; do
  link "$DOTS/$file" "$HOME/$file"
done

for directory in aerospace git herdr hypr karabiner nvim omarchy sesh tuxedo wezterm zsh; do
  link "$DOTS/.config/$directory" "$HOME/.config/$directory"
done
