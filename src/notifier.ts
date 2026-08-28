/**
 * Best-effort operating-system notification delivery.
 *
 * One entry point, notify(), turns a title and a body into a real notification
 * on the machine that runs the harness: a Windows toast (with a balloon-tip
 * fallback), a freedesktop notification (notify-send, then zenity, then
 * kdialog), or a macOS notification through osascript. Every channel is tried
 * in order, each failure is logged at debug level, and nothing is ever thrown
 * at the caller - a missing notifier must never turn into a failed agent turn.
 *
 * Text reaches the OS through arguments only, never through a shell string, so
 * a task name containing quotes, backticks or dollar signs cannot execute
 * anything. The PowerShell scripts are handed over base64-encoded as UTF-16LE
 * (-EncodedCommand), which removes shell quoting from the picture entirely.
 *
 * @module dsh-task-notifier/notifier
 */

import { spawn } from 'node:child_process'
import { platform } from 'node:os'

/** One notification to show. */
export interface NotificationPayload {
  readonly title: string
  readonly body: string
  readonly sound: boolean
}

/** Outcome of one delivery attempt chain. */
export interface DeliveryResult {
  readonly ok: boolean
  /** Which channel reported success, or the last channel tried. */
  readonly channel: string
  /** Short failure or exit detail for the logs. */
  readonly detail: string
}

/** Diagnostic surface, satisfied by ctx.logger(name). */
export interface NotifierLog {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  debug?(message: string, fields?: Record<string, unknown>): void
}

/** How to reach the desktop. Every field comes from plugin configuration. */
export interface NotifierOptions {
  /** App / notifier identity shown by the desktop where the channel supports it. */
  readonly appName: string
  /**
   * Optional external program: argv where the first entry is the executable.
   * {title} and {body} placeholders are replaced; when absent, both strings are
   * appended as the last two arguments. Overrides the built-in channels.
   */
  readonly command: readonly string[]
  /** PowerShell executable to use on Windows; empty selects the built-in order. */
  readonly powershellProgram: string
  /** Per-process kill timer in milliseconds. */
  readonly timeoutMs: number
  readonly log: NotifierLog
}

interface RunResult {
  readonly ok: boolean
  readonly detail: string
}

/** Escape text for inclusion in XML character data or attributes. */
function escapeXml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }
  return text.replace(/[&<>"']/g, (ch) => map[ch] as string)
}

/** Quote a string as a PowerShell literal (single quotes double inside). */
function psLiteral(text: string): string {
  return "'" + text.replace(/'/g, "''") + "'"
}

/** Encode a PowerShell script the way -EncodedCommand expects it. */
function encodeScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Run one program without ever routing its output through a pipe.
 *
 * stdio is ignored on purpose: the notifier does not need the child's output,
 * and a harness process that itself runs under a sandbox can still spawn
 * detached helpers when it does not capture their stdio.
 *
 * @param program - executable to spawn.
 * @param args - argument vector.
 * @param timeoutMs - kill the child when it outlives this budget.
 * @returns whether the child exited zero.
 */
function run(program: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(program, [...args], { stdio: 'ignore', windowsHide: true, shell: false })
    } catch (error) {
      resolve({ ok: false, detail: (error as Error).message })
      return
    }
    let settled = false
    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // A child that cannot be killed is already gone; the timeout still wins.
      }
      finish({ ok: false, detail: 'timed out after ' + timeoutMs + 'ms' })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.once('error', (error: Error) => finish({ ok: false, detail: error.message }))
    child.once('close', (code: number | null) => {
      finish({ ok: code === 0, detail: code === 0 ? 'exit 0' : 'exit ' + String(code) })
    })
  })
}

/** Windows toast XML for one message. */
function toastXml(payload: NotificationPayload): string {
  const audio = payload.sound
    ? '<audio src="ms-winsoundevent:Notification.Default" />'
    : '<audio silent="true" />'
  return '<toast duration="short"><visual><binding template="ToastGeneric">'
    + '<text>' + escapeXml(payload.title) + '</text>'
    + '<text>' + escapeXml(payload.body) + '</text>'
    + '</binding></visual>' + audio + '</toast>'
}

/** PowerShell that raises a WinRT toast, exiting non-zero when unsupported. */
function toastScript(payload: NotificationPayload, appName: string): string {
  return '$ErrorActionPreference = \'Stop\'\n'
    + 'try {\n'
    + '  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]\n'
    + '  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]\n'
    + '  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument\n'
    + '  $xml.LoadXml(' + psLiteral(toastXml(payload)) + ')\n'
    + '  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(' + psLiteral(appName) + ')\n'
    + '  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml\n'
    + '  $notifier.Show($toast)\n'
    + '  exit 0\n'
    + '} catch {\n'
    + '  exit 1\n'
    + '}\n'
}

