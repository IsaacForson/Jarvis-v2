#!/bin/sh
# Moves the NVIDIA and Groq keys from .env into the macOS Keychain (item "Jarvis"), where only this
# user's login can read them, and removes them from .env. Undo: put the lines back in .env.
set -e
cd "$(dirname "$0")/.."
moved=0
for provider in nvidia groq; do
  name="$(echo "$provider" | tr a-z A-Z)_API_KEYS"
  value="$(grep -E "^$name=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
  [ -n "$value" ] || continue
  security add-generic-password -U -s Jarvis -a "$provider-api-keys" -w "$value"
  # Read back before anything is removed.
  [ "$(security find-generic-password -s Jarvis -a "$provider-api-keys" -w)" = "$value" ] || { echo "The Keychain did not return the $provider keys; .env is unchanged."; exit 1; }
  sed -i '' "/^$name=/d" .env
  moved=$((moved + 1))
  echo "The $provider keys are in the Keychain and no longer in .env."
done
[ "$moved" -gt 0 ] || { echo "There are no NVIDIA_API_KEYS or GROQ_API_KEYS lines in .env; nothing to move."; exit 1; }
