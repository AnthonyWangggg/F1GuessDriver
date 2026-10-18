import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
export function encryptBackup(body: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('Backup key must contain 32 bytes')
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from('F1BK1'))
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()])
  return Buffer.concat([Buffer.from('F1BK1'), iv, cipher.getAuthTag(), ciphertext])
}
export function decryptBackup(body: Buffer, key: Buffer): Buffer {
  if (body.length < 33 || body.subarray(0, 5).toString() !== 'F1BK1')
    throw new Error('Invalid encrypted backup')
  const cipher = createDecipheriv('aes-256-gcm', key, body.subarray(5, 17))
  cipher.setAAD(Buffer.from('F1BK1'))
  cipher.setAuthTag(body.subarray(17, 33))
  return Buffer.concat([cipher.update(body.subarray(33)), cipher.final()])
}
export function assertRestoreTarget(source: string, target: string): string {
  const a = new URL(source),
    b = new URL(target),
    name = decodeURIComponent(b.pathname.slice(1))
  if (
    !/^f1_restore_test_[a-z0-9_]+$/.test(name) ||
    decodeURIComponent(a.pathname) === decodeURIComponent(b.pathname) ||
    !/^postgres(ql)?:$/.test(b.protocol)
  )
    throw new Error('Restore requires a separate database named f1_restore_test_*')
  return name
}
