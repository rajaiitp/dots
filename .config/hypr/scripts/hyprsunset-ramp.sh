#!/usr/bin/env bash
# Manage the Hyprsunset temperature ramp without systemd.
set -u

runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$UID}"
pid_file="$runtime_dir/hyprsunset-ramp.pid"
log_file="$runtime_dir/hyprsunset-ramp.log"
lock_file="$runtime_dir/hyprsunset-ramp.lock"
ramp_script="${HYPRSUNSET_RAMP_SCRIPT:-$HOME/.config/hypr/scripts/hyprsunset-ramp.py}"

mkdir -p "$runtime_dir"

read_pid() {
    [[ -r $pid_file ]] || return 1
    local pid
    pid=$(<"$pid_file")
    [[ $pid =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$pid"
}

running_pid() {
    local pid args
    pid=$(read_pid) || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    args=$(ps -p "$pid" -o args= 2>/dev/null || true)
    [[ $args == *"$ramp_script"* ]] || return 1
    printf '%s\n' "$pid"
}

status() {
    running_pid >/dev/null
}

start() {
    exec 9>"$lock_file"
    flock -x 9

    if running_pid >/dev/null; then
        return 0
    fi
    rm -f "$pid_file"

    # Hyprland starts the native daemon immediately before this helper. Give it
    # a short moment to expose its IPC endpoint before the first temperature set.
    for _ in {1..50}; do
        pgrep -x hyprsunset >/dev/null 2>&1 && break
        sleep 0.1
    done

    nohup python3 "$ramp_script" >>"$log_file" 2>&1 </dev/null &
    local pid=$!
    printf '%s\n' "$pid" >"$pid_file"
    sleep 0.1
    if ! running_pid >/dev/null; then
        rm -f "$pid_file"
        return 1
    fi
}

stop() {
    exec 9>"$lock_file"
    flock -x 9

    local pid
    pid=$(running_pid 2>/dev/null || true)
    if [[ -z $pid ]]; then
        rm -f "$pid_file"
        return 0
    fi

    kill "$pid" 2>/dev/null || true
    for _ in {1..50}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
    done
    kill -KILL "$pid" 2>/dev/null || true
    rm -f "$pid_file"
}

case "${1:-status}" in
    start)   start ;;
    stop)    stop ;;
    restart) stop; start ;;
    status)  status ;;
    *)       printf 'usage: %s {start|stop|restart|status}\n' "$0" >&2; exit 2 ;;
esac
