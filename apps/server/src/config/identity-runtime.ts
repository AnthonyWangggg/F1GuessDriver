import { z } from 'zod'
import { IdentityCipher, type IdentityKeyring } from '../identity/crypto.js'
import { RelayMailAdapter, type RelayConfig } from '../identity/relay-mail.js'

const keyringSchema = z
  .object({
    activeId: z.string(),
    legacyId: z.string(),
    keys: z.record(z.string(), z.string()),
    signingKey: z.string(),
  })
  .strict()
export function parseKeyring(input: string): IdentityKeyring {
  try {
    const value = keyringSchema.parse(JSON.parse(input))
    new IdentityCipher(value)
    return value
  } catch {
    throw new Error('Invalid IDENTITY_KEYRING_JSON; values withheld')
  }
}
export function parseRelay(input: string): RelayConfig {
  try {
    const value = JSON.parse(input) as RelayConfig
    new RelayMailAdapter(value)
    return value
  } catch {
    throw new Error('Invalid MAIL_RELAY_JSON; values withheld')
  }
}
