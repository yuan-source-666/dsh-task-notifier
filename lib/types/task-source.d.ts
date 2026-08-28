/**
 * Normalized "some task finished" signals read off the DSH event seams.
 *
 * The harness reports completion in several shapes: a turn closing in a
 * session log, a subagent run ending, a background job settling, a goal being
 * marked complete, and a workflow run finishing. This module folds them into
 * one flat TaskCompletion value so the delivery half stays platform-only and
 * each source stays independently switchable.
 *
 * Every seam is reached through a structural view (see TaskSeamContext below)
 * rather than an import: a community plugin is compiled outside the harness
 * workspace and cannot resolve the internal packages that declare those events,
 * and re-declaring them with module augmentation would collide with the real
 * declarations for anyone who compiles both together.
 *
 * @module dsh-task-notifier/task-source
 */
/** Which kind of finished work produced a completion. */
export type CompletionKind = 'turn' | 'subagent' | 'job' | 'goal' | 'workflow';
/** One finished task, ready to be worded and delivered. */
export interface TaskCompletion {
    /** Completion source family. */
    readonly kind: CompletionKind;
    /** Human-readable task name (session title, prompt, job label, goal text). */
    readonly task: string;
    /** Terminal code reported by the source, e.g. 'completed', 'error', 'killed'. */
    readonly outcome: string;
    /** Whether the source called this end a success. */
    readonly success: boolean;
    /** Dedupe key: one notification per key per throttle window. */
    readonly key: string;
    /** Correlation id (session, run, job, or workflow id) for diagnostics. */
    readonly ref: string;
}
/** Minimal diagnostic surface used by the adapters. */
export interface SourceLog {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
}
/** One logged session event, structurally. */
export interface SessionEventLike {
    readonly type: string;
    readonly data: any;
}
/** A live session, structurally. */
export interface SessionLike {
    readonly id: string;
    readonly header?: {
        readonly parentSession?: unknown;
    };
    readonly events?: readonly SessionEventLike[];
}
/** An agent, structurally. */
export interface AgentLike {
    readonly session: SessionLike;
}
/** Payload of the 'subagent/end' event. */
export interface SubagentEndLike {
    readonly runId?: string;
    readonly provider: string;
    readonly id: string;
    readonly stopReason: string;
}
/** Terminal snapshot of one background job. */
export interface JobSnapshotLike {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly status: string;
    readonly detail?: string;
    readonly ownerSession?: string;
}
/** Payload of the 'goal/changed' event. */
export interface GoalChangedLike {
    readonly agent?: AgentLike;
    readonly change: {
        readonly operation: string;
        readonly goal?: {
            readonly objective?: string;
            readonly updatedAt?: number;
        };
    };
}
/** 'workflow/end' pair of arguments. */
export interface WorkflowRunLike {
    readonly id?: string;
    readonly meta?: {
        readonly name?: string;
        readonly description?: string;
    };
}
/** Terminal result of a workflow run. */
export interface WorkflowResultLike {
    readonly stopReason: string;
    readonly error?: string;
    readonly agentsStarted?: number;
}
/** The 'sessions' service, structurally. */
export interface SessionStoreLike {
    get(id: unknown): SessionLike | undefined;
}
/** The 'sessionTitle' service, structurally. */
export interface SessionTitleLike {
    get(session: unknown): {
        readonly title?: string;
    } | undefined;
}
/** The 'jobs' registry, structurally. */
export interface JobRegistryLike {
    onJobDone(listener: (snapshot: JobSnapshotLike, owner: AgentLike | undefined) => void): () => void;
}
/** The subset of the Cordis context this plugin consumes. */
export interface TaskSeamContext {
    on(name: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void): unknown;
    on(name: 'subagent/end', listener: (info: SubagentEndLike) => void): unknown;
    on(name: 'goal/changed', listener: (payload: GoalChangedLike) => void): unknown;
    on(name: 'workflow/end', listener: (info: WorkflowRunLike, result: WorkflowResultLike) => void): unknown;
    get(name: 'sessions'): SessionStoreLike | undefined;
    get(name: 'sessionTitle'): SessionTitleLike | undefined;
    get(name: 'jobs'): JobRegistryLike | undefined;
}
/**
 * Cast one harness context to the structural seam view.
 *
 * @param ctx - the context handed to apply().
 * @returns the same object, typed by this module's structural view.
 */
export declare function asTaskSeams(ctx: unknown): TaskSeamContext;
/** Which sources to observe; each maps to one completion family. */
export interface SourceOptions {
    readonly onTurnEnd: boolean;
    readonly onSubagentEnd: boolean;
    readonly onJobDone: boolean;
    readonly onGoalComplete: boolean;
    readonly onWorkflowEnd: boolean;
    /** Also report work owned by a child (subagent) session. */
    readonly includeChildSessions: boolean;
    /** Sink for every normalized completion. */
    readonly onCompletion: (completion: TaskCompletion) => void;
    readonly log: SourceLog;
}
/**
 * Derive a session's task name from its log: the latest human prompt.
 *
 * @param session - session whose events to scan.
 * @returns the prompt text, or an empty string when no human turn is logged.
 */
export declare function lastHumanPrompt(session: SessionLike | undefined): string;
/**
 * Best available name for one session: its generated title, else its last
 * human prompt, else nothing (the caller substitutes a stable id).
 *
 * @param ctx - harness context used to reach the optional title service.
 * @param session - session being described.
 * @returns the task name, possibly empty.
 */
export declare function sessionTaskName(ctx: TaskSeamContext, session: SessionLike | undefined): string;
/** Register every enabled completion source on the harness context.
 *
 * All listeners are registered through ctx.on / the job registry, so Cordis
 * removes them when this plugin's fiber unloads (including an HMR replace).
 *
 * @param ctx - harness context.
 * @param options - source switches, child-session policy, and sink.
 * @returns the labels of the sources that are now active.
 */
export declare function subscribeTaskCompletions(ctx: TaskSeamContext, options: SourceOptions): string[];
