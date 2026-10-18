#!/bin/sh
# Install root-owned. authorized_keys: restrict,command="/usr/local/libexec/f1guessdriver-forced"
set -eu
PATH=/usr/bin:/bin
export PATH
original=${SSH_ORIGINAL_COMMAND-}
# grep is line-oriented; reject CR/LF before validating the complete command frame.
filtered=$(printf '%s' "$original" | tr -d '\015\012')
[ "$filtered" = "$original" ] || exit 64
case "$original" in
  "verify auto") exec sudo -n /usr/local/sbin/f1guessdriver-release verify auto ;;
  "rollback auto") exec sudo -n /usr/local/sbin/f1guessdriver-release rollback auto ;;
esac
if printf '%s' "$original" | LC_ALL=C grep -Eq '^deploy (web|server|data) [A-Za-z0-9][A-Za-z0-9_-]{0,95} [a-f0-9]{64}$'; then
  set -f
  set -- $original
  exec sudo -n /usr/local/sbin/f1guessdriver-release "$1" "$2" "$3" "$4"
fi
exit 64
