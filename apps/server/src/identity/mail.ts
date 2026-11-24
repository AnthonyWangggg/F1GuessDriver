import { z } from 'zod'
import { sql } from 'drizzle-orm'
import type { Database } from '@f1/database'
import type { IdentityCipher } from './crypto.js'
import { MailDeliveryError } from './relay-mail.js'

export const mailSchema = z
  .object({
    email: z.email(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    purpose: z.enum(['verify', 'reset', 'email']),
  })
  .strict()
export type IdentityMail = z.infer<typeof mailSchema>
export interface MailAdapter {
  readonly kind: 'mock' | 'production'
  send(id: string, mail: IdentityMail): Promise<void>
}
// No network, logging, or public inbox. Tests may inspect this explicitly injected sink.
export class MockMailAdapter implements MailAdapter {
  readonly kind = 'mock' as const
  readonly messages = new Map<string, IdentityMail>()
  async send(id: string, mail: IdentityMail) {
    this.messages.set(id, mail)
  }
}
export async function dispatchMail(db: Database, cipher: IdentityCipher, adapter: MailAdapter) {
  return db.transaction(async (tx) => {
    const rows = (
      await tx.execute<{ id: string; payload: string; valid: boolean }>(
        sql`SELECT m.id,m.payload,(t.used_at IS NULL AND t.expires_at>clock_timestamp()) AS valid FROM identity_mail_outbox m JOIN identity_tokens t ON t.id=m.token_id WHERE m.delivered=false AND m.attempts<8 AND m.next_attempt_at<=clock_timestamp() ORDER BY m.next_attempt_at LIMIT 3 FOR UPDATE OF m SKIP LOCKED`,
      )
    ).rows
    for (const row of rows) {
      try {
        const message = row.valid ? mailSchema.parse(cipher.open(row.payload)) : undefined
        if (row.valid) {
          // Shared across workers/HTTP instances; no recipient or token is stored here.
          const count = (
            await tx.execute<{
              count: number
            }>(sql`INSERT INTO identity_rate_limits(scope,subject_hash,window_start,request_count)
            VALUES('mail-dispatch','global',clock_timestamp(),1) ON CONFLICT(scope,subject_hash) DO UPDATE SET
            window_start=CASE WHEN identity_rate_limits.window_start<=clock_timestamp()-interval '60 seconds' THEN clock_timestamp() ELSE identity_rate_limits.window_start END,
            request_count=CASE WHEN identity_rate_limits.window_start<=clock_timestamp()-interval '60 seconds' THEN 1 ELSE identity_rate_limits.request_count+1 END RETURNING request_count AS count`)
          ).rows[0]!.count
          if (count > 30) {
            await tx.execute(
              sql`UPDATE identity_mail_outbox SET next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE id=${row.id}`,
            )
            continue
          }
        }
        if (message) await adapter.send(row.id, message)
        await tx.execute(
          sql`UPDATE identity_mail_outbox SET delivered=true,payload='',attempts=attempts+1 WHERE id=${row.id}`,
        )
      } catch (error) {
        if (error instanceof MailDeliveryError && error.permanent)
          await tx.execute(
            sql`UPDATE identity_mail_outbox SET delivered=true,payload='',attempts=attempts+1 WHERE id=${row.id}`,
          )
        else {
          const delay = error instanceof MailDeliveryError ? error.retrySeconds : 60
          await tx.execute(
            sql`UPDATE identity_mail_outbox SET attempts=attempts+1,next_attempt_at=clock_timestamp()+${delay}*interval '1 second' WHERE id=${row.id}`,
          )
        }
      }
    }
    return rows.length
  })
}
