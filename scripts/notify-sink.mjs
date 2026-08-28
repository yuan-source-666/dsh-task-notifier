// Captures one delivery attempt as a JSON line so the smoke test can assert
// on what the plugin actually spawned. Used as the Config.command override:
//   [process.execPath, notify-sink.mjs, <outFile>]  (title and body are
// appended by the notifier as the last two arguments).
import { appendFileSync } from 'node:fs'

const [, , file, ...rest] = process.argv
if (!file) {
  console.error('notify-sink: missing output file argument')
  process.exit(1)
}

// Placeholder mode (--title=... / --body=...) and append mode both land here.
const fields = {}
const positional = []
for (const arg of rest) {
  if (arg.startsWith('--title=')) fields.title = arg.slice('--title='.length)
  else if (arg.startsWith('--body=')) fields.body = arg.slice('--body='.length)
  else positional.push(arg)
}
if (fields.title === undefined && positional.length > 0) fields.title = positional.shift()
if (fields.body === undefined && positional.length > 0) fields.body = positional.shift()
fields.argv = rest

appendFileSync(file, JSON.stringify(fields) + '\n')
