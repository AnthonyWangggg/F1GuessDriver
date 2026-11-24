const unitFixtures = [
  'V3_FINAL_ROLE_TEST_URL',
  ...['MODES', 'BO3', 'IDENTITY', 'POINTS', 'ACCOUNT', 'T3'].flatMap((name) => [
    name + '_TEST_DATABASE_URL',
    name + '_TEST_RUNTIME_URL',
  ]),
]
const browserFixtures = ['MODES', 'BO3'].flatMap((name) => [
  name + '_BROWSER_DATABASE_URL',
  name + '_BROWSER_RUNTIME_URL',
])

export function fullFixtures(step: string, input: NodeJS.ProcessEnv) {
  const env = { ...input }
  // Historical specs use this generic variable, and must never get the synthetic unit fixture.
  delete env.TEST_DATABASE_URL
  const required =
    step === 'unit'
      ? unitFixtures
      : ['e2e', 'cross-browser', 'visual'].includes(step)
        ? browserFixtures
        : ['database', 'game-database', 'history', 'legacy'].includes(step)
          ? ['V3_CERTIFIED_TEST_DATABASE_URL']
          : step === 'production-smoke'
            ? ['V3_PACKAGED_SMOKE_DATABASE_URL']
            : []
  for (const key of required) {
    const value = env[key]
    if (!value) throw new Error(`Full ${step} requires ${key}`)
    const url = new URL(value)
    if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error(`Full ${step} requires a loopback PostgreSQL fixture for ${key}`)
  }
  if (required.includes('V3_CERTIFIED_TEST_DATABASE_URL')) {
    const target = env.V3_CERTIFIED_TEST_DATABASE_URL!
    if (!/^\/f1_restore_test_[a-z0-9_]+$/.test(new URL(target).pathname))
      throw new Error('Full requires an isolated restored certified fixture')
    env.DATABASE_URL = target
    env.TEST_DATABASE_URL = target
  }
  return env
}
