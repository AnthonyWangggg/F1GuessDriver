import { describe, expect, it } from 'vitest'
import { prohibited, prohibitedCandidate } from '../../scripts/lib/release-policy.js'

describe('local operational evidence stays out of source and runtime candidates', () => {
  it.each([
    'deploy/p4d/build.sh',
    'deploy/p4f/public-release.sh',
    'deploy/p4l/f1guessdriver-cert-renew.service',
    'deploy/private-access/connect.ps1',
    'deploy/public-prep/OWNER-APPROVAL.md',
    'docs/v3/private/history/PROD-report.md',
    'PROD-03C-PUBLIC-VERIFIED-RESULT.md',
    'STG-06-DEPLOY-RESULT.md',
    'PRODUCTION-INVENTORY-20261116.md',
    'diagnostics/session.har',
    'keys/id_ed25519',
    'keys/recovery.p12',
  ])('rejects %s regardless of whether a secret string is present', (path) => {
    expect(prohibited(path)).toBe(true)
    expect(prohibitedCandidate(path)).toBe(true)
  })

  it.each(['deploy/README.md', 'deploy/nginx.conf', 'deploy/production.env.example'])(
    'retains generic templates: %s',
    (path) => {
      expect(prohibited(path)).toBe(false)
      expect(prohibitedCandidate(path)).toBe(false)
    },
  )
})
