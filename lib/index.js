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
import Schema from '@deepseek-ai/schemastery';
import { renderMessage, resolveTemplate, resolveTitles } from "./format.js";
import { createNotifier } from "./notifier.js";
import { asTaskSeams, subscribeTaskCompletions } from "./task-source.js";
export const name = 'dsh-task-notifier';
/** Schemastery configuration schema, validated when the plugin loads. */
export const Config = Schema.object({
    enabled: Schema.boolean().default(true).description('总开关：false 时本插件完全不注册监听。'),
    locale: Schema.union(['zh', 'en']).default('zh').description('通知文案语言：zh 用中文标签，en 用英文标签。'),
    title: Schema.string().default('').description('任务成功完成时的通知标题；留空则按 locale 使用内置默认标题。'),
    failureTitle: Schema.string().default('').description('任务以出错、取消或阻塞结束时使用的通知标题；留空则按 locale 使用内置默认标题。'),
    bodyTemplate: Schema.string().default('').description('通知正文模板，可用占位符 {kind} 任务类型、{task} 任务名、{outcome} 结束原因、{ref} 会话或任务 id；留空则按 locale 使用内置模板。'),
    taskNameChars: Schema.number().step(1).min(10).default(120).description('任务名保留的最大字符数，超出部分以省略号收尾。'),
    onTurnEnd: Schema.boolean().default(true).description('会话中的一轮任务答完时通知。'),
    onSubagentEnd: Schema.boolean().default(true).description('委派的子任务（subagent）结束时通知。'),
    onJobDone: Schema.boolean().default(true).description('后台任务（job）结束时通知。'),
    onGoalComplete: Schema.boolean().default(true).description('目标（goal）被标记完成或受阻时通知。'),
    onWorkflowEnd: Schema.boolean().default(true).description('工作流（workflow）运行时结束时通知。'),
    onlySuccess: Schema.boolean().default(false).description('为 true 时只在成功完成时通知，出错与取消不再打扰。'),
    includeChildSessions: Schema.boolean().default(false).description('是否也为子会话（subagent 会话）的轮次与目标发通知。'),
    sound: Schema.boolean().default(true).description('在支持的渠道上播放系统提示音。'),
    dedupeMs: Schema.number().step(1).min(0).default(2000).description('同一完成信号的去重窗口（毫秒）。'),
    appName: Schema.string().default('DeepSeek Harness').description('系统通知里显示的应用名称。'),
    powershellProgram: Schema.string().default('').description('Windows 上指定 PowerShell 程序；留空则依次尝试 powershell.exe 与 pwsh.exe。'),
    command: Schema.array(Schema.string()).default([]).description('自定义投递命令 argv，第一项是可执行文件；用 {title}/{body} 占位符，或省略占位符把两个字符串追加为末尾参数。非空时覆盖内置渠道。'),
    timeoutMs: Schema.number().step(1).min(500).default(15000).description('单个投递进程的最长运行时间（毫秒），超时即终止并换下一个渠道。'),
});
/**
 * Wire the harness completion seams to the desktop notifier.
 *
 * @param ctx - the harness context; registrations are fiber-scoped and are
 *   removed automatically on unload or hot replacement.
 * @param config - the validated composition-layer configuration.
 */
export function apply(ctx, config) {
    const log = ctx.logger('dsh-task-notifier');
    if (!config.enabled) {
        log.info('disabled by configuration; no completion listeners registered');
        return;
    }
    // An empty title field means "follow locale": one locale switch then
    // produces a fully monolingual notification.
    const titles = resolveTitles(config.locale, { success: config.title, failure: config.failureTitle });
    const bodyTemplate = resolveTemplate(config.locale, config.bodyTemplate);
    const notifier = createNotifier({
        appName: config.appName,
        command: config.command,
        powershellProgram: config.powershellProgram,
        timeoutMs: config.timeoutMs,
        log,
    });
    // One notification per completion key per window. A turn can be reported by
    // both the turn seam and a nested source (a subagent's own final turn, for
    // instance), and a hot replacement must not double-ping the user.
    const seen = new Map();
    function shouldReport(key, stamp) {
        const previous = seen.get(key);
        if (previous !== undefined && stamp - previous < config.dedupeMs)
            return false;
        seen.set(key, stamp);
        if (seen.size > 512) {
            const horizon = Math.max(config.dedupeMs, 60_000);
            for (const [seenKey, seenStamp] of seen) {
                if (stamp - seenStamp > horizon)
                    seen.delete(seenKey);
            }
        }
        return true;
    }
    const sources = subscribeTaskCompletions(asTaskSeams(ctx), {
        onTurnEnd: config.onTurnEnd,
        onSubagentEnd: config.onSubagentEnd,
        onJobDone: config.onJobDone,
        onGoalComplete: config.onGoalComplete,
        onWorkflowEnd: config.onWorkflowEnd,
        includeChildSessions: config.includeChildSessions,
        log,
        onCompletion: (completion) => {
            if (config.onlySuccess && !completion.success)
                return;
            if (!shouldReport(completion.key, Date.now()))
                return;
            const message = renderMessage({
                task: completion.task,
                kind: completion.kind,
                outcome: completion.outcome,
                success: completion.success,
                ref: completion.ref,
            }, bodyTemplate, titles, config.locale, config.taskNameChars);
            ctx.emit('task-notifier/completed', { completion, title: message.title, body: message.body });
            void notifier({ title: message.title, body: message.body, sound: config.sound }).then((result) => {
                if (result.ok) {
                    log.info('system notification shown', {
                        channel: result.channel, kind: completion.kind, outcome: completion.outcome,
                        title: message.title, body: message.body,
                    });
                }
            });
        },
    });
    log.info('watching task completions', {
        sources,
        locale: config.locale,
        onlySuccess: config.onlySuccess,
        includeChildSessions: config.includeChildSessions,
        delivery: config.command.length > 0 ? 'command' : 'platform default',
    });
}
