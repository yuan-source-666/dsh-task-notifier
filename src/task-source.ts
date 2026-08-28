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
export type CompletionKind = 'turn' | 'subagent' | 'job' | 'goal' | 'workflow'

/** One finished task, ready to be worded and delivered. */
export interface TaskCompletion {
  /** Completion source family. */
  readonly kind: CompletionKind
  /** Human-readable task name (session title, prompt, job label, goal text). */
  readonly task: string
  /** Terminal code reported by the source, e.g. 'completed', 'error', 'killed'. */
  readonly outcome: string
  /** Whether the source called this end a success. */
  readonly success: boolean
  /** Dedupe key: one notification per key per throttle window. */
  readonly key: string
  /** Correlation id (session, run, job, or workflow id) for diagnostics. */
  readonly ref: string
}

/** Minimal diagnostic surface used by the adapters. */
export interface SourceLog {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

/** One logged session event, structurally. */
export interface SessionEventLike {
  readonly type: string
  readonly data: any
}

/** A live session, structurally. */
export interface SessionLike {
  readonly id: string
  readonly header?: { readonly parentSession?: unknown }
  readonly events?: readonly SessionEventLike[]
}

/** An agent, structurally. */
export interface AgentLike {
  readonly session: SessionLike
}

/** Payload of the 'subagent/end' event. */
export interface SubagentEndLike {
  readonly runId?: string
  readonly provider: string
  readonly id: string
  readonly stopReason: string
}

/** Terminal snapshot of one background job. */
export interface JobSnapshotLike {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly detail?: string
  readonly ownerSession?: string
}

/** Payload of the 'goal/changed' event. */
export interface GoalChangedLike {
  readonly agent?: AgentLike
  readonly change: {
    readonly operation: string
    readonly goal?: { readonly objective?: string; readonly updatedAt?: number }
  }
}

/** 'workflow/end' pair of arguments. */
export interface WorkflowRunLike {
  readonly id?: string
  readonly meta?: { readonly name?: string; readonly description?: string }
}

/** Terminal result of a workflow run. */
export interface WorkflowResultLike {
  readonly stopReason: string
  readonly error?: string
  readonly agentsStarted?: number
}

/** The 'sessions' service, structurally. */
export interface SessionStoreLike {
  get(id: unknown): SessionLike | undefined
}

/** The 'sessionTitle' service, structurally. */
export interface SessionTitleLike {
  get(session: unknown): { readonly title?: string } | undefined
}

/** The 'jobs' registry, structurally. */
export interface JobRegistryLike {
  onJobDone(listener: (snapshot: JobSnapshotLike, owner: AgentLike | undefined) => void): () => void
}

/** The subset of the Cordis context this plugin consumes. */
export interface TaskSeamContext {
  on(name: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void): unknown
  on(name: 'subagent/end', listener: (info: SubagentEndLike) => void): unknown
  on(name: 'goal/changed', listener: (payload: GoalChangedLike) => void): unknown
  on(name: 'workflow/end', listener: (info: WorkflowRunLike, result: WorkflowResultLike) => void): unknown
  get(name: 'sessions'): SessionStoreLike | undefined
  get(name: 'sessionTitle'): SessionTitleLike | undefined
  get(name: 'jobs'): JobRegistryLike | undefined
}

/**
 * Cast one harness context to the structural seam view.
 *
 * @param ctx - the context handed to apply().
 * @returns the same object, typed by this module's structural view.
 */
export function asTaskSeams(ctx: unknown): TaskSeamContext {
  return ctx as unknown as TaskSeamContext
}

/** Which sources to observe; each maps to one completion family. */
export interface SourceOptions {
  readonly onTurnEnd: boolean
  readonly onSubagentEnd: boolean
  readonly onJobDone: boolean
  readonly onGoalComplete: boolean
  readonly onWorkflowEnd: boolean
  /** Also report work owned by a child (subagent) session. */
  readonly includeChildSessions: boolean
  /** Sink for every normalized completion. */
  readonly onCompletion: (completion: TaskCompletion) => void
  readonly log: SourceLog
}

/** True when one session was spawned as a child (subagent) session. */
function isChildSession(session: SessionLike | undefined): boolean {
  if (session === undefined) return false
  const parent = session.header?.parentSession
  return parent !== undefined && parent !== null
}

/** Text blocks of one logged message, concatenated. */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as any).type === 'text'
      && typeof (block as any).text === 'string') {
      parts.push((block as any).text as string)
    }
  }
  return parts.join(' ')
}

/**
 * Derive a session's task name from its log: the latest human prompt.
 *
 * @param session - session whose events to scan.
 * @returns the prompt text, or an empty string when no human turn is logged.
 */
export function lastHumanPrompt(session: SessionLike | undefined): string {
  const events = session?.events
  if (!Array.isArray(events)) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const source = event.data?.source
    if (source === undefined || source.kind !== 'user') continue
    const text = messageText(event.data?.message?.content ?? event.data?.content)
    if (text.trim().length > 0) return text
  }
  return ''
}

