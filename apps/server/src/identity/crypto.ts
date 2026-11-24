import {
  argon2,
  randomBytes,
  createHash,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from 'node:crypto'
import { passwordBudget } from './hash-budget.js'

export const secret = () => randomBytes(32).toString('hex')
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
export const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
export const PASSWORD_COST = { memory: 65536, passes: 3, parallelism: 1, tagLength: 32 } as const
const derive = (password: string, salt: Buffer) =>
  passwordBudget.run(
    () =>
      new Promise<Buffer>((resolve, reject) =>
        argon2('argon2id', { ...PASSWORD_COST, message: password, nonce: salt }, (error, value) =>
          error ? reject(error) : resolve(value),
        ),
      ),
  )
export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  return `$argon2id$v=19$m=65536,t=3,p=1$${salt.toString('base64')}$${(await derive(password, salt)).toString('base64')}`
}
export async function verifyPassword(password: string, encoded: string) {
  const parts = encoded.split('$')
  if (
    parts.length !== 6 ||
    parts[1] !== 'argon2id' ||
    parts[2] !== 'v=19' ||
    parts[3] !== 'm=65536,t=3,p=1'
  )
    return false
  const salt = Buffer.from(parts[4]!, 'base64')
  const expected = Buffer.from(parts[5]!, 'base64')
  if (salt.length !== 16 || expected.length !== 32) return false
  const actual = await derive(password, salt)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
export type IdentityKeyring = {
  activeId: string
  legacyId: string
  keys: Record<string, string>
  /** Stable authentication HMAC key; encryption rotation must not rotate this. */
  signingKey: string
}
export type IdentityKey = string | IdentityKeyring
export class IdentityCipher {
  private readonly key: Buffer
  private readonly signing: Buffer
  private readonly ring: IdentityKeyring | undefined
  constructor(key: IdentityKey) {
    const valid = (value: unknown): value is string =>
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    if (typeof key === 'string') {
      if (!valid(key)) throw new Error('Invalid identity encryption key')
      this.key = this.signing = Buffer.from(key, 'hex')
    } else {
      if (
        !key ||
        !/^[a-zA-Z0-9_-]{1,32}$/.test(key.activeId) ||
        !/^[a-zA-Z0-9_-]{1,32}$/.test(key.legacyId) ||
        !Object.hasOwn(key.keys, key.activeId) ||
        !Object.hasOwn(key.keys, key.legacyId) ||
        !valid(key.signingKey) ||
        Object.keys(key.keys).length > 16 ||
        Object.entries(key.keys).some(
          ([id, value]) => !/^[a-zA-Z0-9_-]{1,32}$/.test(id) || !valid(value),
        )
      )
        throw new Error('Invalid identity keyring')
      this.ring = structuredClone(key)
      this.key = Buffer.from(key.keys[key.activeId]!, 'hex')
      this.signing = Buffer.from(key.signingKey, 'hex')
    }
  }
  digest(value: string) {
    return createHmac('sha256', this.signing).update(value).digest('hex')
  }
  compatibilityTag() {
    // Opaque proof of configured read keys + stable signing key, not key material.
    const keys = this.ring
      ? Object.entries(this.ring.keys).sort(([a], [b]) => a.localeCompare(b))
      : [['legacy', this.key.toString('hex')]]
    return this.digest(JSON.stringify({ keys, legacyId: this.ring?.legacyId ?? 'legacy' }))
  }
  auditMetadata() {
    return {
      writeKeyId: this.ring?.activeId ?? 'legacy-unversioned',
      readKeyIds: this.ring ? Object.keys(this.ring.keys).sort() : ['legacy-unversioned'],
      legacyKeyId: this.ring?.legacyId ?? 'legacy-unversioned',
      readSetTag: this.compatibilityTag(),
    }
  }
  seal(value: unknown) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const prefix = this.ring ? `v2.${this.ring.activeId}.` : ''
    cipher.setAAD(Buffer.from(prefix || 'identity-v1'))
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    return prefix + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
  }
  open(value: string): unknown {
    try {
      let key = this.key,
        aad = 'identity-v1',
        payload = value
      if (value.includes('.')) {
        const match = /^v2\.([a-zA-Z0-9_-]{1,32})\.([A-Za-z0-9+/]+={0,2})$/.exec(value)
        if (!match || !this.ring || !Object.hasOwn(this.ring.keys, match[1]!)) throw new Error()
        key = Buffer.from(this.ring.keys[match[1]!]!, 'hex')
        aad = `v2.${match[1]}.`
        payload = match[2]!
      } else if (this.ring) key = Buffer.from(this.ring.keys[this.ring.legacyId]!, 'hex')
      if (payload.length > 131072 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error()
      const bytes = Buffer.from(payload, 'base64')
      if (bytes.length < 29) throw new Error()
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      cipher.setAAD(Buffer.from(aad))
      cipher.setAuthTag(bytes.subarray(12, 28))
      return JSON.parse(
        Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
      ) as unknown
    } catch {
      throw new Error('Sealed material unavailable or authentication failed')
    }
  }
}
