#!/bin/sh
# Lets Jarvis wake this Mac from sleep for alarms, reminders and scheduled tasks, and nothing else:
# the rule allows only `pmset schedule wake`, without a password. Undo: sudo rm /etc/sudoers.d/jarvis-wake
set -e
rule="$(id -un) ALL=(root) NOPASSWD: /usr/bin/pmset schedule wake *"
tmp="$(mktemp)"
echo "$rule" > "$tmp"
visudo -cf "$tmp" >/dev/null
sudo install -m 440 -o root -g wheel "$tmp" /etc/sudoers.d/jarvis-wake
rm -f "$tmp"
echo "Done: Jarvis can now wake the Mac for alarms, reminders and scheduled tasks."