/**
 * Best available name for one session: its generated title, else its last
 * human prompt, else nothing (the caller substitutes a stable id).
 *
 * @param ctx - harness context used to reach the optional title service.
 * @param session - session being described.
 * @returns the task name, possibly empty.
 */
export function sessionTaskName(ctx: TaskSeamContext, session: SessionLike | undefined): string {
  try {
    const snapshot = ctx.get('sessionTitle')?.get(session)
    const title = snapshot?.title
    if (typeof title === 'string' && title.trim().length > 0) return title
  } catch {
    // The title service is optional and may reject a disposed session; the
    // log-derived name below is the intended fallback either way.
  }
  return lastHumanPrompt(session)
}

/** Resolve a session by id, tolerating an absent store or an unknown id. */
function lookupSession(ctx: TaskSeamContext, id: string): SessionLike | undefined {
  try {
    return ctx.get('sessions')?.get(id)
  } catch {
    return undefined
  }
}

/** Turn-end reasons that are harness bookkeeping, not a finished task. */
const IGNORED_TURN_REASONS = new Set(['interrupted'])

/** Register every enabled completion source on the harness context.
 *
 * All listeners are registered through ctx.on / the job registry, so Cordis
 * removes them when this plugin's fiber unloads (including an HMR replace).
 *
 * @param ctx - harness context.
 * @param options - source switches, child-session policy, and sink.
 * @returns the labels of the sources that are now active.
 */
export function subscribeTaskCompletions(ctx: TaskSeamContext, options: SourceOptions): string[] {
  const active: string[] = []
  const emit = (completion: TaskCompletion): void => {
    try {
      options.onCompletion(completion)
    } catch (error) {
      options.log.warn('completion sink threw', { kind: completion.kind, error: String(error) })
    }
  }

  if (options.onTurnEnd) {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return
      const reason = event.data?.reason
      const kind = typeof reason?.kind === 'string' ? reason.kind as string : 'completed'
      if (IGNORED_TURN_REASONS.has(kind)) return
      if (!options.includeChildSessions && isChildSession(session)) return
      const turn = typeof event.data?.turn === 'number' ? event.data.turn : undefined
      const ref = String(session?.id ?? 'unknown')
      emit({
        kind: 'turn',
        task: sessionTaskName(ctx, session) || (turn === undefined ? ref : 'turn ' + turn),
        outcome: kind,
        success: kind === 'completed',
        key: 'turn:' + ref + ':' + String(turn ?? '?'),
        ref,
      })
    })
    active.push('turn')
  }

  if (options.onSubagentEnd) {
    ctx.on('subagent/end', (info) => {
      if (info === undefined || info === null) return
      // A subagent run is by definition a child session, so this source is
      // governed by its own switch rather than by includeChildSessions; the
      // child session is looked up only to name the task.
      const child = lookupSession(ctx, String(info.id))
      const name = sessionTaskName(ctx, child)
      emit({
        kind: 'subagent',
        task: name || (info.provider + ' ' + String(info.id)),
        outcome: String(info.stopReason ?? 'completed'),
        success: info.stopReason === 'completed',
        key: 'subagent:' + String(info.runId ?? info.id),
        ref: String(info.id),
      })
    })
    active.push('subagent')
  }

  if (options.onJobDone) {
    let registry: JobRegistryLike | undefined
    try {
      registry = ctx.get('jobs')
    } catch {
      registry = undefined
    }
    if (registry === undefined || typeof registry.onJobDone !== 'function') {
      options.log.info('job source skipped: no jobs service in this composition')
    } else {
      registry.onJobDone((snapshot) => {
        emit({
          kind: 'job',
          task: snapshot.label || snapshot.kind + ' ' + snapshot.id,
          outcome: String(snapshot.status ?? 'completed'),
          success: snapshot.status === 'completed',
          key: 'job:' + snapshot.id,
          ref: snapshot.id,
        })
      })
      active.push('job')
    }
  }

  if (options.onGoalComplete) {
    ctx.on('goal/changed', (payload) => {
      const operation = payload?.change?.operation
      if (operation !== 'complete' && operation !== 'block') return
      const session = payload.agent?.session
      if (!options.includeChildSessions && isChildSession(session)) return
      const objective = payload.change.goal?.objective
      const ref = String(session?.id ?? 'goal')
      emit({
        kind: 'goal',
        task: objective ?? 'goal',
        outcome: operation,
        success: operation === 'complete',
        key: 'goal:' + ref + ':' + String(payload.change.goal?.updatedAt ?? operation),
        ref,
      })
    })
    active.push('goal')
  }

  if (options.onWorkflowEnd) {
    ctx.on('workflow/end', (info, result) => {
      const stopReason = String(result?.stopReason ?? 'completed')
      const name = info?.meta?.description || info?.meta?.name || 'workflow'
      const ref = String(info?.id ?? name)
      emit({
        kind: 'workflow',
        task: name,
        outcome: stopReason,
        success: stopReason === 'completed',
        key: 'workflow:' + ref,
        ref,
      })
    })
    active.push('workflow')
  }

  return active
}
