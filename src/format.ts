/**
 * Wording and layout for one completion notification: the task name, the
 * localized kind/outcome labels, and the title/body templates. Pure string
 * work with no I/O, so it is unit-testable without a harness or an OS.
 *
 * @module dsh-task-notifier/format
 */

import type { CompletionKind } from './task-source.ts'

/** Supported label languages. */
export type NotifierLocale = 'zh' | 'en'

interface LocaleLabels {
  /** Display name of each completion source. */
  readonly kind: Record<CompletionKind, string>
  /** Fallback body when a task has no discoverable name. */
  readonly unnamed: string
}

/** Terminal outcomes shared by every source; unknown codes pass through. */
const OUTCOME_LABELS: Record<NotifierLocale, Record<string, string>> = {
  zh: {
    completed: '已完成',
    success: '已完成',
    complete: '已完成',
    error: '执行出错',
    failed: '执行出错',
    aborted: '已取消',
    cancelled: '已取消',
    killed: '已取消',
    interrupted: '被中断',
    blocked: '已阻塞',
    block: '已阻塞',
    refusal: '被拒绝',
    'max-tokens': '输出被截断',
  },
  en: {
    completed: 'completed',
    success: 'succeeded',
    complete: 'completed',
    error: 'failed',
    failed: 'failed',
    aborted: 'cancelled',
    cancelled: 'cancelled',
    killed: 'cancelled',
    interrupted: 'interrupted',
    blocked: 'blocked',
    block: 'blocked',
    refusal: 'refused',
    'max-tokens': 'truncated',
  },
}

const LOCALES: Record<NotifierLocale, LocaleLabels> = {
  zh: {
    kind: {
      turn: '对话任务',
      subagent: '子任务',
      job: '后台任务',
      goal: '目标',
      workflow: '工作流',
    },
    unnamed: '未命名任务',
  },
  en: {
    kind: {
      turn: 'Chat task',
      subagent: 'Subagent task',
      job: 'Background job',
      goal: 'Goal',
      workflow: 'Workflow',
    },
    unnamed: 'untitled task',
  },
}

/** Resolve a locale tag to its label table (anything but 'en' uses Chinese). */
export function labelsFor(locale: string): LocaleLabels {
  return locale === 'en' ? LOCALES.en : LOCALES.zh
}

/**
 * Body templates per locale.
 *
 * The template is configurable, so the schema defaults it to empty and this
 * table fills it in: only the separator between the kind label and the task
 * name is locale-specific (a full-width colon reads wrong after an English
 * label), and one locale field should not need three rewrites.
 */
export const DEFAULT_TEMPLATES: Record<NotifierLocale, string> = {
  zh: '{kind}：{task}',
  en: '{kind}: {task}',
}

/**
 * Resolve the effective body template: a configured template wins, an empty
 * one follows the locale.
 *
 * @param locale - label language.
 * @param configured - bodyTemplate from configuration.
 * @returns the template to render.
 */
export function resolveTemplate(locale: string, configured: string): string {
  const value = (configured ?? '').trim()
  return value.length > 0 ? value : DEFAULT_TEMPLATES[locale === 'en' ? 'en' : 'zh']
}

/** One notification title pair. */
export interface TitlePair {
  readonly success: string
  readonly failure: string
}

/**
 * Title pairs that match each locale's labels.
 *
 * Titles are configurable strings, so the schema defaults them to empty and
 * this table fills them in: an all-English notification needs only the single
 * locale field, never three separate rewrites.
 */
export const DEFAULT_TITLES: Record<NotifierLocale, TitlePair> = {
  zh: { success: 'DSH 任务完成', failure: 'DSH 任务未正常结束' },
  en: { success: 'DSH task completed', failure: 'DSH task did not finish cleanly' },
}

/**
 * Resolve the effective titles: configured text wins, an empty field falls
 * back to the locale's default.
 *
 * @param locale - label language.
 * @param configured - title strings from configuration.
 * @returns the title pair to render with.
 */
export function resolveTitles(locale: string, configured: { readonly success?: string; readonly failure?: string }): TitlePair {
  const fallback = DEFAULT_TITLES[locale === 'en' ? 'en' : 'zh']
  const success = (configured.success ?? '').trim()
  const failure = (configured.failure ?? '').trim()
  return {
    success: success.length > 0 ? success : fallback.success,
    failure: failure.length > 0 ? failure : fallback.failure,
  }
}

/** Localized label for one completion source. */
export function kindLabel(locale: string, kind: CompletionKind): string {
  return labelsFor(locale).kind[kind] ?? kind
}

/** Localized label for a terminal outcome. */
export function outcomeLabel(locale: string, outcome: string): string {
  const table = OUTCOME_LABELS[locale === 'en' ? 'en' : 'zh']
  return table[outcome] ?? outcome
}

/**
 * Collapse a task name onto one printable line and bound its length.
 *
 * Notification surfaces differ: a Windows toast wraps, a balloon tip and every
 * command-line notifier assume one line. Folding whitespace keeps all channels
 * readable; the cap stops a pasted prompt from swallowing the whole toast.
 *
 * @param text - raw task-name candidate.
 * @param maxChars - maximum kept characters; non-positive disables the cap.
 * @returns a single-line, truncated string, possibly empty.
 */
export function oneLine(text: string, maxChars: number): string {
  const folded = text.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (folded.length === 0) return ''
  if (maxChars <= 0 || folded.length <= maxChars) return folded
  return folded.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '…'
}

/**
 * Substitute {field} placeholders in a template.
 *
 * Unknown placeholders are left intact, so a typo in cordis.yml shows up in the
 * notification instead of silently vanishing.
 *
 * @param template - body or title template.
 * @param fields - replacement values keyed by placeholder name.
 * @returns the rendered string.
 */
export function renderTemplate(template: string, fields: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in fields ? fields[key] as string : match))
}

/** Everything needed to render one notification from one completion. */
export interface RenderInput {
  /** Raw task name, as discovered by the source adapter. */
  readonly task: string
  readonly kind: CompletionKind
  readonly outcome: string
  readonly success: boolean
  readonly ref: string
}

/** A rendered notification, ready for the delivery half. */
export interface RenderedMessage {
  readonly title: string
  readonly body: string
}

/**
 * Render one completion into title and body text.
 *
 * @param input - normalized completion facts.
 * @param template - body template accepting {task}, {kind}, {outcome}, {ref}.
 * @param titles - title strings for success and non-success outcomes.
 * @param locale - label language.
 * @param maxChars - task-name length cap.
 * @returns the message to deliver.
 */
export function renderMessage(
  input: RenderInput,
  template: string,
  titles: { readonly success: string; readonly failure: string },
  locale: string,
  maxChars: number,
): RenderedMessage {
  const task = oneLine(input.task, maxChars) || labelsFor(locale).unnamed
  const fields: Record<string, string> = {
    task,
    kind: kindLabel(locale, input.kind),
    outcome: outcomeLabel(locale, input.outcome),
    ref: input.ref,
  }
  return {
    title: renderTemplate(input.success ? titles.success : titles.failure, fields),
    body: renderTemplate(template, fields),
  }
}
