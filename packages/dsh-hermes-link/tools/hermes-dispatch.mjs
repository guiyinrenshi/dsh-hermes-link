// tools/hermes-dispatch.mjs
//
// v0.8.0 — delegate a task TO Hermes Agent, from DSH.
//
// This is the reverse of `dispatch_task` (Hermes -> DSH): the DSH agent calls
// this tool, the plugin starts a Hermes child through the registered `hermes`
// subagent provider, waits for its final answer and returns it.
//
// Hermes runs through its own one-shot mode (`hermes -z`), so the child keeps
// Hermes' tools, memory, rules and AGENTS.md. Continuity uses Hermes' own
// session store: `--in <workdir> --resume latest` continues the most recent
// Hermes session for that workspace.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveSubagents } from '../services/host-compat.mjs'

function pickParents(ctx) {
  const out = []
  const push = (a) => { if (a && !out.includes(a)) out.push(a) }
  try { for (const a of (ctx.agents && typeof ctx.agents.roots === 'function' && ctx.agents.roots()) || []) push(a) } catch {}
  try { for (const a of (ctx.agents && typeof ctx.agents.list === 'function' && ctx.agents.list()) || []) push(a) } catch {}
  return out
}

function textOf(settled) {
  const blocks = (settled && settled.output) || []
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

export function createHermesDispatchTool({ ctx, hermesBin }) {
  return defineTool({
    name: 'hermes_dispatch',
    description:
      'Delegate one focused task to Hermes Agent and wait for its final answer (the reverse of dispatch_task). Hermes runs as a real subagent through its own one-shot mode, so it keeps its tools, memory, rules and AGENTS.md in the given working directory. Use it when the task needs Hermes-side context or a second agent, not for work DSH can do itself.',
    parameters: {
      task: { type: 'string', required: true, description: 'The task/prompt to hand to Hermes.' },
      workdir: { type: 'string', description: 'Working directory for the Hermes child (also selects its resumable session). Defaults to the current DSH working directory.' },
      model: { type: 'string', description: 'Optional Hermes model override, e.g. anthropic/claude-sonnet-4.6.' },
      provider: { type: 'string', description: 'Optional Hermes inference provider override.' },
      reasoning: { type: 'string', description: 'Optional reasoning effort: none|minimal|low|medium|high|xhigh|max|ultra.' },
      toolset: { type: 'string', description: 'Optional comma-separated Hermes toolsets to enable for this run.' },
      resume: { type: 'string', description: "Hermes session to continue: 'latest' (default), a session id/title, or 'new' to start fresh." },
      timeout_ms: { type: 'integer', description: 'Give up after this many milliseconds (default 600000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          text: { type: 'string' },
          stop_reason: { type: 'string' },
          elapsed_ms: { type: 'integer' },
          workdir: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        const v = value || {}
        const head = '[hermes_dispatch] status=' + v.status +
          (v.stop_reason ? ' stop_reason=' + v.stop_reason : '') +
          (typeof v.elapsed_ms === 'number' ? ' elapsed_ms=' + v.elapsed_ms : '') +
          (v.workdir ? ' workdir=' + v.workdir : '')
        return [{ type: 'text', text: head + '\n\n--- answer ---\n' + (v.text || v.error || '(empty)') }]
      },
    },
    async execute(args) {
      const started = Date.now()
      const task = args && typeof args.task === 'string' ? args.task.trim() : ''
      if (!task) return { status: 'error', error: 'task is required', elapsed_ms: 0 }
      const parents = pickParents(ctx)
      const parent = parents[0]
      if (!parent) return { status: 'error', error: 'no live DSH agent to act as parent', elapsed_ms: 0 }

      const workdir = typeof args.workdir === 'string' && args.workdir
        ? args.workdir
        : (parent.session && parent.session.header && parent.session.header.cwd) || process.cwd()
      const resumeRaw = typeof args.resume === 'string' ? args.resume.trim() : 'latest'
      const resume = resumeRaw === 'new' ? '' : resumeRaw

      const controller = new AbortController()
      const timeoutMs = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : 600000
      const timer = setTimeout(() => controller.abort(new Error('hermes_dispatch timeout')), timeoutMs)
      let run = null
      try {
        const subagents = resolveSubagents(ctx)
        run = await subagents.start('hermes', {
          label: 'hermes-child: ' + task.slice(0, 60),
          prompt: [{ type: 'text', text: task }],
          parent,
          signal: controller.signal,
          cwd: workdir,
          resume,
          model: args.model,
          provider: args.provider,
          reasoning: args.reasoning,
          toolset: args.toolset,
        })
        const settled = await run.result
        clearTimeout(timer)
        const text = textOf(settled)
        const stopReason = (settled && settled.stopReason) || 'completed'
        return {
          status: stopReason === 'completed' ? 'ok' : 'error',
          text,
          stop_reason: stopReason,
          elapsed_ms: Date.now() - started,
          workdir,
          ...(settled && settled.error ? { error: String(settled.error) } : {}),
        }
      } catch (e) {
        clearTimeout(timer)
        return {
          status: 'error',
          error: String((e && e.message) || e),
          elapsed_ms: Date.now() - started,
          workdir,
        }
      } finally {
        clearTimeout(timer)
        if (run && typeof run.dispose === 'function') {
          try { await run.dispose() } catch {}
        }
      }
    },
  })
}
