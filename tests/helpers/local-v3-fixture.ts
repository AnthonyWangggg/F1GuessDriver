export function localV3Fixture(admin: string, runtime: string) {
  const [a, r] = [new URL(admin), new URL(runtime)]
  const sameFixture =
    [a, r].every(
      (u) => u.protocol === 'postgresql:' && u.hostname === '127.0.0.1' && !u.search && !u.hash,
    ) &&
    a.port === r.port &&
    a.pathname === r.pathname &&
    a.username !== r.username
  const old = a.port === '55439' && a.pathname === '/f1_bo3_test_phase_g4_regression'
  const phase3 =
    a.port === '55483' &&
    a.pathname === '/f1_bo3_test_phase3' &&
    a.username === 'local_admin' &&
    r.username === 'f1_bo3_test_app'
  if (!sameFixture || (!old && !phase3) || process.env.NODE_ENV !== 'test')
    throw new Error('Explicit marked local v3 fixture required')
  return {
    database: a.pathname.slice(1),
    runtimeRole: r.username,
    directory: phase3
      ? /\/F1GuessDriver\/local-private\/local-v3-[a-f0-9]{8}\/pgdata$/
      : /\/F1GuessDriver\/local-private\/phase-a\/pgdata$/,
  }
}
