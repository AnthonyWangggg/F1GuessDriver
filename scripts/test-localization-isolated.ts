import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile, mkdir, cp, readdir, readFile, realpath, symlink } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { createDatabase } from '@f1/database'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import { databaseUrl, main } from './lib/runtime.js'
import { assertRestoreTarget } from './lib/backup.js'

async function legacyRuntime(suffix: string) {
  const frozen =
    process.env.LOCALIZATION_LEGACY_SOURCE ??
    'local-private/daily-closeout-20261016/linux-source-73c64168c3e0'
  const target = `local-private/localization/legacy-${suffix}`
  if (!(await readFile(`${frozen}/pnpm-lock.yaml`)).equals(await readFile('pnpm-lock.yaml')))
    throw new Error(
      'Legacy source lockfile differs; independent dependency installation/review required',
    )
  await mkdir(target, { recursive: true })
  await cp(`${frozen}/tsconfig.base.json`, `${target}/tsconfig.base.json`)
  await cp(`${frozen}/package.json`, `${target}/package.json`)
  await cp(`${frozen}/data/game`, `${target}/data/game`, { recursive: true })
  for (const unit of ['packages/shared', 'packages/database', 'apps/server']) {
    await mkdir(`${target}/${unit}`, { recursive: true })
    for (const file of ['src', 'tsconfig.json', 'package.json'])
      await cp(`${frozen}/${unit}/${file}`, `${target}/${unit}/${file}`, { recursive: true })
  }
  for (const name of ['shared', 'database']) {
    const link = `${target}/node_modules/@f1/${name}`
    await mkdir(dirname(link), { recursive: true })
    await symlink(
      resolve(`${target}/packages/${name}`),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  }
  for (const [unit, dependencies] of [
    ['apps/server', ['fastify', 'abstract-logging', 'dotenv', 'drizzle-orm', 'zod']],
    ['packages/database', ['pg', '@types/pg']],
  ] as const) {
    for (const name of dependencies) {
      const link = `${target}/${unit}/node_modules/${name}`
      await mkdir(dirname(link), { recursive: true })
      await symlink(
        await realpath(`${unit}/node_modules/${name}`),
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    }
  }
  for (const unit of ['packages/shared', 'packages/database', 'apps/server']) {
    execFileSync(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '-p', `${target}/${unit}/tsconfig.json`],
      { stdio: 'inherit' },
    )
  }
  console.info(
    JSON.stringify({ legacySource: frozen, rebuiltRuntime: target, platform: process.platform }),
  )
  return target
}

async function cloneSchema(base: URL, schema: string) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Loopback only')
  const admin = createDatabase(base.toString())
  const target = new URL(base)
  target.searchParams.set('options', `-c search_path=${schema}`)
  const database = createDatabase(target.toString())
  const folder = `local-private/localization/${schema}-migrations`
  try {
    await admin.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`)
    await cp('packages/database/migrations', folder, { recursive: true })
    for (const file of await readdir(folder))
      if (file.endsWith('.sql')) {
        const path = `${folder}/${file}`
        await writeFile(
          path,
          (await readFile(path, 'utf8')).replaceAll('"public".', `"${schema}".`),
        )
      }
    await migrate(database.db, { migrationsFolder: folder, migrationsSchema: schema })
    await database.db.transaction(async (tx) => {
      const tables = await tx.execute<{ name: string }>(
        sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=${schema} AND tablename NOT IN ('__drizzle_migrations','game_sessions','game_guesses') ORDER BY tablename`,
      )
      const fks = await tx.execute<{ child: string; parent: string }>(
        sql`SELECT c.relname AS child, p.relname AS parent FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid WHERE f.contype='f' AND f.connamespace=${schema}::regnamespace`,
      )
      const pending = new Set(tables.rows.map((r) => r.name))
      while (pending.size) {
        const ready = [...pending].filter(
          (name) => !fks.rows.some((f) => f.child === name && pending.has(f.parent)),
        )
        if (!ready.length) throw new Error('Cannot topologically copy local static tables')
        for (const name of ready) {
          const sourceExists = await tx.execute<{ present: boolean }>(
            sql`SELECT to_regclass(${'public.' + name}) IS NOT NULL AS present`,
          )
          if (!sourceExists.rows[0]?.present) {
            if (
              ![
                'daily_challenges',
                'daily_entries',
                'daily_guesses',
                'daily_submissions',
                'daily_rate_limits',
                'matches',
                'match_queue',
                'match_players',
                'match_memberships',
                'match_guesses',
                'match_requests',
                'match_rate_limits',
              ].includes(name)
            )
              throw new Error('Missing historical source table: ' + name)
            pending.delete(name)
            continue
          }
          await tx.execute(
            sql`INSERT INTO ${sql.identifier(schema)}.${sql.identifier(name)} SELECT * FROM public.${sql.identifier(name)}`,
          )
          pending.delete(name)
        }
      }
    })
    return target
  } finally {
    await database.close()
    await admin.close()
  }
}

