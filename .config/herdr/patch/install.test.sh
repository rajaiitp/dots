#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
INSTALLER="${SCRIPT_DIR}/install.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/herdr-install-test.XXXXXXXX")
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
    printf 'test failure: %s\n' "$*" >&2
    exit 1
}

assert_file_hash() {
    local expected=$1
    local path=$2
    local actual
    actual=$(sha256sum -- "$path" | awk '{print $1}')
    [[ "$actual" == "$expected" ]] || fail "$path hash $actual != $expected"
}

assert_log_contains() {
    local needle=$1
    local log=$2
    grep -F -- "$needle" "$log" >/dev/null || fail "log does not contain: $needle"
}

assert_log_order() {
    local log=$1
    shift
    local previous=0 line
    for needle in "$@"; do
        line=$(grep -n -F -- "$needle" "$log" | head -n 1 | cut -d: -f1)
        [[ -n "$line" ]] || fail "log does not contain ordered step: $needle"
        (( line > previous )) || fail "log step out of order: $needle"
        previous=$line
    done
}

write_fake_binary() {
    local path=$1
    local version=$2
    cat > "$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
version=$(printf '%q' "$version")
state=\${FAKE_STATE:?}
log=\${state}/commands.log
printf 'binary %s %s\\n' "\$version" "\$*" >> "\$log"

if [[ \${1:-} == "--version" ]]; then
    printf 'herdr %s\\n' "\$version"
    exit 0
fi
if [[ \${1:-} == "config" && \${2:-} == "check" ]]; then
    exit 0
fi
if [[ \${1:-} == "api" && \${2:-} == "snapshot" ]]; then
    printf '{"workspaces":[]}\\n'
    exit 0
fi
if [[ \${1:-} == "status" && \${2:-} == "server" ]]; then
    if [[ (\${FAKE_STATUS_TIMEOUT:-0} == 1 && -e \${state}/forward-complete) || ! -e \${state}/server-running ]]; then
        printf 'status: stopped\\n' >&2
        exit 1
    fi
    printf 'status: running\\nprotocol: 20\\n'
    exit 0
fi
if [[ \${1:-} == "server" && \${2:-} == "live-handoff" ]]; then
    import_exe=''
    while (( \$# )); do
        case \$1 in
            --import-exe) import_exe=\$2; shift 2 ;;
            *) shift ;;
        esac
    done
    printf 'handoff %s\\n' "\$import_exe" >> "\$log"
    if [[ \$import_exe == \${FAKE_DEST:-} && \${FAKE_FORWARD_FAIL:-0} == 1 && ! -e \${state}/forward-failed ]]; then
        touch "\${state}/forward-failed"
        ln -sfn -- "\$import_exe" "\${FAKE_PROC_ROOT}/4242/exe"
        exit 1
    fi
    if [[ \$import_exe == *"/backups/"* && \${FAKE_REVERSE_FAIL:-0} == 1 ]]; then
        exit 1
    fi
    if [[ \$import_exe == *"/backups/"* && \${FAKE_STATUS_TIMEOUT:-0} == 1 ]]; then
        exit 0
    fi
    if [[ \$import_exe == \${FAKE_DEST:-} && \${FAKE_WRONG_PROCESS:-0} == 1 ]]; then
        ln -sfn -- "\${state}/unrelated" "\${FAKE_PROC_ROOT}/4242/exe"
    else
        ln -sfn -- "\$import_exe" "\${FAKE_PROC_ROOT}/4242/exe"
    fi
    if [[ \$import_exe == \${FAKE_DEST:-} ]]; then
        touch "\${state}/forward-complete"
    fi
    exit 0
fi
exit 0
EOF
    chmod 755 "$path"
}

