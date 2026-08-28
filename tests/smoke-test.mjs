/**
 * Runtime smoke test for the built dsh-task-notifier plugin.
 *
 * Boots lib/index.js against a stub ctx (recording listeners, an optional
 * service map, and every log line), drives the real DSH event shapes through
 * it, and asserts what the desktop was asked to show. Delivery goes through
 * the Config.command override into scripts/notify-sink.mjs, so the whole test
 * runs identically on Windows, macOS and Linux with no notifier installed.
 *
 * No harness, no API key, no network.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
const sink = fileURLToPath(new URL('../scripts/notify-sink.mjs', import.meta.url))
const workspace = mkdtempSync(join(tmpdir(), 'dsh-task-notifier-'))

let counter = 0
const results = []
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => results.push(['ok', name]),
    (error) => results.push(['FAIL', name, error && error.message ? error.message : String(error)]),
  )
}

/** Stub ctx: listener registry, optional-service map, and log capture. */
function makeCtx() {
  const listeners = new Map()
  const services = new Map()
  const logs = []
  const ctx = {
    listeners,
    services,
    logs,
    logger: () => ({
      info: (message, fields) => logs.push(['info', message, fields]),
      warn: (message, fields) => logs.push(['warn', message, fields]),
      debug: (message, fields) => logs.push(['debug', message, fields]),
      error: (message, fields) => logs.push(['error', message, fields]),
    }),
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => true
    },
    off(name, listener) {
      const list = listeners.get(name) || []
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    },
    emit(name, payload) {
      for (const listener of [...(listeners.get(name) || [])]) listener(payload)
    },
    get(key) {
      return services.get(key)
    },
    set(key, value) {
      services.set(key, value)
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    /** Invoke every listener of one event, as Cordis dispatch does. */
    dispatch(name, ...args) {
      for (const listener of [...(listeners.get(name) || [])]) listener(...args)
    },
  }
  return ctx
}

/** Config resolved through the plugin's own schema, so defaults are covered. */
function config(overrides) {
  const file = join(workspace, 'sink-' + ++counter + '.jsonl')
  const base = { command: [process.execPath, sink, file], dedupeMs: 2000, timeoutMs: 15000 }
  return { resolved: plugin.Config({ ...base, ...overrides }), file }
}

/** Notifications the sink recorded for one config. */
function delivered(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** Poll until the sink file holds the expected number of deliveries. */
async function untilDelivered(file, count, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = delivered(file)
    if (rows.length >= count) return rows
    if (Date.now() > deadline) {
      assert.fail('expected ' + count + ' notification(s), got ' + rows.length + ': ' + JSON.stringify(rows))
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** A session stub shaped like dsh-session: id, header, and a folded log. */
function session(id, events, header) {
  return { id, header: header || {}, events: events || [] }
}

/** One logged human prompt event. */
function humanPrompt(text) {
  return { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text }] } } }
}

/** Close a turn in the log. */
function turnEnd(turn, kind) {
  return { type: 'turn/end', data: { turn, reason: kind === undefined ? { kind: 'completed' } : { kind } } }
}

// ---------------------------------------------------------------- schema

await check('config defaults resolve from the schema', () => {
  const { resolved } = config({})
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.locale, 'zh')
  assert.equal(resolved.title, '', 'an empty title follows the locale')
  assert.equal(resolved.failureTitle, '')
  assert.equal(resolved.bodyTemplate, '', 'an empty template follows the locale')
  assert.equal(resolved.taskNameChars, 120)
  assert.equal(resolved.onTurnEnd, true)
  assert.equal(resolved.onSubagentEnd, true)
  assert.equal(resolved.onJobDone, true)
  assert.equal(resolved.onGoalComplete, true)
  assert.equal(resolved.onWorkflowEnd, true)
  assert.equal(resolved.onlySuccess, false)
  assert.equal(resolved.includeChildSessions, false)
  assert.equal(resolved.appName, 'DeepSeek Harness')
  assert.equal(resolved.command[0], process.execPath)
})

