import { describe, expect, it } from 'vitest'
import { publicationBlockers } from '../../scripts/lib/publication.js'
import { reviewedDependencyExample } from '../../scripts/lib/dependency-examples.js'
import { createHash } from 'node:crypto'
describe('publication requires exact human review', () => {
  const reviewed = {
    candidateSha256: 'files',
    licenseSha256: 'license',
    ownerLicenseDecision: 'owner decision',
    dataRedistributionEvidence: 'reviewed evidence',
    dependencyReview: 'reviewed notices',
    fileReview: 'owner reviewed',
  }
  it('blocks missing license, data and file decisions', () => {
    expect(publicationBlockers({}, 'files')).toContain('project-license-evidence-required')
    expect(publicationBlockers({}, 'files')).toContain('OWNER_APPROVAL_REQUIRED')
  })
  it('invalidates review when candidates or license change', () => {
    expect(publicationBlockers(reviewed, 'changed', 'changed')).toContain(
      'exact-candidate-owner-review-required',
    )
    expect(publicationBlockers(reviewed, 'files', 'license', 'new-data-scope')).toContain(
      'data-scope-owner-review-required',
    )
  })
  it('accepts technical review without granting permission to publish', () => {
    expect(publicationBlockers(reviewed, 'files', 'license')).toEqual([])
  })
})
it('never allows a changed dependency file or a different rule by example review', () => {
  const body = 'public synthetic example'
  const review = [
    {
      file: 'vendor/README.md',
      sha256: createHash('sha256').update(body).digest('hex'),
      rules: ['example'],
      reason: 'synthetic upstream example',
      sourceUrl: 'https://example.invalid/source',
    },
  ]
  expect(reviewedDependencyExample('vendor/README.md', body, 'example', review)).toBe(true)
  expect(reviewedDependencyExample('vendor/README.md', body + 'changed', 'example', review)).toBe(
    false,
  )
  expect(reviewedDependencyExample('vendor/README.md', body, 'private-key', review)).toBe(false)
  expect(reviewedDependencyExample('other/README.md', body, 'example', review)).toBe(false)
})