// Only clone a loopback development database. No backup restore, production access or cleanup.
main(async () => {
  const source = new URL(databaseUrl())
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname))
    throw new Error('Isolation runner requires a loopback development database')
  const restore = new URL(process.env.RESTORE_DATABASE_URL ?? '')
  assertRestoreTarget(source.toString(), restore.toString())
  const suffix = randomBytes(5).toString('hex')
  const legacy = process.env.LOCALIZATION_LEGACY_RELEASE ?? (await legacyRuntime(suffix))
  const testName = `f1_loc_test_${suffix}`,
    smokeName = `f1_loc_smoke_${suffix}`
  // Existing low-privilege development role can create schemas, not databases.
  // Apply the unchanged migrations only inside two fresh, named local schemas.
  const testUrl = await cloneSchema(source, testName)
  const smokeUrl = await cloneSchema(restore, smokeName)
  await mkdir('local-private/localization', { recursive: true })
  await writeFile(
    'local-private/localization/test-targets.json',
    JSON.stringify({ testName, smokeName }, null, 2),
  )
  console.info(JSON.stringify({ testName, smokeName, productionMutation: false }))
  const cli = process.env.npm_execpath
  if (!cli) throw new Error('Run through pnpm')
  const baselineKind = process.argv.includes('--baseline-default')
    ? 'default'
    : process.argv.includes('--baseline-visual')
      ? 'visual'
      : null
  const args = baselineKind
    ? [
        'exec',
        'playwright',
        'test',
        'tests/e2e/p3.2-c.spec.ts',
        'tests/e2e/visual.spec.ts',
        'tests/e2e/daily-display.spec.ts',
        ...(baselineKind === 'visual' ? ['--config', 'playwright.p4b-visual.config.ts'] : []),
        '--update-snapshots=changed',
      ]
    : process.argv.includes('--matching')
      ? [
          'exec',
          'vitest',
          'run',
          'tests/game-rules/matching-database.spec.ts',
          'tests/game-rules/match-policy.spec.ts',
          'tests/game-rules/localization-compatibility.spec.ts',
        ]
      : process.argv.includes('--matching-e2e')
        ? [
            'exec',
            'playwright',
            'test',
            'tests/e2e/matching.spec.ts',
            'tests/e2e/daily-entry.spec.ts',
            'tests/e2e/daily.spec.ts',
            'tests/e2e/daily-display.spec.ts',
          ]
        : process.argv.includes('--daily')
          ? [
              'exec',
              'vitest',
              'run',
              'tests/game-rules/daily.spec.ts',
              'tests/game-rules/daily-database.spec.ts',
              'tests/game-rules/localization-compatibility.spec.ts',
              'tests/game-rules/production.spec.ts',
            ]
          : process.argv.includes('--daily-e2e')
            ? ['exec', 'playwright', 'test', 'tests/e2e/daily.spec.ts']
            : process.argv.includes('--targeted')
              ? [
                  'exec',
                  'vitest',
                  'run',
                  'tests/game-rules/localization.spec.ts',
                  'apps/web/src/services/localization.spec.ts',
                  'tests/game-rules/localization-database.spec.ts',
                  'tests/game-rules/localization-compatibility.spec.ts',
                ]
              : ['verify:full', '--refresh']
  execFileSync(
    /\.exe$/i.test(cli) ? cli : process.execPath,
    /\.exe$/i.test(cli) ? args : [cli, ...args],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        LOCALIZATION_LEGACY_RELEASE: legacy,
        DATABASE_URL: testUrl.toString(),
        TEST_DATABASE_URL: testUrl.toString(),
        RESTORE_DATABASE_URL: smokeUrl.toString(),
        E2E_WEB_PORT: '5273',
        E2E_API_PORT: '3107',
        DAILY_CHALLENGE_ENABLED: process.argv.some(
          (arg) => arg.startsWith('--daily') || arg.startsWith('--matching'),
        )
          ? 'true'
          : (process.env.DAILY_CHALLENGE_ENABLED ?? 'false'),
        MATCHMAKING_ENABLED: process.argv.some((arg) => arg.startsWith('--matching'))
          ? 'true'
          : (process.env.MATCHMAKING_ENABLED ?? 'false'),
        ...(process.argv.some((arg) => arg.startsWith('--matching'))
          ? { MATCH_TEST_DATABASE_URL: testUrl.toString() }
          : {}),
      },
    },
  )
})