// ---------------------------------------------------------------- turn

await check('an answered turn notifies with the session title', async () => {
  const { resolved, file } = config({})
  const ctx = makeCtx()
  ctx.set('sessionTitle', { get: () => ({ title: '修复登录接口 500 报错' }) })
  plugin.apply(ctx, resolved)
  ctx.dispatch('session/event', session('s-1', [humanPrompt('帮我看看登录')]), turnEnd(1))
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].title, 'DSH 任务完成')
  assert.equal(rows[0].body, '对话任务：修复登录接口 500 报错')
})

await check('without a title service the last human prompt names the task', async () => {
  const { resolved, file } = config({})
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('session/event', session('s-2', [
    humanPrompt('第一条指令'),
    { type: 'user/message', data: { source: { kind: 'agent.inject' }, message: { content: [{ type: 'text', text: '注入的上下文' }] } } },
    humanPrompt('请把 README 翻译成英文'),
  ]), turnEnd(3))
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].body, '对话任务：请把 README 翻译成英文')
})

await check('a failed turn uses the failure title', async () => {
  const { resolved, file } = config({ failureTitle: 'DSH 任务失败' })
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('session/event', session('s-3', [humanPrompt('跑一下测试')]), turnEnd(2, 'error'))
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].title, 'DSH 任务失败')
  assert.equal(rows[0].body, '对话任务：跑一下测试')
})

await check('repaired turns and child sessions stay quiet', async () => {
  const { resolved, file } = config({})
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('session/event', session('s-4', []), turnEnd(1, 'interrupted'))
  ctx.dispatch('session/event', session('s-5', [], { parentSession: 's-1' }), turnEnd(1))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(delivered(file), [])
})

await check('includeChildSessions lets a subagent turn through', async () => {
  const { resolved, file } = config({ includeChildSessions: true })
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('session/event', session('s-6', [humanPrompt('审计 src 目录')], { parentSession: 's-1' }), turnEnd(1))
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].body, '对话任务：审计 src 目录')
})

await check('dedupeMs collapses a repeated report of the same turn', async () => {
  const { resolved, file } = config({ dedupeMs: 4000 })
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  const target = session('s-7', [humanPrompt('同一个任务')])
  ctx.dispatch('session/event', target, turnEnd(1))
  ctx.dispatch('session/event', target, turnEnd(1))
  const rows = await untilDelivered(file, 1)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(delivered(file).length, 1)
  assert.equal(rows[0].body, '对话任务：同一个任务')
})

await check('onlySuccess mutes the error outcome', async () => {
  const { resolved, file } = config({ onlySuccess: true })
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('session/event', session('s-8', [humanPrompt('会失败的任务')]), turnEnd(1, 'error'))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(delivered(file), [])
  ctx.dispatch('session/event', session('s-9', [humanPrompt('会成功的任务')]), turnEnd(1))
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].body, '对话任务：会成功的任务')
})

// ---------------------------------------------------------------- subagent

await check('a finished subagent run names its own session', async () => {
  const { resolved, file } = config({})
  const ctx = makeCtx()
  const children = new Map([['child-1', session('child-1', [humanPrompt('梳理 packages 依赖关系')])]])
  ctx.set('sessions', { get: (id) => children.get(id) })
  plugin.apply(ctx, resolved)
  ctx.dispatch('subagent/end', { runId: 'run-1', provider: 'in-process', id: 'child-1', stopReason: 'completed' })
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].title, 'DSH 任务完成')
  assert.equal(rows[0].body, '子任务：梳理 packages 依赖关系')
})

await check('an aborted subagent reports the cancelled outcome', async () => {
  const { resolved, file } = config({ bodyTemplate: '{kind} {ref} -> {outcome}' })
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('subagent/end', { runId: 'run-2', provider: 'acp', id: 'child-9', stopReason: 'aborted' })
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].title, 'DSH 任务未正常结束')
  assert.equal(rows[0].body, '子任务 child-9 -> 已取消')
})

// ---------------------------------------------------------------- jobs

