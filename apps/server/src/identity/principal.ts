import type { FastifyRequest } from 'fastify'
import { sql } from 'drizzle-orm'
import { rawOwnerIdentity } from '../middleware/security.js'
import { ACCOUNT_COOKIE, readIdentityCookie } from './http.js'
import { ensureOwner, makeOwnerGuard, type IdentityTx } from './access.js'
import { sha256 } from './crypto.js'
import { ApiError } from '../services/errors.js'
export async function resolvePrincipal(tx: IdentityTx, request: FastifyRequest, required: boolean) {
  const token = readIdentityCookie(request, ACCOUNT_COOKIE),
    sessionHash = token ? sha256(token) : null
  if (
    !token &&
    (request.headers.cookie ?? '').split(';').some((c) => c.trim().startsWith(ACCOUNT_COOKIE + '='))
  )
    throw new ApiError(401, 'ACCOUNT_SESSION_REQUIRED', 'Sign in again')
  let owner = rawOwnerIdentity(request)?.hash ?? null
  if (sessionHash) {
    owner =
      (
        await tx.execute<{ owner_hash: string }>(
          sql`SELECT o.owner_hash FROM identity_sessions s JOIN identity_owners o ON o.claimed_account_id=s.account_id WHERE s.token_hash=${sessionHash} AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`,
        )
      ).rows[0]?.owner_hash ?? null
    if (!owner) throw new ApiError(401, 'ACCOUNT_SESSION_REQUIRED', 'Sign in again')
  }
  if (!owner) {
    if (required)
      throw new ApiError(401, 'ANONYMOUS_SESSION_REQUIRED', 'Start a game or sign in first')
    return null
  }
  await makeOwnerGuard(sessionHash)(tx, owner)
  const mapped = await ensureOwner(tx, owner)
  return { id: mapped.principal_id, owner }
}
