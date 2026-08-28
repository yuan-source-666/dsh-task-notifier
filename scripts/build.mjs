// Build helper for dsh-task-notifier: compiles src/ to lib/ with whatever
// TypeScript is reachable, and never assumes a sibling monorepo checkout.
//
// Why not just "tsc -p .": a git-installed DSH bundle runs this from
// "prepare" with only production dependencies present, so typescript may be
// missing. In that case a tarball that already ships lib/ is complete and the
// build must be a no-op, while a source-only checkout must fail with an
// instruction rather than a stack trace.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromHere = createRequire(import.meta.url)
const noEmit = process.argv.includes('--noEmit')

/** Resolve a usable tsc entry point, or undefined when none is installed. */
function resolveTsc() {
  const local = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  if (existsSync(local)) return local
  try {
    return requireFromHere.resolve('typescript/bin/tsc')
  } catch {
    return undefined
  }
}

const tsc = resolveTsc()
if (tsc === undefined) {
  if (existsSync(join(root, 'lib', 'index.js'))) {
    console.log('[dsh-task-notifier] typescript is not installed and lib/ is already built - nothing to do')
    process.exit(0)
  }
  console.error([
    '[dsh-task-notifier] TypeScript is not installed and no prebuilt lib/ exists.',
    '  Fix with one of:',
    '    npm install            # or: pnpm install  (installs the dev dependency)',
    '    pnpm add -D typescript',
    '  or skip the build entirely by installing a packed tarball:',
    '    dsh plugin add ./dsh-task-notifier-<version>.tgz',
    '  or by loading the TypeScript source through a dev overlay patch.',
  ].join('\n'))
  process.exit(1)
}

const args = noEmit ? ['-p', 'tsconfig.json', '--noEmit'] : ['-p', 'tsconfig.json']
const result = spawnSync(process.execPath, [tsc, ...args], { cwd: root, stdio: 'inherit' })
if (result.status !== 0) {
  console.error('[dsh-task-notifier] TypeScript reported problems (exit ' + String(result.status) + ')')
  process.exit(result.status ?? 1)
}
console.log('[dsh-task-notifier] ' + (noEmit ? 'typecheck clean' : 'built lib/ from src/'))

