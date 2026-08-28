/**
 * dsh-task-notifier - raises an operating-system notification whenever one of
 * the user's tasks finishes in DeepSeek Harness.
 *
 * A "task" is whatever the harness reports as finished work, and each family
 * has its own switch: an answered turn in a session, a delegated subagent run,
 * a background job, a same-session goal marked complete, and a settled workflow
 * run. Every enabled source is normalized into one TaskCompletion (see
 * ./task-source.ts), worded into a title and body (./format.ts), and delivered
 * through the desktop notifier of the host OS (./notifier.ts). Delivery is
 * fire-and-forget and total: a machine with no working notifier logs a warning
 * and the agent turn continues untouched.
 *
 * All deployment-varying values are configuration fields, so a private
 * cordis.yml layer can retune wording, sources, throttling and the delivery
 * command without touching code.
 *
 * @module dsh-task-notifier
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type NotifierLocale } from './format.ts';
import { type TaskCompletion } from './task-source.ts';
export declare const name = "dsh-task-notifier";
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * One task completion recognized by this plugin, emitted before delivery.
         * Lets another plugin mirror the same signal into its own surface (a Web
         * card, a chat log, a webhook) without re-reading the harness seams.
         * @mode emit
         */
        'task-notifier/completed'(this: Context, payload: {
            readonly completion: TaskCompletion;
            readonly title: string;
            readonly body: string;
        }): void;
    }
}
/** Configurable parameters; defaults live in the schema below, not in code. */
export interface Config {
    /** Master switch: when false, no listener is registered at all. */
    enabled: boolean;
    /** Label language of the generated notification text. */
    locale: NotifierLocale;
    /** Notification title for a successful completion; empty follows locale. */
    title: string;
    /** Title for a completion that did not succeed; empty follows locale. */
    failureTitle: string;
    /** Body template; accepts {task}, {kind}, {outcome} and {ref}; empty follows locale. */
    bodyTemplate: string;
    /** Maximum characters kept from the discovered task name. */
    taskNameChars: number;
    /** Notify when an agent turn (a answered task in a session) ends. */
    onTurnEnd: boolean;
    /** Notify when a delegated subagent run ends. */
    onSubagentEnd: boolean;
    /** Notify when a background job settles. */
    onJobDone: boolean;
    /** Notify when a goal is marked complete or blocked. */
    onGoalComplete: boolean;
    /** Notify when a workflow run settles. */
    onWorkflowEnd: boolean;
    /** Suppress non-success outcomes (errors, cancellations, truncations). */
    onlySuccess: boolean;
    /** Also report turns and goals owned by child (subagent) sessions. */
    includeChildSessions: boolean;
    /** Ask the desktop for its notification sound where the channel supports it. */
    sound: boolean;
    /** Dedupe window per completion key, in milliseconds. */
    dedupeMs: number;
    /** Notifier identity shown by the desktop. */
    appName: string;
    /** PowerShell executable on Windows; empty uses powershell.exe then pwsh.exe. */
    powershellProgram: string;
    /**
     * External delivery command (argv; first entry is the executable). {title}
     * and {body} are substituted, or both strings are appended when the template
     * is absent. Overrides every built-in channel.
     */
    command: string[];
    /** Kill a delivery process after this many milliseconds. */
    timeoutMs: number;
}
/** Schemastery configuration schema, validated when the plugin loads. */
export declare const Config: Schema<Config>;
/**
 * Wire the harness completion seams to the desktop notifier.
 *
 * @param ctx - the harness context; registrations are fiber-scoped and are
 *   removed automatically on unload or hot replacement.
 * @param config - the validated composition-layer configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
