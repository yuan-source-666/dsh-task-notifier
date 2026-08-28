// Fire one real system notification through the plugin's own delivery code.
// Use it to check the desktop channel without starting the harness:
//
//   pnpm run test:notify                    # Chinese success toast
//   pnpm run test:notify -- --failure       # the failure title
//   pnpm run test:notify -- --locale=en --title=DSH --body='hello there'
//
// Exits non-zero when no channel could deliver, and prints which one won.
import { deliver } from '../lib/notifier.js'

const args = process.argv.slice(2)
function flag(name) {
  return args.includes('--' + name)
}
function value(name, fallback) {
  const prefix = '--' + name + '='
  const hit = args.find((arg) => arg.startsWith(prefix))
  return hit === undefined ? fallback : hit.slice(prefix.length)
}

const locale = value('locale', 'zh')
const failure = flag('failure')
const title = value('title', failure
  ? (locale === 'en' ? 'DSH task did not finish cleanly' : 'DSH 任务未正常结束')
  : (locale === 'en' ? 'DSH task completed' : 'DSH 任务完成'))
const body = value('body', locale === 'en'
  ? 'Chat task: verify that desktop notifications arrive'
  : '对话任务：验证系统通知是否可以弹出')
const sound = value('sound', 'true') !== 'false'

const result = await deliver({
  appName: value('app', 'DeepSeek Harness'),
  command: [],
  powershellProgram: value('powershell', ''),
  timeoutMs: Number(value('timeout', '15000')),
  log: {
    info: (message, fields) => console.log('[info]', message, fields ?? ''),
    warn: (message, fields) => console.log('[warn]', message, fields ?? ''),
    debug: (message, fields) => console.log('[debug]', message, fields ?? ''),
  },
}, { title, body, sound })

console.log(JSON.stringify(result))
process.exit(result.ok ? 0 : 1)
