export TODO_DIR="$HOME/notes"
export TODO_FILE="$TODO_DIR/todo.txt"

[[ -r "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"

[[ -r "${XIAOMI_PROJECTS_ROOT:-$HOME/xiaomi-pad-projects}/host/tablet.zsh" ]] &&
  source "${XIAOMI_PROJECTS_ROOT:-$HOME/xiaomi-pad-projects}/host/tablet.zsh"
