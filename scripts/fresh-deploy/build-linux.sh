#!/usr/bin/env bash
set -euo pipefail

if [[ $# == 0 || ( $# == 1 && $1 == --dry-run ) ]]; then
  cat <<'EOF'
DRY_RUN: use an isolated Ubuntu 24.04 builder matching the reviewed production architecture.
Verify the frozen source lock, install Linux dependencies, build and inspect the runtime package,
run packaged HTTP against an isolated initialized PostgreSQL 18 fixture, then hash the archive.
EOF
  exit 0
fi
[[ $# == 1 && $1 == --build-local ]] || exit 2
[[ $(uname -s) == Linux && $(uname -m) == "${FRESH_BUILD_ARCH:?reviewed target architecture required}" ]]
[[ -f /etc/os-release ]] && grep -qx 'ID=ubuntu' /etc/os-release
grep -qx 'VERSION_ID="24.04"' /etc/os-release
[[ $(id -u) != 0 && ! -e /etc/f1guessdriver && ! -e /opt/f1guessdriver ]]
[[ $(node --version) == "${FRESH_BUILD_NODE:?reviewed Node version required}" ]]
[[ ${FRESH_BUILD_NODE_SHA256:?reviewed Node binary SHA256 required} =~ ^[a-f0-9]{64}$ ]]
printf '%s  %s\n' "$FRESH_BUILD_NODE_SHA256" "$(readlink -f -- "$(command -v node)")" | sha256sum --check --status
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major!==24||minor<12) process.exit(1)'
[[ $(pnpm --version) == 11.25.0 ]]
[[ ${FRESH_BUILD_LOCK_SHA256:?locked source SHA256 required} =~ ^[a-f0-9]{64}$ ]]
printf '%s  pnpm-lock.yaml\n' "$FRESH_BUILD_LOCK_SHA256" | sha256sum --check --status
[[ ! -e node_modules && ! -e apps/server/node_modules && ! -e apps/web/node_modules ]]
[[ ! -e .env && ! -e apps/server/.env && ! -e apps/web/.env ]]
[[ ! -e apps/server/dist && ! -e apps/web/dist && ! -e release/latest.txt ]]
[[ -z ${RESTORE_DATABASE_URL:-} && -z ${V3_CERTIFIED_TEST_DATABASE_URL:-} && -z ${V3_PACKAGED_SMOKE_DATABASE_URL:-} ]]
[[ ${V3_FINAL_ROLE_TEST_URL:?isolated cluster administrative URL required} == postgresql://local_admin@127.0.0.1:55483/postgres ]]
[[ ${V3_CERTIFIED_BRIDGE_FILE:?private reviewed bridge path required} == local-private/* ]]
[[ ${V3_CERTIFIED_BRIDGE_SHA256:?reviewed bridge SHA256 required} =~ ^[a-f0-9]{64}$ ]]
[[ ${IDENTITY_ENCRYPTION_KEY:?disposable synthetic key required} =~ ^[a-f0-9]{64}$ && -z ${IDENTITY_KEYRING_JSON:-} ]]
unset DATABASE_URL
pnpm install --frozen-lockfile

fixture=$(NODE_ENV=test pnpm exec tsx scripts/fresh-deploy/init-database.ts --apply-linux-local | tee /dev/stderr | awk '/^PHASE4B_TARGET / {print $2, $3}')
read -r database role <<< "$fixture"
[[ $database =~ ^f1_restore_test_phase4b_[a-f0-9]{12}$ && $role =~ ^f1fresh_app_[a-f0-9]{12}$ ]]
export DATABASE_URL='postgresql://local_admin@127.0.0.1:55483/f1_fresh_test_phase4b_unused'
export V3_CERTIFIED_TEST_DATABASE_URL="postgresql://local_admin@127.0.0.1:55483/$database"
export RESTORE_DATABASE_URL="postgresql://$role@127.0.0.1:55483/$database"

# Existing release smoke uses separate source and restored targets. Both are builder-local.
node --input-type=module <<'EOF'
import assert from 'node:assert/strict'
for (const key of ['DATABASE_URL', 'RESTORE_DATABASE_URL', 'V3_CERTIFIED_TEST_DATABASE_URL']) {
  const url = new URL(process.env[key])
  assert.equal(url.protocol, 'postgresql:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.match(url.pathname, /^\/f1_(?:restore_test|fresh_test)_[a-z0-9_]+$/)
  assert.ok(!url.search && !url.hash)
}
assert.notEqual(new URL(process.env.DATABASE_URL).pathname,new URL(process.env.RESTORE_DATABASE_URL).pathname)
assert.match(new URL(process.env.RESTORE_DATABASE_URL).pathname, /^\/f1_restore_test_/)
const verified = new URL(process.env.V3_CERTIFIED_TEST_DATABASE_URL)
const runtime = new URL(process.env.RESTORE_DATABASE_URL)
assert.equal(verified.host + verified.pathname, runtime.host + runtime.pathname)
assert.notEqual(verified.username, runtime.username)
assert.match(process.env.V3_CERTIFIED_BRIDGE_SHA256, /^[a-f0-9]{64}$/)
assert.ok(!process.env.V3_PACKAGED_SMOKE_DATABASE_URL)
assert.match(process.env.IDENTITY_ENCRYPTION_KEY, /^[a-f0-9]{64}$/)
assert.ok(!process.env.IDENTITY_KEYRING_JSON)
EOF
pnpm type-check
pnpm build
NODE_ENV=test pnpm exec tsx scripts/fresh-deploy/certified-bridge.ts --verify "${V3_CERTIFIED_BRIDGE_FILE:?private reviewed bridge path required}"
node --input-type=module <<'EOF'
import assert from 'node:assert/strict'
import { Pool } from '@f1/database'
const db = new Pool({ connectionString: process.env.RESTORE_DATABASE_URL })
try {
  const {rows} = await db.query(`SELECT
    current_setting('server_version_num')::int/10000 = 18 AS pg18,
    NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AS restricted,
    NOT has_schema_privilege(current_user,'public','CREATE') AS no_ddl,
    NOT has_table_privilege(current_user,'public.points_ledger','UPDATE,DELETE,TRUNCATE') AS no_ledger_rewrite,
    NOT EXISTS (SELECT 1 FROM pg_constraint fk JOIN pg_class parent ON parent.oid=fk.confrelid
      JOIN pg_namespace ns ON ns.oid=parent.relnamespace WHERE fk.contype='f' AND ns.nspname='public'
      AND NOT has_schema_privilege(parent.relowner,ns.oid,'USAGE')) AS fk_owner_usage,
    (SELECT NOT owner.rolcanlogin AND NOT owner.rolsuper
      FROM pg_class parent JOIN pg_roles owner ON owner.oid=parent.relowner
      WHERE parent.oid='public.identity_principals'::regclass) AS owner_fenced
    FROM pg_roles WHERE rolname=current_user`)
  assert.deepEqual(rows, [{pg18:true,restricted:true,no_ddl:true,no_ledger_rewrite:true,fk_owner_usage:true,owner_fenced:true}])
  console.log('Final runtime role and FK-owner ACL passed')
} finally {
  await db.end()
}
EOF
pnpm security:scan
pnpm licenses:inventory
pnpm release:pack
pnpm release:inspect
printf '%s  pnpm-lock.yaml\n' "$FRESH_BUILD_LOCK_SHA256" | sha256sum --check --status

root=$(cat release/latest.txt)
[[ $(dirname -- "$root") == "$(pwd -P)/release" && -d "$root" ]]
name=$(basename -- "$root")
[[ $name =~ ^[a-f0-9-]{36}$ ]]
output="release/linux-$name"
[[ ! -e $output ]]
stage=$(mktemp -d "$(pwd -P)/release/smoke-archive-XXXXXXXX")
trap 'printf "Linux archive staging (inspect on failure): %s\n" "$stage" >&2' EXIT
(
  cd -- "$root"
  LC_ALL=C find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
) > "$stage/files.sha256"
(
  cd -- "$root"
  LC_ALL=C find . -type l -printf '%p\t%l\n' | LC_ALL=C sort
) > "$stage/links.tsv"
tar --hard-dereference --sort=name --owner=0 --group=0 --numeric-owner -czf "$stage/driver-guess-3-linux.tar.gz" -C "$root" .
python3 scripts/fresh-deploy/check-linux-archive.py "$stage/driver-guess-3-linux.tar.gz" --arch "$FRESH_BUILD_ARCH"
(
  cd -- "$stage"
  sha256sum driver-guess-3-linux.tar.gz files.sha256 links.tsv > SHA256SUMS
  sha256sum --check SHA256SUMS
)
unpacked=$(mktemp -d "$(pwd -P)/release/smoke-extracted-XXXXXXXX")
tar --extract --gzip --file "$stage/driver-guess-3-linux.tar.gz" --directory "$unpacked" --no-same-owner --no-same-permissions
(
  cd -- "$unpacked"
  sha256sum --check --quiet "$stage/files.sha256"
  LC_ALL=C find . -type l -printf '%p\t%l\n' | LC_ALL=C sort | cmp "$stage/links.tsv" -
)
RELEASE_SMOKE_ROOT="$unpacked" pnpm release:smoke
mv -T -- "$stage" "$output"
trap - EXIT
printf 'LOCAL_LINUX_CANDIDATE %s\n' "$output"
