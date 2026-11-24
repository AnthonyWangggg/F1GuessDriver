# Driver Guess 3.0 database finalization

This sequence is part of the release candidate. Execution against a server requires a separately approved plan for the exact target, roles, artifact, backup and rollback point.

1. In the maintenance window, apply the locked migration journal through 0014. Before exposing the application, apply the base runtime ACL and the identity, modes, points and BO3 templates under the schema administrator. Resolve the example role names against the approved role mapping. The identity ACL template includes historical grants and assumes those tables exist at this point.
2. Close temporary migration connections, revoke temporary maintenance membership and CONNECT, and set the migration role NOLOGIN. Keep the application fenced while finalizing.
3. Apply `v3-migration-owner.sql.example` with the actual retained owner of `public.identity_principals`. The transaction verifies that the owner is non-superuser and NOLOGIN, lacks schema CREATE, and gives that owner direct schema USAGE. It then checks every public FK parent owner. Stop on any unexpected owner or failing ACL.
4. Confirm the runtime has schema USAGE and the reviewed table, sequence and function permissions, and is denied DDL and ledger updates/deletes. Verify the approved points activation through the production points contract.
5. With traffic still fenced, test the candidate via a local HTTP process using the final runtime role. Require successful runtime readiness and an anonymous `GET /api/v3/modes/session` on a client without cookies, followed by cookie recovery and account-session verification. Match the migration and template digests to the approved candidate before exposing the app.

The local-only cleanup template is guarded by database name, loopback, port and data directory and uses `RESTRICT`. It is outside the runtime artifact. Any server data cleanup requires its own reviewed target and dependency/rollback plan.

For a fresh 3.0 database, require empty legacy and business tables after the 15 migrations. Drop the exact legacy table set with `RESTRICT` before grants, and use `identity-fresh-roles.sql.example` in place of the historical identity ACL. Apply the certified data allowlist and verify it before enabling LOGIN. See the Phase 4A fresh deployment plan for the local rehearsal and future production authorization boundaries.