await check('a settled background job notifies with its label', async () => {
  const { resolved, file } = config({})
  const ctx = makeCtx()
  let listener
  ctx.set('jobs', { onJobDone: (fn) => { listener = fn; return () => {} } })
  plugin.apply(ctx, resolved)
  assert.equal(typeof listener, 'function', 'the job source must subscribe')
  listener({ id: 'bash-7', kind: 'bash', label: 'pnpm test', status: 'completed', ownerSession: 's-1' }, undefined)
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].body, '后台任务：pnpm test')
})

await check('a killed job reports the cancelled outcome in English', async () => {
  const { resolved, file } = config({ locale: 'en' })
  const ctx = makeCtx()
  let listener
  ctx.set('jobs', { onJobDone: (fn) => { listener = fn; return () => {} } })
  plugin.apply(ctx, resolved)
  listener({ id: 'subagent-3', kind: 'subagent', label: 'audit deps', status: 'killed' }, undefined)
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].title, 'DSH task did not finish cleanly')
  assert.equal(rows[0].body, 'Background job: audit deps')
})

await check('a composition without the jobs service degrades quietly', () => {
  const { resolved } = config({})
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  assert.ok(ctx.logs.some((entry) => String(entry[1]).includes('job source skipped')), 'expected a skip notice')
})

// ---------------------------------------------------------------- goal / workflow

await check('a completed goal notifies with its objective', async () => {
  const { resolved, file } = config({})
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('goal/changed', {
    agent: { session: session('s-10', []) },
    change: { operation: 'complete', ref: { id: 'goal-1', revision: 4 }, goal: { objective: '把插件文档补全并跑通测试', updatedAt: 1 } },
  })
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].body, '目标：把插件文档补全并跑通测试')
})

await check('intermediate goal edits are not completions', async () => {
  const { resolved, file } = config({})
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('goal/changed', { agent: { session: session('s-11', []) }, change: { operation: 'edit', ref: {}, goal: { objective: 'x', updatedAt: 2 } } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(delivered(file), [])
})

await check('a blocked goal uses the failure title', async () => {
  const { resolved, file } = config({})
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('goal/changed', { agent: { session: session('s-12', []) }, change: { operation: 'block', ref: {}, goal: { objective: '等待外部接口', updatedAt: 3 } } })
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].title, 'DSH 任务未正常结束')
  assert.equal(rows[0].body, '目标：等待外部接口')
})

await check('a settled workflow run notifies once', async () => {
  const { resolved, file } = config({})
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('workflow/end', { id: 'wf-1', meta: { name: 'audit-tree', description: '全仓依赖审计' } }, { stopReason: 'completed', agentsStarted: 12 })
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].body, '工作流：全仓依赖审计')
})

// ---------------------------------------------------------------- switches, wording

await check('enabled false registers nothing', () => {
  const { resolved } = config({ enabled: false })
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  assert.equal(ctx.listeners.size, 0)
  assert.ok(ctx.logs.some((entry) => String(entry[1]).includes('disabled by configuration')))
})

await check('a single source switch mutes the others', async () => {
  const { resolved, file } = config({ onSubagentEnd: false, onJobDone: false, onGoalComplete: false, onWorkflowEnd: false })
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('subagent/end', { runId: 'r', provider: 'p', id: 'c', stopReason: 'completed' })
  ctx.dispatch('workflow/end', { id: 'w', meta: { name: 'n' } }, { stopReason: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(delivered(file), [])
  ctx.dispatch('session/event', session('s-13', [humanPrompt('只开轮次来源')]), turnEnd(1))
  await untilDelivered(file, 1)
})

await check('long task names fold onto one capped line', async () => {
  const { resolved, file } = config({ taskNameChars: 20 })
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  const long = '重构\n' + 'x'.repeat(200) + '\t结尾\n换行'
  ctx.dispatch('session/event', session('s-14', [humanPrompt(long)]), turnEnd(1))
  const rows = await untilDelivered(file, 1)
  const body = rows[0].body
  assert.ok(!body.includes('\n'), 'body must stay single-line: ' + body)
  assert.ok(body.length <= '对话任务：'.length + 20, 'body must respect the cap: ' + body.length)
  assert.ok(body.endsWith('…'), 'truncation must be visible: ' + body)
})

await check('task text with shell and replacement metacharacters survives', async () => {
  const file = join(workspace, 'sink-' + ++counter + '.jsonl')
  const resolved = plugin.Config({ command: [process.execPath, sink, file, '--body={body}', '--title={title}'], dedupeMs: 2000, timeoutMs: 15000 })
  const ctx = makeCtx()
  const tricky = '修好 $& 与 引号 、$(rm -rf) 与 rm * 的解析'
  plugin.apply(ctx, resolved)
  ctx.set('sessionTitle', { get: () => ({ title: tricky }) })
  ctx.dispatch('session/event', session('s-15', []), turnEnd(1))
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].body, '对话任务：' + tricky)
  assert.equal(rows[0].title, 'DSH 任务完成')
})