write_fake_tools() {
    local bin_dir=$1
    mkdir -p "$bin_dir"

    cat > "$bin_dir/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >> "${FAKE_STATE}/commands.log"
if [[ ${1:-} == clone ]]; then
    destination=${@: -1}
    mkdir -p "$destination"
    printf '%s\n' "$destination" > "${FAKE_STATE}/source_path"
    exit 0
fi
if [[ ${1:-} == -C ]]; then
    source=$2
    shift 2
    case ${1:-} in
        fetch|checkout)
            exit 0
            ;;
        rev-parse)
            printf '0123456789abcdef0123456789abcdef01234567\n'
            exit 0
            ;;
        apply)
            if [[ ${2:-} == --check ]]; then
                printf 'git apply check %s\n' "${3:-}" >> "${FAKE_STATE}/commands.log"
            else
                touch "$source/.patched"
                printf 'git apply apply %s\n' "${2:-}" >> "${FAKE_STATE}/commands.log"
            fi
            exit 0
            ;;
    esac
fi
exit 0
EOF

    cat > "$bin_dir/rustup" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'rustup %s\n' "$*" >> "${FAKE_STATE}/commands.log"
if [[ "$*" == *"cargo --version"* ]]; then
    printf 'cargo 1.96.1\n'
    exit 0
fi
if [[ "$*" == *"cargo test"* ]]; then
    source=$(cat "${FAKE_STATE}/source_path")
    if [[ -e "$source/.patched" && ${FAKE_FAIL_POSTPATCH:-0} == 1 ]]; then
        exit 17
    fi
    exit 0
fi
if [[ "$*" == *"cargo build"* ]]; then
    source=$(cat "${FAKE_STATE}/source_path")
    mkdir -p "$source/target/release"
    cat > "$source/target/release/herdr" <<'HERDR_BINARY'
#!/usr/bin/env bash
set -euo pipefail
version=9.9.9
state=${FAKE_STATE:?}
log=${state}/commands.log
printf 'binary %s %s\n' "$version" "$*" >> "$log"
if [[ ${1:-} == "--version" ]]; then
    printf 'herdr %s\n' "$version"
    exit 0
fi
if [[ ${1:-} == "config" && ${2:-} == "check" ]]; then
    exit 0
fi
if [[ ${1:-} == "api" && ${2:-} == "snapshot" ]]; then
    printf '{"workspaces":[]}\n'
    exit 0
fi
if [[ ${1:-} == "status" && ${2:-} == "server" ]]; then
    if [[ (${FAKE_STATUS_TIMEOUT:-0} == 1 && -e ${state}/forward-complete) || ! -e ${state}/server-running ]]; then
        printf 'status: stopped\n' >&2
        exit 1
    fi
    printf 'status: running\nprotocol: 20\n'
    exit 0
fi
if [[ ${1:-} == "server" && ${2:-} == "live-handoff" ]]; then
    import_exe=''
    while (( $# )); do
        case $1 in
            --import-exe) import_exe=$2; shift 2 ;;
            *) shift ;;
        esac
    done
    printf 'handoff %s\n' "$import_exe" >> "$log"
    if [[ $import_exe == ${FAKE_DEST:-} && ${FAKE_FORWARD_FAIL:-0} == 1 && ! -e ${state}/forward-failed ]]; then
        touch "${state}/forward-failed"
        ln -sfn -- "$import_exe" "${FAKE_PROC_ROOT}/4242/exe"
        exit 1
    fi
    if [[ $import_exe == *"/backups/"* && ${FAKE_REVERSE_FAIL:-0} == 1 ]]; then
        exit 1
    fi
    if [[ $import_exe == *"/backups/"* && ${FAKE_STATUS_TIMEOUT:-0} == 1 ]]; then
        exit 0
    fi
    if [[ $import_exe == ${FAKE_DEST:-} && ${FAKE_WRONG_PROCESS:-0} == 1 ]]; then
        ln -sfn -- "${state}/unrelated" "${FAKE_PROC_ROOT}/4242/exe"
    else
        ln -sfn -- "$import_exe" "${FAKE_PROC_ROOT}/4242/exe"
    fi
    if [[ $import_exe == ${FAKE_DEST:-} ]]; then
        touch "${state}/forward-complete"
    fi
    exit 0
fi
exit 0
HERDR_BINARY
    chmod 755 "$source/target/release/herdr"
    exit 0
fi
exit 0
EOF
    chmod 755 "$bin_dir/git" "$bin_dir/rustup"

    cat > "$bin_dir/zig" <<'EOF'
