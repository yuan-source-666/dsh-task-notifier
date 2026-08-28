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
/**
 * Cast one harness context to the structural seam view.
 *
 * @param ctx - the context handed to apply().
 * @returns the same object, typed by this module's structural view.
 */
export function asTaskSeams(ctx) {
    return ctx;
}
/** True when one session was spawned as a child (subagent) session. */
function isChildSession(session) {
    if (session === undefined)
        return false;
    const parent = session.header?.parentSession;
    return parent !== undefined && parent !== null;
}
/** Text blocks of one logged message, concatenated. */
function messageText(content) {
    if (!Array.isArray(content))
        return typeof content === 'string' ? content : '';
    const parts = [];
    for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text'
            && typeof block.text === 'string') {
            parts.push(block.text);
        }
    }
    return parts.join(' ');
}
/**
 * Derive a session's task name from its log: the latest human prompt.
 *
 * @param session - session whose events to scan.
 * @returns the prompt text, or an empty string when no human turn is logged.
 */
export function lastHumanPrompt(session) {
    const events = session?.events;
    if (!Array.isArray(events))
        return '';
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined || event.type !== 'user/message')
            continue;
        const source = event.data?.source;
        if (source === undefined || source.kind !== 'user')
            continue;
        const text = messageText(event.data?.message?.content ?? event.data?.content);
        if (text.trim().length > 0)
            return text;
    }
    return '';
}
/**
 * Best available name for one session: its generated title, else its last
 * human prompt, else nothing (the caller substitutes a stable id).
 *
 * @param ctx - harness context used to reach the optional title service.
 * @param session - session being described.
 * @returns the task name, possibly empty.
 */
export function sessionTaskName(ctx, session) {
    try {
        const snapshot = ctx.get('sessionTitle')?.get(session);
        const title = snapshot?.title;
        if (typeof title === 'string' && title.trim().length > 0)
            return title;
    }
    catch {
        // The title service is optional and may reject a disposed session; the
        // log-derived name below is the intended fallback either way.
    }
    return lastHumanPrompt(session);
}
/** Resolve a session by id, tolerating an absent store or an unknown id. */
function lookupSession(ctx, id) {
    try {
        return ctx.get('sessions')?.get(id);
    }
    catch {
        return undefined;
    }
}
/** Turn-end reasons that are harness bookkeeping, not a finished task. */
const IGNORED_TURN_REASONS = new Set(['interrupted']);
/** Register every enabled completion source on the harness context.
 *
 * All listeners are registered through ctx.on / the job registry, so Cordis
 * removes them when this plugin's fiber unloads (including an HMR replace).
 *
 * @param ctx - harness context.
 * @param options - source switches, child-session policy, and sink.
 * @returns the labels of the sources that are now active.
 */
export function subscribeTaskCompletions(ctx, options) {
    const active = [];
    const emit = (completion) => {
        try {
            options.onCompletion(completion);
        }
        catch (error) {
            options.log.warn('completion sink threw', { kind: completion.kind, error: String(error) });
        }
    };
    if (options.onTurnEnd) {
        ctx.on('session/event', (session, event) => {
            if (event?.type !== 'turn/end')
                return;
            const reason = event.data?.reason;
            const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed';
            if (IGNORED_TURN_REASONS.has(kind))
                return;
            if (!options.includeChildSessions && isChildSession(session))
                return;
            const turn = typeof event.data?.turn === 'number' ? event.data.turn : undefined;
            const ref = String(session?.id ?? 'unknown');
            emit({
                kind: 'turn',
                task: sessionTaskName(ctx, session) || (turn === undefined ? ref : 'turn ' + turn),
                outcome: kind,
                success: kind === 'completed',
                key: 'turn:' + ref + ':' + String(turn ?? '?'),
                ref,
            });
        });
        active.push('turn');
    }
    if (options.onSubagentEnd) {
        ctx.on('subagent/end', (info) => {
            if (info === undefined || info === null)
                return;
            // A subagent run is by definition a child session, so this source is
            // governed by its own switch rather than by includeChildSessions; the
            // child session is looked up only to name the task.
            const child = lookupSession(ctx, String(info.id));
            const name = sessionTaskName(ctx, child);
            emit({
                kind: 'subagent',
                task: name || (info.provider + ' ' + String(info.id)),
                outcome: String(info.stopReason ?? 'completed'),
                success: info.stopReason === 'completed',
                key: 'subagent:' + String(info.runId ?? info.id),
                ref: String(info.id),
            });
        });
        active.push('subagent');
    }
    if (options.onJobDone) {
        let registry;
        try {
            registry = ctx.get('jobs');
        }
        catch {
            registry = undefined;
        }
        if (registry === undefined || typeof registry.onJobDone !== 'function') {
            options.log.info('job source skipped: no jobs service in this composition');
        }
        else {
            registry.onJobDone((snapshot) => {
                emit({
                    kind: 'job',
                    task: snapshot.label || snapshot.kind + ' ' + snapshot.id,
                    outcome: String(snapshot.status ?? 'completed'),
                    success: snapshot.status === 'completed',
                    key: 'job:' + snapshot.id,
                    ref: snapshot.id,
                });
            });
            active.push('job');
        }
    }
    if (options.onGoalComplete) {
        ctx.on('goal/changed', (payload) => {
            const operation = payload?.change?.operation;
            if (operation !== 'complete' && operation !== 'block')
                return;
            const session = payload.agent?.session;
            if (!options.includeChildSessions && isChildSession(session))
                return;
            const objective = payload.change.goal?.objective;
            const ref = String(session?.id ?? 'goal');
            emit({
                kind: 'goal',
                task: objective ?? 'goal',
                outcome: operation,
                success: operation === 'complete',
                key: 'goal:' + ref + ':' + String(payload.change.goal?.updatedAt ?? operation),
                ref,
            });
        });
        active.push('goal');
    }
    if (options.onWorkflowEnd) {
        ctx.on('workflow/end', (info, result) => {
            const stopReason = String(result?.stopReason ?? 'completed');
            const name = info?.meta?.description || info?.meta?.name || 'workflow';
            const ref = String(info?.id ?? name);
            emit({
                kind: 'workflow',
                task: name,
                outcome: stopReason,
                success: stopReason === 'completed',
                key: 'workflow:' + ref,
                ref,
            });
        });
        active.push('workflow');
    }
    return active;
}
