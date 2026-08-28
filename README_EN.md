# dsh-task-notifier

A DeepSeek Harness community plugin (bundle) that **raises an operating-system notification when one of your tasks
finishes**, telling you that *this particular task is done*.

Agents run long jobs in the background, and by the time you look at the window the answer has been sitting there for
minutes. This plugin lifts DSH's internal "a task ended" signals out of the harness and hands them to the desktop -
a Windows toast, a freedesktop notification, a macOS notification - with the name of the task that finished.

| What finished | Notification title | Notification body |
| --- | --- | --- |
| An answered turn | DSH task completed | Chat task: 修复登录接口 500 报错 |
| A delegated subagent | DSH task completed | Subagent task: audit the packages dependency graph |
| A background job | DSH task completed | Background job: pnpm test |
| A goal marked complete | DSH task completed | Goal: finish the plugin docs and get tests green |
| A workflow run | DSH task completed | Workflow: whole-repo dependency audit |
| Error, cancel, truncation | DSH task did not finish cleanly | Background job: pnpm test |

The task name is the session title when DSH has generated one, otherwise the latest human prompt in that session.

Chinese documentation (config reference, platform channels, troubleshooting): [README.md](./README.md).

## What it observes

Completion takes several shapes in DSH. Each family has its own switch, every one of them is an event listener, and
nothing is polled:

| Switch (default on) | Seam | Success test |
| --- | --- | --- |
| `onTurnEnd` | `turn/end` inside `session/event` | `reason.kind === 'completed'`; `error`, `aborted`, `blocked` and `max-tokens` report a non-success title |
| `onSubagentEnd` | `subagent/end` | `stopReason === 'completed'` |
| `onJobDone` | `ctx.jobs.onJobDone` (`@deepseek-ai/dsh-jobs`) | `status === 'completed'` |
| `onGoalComplete` | `goal/changed` | `complete` and `block` only - `create` / `edit` / `pause` / `resume` are intermediate states |
| `onWorkflowEnd` | `workflow/end` | `stopReason === 'completed'` |

Three noise rules on top:

- **Child sessions are silent by default.** Every turn inside a subagent session also closes with `turn/end`; it only
  notifies when `includeChildSessions: true`. The subagent's own completion is covered by `onSubagentEnd`.
- **Repaired `interrupted` turns never notify.** That record is written by the persistence backend when it closes a
  crash-orphaned turn on reload; it is bookkeeping, not finished work.
- **`dedupeMs` (2 s by default)** collapses a completion reported through several seams at once, and keeps a hot
  replacement of the plugin from double-pinging you.

Delivery is best-effort and total: when every channel fails, one warning line is logged and the agent's turn is
untouched. A machine with no working notifier can never fail a task.

## Install and enable

Run these from the [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) repository root.

### Option 1 - straight from source (recommended first run)

Point the dev layer at your checkout (one command, no hand-editing), then start:

```sh
node scripts/write-dev-patch.mjs   # rewrites load.dev.patch.yml and prints the command
cd /path/to/deepseek-harness
pnpm dsh web --patch "<the load.dev.patch.yml path it printed>"
```

Open `http://127.0.0.1:3080` and ask for something. The moment the agent finishes, the desktop shows
"DSH task completed / Chat task: ...". The terminal logs `watching task completions` and
`system notification shown` from `dsh-task-notifier`.

> **On Windows** an absolute plugin path must be a `file:///C:/...` URL: a bare `C:/...` is rejected by Node's ESM
> loader as an unknown protocol (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). The `file:///` form is valid on every platform,
> which is why the shipped template uses it.

### Option 2 - install as a bundle

```sh
dsh plugin --profile demo add /absolute/path/to/dsh-task-notifier
dsh --profile demo
```

The package declares `dsh.bundle.patch`, so the `id: task-notifier` row joins the composition on install.
`dsh --profile demo --dump-config` shows the applied layer without starting anything. A `github:` install also works
immediately: the repository commits a prebuilt `lib/` on purpose, because DSH git installs receive the source tree
and run no build step, so no TypeScript and no build-script authorization are needed.