#!/usr/bin/env bash
printf '0.15.2\n'
EOF
    chmod 755 "$bin_dir/zig"
}

new_case() {
    local name=$1
    CASE_ROOT="${TEST_ROOT}/${name}"
    mkdir -p "$CASE_ROOT/home" "$CASE_ROOT/config" "$CASE_ROOT/state" "$CASE_ROOT/runtime" "$CASE_ROOT/backups" "$CASE_ROOT/bin" "$CASE_ROOT/proc/4242"
    : > "$CASE_ROOT/commands.log"
    printf 'fixture-config\n' > "$CASE_ROOT/config/config.toml"
    write_fake_tools "$CASE_ROOT/bin"
    printf 'not-herdr\n' > "$CASE_ROOT/unrelated"
    write_fake_binary "$CASE_ROOT/old-herdr" "8.8.8"
    export CASE_ROOT
}

run_installer() {
    local log=$1
    shift
    set +e
    env \
        PATH="${CASE_ROOT}/bin:${PATH}" \
        HOME="${CASE_ROOT}/home" \
        XDG_CONFIG_HOME="${CASE_ROOT}/config" \
        XDG_STATE_HOME="${CASE_ROOT}/state" \
        XDG_RUNTIME_DIR="${CASE_ROOT}/runtime" \
        HERDR_REPO_URL="fixture://herdr" \
        HERDR_REF="fixture-ref" \
        HERDR_RUST_TOOLCHAIN="fake" \
        HERDR_BIN="${CASE_ROOT}/herdr" \
        HERDR_CONFIG_PATH="${CASE_ROOT}/config/config.toml" \
        HERDR_BACKUP_DIR="${CASE_ROOT}/backups" \
        HERDR_PROC_ROOT="${CASE_ROOT}/proc" \
        HERDR_RUN_TRANSACTION_TESTS=0 \
        FAKE_STATE="${CASE_ROOT}" \
        FAKE_PROC_ROOT="${CASE_ROOT}/proc" \
        FAKE_DEST="${CASE_ROOT}/herdr" \
        ZIG="${CASE_ROOT}/bin/zig" \
        "$@" "$INSTALLER" >"$log" 2>&1
    status=$?
    set -e
    return "$status"
}

# Missing/invalid post-patch tests must stop before installation.
new_case postpatch-failure
install -m 755 "$CASE_ROOT/old-herdr" "$CASE_ROOT/herdr"
old_hash=$(sha256sum -- "$CASE_ROOT/herdr" | awk '{print $1}')
if run_installer "$CASE_ROOT/output.log" FAKE_FAIL_POSTPATCH=1; then
    fail "post-patch failure case unexpectedly succeeded"
fi
assert_file_hash "$old_hash" "$CASE_ROOT/herdr"
[[ ! -e "$CASE_ROOT/herdr.new."* ]] 2>/dev/null || fail "temporary install file remained"

# A clean install records the immutable checked-out commit and performs no handoff.
new_case clean-install
if ! run_installer "$CASE_ROOT/output.log"; then
    fail "clean install failed"
fi
assert_log_order "$CASE_ROOT/commands.log" \
    'git clone' 'git apply check' 'git apply apply'
post_fmt=$(grep -n -F 'rustup run fake cargo fmt' "$CASE_ROOT/commands.log" | tail -n 1 | cut -d: -f1)
post_test=$(grep -n -F 'rustup run fake cargo test' "$CASE_ROOT/commands.log" | tail -n 1 | cut -d: -f1)
post_build=$(grep -n -F 'rustup run fake cargo build' "$CASE_ROOT/commands.log" | tail -n 1 | cut -d: -f1)
(( post_fmt < post_test && post_test < post_build )) || fail "post-patch formatting, tests, and build are out of order"
metadata=$(find "$CASE_ROOT/backups" -name install-metadata -type f -print -quit)
[[ -f "$metadata" ]] || fail "install metadata missing"
grep -Fx 'source_ref=fixture-ref' "$metadata" >/dev/null
grep -Fx 'source_commit=0123456789abcdef0123456789abcdef01234567' "$metadata" >/dev/null
assert_log_contains 'binary 9.9.9 --version' "$CASE_ROOT/commands.log"
! grep -F 'handoff ' "$CASE_ROOT/commands.log" >/dev/null || fail "clean install attempted handoff"

