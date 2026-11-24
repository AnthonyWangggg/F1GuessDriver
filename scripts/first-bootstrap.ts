import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyApproval, migrationBundle } from './lib/first-upgrade.js'

// Review entry only. Actual privileged operations require a separate approved window.
async function review() {
  const args = process.argv.slice(2)
  if (args.length !== 3)
    throw new Error('Usage: tsx scripts/first-bootstrap.ts PLAN SIGNATURE PINNED_PUBLIC_KEY')
  const plan = verifyApproval(
    await readFile(args[0]!),
    await readFile(args[1]!),
    await readFile(args[2]!, 'utf8'),
  )
  const b = await migrationBundle(
    resolve(dirname(fileURLToPath(import.meta.url)), '../packages/database/migrations'),
  )
  if (
    b.journalSha !== plan.migrations.journalSha ||
    b.migrations.some((m, i) => m.hash !== plan.migrations.hashes[i])
  )
    throw new Error('Approved bundle mismatch')
  console.info(
    JSON.stringify(
      {
        contract: plan.contract,
        planId: plan.id,
        status: 'PLAN_VALID_NOT_EXECUTED',
        actions: [
          'Validate exact old SHA/dual manifests/active route and full candidate approval; unknown stops.',
          'Install approved external whole-site 503 gate; verify no-store and drain old Nginx workers/keepalive.',
          'Gracefully stop and persistently mask incompatible slots and all scheduled/external writers; unknown processes stop.',
          'Fence every application login, terminate only approved application connections; wait zero client backends.',
          'Preserve in-flight games/queues/sessions unchanged. Obtain backup/roles/key references and independent recovery receipt after freeze.',
          'Approve/sign exact target, contiguous journal and before/after catalog digests, backup receipt and fresh observer.',
          'Run controlled migration entry once; on failure keep gate/fence, inspect metadata; never auto-restore.',
          'Approve least-privilege grants and complete A/G1/G2/G3 build in both slots; old executable paths remain unavailable.',
          'Behind external gate start both complete runtimes and verify exact manifest/keyset/readiness/full mail/BO3 conditions via authorizeFirstOpen.',
          'Approve Web/API coherent switch and remove external gate only after fresh checks. Observe recovery without rewriting rules.',
        ],
      },
      null,
      2,
    ),
  )
}
void review().catch(() => {
  console.error('BLOCKED: first bootstrap approval/bundle invalid; no action executed')
  process.exitCode = 1
})
