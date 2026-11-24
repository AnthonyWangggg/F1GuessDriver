#!/usr/bin/env bash
set -euo pipefail
umask 022
[[ "$(node --version)" == "v$1" && "$(pnpm --version)" == 11.25.0 ]]
printf '%s  pnpm-lock.yaml\n' "$2" | sha256sum -c
pnpm install --frozen-lockfile --network-concurrency=4 --child-concurrency=1
pnpm -r --workspace-concurrency=1 build
pnpm release:pack
printf '%s  pnpm-lock.yaml\n' "$2" | sha256sum -c
release=$(<release/latest.txt)
[[ $release =~ ^"$PWD"/release/[a-f0-9-]{36}$ && -d $release ]]
# Inspect the packaged runtime and record the publication gate for this exact build.
git init --quiet
git add --force -- apps packages scripts deploy docs data reports LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ':!**/node_modules' ':!**/dist'
if pnpm release:inspect; then
  touch publication-pass
fi
# The source archive is separately checked before installation. Runtime links are
# intentionally retained and checked by the controller before extraction.
chmod -R a+rX,a-w "$release"
tar --hard-dereference --sort=name --owner=0 --group=0 --numeric-owner \
  -czf runtime.tar.gz -C "$release" .