# Existing server: successful forward handoff must leave the running process on the target.
new_case successful-handoff
install -m 755 "$CASE_ROOT/old-herdr" "$CASE_ROOT/herdr"
touch "$CASE_ROOT/server-running"
printf 'herdr\0server\0' > "$CASE_ROOT/proc/4242/cmdline"
ln -s "$CASE_ROOT/herdr" "$CASE_ROOT/proc/4242/exe"
if ! run_installer "$CASE_ROOT/output.log"; then
    fail "successful handoff case failed"
fi
target_hash=$(sha256sum -- "$CASE_ROOT/herdr" | awk '{print $1}')
assert_file_hash "$target_hash" "$CASE_ROOT/proc/4242/exe"
assert_log_contains "handoff ${CASE_ROOT}/herdr" "$CASE_ROOT/commands.log"

# Ambiguous forward failure must reverse-handoff before restoring the old file.
new_case forward-failure
install -m 755 "$CASE_ROOT/old-herdr" "$CASE_ROOT/herdr"
touch "$CASE_ROOT/server-running"
printf 'herdr\0server\0' > "$CASE_ROOT/proc/4242/cmdline"
ln -s "$CASE_ROOT/herdr" "$CASE_ROOT/proc/4242/exe"
if run_installer "$CASE_ROOT/output.log" FAKE_FORWARD_FAIL=1; then
    fail "forward failure case unexpectedly succeeded"
fi
assert_file_hash "$(sha256sum -- "$CASE_ROOT/old-herdr" | awk '{print $1}')" "$CASE_ROOT/herdr"
assert_log_contains 'handoff ' "$CASE_ROOT/commands.log"
[[ $(grep -c 'handoff ' "$CASE_ROOT/commands.log") -ge 2 ]] || fail "reverse handoff was not attempted"

# A status timeout must not be treated as proof that the known-running server exited.
new_case status-timeout
install -m 755 "$CASE_ROOT/old-herdr" "$CASE_ROOT/herdr"
touch "$CASE_ROOT/server-running"
printf 'herdr\0server\0' > "$CASE_ROOT/proc/4242/cmdline"
ln -s "$CASE_ROOT/herdr" "$CASE_ROOT/proc/4242/exe"
if run_installer "$CASE_ROOT/output.log" FAKE_STATUS_TIMEOUT=1; then
    fail "status timeout case unexpectedly succeeded"
fi
target_hash=$(sha256sum -- "$CASE_ROOT/herdr" | awk '{print $1}')
assert_file_hash "$target_hash" "$CASE_ROOT/proc/4242/exe"
assert_log_contains 'handoff ' "$CASE_ROOT/commands.log"
[[ $(grep -c 'handoff ' "$CASE_ROOT/commands.log") -ge 2 ]] || fail "status timeout did not reverse-handoff"

# An unidentifiable process plus reverse failure must preserve the staged file.
new_case reverse-failure
install -m 755 "$CASE_ROOT/old-herdr" "$CASE_ROOT/herdr"
touch "$CASE_ROOT/server-running"
printf 'herdr\0server\0' > "$CASE_ROOT/proc/4242/cmdline"
ln -s "$CASE_ROOT/herdr" "$CASE_ROOT/proc/4242/exe"
if run_installer "$CASE_ROOT/output.log" FAKE_WRONG_PROCESS=1 FAKE_REVERSE_FAIL=1; then
    fail "reverse failure case unexpectedly succeeded"
fi
target_hash=$(sha256sum -- "$CASE_ROOT/old-herdr" | awk '{print $1}')
[[ "$(sha256sum -- "$CASE_ROOT/herdr" | awk '{print $1}')" != "$target_hash" ]] || fail "staged file was overwritten after unproven rollback"
assert_log_contains 'handoff ' "$CASE_ROOT/commands.log"

printf '%s\n' 'installer transaction tests: ok'
