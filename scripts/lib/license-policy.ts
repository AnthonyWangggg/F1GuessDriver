import { createHash } from 'node:crypto'

export const ownMitSha256 = 'fd3f352789b6e9d4fe9342eb521f25e7fced2a4589c821c87d869e402c13f4e1'
export const sha256 = (body: string | Buffer) => createHash('sha256').update(body).digest('hex')
export function validOwnMit(body: string) {
  return sha256(body.replaceAll('\r\n', '\n')) === ownMitSha256
}
export function versionLicenseStatus(covered: boolean, review?: string) {
  return review && review !== 'confirmed' ? review : covered ? 'confirmed' : 'pending'
}
export type DataPublicationRecord = {
  file: string
  sha256: string
  status: 'original-config' | 'attributed-resource' | 'local-only'
  sources: string[]
  reason: string
}
export function dataPublicationBlockers(
  file: string,
  digest: string,
  records: DataPublicationRecord[],
) {
  if (!/^(data\/|tests\/.*fixtures\/|reports\/pole-audit\/)/.test(file)) return []
  const record = records.find((item) => item.file === file)
  if (!record) return ['unclassified-data-publication']
  if (record.status === 'local-only') return ['unapproved-data-redistribution']
  if (record.sha256 !== digest) return ['data-publication-review-stale']
  return []
}
