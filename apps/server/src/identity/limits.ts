import type { Database } from '@f1/database'
import { sql } from 'drizzle-orm'
import { sha256 } from './crypto.js'
import { ApiError } from '../services/errors.js'

export async function consumeSharedLimit(
  db: Database,
  scope: string,
  subject: string,
  limit: number,
  seconds = 60,
) {
  const row = (
    await db.execute<{
      count: number
    }>(sql`INSERT INTO identity_rate_limits(scope,subject_hash,window_start,request_count) VALUES(${scope},${sha256(subject)},clock_timestamp(),1)
    ON CONFLICT(scope,subject_hash) DO UPDATE SET window_start=CASE WHEN identity_rate_limits.window_start<=clock_timestamp()-${seconds}*interval '1 second' THEN clock_timestamp() ELSE identity_rate_limits.window_start END,
    request_count=CASE WHEN identity_rate_limits.window_start<=clock_timestamp()-${seconds}*interval '1 second' THEN 1 ELSE identity_rate_limits.request_count+1 END RETURNING request_count AS count`)
  ).rows[0]!
  if (row.count > limit) throw new ApiError(429, 'RATE_LIMITED', 'Retry later')
}
