#!/bin/sh
# Moves the NVIDIA keys from .env into the macOS Keychain (item "Jarvis"), where only this user's
# login can read them, and removes them from .env. Undo: put the NVIDIA_API_KEYS line back in .env.
set -e
cd "$(dirname "$0")/.."
value="$(grep -E '^NVIDIA_API_KEYS=' .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
[ -n "$value" ] || { echo "There is no NVIDIA_API_KEYS line in .env; nothing to move."; exit 1; }
security add-generic-password -U -s Jarvis -a nvidia-api-keys -w "$value"
# Read back before anything is removed.
[ "$(security find-generic-password -s Jarvis -a nvidia-api-keys -w)" = "$value" ] || { echo "The Keychain did not return the keys; .env is unchanged."; exit 1; }
sed -i '' '/^NVIDIA_API_KEYS=/d' .env
echo "Done: the keys are in the Keychain and no longer in .env."