### Option 3 - tarball, no build on the target machine

```sh
pnpm run pack
dsh plugin --profile demo add ./dsh-task-notifier-1.0.0.tgz
```

## Configuration

Every field has a working default; the values below are those defaults.

```yaml
- insert:
    - id: task-notifier
      name: dsh-task-notifier
      config:
        enabled: true                # master switch; false registers no listener at all
        locale: 'zh'                 # 'zh' or 'en'; one field drives all generated wording
        title: ''                    # success title; empty follows locale
        failureTitle: ''             # non-success title; empty follows locale
        bodyTemplate: ''             # body template; empty follows locale
        taskNameChars: 120           # characters kept from the task name, then an ellipsis
        onTurnEnd: true
        onSubagentEnd: true
        onJobDone: true
        onGoalComplete: true
        onWorkflowEnd: true
        onlySuccess: false           # true = stay quiet about failures
        includeChildSessions: false  # true = also report turns inside subagent sessions
        sound: true
        dedupeMs: 2000               # dedupe window per completion key
        appName: 'DeepSeek Harness'  # notifier identity shown by the desktop
        powershellProgram: ''        # Windows override; empty tries powershell.exe then pwsh.exe
        command: []                  # custom argv delivery; overrides every built-in channel
        timeoutMs: 15000             # kill a delivery process after this long
```

The body template accepts `{kind}`, `{task}`, `{outcome}` and `{ref}`. An unknown placeholder such as
`{nope}` is left visible in the notification instead of silently disappearing.

`locale` switches the kind and outcome labels, the default titles, and the default template's separator
(`：` versus `: `) together, so English output never comes out half-translated.

### Delivery through your own program

When `command` argv contains `{title}` or `{body}` they are substituted in place; otherwise both strings are
appended as the last two arguments. Nothing goes through a shell, so a task name containing `$&`, quotes, backticks or
`$(...)` stays literal (the smoke test asserts exactly that).

## Channels per platform

| Platform | Tried in order |
| --- | --- |
| Windows | `powershell.exe` + WinRT toast → `powershell.exe` + balloon tip → `pwsh.exe` + toast → `pwsh.exe` + balloon |
| Linux | `notify-send` → `zenity --notification` → `kdialog --passivepopup` (plus a best-effort `paplay` when `sound` is on) |
| macOS | `osascript` `display notification` (Glass sound when `sound` is on) |
| Any | `command` when it is not empty |

PowerShell scripts travel base64-encoded as UTF-16LE (`-EncodedCommand`), so quoting in the task text cannot break the
command. Child processes always use `stdio: 'ignore'`, which keeps the plugin working when the host itself runs under a
sandbox that forbids captured pipes.

## Verify it yourself

```sh
pnpm install
pnpm test              # build + 26 checks against a stub ctx, real spawn into a capture script
pnpm run test:notify   # one genuine notification through the plugin's own delivery code
pnpm run test:notify -- --failure --locale=en
```

## For other plugins

Every recognized completion is republished on the plugin's own event, so another extension can reuse the signal
without re-reading the harness seams:

```ts
ctx.on('task-notifier/completed', ({ completion, title, body }) => {
  // completion: { kind, task, outcome, success, key, ref }
})
```

## Limits

- The notification appears on the machine **running dsh**. With a remote browser you get the server's toast, not your
  laptop's; add a client plugin that subscribes to `task-notifier/completed` if you want in-browser notices.
- Session titles are generated asynchronously (and carry their own byte budget), so a notification may show a shortened
  title, or fall back to the human prompt before a title exists.
- An auto-continuing goal ends one turn per round, so every round notifies. To be pinged only when the goal itself
  finishes, set `onTurnEnd: false` and keep `onGoalComplete: true`.
- The notification text contains the task name (120 characters by default). Set `bodyTemplate: '{kind} {ref}'` or
  lower `taskNameChars` if prompts must not reach the desktop.
- `onJobDone` needs `ctx.jobs` in the composition (for example `dsh-jobs-local`); without it the plugin logs one
  line and skips that source.

## License

MIT

