import { z } from 'zod'
import { mailSchema, type IdentityMail, type MailAdapter } from './mail.js'

export const relayConfigSchema = z
  .object({
    endpoint: z.url(),
    bearer: z
      .string()
      .min(32)
      .max(1024)
      .regex(/^[A-Za-z0-9_./+=-]+$/),
    from: z.email(),
    appOrigin: z.url(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of ['endpoint', 'appOrigin'] as const) {
      const url = new URL(value[field])
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (field === 'appOrigin' && url.origin !== value[field])
      )
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Exact secure mail configuration required',
        })
    }
  })
export type RelayConfig = z.infer<typeof relayConfigSchema>
export class MailDeliveryError extends Error {
  constructor(
    readonly permanent: boolean,
    readonly retrySeconds = 60,
  ) {
    super(permanent ? 'Mail recipient rejected' : 'Mail delivery unavailable')
  }
}
/** Provider-neutral, opt-in HTTPS relay contract. No provider is chosen here.
 * Relay MUST deduplicate Idempotency-Key across retries/workers and suppress
 * bounced/complaining recipients. A 2xx means durable acceptance, not delivery.
 */
export class RelayMailAdapter implements MailAdapter {
  readonly kind = 'production' as const
  private readonly config: RelayConfig
  constructor(
    config: RelayConfig,
    private readonly transport: typeof fetch = fetch,
  ) {
    const parsed = relayConfigSchema.safeParse(config)
    if (!parsed.success) throw new Error('Invalid production mail adapter configuration')
    this.config = parsed.data
  }
  async send(id: string, input: IdentityMail) {
    if (!z.uuid().safeParse(id).success) throw new Error('Invalid mail delivery identifier')
    const mail = mailSchema.parse(input)
    const flow = { verify: 'verify', reset: 'reset', email: 'email-confirm' }[mail.purpose]
    const link = `${this.config.appOrigin}/account?flow=${flow}#token=${mail.token}`
    let response: Response
    try {
      response = await this.transport(this.config.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.bearer}`,
          'idempotency-key': id,
        },
        body: JSON.stringify({
          from: this.config.from,
          to: mail.email,
          subject: 'Driver Guess account verification',
          text: `Complete your ${mail.purpose} request: ${link}`,
        }),
      })
    } catch {
      throw new MailDeliveryError(false)
    }
    // Never log, parse or retain provider responses: they can echo a token.
    void response.body?.cancel().catch(() => undefined)
    if ([200, 202, 204].includes(response.status)) return
    if ([410, 422].includes(response.status)) throw new MailDeliveryError(true)
    const retry = Number(response.headers.get('retry-after'))
    throw new MailDeliveryError(
      false,
      Number.isFinite(retry) ? Math.min(3600, Math.max(60, retry)) : 60,
    )
  }
}