/** PowerShell that raises a legacy tray balloon tip. */
function balloonScript(payload: NotificationPayload): string {
  const sound = payload.sound
    ? '  try { [console]::beep(880, 180) } catch { }\n'
    : ''
  return '$ErrorActionPreference = \'Stop\'\n'
    + 'try {\n'
    + '  Add-Type -AssemblyName System.Windows.Forms\n'
    + '  Add-Type -AssemblyName System.Drawing\n'
    + sound
    + '  $icon = New-Object System.Windows.Forms.NotifyIcon\n'
    + '  $icon.Icon = [System.Drawing.SystemIcons]::Information\n'
    + '  $icon.BalloonTipTitle = ' + psLiteral(payload.title) + '\n'
    + '  $icon.BalloonTipText = ' + psLiteral(payload.body) + '\n'
    + '  $icon.Visible = $true\n'
    + '  $icon.ShowBalloonTip(8000)\n'
    + '  Start-Sleep -Milliseconds 3000\n'
    + '  $icon.Visible = $false\n'
    + '  $icon.Dispose()\n'
    + '  exit 0\n'
    + '} catch {\n'
    + '  exit 1\n'
    + '}\n'
}

/** Windows PowerShell first: it always carries the WinRT and WinForms types. */
function windowsCandidates(powershellProgram: string): string[] {
  const custom = powershellProgram.trim()
  if (custom.length > 0) return [custom]
  return ['powershell.exe', 'pwsh.exe']
}

/** Best-effort sound on desktop Linux; a missing paplay is not an error. */
async function playLinuxSound(timeoutMs: number): Promise<void> {
  await run('paplay', ['/usr/share/sounds/freedesktop/stereo/complete.oga'], timeoutMs)
}

/**
 * Deliver one notification through the operating system.
 *
 * @param options - delivery configuration.
 * @param payload - the message to show.
 * @returns the winning channel, or the last one that was tried.
 */
export async function deliver(options: NotifierOptions, payload: NotificationPayload): Promise<DeliveryResult> {
  const os = platform()
  const attempts: Array<{ channel: string; task: () => Promise<RunResult> }> = []

  if (options.command.length > 0) {
    const [program, ...rest] = options.command
    const usesPlaceholders = rest.some((arg) => arg.includes('{title}') || arg.includes('{body}'))
    const args = (usesPlaceholders
      // A function replacer keeps a '$&' inside a task name verbatim.
      ? rest.map((arg) => arg.replace(/\{title\}/g, () => payload.title).replace(/\{body\}/g, () => payload.body))
      : [...rest, payload.title, payload.body])
    attempts.push({
      channel: 'command:' + String(program),
      task: () => run(String(program), args, options.timeoutMs),
    })
  } else if (os === 'win32') {
    for (const program of windowsCandidates(options.powershellProgram)) {
      attempts.push({
        channel: program + ' + toast',
        task: () => run(program, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
          '-EncodedCommand', encodeScript(toastScript(payload, options.appName))], options.timeoutMs),
      })
      attempts.push({
        channel: program + ' + balloon',
        task: () => run(program, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
          encodeScript(balloonScript(payload))], options.timeoutMs),
      })
    }
  } else if (os === 'darwin') {
    attempts.push({
      channel: 'osascript',
      task: () => run('osascript', [
        '-e', 'on run argv',
        '-e', 'display notification (item 1 of argv) with title (item 2 of argv) sound name (item 3 of argv)',
        '-e', 'end run',
        payload.body,
        payload.title,
        payload.sound ? 'Glass' : '',
      ], options.timeoutMs),
    })
  } else {
    attempts.push({
      channel: 'notify-send',
      task: async () => {
        const result = await run('notify-send', [
          '--app-name=' + options.appName,
          '--urgency=normal',
          '--expire-time=8000',
          payload.title,
          payload.body,
        ], options.timeoutMs)
        if (result.ok && payload.sound) await playLinuxSound(options.timeoutMs)
        return result
      },
    })
    attempts.push({
      channel: 'zenity',
      task: () => run('zenity', ['--notification', '--text=' + payload.title + '\n' + payload.body], options.timeoutMs),
    })
    attempts.push({
      channel: 'kdialog',
      task: async () => {
        const result = await run('kdialog', ['--title', payload.title, '--passivepopup', payload.body, '8'], options.timeoutMs)
        if (result.ok && payload.sound) await playLinuxSound(options.timeoutMs)
        return result
      },
    })
  }

  let last: DeliveryResult = { ok: false, channel: 'none', detail: 'no channel available on ' + os }
  for (const attempt of attempts) {
    let result: RunResult
    try {
      result = await attempt.task()
    } catch (error) {
      result = { ok: false, detail: (error as Error).message }
    }
    last = { ok: result.ok, channel: attempt.channel, detail: result.detail }
    if (result.ok) return last
    options.log.debug?.('notification channel failed', { channel: attempt.channel, detail: result.detail })
  }
  return last
}

/**
 * Build a notifier bound to one configuration and logger.
 *
 * @param options - delivery configuration.
 * @returns a function that shows one notification and never throws.
 */
export function createNotifier(options: NotifierOptions): (payload: NotificationPayload) => Promise<DeliveryResult> {
  return async (payload: NotificationPayload): Promise<DeliveryResult> => {
    try {
      const result = await deliver(options, payload)
      if (!result.ok) {
        options.log.warn('could not deliver a system notification', {
          channel: result.channel, detail: result.detail, title: payload.title,
        })
      }
      return result
    } catch (error) {
      // Defensive: delivery is already total, but a notifier must never be the
      // reason a completion path rejects.
      options.log.warn('notification delivery threw', { error: String(error) })
      return { ok: false, channel: 'error', detail: String(error) }
    }
  }
}
