#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <multipass-instance-name>" >&2
    exit 1
fi

INSTANCE="$1"
SSH_KEY="$HOME/.ssh/id_rsa.pub"
SSH_CONFIG="$HOME/.ssh/config"
SSH_KNOWN_HOSTS="$HOME/.ssh/known_hosts"

for cmd in multipass ssh-keyscan; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: $cmd is required." >&2
        exit 1
    fi
done

if [ ! -f "$SSH_KEY" ]; then
    echo "Error: $SSH_KEY is missing. Generate it with ssh-keygen." >&2
    exit 1
fi

if ! multipass info "$INSTANCE" >/dev/null 2>&1; then
    echo "Instance $INSTANCE does not exist. Create it first." >&2
    exit 1
fi

echo "Ensuring $INSTANCE is running..."
multipass start "$INSTANCE" >/dev/null 2>&1 || true

echo "Copying your SSH key to $INSTANCE..."

IP=$(multipass info "$INSTANCE" | awk '/IPv4:/ {print $2; exit}')
if [ -z "$IP" ]; then
    echo "Unable to determine IPv4 address for $INSTANCE." >&2
    exit 1
fi

echo "Updating ~/.ssh/config for $INSTANCE..."
mkdir -p "$(dirname "$SSH_CONFIG")"
if ! grep -q "^Host $INSTANCE" "$SSH_CONFIG" 2>/dev/null; then
    cat >> "$SSH_CONFIG" <<EOF
Host $INSTANCE
    HostName $INSTANCE
    User ubuntu
    IdentityFile ~/.ssh/id_rsa
    PreferredAuthentications publickey
    StrictHostKeyChecking accept-new
    UserKnownHostsFile $SSH_KNOWN_HOSTS
EOF
fi

echo "Refreshing known_hosts entry for $INSTANCE..."
ssh-keyscan -H "$INSTANCE" >> "$SSH_KNOWN_HOSTS" >/dev/null 2>&1 || true

echo "SSH setup for $INSTANCE is complete. You can now run:"
echo "  ssh $INSTANCE"
