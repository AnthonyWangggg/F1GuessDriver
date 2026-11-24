#!/usr/bin/env bash
# Isolated Linux rehearsal only. Does not install, deploy, migrate or alter a production service.
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo 'BLOCKED: Linux required'; exit 2; }
[[ "${NODE_ENV:-}" == test && "${G3_LINUX_DRILL:-}" == isolated-argon ]] || {
  echo 'BLOCKED: explicit NODE_ENV=test G3_LINUX_DRILL=isolated-argon required'; exit 2;
}
command -v systemd-run >/dev/null
timeout 10s systemctl --user is-system-running --wait >/dev/null
[[ -d /sys/fs/cgroup && -f /sys/fs/cgroup/cgroup.controllers ]] || exit 2
unit=f1-g3-isolated-argon
if systemctl --user is-active --quiet "$unit"; then
  echo 'BLOCKED: rehearsal unit already active'; exit 2
fi
mkdir -p local-private/phase-g3
trap 'systemctl --user stop "$unit" >/dev/null 2>&1 || true' EXIT
systemd-run --user --wait --pipe --remain-after-exit --unit="$unit" \
  --property=MemoryHigh=384M --property=MemoryMax=512M --property=MemorySwapMax=0 \
  --property=TasksMax=64 --working-directory="$PWD" \
  node --import tsx scripts/phase-g3/crypto-benchmark.ts \
  >local-private/phase-g3/linux-argon.log 2>&1
systemctl --user show "$unit" -p Result -p MemoryPeak -p MemoryMax -p MemoryHigh \
  -p NRestarts -p ExecMainStatus >local-private/phase-g3/linux-cgroup.txt
echo 'Argon rehearsal complete. Full HTTP worker restart/OOM and Nginx drain remain separate required tests.'
