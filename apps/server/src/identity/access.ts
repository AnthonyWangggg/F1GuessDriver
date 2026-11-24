import { sql } from 'drizzle-orm'
import type { Database } from '@f1/database'
import type { FastifyRequest } from 'fastify'
import { ApiError } from '../services/errors.js'

export type IdentityTx = Parameters<Parameters<Database['transaction']>[0]>[0]
export type OwnerGuard = (tx: IdentityTx, owner: string) => Promise<void>
export type Access = { ownerHash: string | null; sessionHash: string | null; guard: OwnerGuard }
export const accesses = new WeakMap<FastifyRequest, Access>()
export const ownerGuard = (request: FastifyRequest) => accesses.get(request)?.guard
export const ownerLock = (tx: IdentityTx, owner: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'identity-owner:' + owner},0))`)
export async function ensureOwner(tx: IdentityTx, owner: string) {
  await ownerLock(tx, owner)
  let row = (
    await tx.execute<{ principal_id: string; claimed_account_id: string | null }>(
      sql`SELECT principal_id,claimed_account_id FROM identity_owners WHERE owner_hash=${owner} FOR SHARE`,
    )
  ).rows[0]
  if (!row) {
    const p = (
      await tx.execute<{ id: string }>(
        sql`INSERT INTO identity_principals DEFAULT VALUES RETURNING id`,
      )
    ).rows[0]!
    await tx.execute(
      sql`INSERT INTO identity_owners(owner_hash,principal_id) VALUES(${owner},${p.id})`,
    )
    row = { principal_id: p.id, claimed_account_id: null }
  }
  return row
}
export function makeOwnerGuard(sessionHash: string | null): OwnerGuard {
  return async (tx, owner) => {
    await ownerLock(tx, owner)
    const row = (
      await tx.execute<{ principal_id: string; claimed_account_id: string | null }>(
        sql`SELECT principal_id,claimed_account_id FROM identity_owners WHERE owner_hash=${owner} FOR SHARE`,
      )
    ).rows[0]
    if (!row) {
      if (sessionHash) throw new ApiError(401, 'ACCOUNT_SESSION_REQUIRED', 'Sign in again')
      return // Legacy reads do not allocate principals for arbitrary cookie values.
    }
    if (sessionHash) {
      const s = (
        await tx.execute<{ id: string }>(
          sql`SELECT s.id FROM identity_sessions s JOIN identity_accounts a ON a.id=s.account_id WHERE s.token_hash=${sessionHash} AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.principal_id=${row.principal_id} AND a.id=${row.claimed_account_id} FOR SHARE OF s,a`,
        )
      ).rows[0]
      if (!s) throw new ApiError(401, 'ACCOUNT_SESSION_REQUIRED', 'Sign in again')
    } else if (row.claimed_account_id)
      throw new ApiError(
        401,
        'ACCOUNT_SESSION_REQUIRED',
        'This guest identity has been claimed; sign in',
      )
  }
}
