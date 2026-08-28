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
/** One notification to show. */
export interface NotificationPayload {
    readonly title: string;
    readonly body: string;
    readonly sound: boolean;
}
/** Outcome of one delivery attempt chain. */
export interface DeliveryResult {
    readonly ok: boolean;
    /** Which channel reported success, or the last channel tried. */
    readonly channel: string;
    /** Short failure or exit detail for the logs. */
    readonly detail: string;
}
/** Diagnostic surface, satisfied by ctx.logger(name). */
export interface NotifierLog {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    debug?(message: string, fields?: Record<string, unknown>): void;
}
/** How to reach the desktop. Every field comes from plugin configuration. */
export interface NotifierOptions {
    /** App / notifier identity shown by the desktop where the channel supports it. */
    readonly appName: string;
    /**
     * Optional external program: argv where the first entry is the executable.
     * {title} and {body} placeholders are replaced; when absent, both strings are
     * appended as the last two arguments. Overrides the built-in channels.
     */
    readonly command: readonly string[];
    /** PowerShell executable to use on Windows; empty selects the built-in order. */
    readonly powershellProgram: string;
    /** Per-process kill timer in milliseconds. */
    readonly timeoutMs: number;
    readonly log: NotifierLog;
}
/**
 * Deliver one notification through the operating system.
 *
 * @param options - delivery configuration.
 * @param payload - the message to show.
 * @returns the winning channel, or the last one that was tried.
 */
export declare function deliver(options: NotifierOptions, payload: NotificationPayload): Promise<DeliveryResult>;
/**
 * Build a notifier bound to one configuration and logger.
 *
 * @param options - delivery configuration.
 * @returns a function that shows one notification and never throws.
 */
export declare function createNotifier(options: NotifierOptions): (payload: NotificationPayload) => Promise<DeliveryResult>;
