export type Finding = { severity: 'BLOCKER' | 'WARNING' | 'INFO'; file: string; rule: string }
export function prohibitedCandidate(path: string): boolean {
  const p = path.replaceAll('\\', '/')
  return (
    prohibited(p) ||
    /(^|\/)(release|release-tools|node_modules|dist|build|coverage|\.cache|\.pnpm-store|\.idea|logs)(\/|$)/.test(
      p,
    ) ||
    /\.(?:sql\.(?:gz|zip)|dump\.zip|sqlite|db|tmp|bak)$/.test(p)
  )
}
export function prohibited(path: string): boolean {
  const p = path.replaceAll('\\', '/')
  return (
    /^deploy\/(?:p4[^/]*|private-access|public-prep)\//.test(p) ||
    (p.startsWith('reports/') &&
      !['reports/pole-audit/audit.json', 'reports/pole-audit/legacy-baseline.json'].includes(p)) ||
    (p.endsWith('.sql') && !/(^|\/)(packages\/database|@f1\/database)\/migrations\//.test(p)) ||
    (/(^|\/)(\.env(?:\..*)?|local-private|local-archive|backups|test-results|playwright-report)(\/|$)/.test(
      p,
    ) &&
      !p.endsWith('.env.example')) ||
    /development-report\.md$|(^|\/).*?-snapshots\/|\.(dump|backup|f1backup|pem|key|webm|log|trace)$/.test(
      p,
    )
  )
}
export function secretRules(text: string): string[] {
  const rules: string[] = []
  for (const match of text.matchAll(/postgres(?:ql)?:\/\/[^\s"'<>`]+/g)) {
    try {
      const password = decodeURIComponent(new URL(match[0]).password)
      const url = new URL(match[0])
      const synthetic =
        url.username === 'test' &&
        password === 'test' &&
        url.hostname === 'localhost' &&
        url.pathname === '/test'
      if (password && password !== 'CHANGE_ME' && !synthetic && !password.includes('${'))
        rules.push('database-credential')
    } catch {
      /* Non-literal template is not a credential. */
    }
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) rules.push('private-key')
  if (
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{30,})\b/.test(
      text,
    )
  )
    rules.push('access-key')
  for (const match of text.matchAll(/f1_player=([a-f0-9]{64})/gi))
    if (new Set(match[1]).size > 2) rules.push('anonymous-cookie')
  if (/(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][A-Za-z0-9/+_-]{20,}["']/i.test(text))
    rules.push('embedded-secret')
  return [...new Set(rules)]
}