await check('an explicit title wins over the locale default', async () => {
  const { resolved, file } = config({ locale: 'en', title: '任务完成 ✅' })
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('session/event', session('s-20', [humanPrompt('显式标题')]), turnEnd(1))
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].title, '任务完成 ✅')
  assert.equal(rows[0].body, 'Chat task: 显式标题')
})

await check('unknown template placeholders stay visible', async () => {
  const { resolved, file } = config({ bodyTemplate: '{nope} {task}' })
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('session/event', session('s-16', [humanPrompt('占位符')]), turnEnd(1))
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].body, '{nope} 占位符')
})

// ---------------------------------------------------------------- failure handling

await check('a broken delivery command warns instead of throwing', async () => {
  const file = join(workspace, 'unused-' + ++counter + '.jsonl')
  const resolved = plugin.Config({ command: ['definitely-not-an-installed-program-xyz', file], dedupeMs: 2000, timeoutMs: 3000 })
  const ctx = makeCtx()
  plugin.apply(ctx, resolved)
  ctx.dispatch('session/event', session('s-17', [humanPrompt('投递会失败')]), turnEnd(1))
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (ctx.logs.some((entry) => entry[0] === 'warn' && String(entry[1]).includes('could not deliver'))) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(ctx.logs.some((entry) => entry[0] === 'warn' && String(entry[1]).includes('could not deliver')),
    'expected a delivery warning, got ' + JSON.stringify(ctx.logs))
})

await check('a throwing title service falls back to the log', async () => {
  const { resolved, file } = config({})
  const ctx = makeCtx()
  ctx.set('sessionTitle', { get: () => { throw new Error('session disposed') } })
  plugin.apply(ctx, resolved)
  ctx.dispatch('session/event', session('s-18', [humanPrompt('标题服务不可用')]), turnEnd(1))
  const rows = await untilDelivered(file, 1)
  assert.equal(rows[0].body, '对话任务：标题服务不可用')
})

await check('the plugin republishes each completion on its own event', async () => {
  const { resolved, file } = config({})
  const ctx = makeCtx()
  const seen = []
  ctx.on('task-notifier/completed', (payload) => seen.push(payload))
  plugin.apply(ctx, resolved)
  ctx.dispatch('session/event', session('s-19', [humanPrompt('转发给其他插件')]), turnEnd(1))
  await untilDelivered(file, 1)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].completion.kind, 'turn')
  assert.equal(seen[0].title, 'DSH 任务完成')
  assert.equal(seen[0].body, '对话任务：转发给其他插件')
})

appendFileSync(join(workspace, 'README.txt'), 'dsh-task-notifier smoke test output\n')

const failed = results.filter((row) => row[0] === 'FAIL')
for (const row of results) console.log(row[0] === 'ok' ? '  ok  ' : ' FAIL ', row[1], row[2] ? '\n        ' + row[2] : '')
console.log('')
console.log((results.length - failed.length) + '/' + results.length + ' checks passed (fixtures: ' + workspace + ')')
process.exit(failed.length === 0 ? 0 : 1)
