/**
 * Wording and layout for one completion notification: the task name, the
 * localized kind/outcome labels, and the title/body templates. Pure string
 * work with no I/O, so it is unit-testable without a harness or an OS.
 *
 * @module dsh-task-notifier/format
 */
import type { CompletionKind } from './task-source.ts';
/** Supported label languages. */
export type NotifierLocale = 'zh' | 'en';
interface LocaleLabels {
    /** Display name of each completion source. */
    readonly kind: Record<CompletionKind, string>;
    /** Fallback body when a task has no discoverable name. */
    readonly unnamed: string;
}
/** Resolve a locale tag to its label table (anything but 'en' uses Chinese). */
export declare function labelsFor(locale: string): LocaleLabels;
/**
 * Body templates per locale.
 *
 * The template is configurable, so the schema defaults it to empty and this
 * table fills it in: only the separator between the kind label and the task
 * name is locale-specific (a full-width colon reads wrong after an English
 * label), and one locale field should not need three rewrites.
 */
export declare const DEFAULT_TEMPLATES: Record<NotifierLocale, string>;
/**
 * Resolve the effective body template: a configured template wins, an empty
 * one follows the locale.
 *
 * @param locale - label language.
 * @param configured - bodyTemplate from configuration.
 * @returns the template to render.
 */
export declare function resolveTemplate(locale: string, configured: string): string;
/** One notification title pair. */
export interface TitlePair {
    readonly success: string;
    readonly failure: string;
}
/**
 * Title pairs that match each locale's labels.
 *
 * Titles are configurable strings, so the schema defaults them to empty and
 * this table fills them in: an all-English notification needs only the single
 * locale field, never three separate rewrites.
 */
export declare const DEFAULT_TITLES: Record<NotifierLocale, TitlePair>;
/**
 * Resolve the effective titles: configured text wins, an empty field falls
 * back to the locale's default.
 *
 * @param locale - label language.
 * @param configured - title strings from configuration.
 * @returns the title pair to render with.
 */
export declare function resolveTitles(locale: string, configured: {
    readonly success?: string;
    readonly failure?: string;
}): TitlePair;
/** Localized label for one completion source. */
export declare function kindLabel(locale: string, kind: CompletionKind): string;
/** Localized label for a terminal outcome. */
export declare function outcomeLabel(locale: string, outcome: string): string;
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
export declare function oneLine(text: string, maxChars: number): string;
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
export declare function renderTemplate(template: string, fields: Record<string, string>): string;
/** Everything needed to render one notification from one completion. */
export interface RenderInput {
    /** Raw task name, as discovered by the source adapter. */
    readonly task: string;
    readonly kind: CompletionKind;
    readonly outcome: string;
    readonly success: boolean;
    readonly ref: string;
}
/** A rendered notification, ready for the delivery half. */
export interface RenderedMessage {
    readonly title: string;
    readonly body: string;
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
export declare function renderMessage(input: RenderInput, template: string, titles: {
    readonly success: string;
    readonly failure: string;
}, locale: string, maxChars: number): RenderedMessage;
export {};
