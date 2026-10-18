import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { prohibitedCandidate } from '../../scripts/lib/release-policy.js'
import {
  dataPublicationBlockers,
  validOwnMit,
  versionLicenseStatus,
} from '../../scripts/lib/license-policy.js'

describe('license scope and data candidate integrity', () => {
  it('rejects tracked caches, deployment outputs and dumps independently of gitignore', () => {
    for (const file of [
      'release/x/README.md',
      'apps/web/dist/index.html',
      'node_modules/vendor/LICENSE',
      '.cache/x',
      'data/export.sql.gz',
      'local-private/publication/approval.json',
    ])
      expect(prohibitedCandidate(file)).toBe(true)
    for (const file of [
      'LICENSE',
      'docs/DATA-LICENSES.md',
      'apps/web/src/views/GameView.vue',
      'packages/database/migrations/0001.sql',
      '.env.example',
    ])
      expect(prohibitedCandidate(file)).toBe(false)
  })
  it('does not let another release or a full text mask missing scope or contradictory terms', () => {
    expect(versionLicenseStatus(true)).toBe('confirmed')
    expect(versionLicenseStatus(false)).toBe('pending')
    expect(versionLicenseStatus(false, 'confirmed')).toBe('pending')
    expect(versionLicenseStatus(true, 'conflict')).toBe('conflict')
    expect(versionLicenseStatus(true, 'pending')).toBe('pending')
  })
  it('accepts the owner MIT text with LF or CRLF but rejects changed grant and holder', () => {
    const text = readFileSync('LICENSE', 'utf8')
    expect(validOwnMit(text)).toBe(true)
    expect(validOwnMit(text.replaceAll('\n', '\r\n'))).toBe(true)
    expect(validOwnMit(text.replace('WONTONANTI', 'other'))).toBe(false)
    expect(validOwnMit(text.replace('without restriction', 'with restriction'))).toBe(false)
  })
  it('rejects private evidence, unknown fixtures and stale scope rather than treating data as MIT', () => {
    const records = [
      {
        file: 'data/facts.json',
        sha256: 'a',
        status: 'local-only' as const,
        sources: ['Jolpica'],
        reason: 'mixed',
      },
      {
        file: 'data/config.json',
        sha256: 'b',
        status: 'original-config' as const,
        sources: ['original'],
        reason: 'config',
      },
    ]
    expect(dataPublicationBlockers('data/facts.json', 'a', records)).toEqual([
      'unapproved-data-redistribution',
    ])
    expect(dataPublicationBlockers('tests/fixtures/new.json', 'a', records)).toEqual([
      'unclassified-data-publication',
    ])
    expect(dataPublicationBlockers('data/config.json', 'changed', records)).toEqual([
      'data-publication-review-stale',
    ])
    expect(dataPublicationBlockers('data/config.json', 'b', records)).toEqual([])
  })
})
