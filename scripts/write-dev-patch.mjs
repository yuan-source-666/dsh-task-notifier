// Point load.dev.patch.yml's plugin entry at this checkout, then print the
// command to run from the deepseek-harness repo root. Run it once after
// cloning; the shipped layer carries a '<PATH-TO>' placeholder because a
// patch row needs an absolute specifier and a machine-specific path would
// be wrong for everyone else.
//
//   node scripts/write-dev-patch.mjs          # rewrite the entry
//   node scripts/write-dev-patch.mjs --check  # report only; exit 1 if unset
//
// The entry is rewritten as a file:// URL from pathToFileURL, which is the
// only absolute form Node's ESM loader accepts on Windows ('file:///E:/..'),
// and is correct on Linux and macOS too. The printed --patch argument stays
// a native path, because that argument is read by the dsh CLI, not imported.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const layer = join(root, 'load.dev.patch.yml')
const entry = join(root, 'src', 'index.ts')
const text = readFileSync(layer, 'utf8')

// Only the row matters: the header comments mention the placeholder on purpose.
const row = (text.match(/^\s*name: '(.*)'$/mu) ?? ['', ''])[1]
const filled = row.length > 0 && !row.includes('<PATH-TO>')

if (process.argv.includes('--check')) {
  console.log(filled ? 'load.dev.patch.yml already points at: ' + row : 'load.dev.patch.yml still holds <PATH-TO>')
  process.exit(filled ? 0 : 1)
}

const url = pathToFileURL(entry).href
if (filled && row === url) {
  console.log('already machine-local: ' + row)
} else if (/^\s*name: '.*'$/mu.test(text)) {
  writeFileSync(layer, text.replace(/^(\s*)name: '.*'$/mu, (_all, indent) => indent + "name: '" + url + "'"), 'utf8')
  console.log((filled ? 're-pointed' : 'rewrote') + ' load.dev.patch.yml -> ' + url)
} else {
  console.error('load.dev.patch.yml has no name row to rewrite')
  process.exit(1)
}

console.log('')
console.log('from the deepseek-harness repo root:')
console.log('  pnpm dsh web --patch "' + layer + '"')
