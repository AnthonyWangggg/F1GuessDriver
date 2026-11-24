#!/usr/bin/env bash
# Separate T2 approval and an R-installed dedicated system unit required. No sudo/install.
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo 'BLOCKED: Linux required'; exit 2; }
[[ "${NODE_ENV:-}" == test && "${G4_LINUX_DRILL:-}" == isolated-argon ]] || {
  echo 'BLOCKED: explicit NODE_ENV=test G4_LINUX_DRILL=isolated-argon required'; exit 2;
}
[[ -n "${L3_T2_APPROVAL_REFERENCE:-}" ]] || { echo 'BLOCKED: explicit T2 approval reference required'; exit 2; }
[[ -d /sys/fs/cgroup && -f /sys/fs/cgroup/cgroup.controllers ]] || exit 2
unit=f1-g4-l3-argon.service
root=/var/tmp/f1-g4
[[ "$PWD" == "$root/candidate" ]] || { echo 'BLOCKED: isolated candidate directory required'; exit 2; }
[[ "$(systemctl show "$unit" -p LoadState --value)" == loaded ]] || exit 2
[[ "$(systemctl show "$unit" -p User --value)" == f1l3test ]] || exit 2
if systemctl is-active --quiet "$unit"; then
  echo 'BLOCKED: rehearsal unit already active'; exit 2
fi
[[ -d "$root/evidence" ]] || { echo 'BLOCKED: R-created evidence directory required'; exit 2; }
trap 'systemctl --no-ask-password stop "$unit" >/dev/null 2>&1 || true' EXIT
systemctl --no-ask-password start "$unit"
systemctl show "$unit" -p Result -p MemoryPeak -p MemoryMax -p MemoryHigh \
  -p NRestarts -p ExecMainStatus >"$root/evidence/linux-cgroup.txt"
[[ "$(systemctl show "$unit" -p Result --value)" == success ]] || exit 1
echo 'Dedicated Argon/cgroup rehearsal only. HTTP/PG/proxy recovery is separate.'
