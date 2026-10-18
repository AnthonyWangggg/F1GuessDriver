#!/bin/sh
set -eu
# sudoers grants this executable, so validate again before loading Node or reading CWD.
case "${1-}:${2-}:$#" in
  verify:auto:2|rollback:auto:2) ;;
  deploy:web:4|deploy:server:4|deploy:data:4)
    case "$3" in ''|*[!A-Za-z0-9_-]*) exit 64 ;; esac
    case "$3" in [A-Za-z0-9]*) ;; *) exit 64 ;; esac
    [ "${#3}" -le 96 ] || exit 64
    [ "${#4}" -eq 64 ] || exit 64
    case "$4" in *[!a-f0-9]*) exit 64 ;; esac
    ;;
  *) exit 64 ;;
esac
umask 077
cd /
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/node /opt/f1guessdriver/maintenance/rolling/deploy.js "$@"
