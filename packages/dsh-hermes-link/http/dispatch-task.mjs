// http/dispatch-task.mjs
//
// v0.3.0 - split out of http/dispatch.mjs (E1 refactor). Owns:
//   - handleDispatchTask (one-shot + continuable spawn paths)
//   - validateSpec / formatPersona / extractOutputText / measureRealTokens
//   - extractRecentParentTurns / renderTurnsForContext (shared history rendering)
//   - pickParentAgent (used by both dispatch-task and dispatch-control)
//   - the module-level dispatchers Map (one-shot task lifecycle)

import schema from '../dispatch-spec.schema.json' with { type: 'json' }
import { appendAudit } from '../services/audit.mjs'
import { buildProjectMemorySlice } from '../services/hermes-project-memory.mjs'
import { resolveSubagents } from '../services/host-compat.mjs'
import { mcpError } from './_util.mjs'
import { sessionEvents, sessionSeq } from '../services/host-session.mjs'

export const VERSION = '0.5.0'

const DEFAULT_MAX_TOKENS  = 4000
const DEFAULT_DEADLINE_MS = 60000
const PROVIDER_NAME       = 'spawn'

// v0.7.0 - the model route is HOST CONFIGURATION, not a plugin constant.
// Up to v0.6.11 this module hardcoded provider 'deepseek-official' and models
// 'deepseek-v4-flash/pro', which only exist on the upstream author's machine;
// every dispatch on any other host died inside LLM route resolution.
//
// Defaults: NO agentOptions is sent, so the child inherits the parent's live
// route (the host default model). Operators can pin tiers with env vars read
// at plugin load:
//   HERMES_LINK_MODEL_TIERS='{"flash":"coding-plan/qwen3.8-flash","pro":"coding-plan/qwen3.8-pro"}'
//   (JSON object; a value "provider/model" or bare "model" - a bare model
//    keeps HERMES_LINK_LLM_PROVIDER, and without it the parent's provider.)
//   HERMES_LINK_LLM_PROVIDER='coding-plan'
const DEFAULT_LLM_PROVIDER = process.env.HERMES_LINK_LLM_PROVIDER || ''

export function modelTiersFromEnv(env) {
  const raw = (env || process.env).HERMES_LINK_MODEL_TIERS
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

export function resolveDispatchModel(tier, tiers, defaultProvider) {
  const spec = (tiers || {})[tier || 'flash']
  if (spec == null) return null
  if (typeof spec === 'string') {
    if (spec.includes('/')) {
      const [provider, ...rest] = spec.split('/')
      return { provider, model: rest.join('/') }
    }
    return { ...(defaultProvider ? { provider: defaultProvider } : {}), model: spec }
  }
  if (typeof spec === 'object' && (spec.model || spec.provider)) return spec
  return null
}

const dispatchers = new Map()

export function dispatcherCount() { return dispatchers.size }

export async function handleDispatchTask(ctx, args, deps) {
  const { consultClient, foundationSlice, continuations, outbox, sseBroker } = deps
  const err = validateSpec(args)
  if (err) return { _error: mcpError(null, 'E_INVALID_SPEC', err) }

  const parentCandidates = pickParentAgents(ctx)
  let parent = parentCandidates[0] || null
  if (!parent) {
    return { _error: mcpError(null, 'E_NO_LIVE_AGENT', 'no live agent available; dsh session must be running to dispatch a task') }
  }

  const taskId = args.task_id
  if (dispatchers.has(taskId)) {
    return { _error: mcpError(null, 'E_DUPLICATE_TASK_ID', 'already running: ' + taskId) }
  }
  dispatchers.set(taskId, { startedAt: Date.now(), status: 'running' })

  const subagents = resolveSubagents(ctx)
  const modelTiers = modelTiersFromEnv()
  const dispatchModel = resolveDispatchModel(args.model_tier || 'flash', modelTiers, DEFAULT_LLM_PROVIDER)
  const model = dispatchModel
    ? (dispatchModel.provider ? dispatchModel.provider + '/' + dispatchModel.model : String(dispatchModel.model))
    : 'inherited(parent)'
  const childAgentOptions = {}
  if (dispatchModel) {
    if (dispatchModel.provider) childAgentOptions.provider = dispatchModel.provider
    if (dispatchModel.model) childAgentOptions.model = dispatchModel.model
  }
  if (Number.isInteger(args.max_tokens) && args.max_tokens > 0) childAgentOptions.maxTokens = args.max_tokens
  else childAgentOptions.maxTokens = DEFAULT_MAX_TOKENS
  const mode = args.mode === 'continuable' ? 'continuable' : 'one-shot'
  const provider = (args.provider === 'fork' || args.provider === 'spawn')
    ? args.provider
    : (mode === 'continuable' ? 'fork' : 'spawn')
  const sharedHistoryN = Number.isInteger(args.shared_history_n) ? args.shared_history_n : 0
  const includeProjectMemory = args.include_project_memory === true
  const dshCwd = parent && parent.session && parent.session.header && parent.session.header.cwd
  let projectMemorySlice = ''
  if (includeProjectMemory && dshCwd && deps.hermesHome) {
    try { projectMemorySlice = await buildProjectMemorySlice(deps.hermesHome, dshCwd) || '' }
    catch (e) { projectMemorySlice = '' }
  }
  const persona = formatPersona(args, foundationSlice || '', {
    mode, provider, sharedHistoryN, parent, ctx,
    projectMemorySlice,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('deadline_ms exceeded')),
    args.deadline_ms || DEFAULT_DEADLINE_MS)
  const startedAt = Date.now()

  appendAudit({
    ts: new Date(startedAt).toISOString(),
    status: 'queued',
    task_id: taskId,
    skill: args.skill,
    model_tier: args.model_tier || 'flash',
    model,
    mode,
    provider,
    parent_agent_id: parent.id,
    deadline_ms: args.deadline_ms || DEFAULT_DEADLINE_MS,
  })

  if (mode === 'continuable') {
    try {
      const started = await spawnWithParentCandidates(parentCandidates, (candidate) => subagents.startContinuable({
        provider,
        label: 'dsh-hermes-link:' + taskId,
        signal: controller.signal,
        request: {
          label: 'dsh-hermes-link:' + taskId,
          prompt: [{ type: 'text', text: args.task }],
          parent: candidate,
          signal: controller.signal,
          toolFilter: { allow: [args.skill] },
          persona,
          agentOptions: childAgentOptions,
          maxDepth: 1,
        },
      }))
      parent = started.parent
      const spawnResult = started.value
      const childId = String(spawnResult.childId)
      const workspace = (parent.session && parent.session.header && parent.session.header.cwd) || ''
      let amendNonce = ''
      if (continuations) {
        const entry = {
          child_id: childId,
          task_id: taskId,
          parent_agent_id: parent.id,
          workspace,
          model,
          model_tier: args.model_tier || 'flash',
          skill: args.skill,
          created_at: startedAt,
          last_seen: startedAt,
          status: 'started',
          stop_reason: null,
          mode,
          initialSpec: args,
        }
        continuations.register(entry)
        const reg = continuations.get(childId)
        amendNonce = (reg && reg.amendNonce) || ''
      }
      clearTimeout(timer)
      if (sseBroker) sseBroker.publish(taskId, { kind: 'lifecycle', data: { status: 'spawned', child_id: childId } })
      appendAudit({
        ts: new Date().toISOString(),
        status: 'continuable_started',
        task_id: taskId,
        child_id: childId,
        parent_agent_id: parent.id,
        model,
        skill: args.skill,
      })
      const amendFileName = amendNonce
        ? 'Use filename pattern: <ts>-' + taskId + '-' + amendNonce + '.json when writing the amend file (v0.2.2+ nonce-authenticated protocol).'
        : '(warning: amend nonce unavailable; amend files will be rejected until the child is re-registered)'
      return {
        content: [{
          type: 'text',
          text: [
            '[dsh-hermes-link v' + VERSION + '] continuable child_id=' + childId,
            'task_id=' + taskId + '  skill=' + args.skill + '  model=' + model,
            'parent_agent_id=' + parent.id,
            'message_id=' + String(spawnResult.messageId),
            '',
            'To continue: dispatch_followup { child_id: "' + childId + '", content: [...] }',
            'To abort: dispatch_interrupt { child_id: "' + childId + '" }',
            amendFileName,
          ].join('\n'),
        }],
        metadata: {
          v0_2_status: 'continuable_started',
          task_id: taskId,
          child_id: childId,
          message_id: String(spawnResult.messageId),
          parent_agent_id: parent.id,
          mode,
          amend_nonce: amendNonce,
          amend_filename_pattern: amendNonce ? ('<ts>-' + taskId + '-' + amendNonce + '.json') : null,
        },
      }
    } catch (e) {
      clearTimeout(timer)
      dispatchers.set(taskId, { startedAt, finishedAt: Date.now(), status: 'error' })
      setTimeout(() => dispatchers.delete(taskId), 60_000)
      appendAudit({
        ts: new Date().toISOString(),
        status: 'error',
        stage: 'continuable_spawn',
        task_id: taskId,
        error: String(e && e.message || e),
      })
      if (sseBroker) {
        sseBroker.publish(taskId, { kind: 'lifecycle', data: { status: 'spawn_failed', error: String(e && e.message || e) } })
        sseBroker.detachTask(taskId, 'spawn_failed')
      }
      return { _error: mcpError(null, 'E_SPAWN_FAILED', 'continuable spawn failed: ' + (e && e.message || e)) }
    }
  }

  // one-shot path
  let runResult, error, run
  try {
    const started = await spawnWithParentCandidates(parentCandidates, (candidate) => subagents.start(PROVIDER_NAME, {
      label: 'dsh-hermes-link:' + taskId,
      prompt: [{ type: 'text', text: args.task }],
      parent: candidate,
      signal: controller.signal,
      toolFilter: { allow: [args.skill] },
      persona,
      agentOptions: childAgentOptions,
      maxDepth: 1,
    }))
    parent = started.parent
    run = started.value
    runResult = await run.result
  } catch (e) {
    error = e
  }
  clearTimeout(timer)
  const finishedAt = Date.now()

  let realTokens = null
  if (run) {
    if (!error) realTokens = measureRealTokens(ctx, run.localAgent)
    try { await run.dispose() } catch {}
  }

  dispatchers.set(taskId, { startedAt, finishedAt, status: error ? 'error' : 'completed' })
  setTimeout(() => dispatchers.delete(taskId), 60_000)

  const outputText = error ? '' : extractOutputText(runResult && runResult.output)
  const stopReason = error ? 'error' : ((runResult && runResult.stopReason) || 'completed')
  appendAudit({
    ts: new Date(finishedAt).toISOString(),
    status: error ? 'error' : stopReason,
    task_id: taskId,
    skill: args.skill,
    model,
    mode: 'one-shot',
    elapsed_ms: finishedAt - startedAt,
    parent_agent_id: parent.id,
    subagent_session_id: run ? run.id : null,
    output_chars: outputText.length,
    real_tokens: realTokens,
  })

  let d1Status = 'skipped'
  if (consultClient) {
    try {
      consultClient.writeResult({
        task_id: taskId,
        status: error ? 'error' : 'ok',
        output: outputText,
        tokens_used: realTokens ? realTokens.total_tokens : null,
        error: error ? String(error && error.message || error) : undefined,
        elapsed_ms: finishedAt - startedAt,
      })
      d1Status = 'written'
    } catch (e) {
      d1Status = 'failed: ' + (e && e.message || e)
    }
  }
  if (outbox) {
    outbox.appendUsage({
      kind: 'dispatch',
      mode: 'one-shot',
      task_id: taskId,
      status: error ? 'error' : 'ok',
      stop_reason: stopReason,
      elapsed_ms: finishedAt - startedAt,
      tokens_used: realTokens ? realTokens.total_tokens : null,
      model,
      skill: args.skill,
    })
  }

  if (error) {
    return { _error: mcpError(null, 'E_DISPATCH_FAILED', 'dispatch failed: ' + (error && error.message || error),
      { task_id: taskId, elapsed_ms: finishedAt - startedAt, d1: d1Status }) }
  }
  return {
    content: [{
      type: 'text',
      text: [
        '[dsh-hermes-link v' + VERSION + '] task_id=' + taskId,
        'skill=' + args.skill + '  model=' + model + '  mode=one-shot',
        'elapsed_ms=' + (finishedAt - startedAt) + '  stop_reason=' + stopReason,
        realTokens ? 'real_tokens: total=' + realTokens.total_tokens + ' surface=' + realTokens.surface_tokens : 'real_tokens: (unavailable)',
        'd1_status=' + d1Status,
        '',
        '--- output ---',
        outputText || '(empty)',
      ].join('\n'),
    }],
    metadata: {
      task_id: taskId,
      status: stopReason,
      elapsed_ms: finishedAt - startedAt,
      d1: d1Status,
      tokens_used: realTokens ? realTokens.total_tokens : null,
      real_tokens: realTokens,
    },
  }
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return 'spec must be a JSON object'
  for (const k of schema.required) {
    if (spec[k] === undefined || spec[k] === null) return 'missing required field: ' + k
  }
  for (const [k, def] of Object.entries(schema.properties)) {
    const v = spec[k]
    if (v === undefined) continue
    if (def.type === 'string') {
      if (typeof v !== 'string') return k + ' must be string'
      if (def.minLength != null && v.length < def.minLength) return k + ' shorter than minLength=' + def.minLength
      if (def.maxLength != null && v.length > def.maxLength) return k + ' longer than maxLength=' + def.maxLength
      if (def.enum && !def.enum.includes(v)) return k + ' must be one of ' + def.enum.join(',')
    } else if (def.type === 'integer') {
      if (!Number.isInteger(v)) return k + ' must be integer'
      if (def.minimum != null && v < def.minimum) return k + ' too small'
      if (def.maximum != null && v > def.maximum) return k + ' too large'
    } else if (def.type === 'array') {
      if (!Array.isArray(v)) return k + ' must be array'
      if (def.maxItems != null && v.length > def.maxItems) return k + ' has more than ' + def.maxItems + ' items'
      const items = def.items
      if (items && typeof items === 'object') {
        const allowed = items.additionalProperties === false ? new Set(Object.keys(items.properties || {})) : null
        for (const item of v) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return k + ' items must be objects'
          if (allowed) {
            for (const ik of Object.keys(item)) if (!allowed.has(ik)) return k + ' item has unknown field: ' + ik
          }
        }
      }
    } else if (def.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return k + ' must be object'
    }
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties))
    for (const k of Object.keys(spec)) if (!allowed.has(k)) return 'unknown field at top level: ' + k
  }
  return null
}

export function formatPersona(args, foundationSlice, opts) {
  opts = opts || {}
  const knowledgeLines = []
  for (const k of (args.knowledge_subset || [])) {
    knowledgeLines.push('  - source: ' + k.source)
    if (k.scope)   knowledgeLines.push('    scope: ' + k.scope)
    if (k.excerpt) knowledgeLines.push('    excerpt: ' + k.excerpt)
    if (k.why)     knowledgeLines.push('    why: ' + k.why)
  }
  const mode = opts.mode || 'one-shot'
  const provider = opts.provider || 'spawn'
  const sharedHistoryN = opts.sharedHistoryN || 0
  const projectMemorySlice = opts.projectMemorySlice || ''
  const parent = opts.parent
  const ctx = opts.ctx
  let sharedHistoryBlock = ''
  if (sharedHistoryN > 0 && parent && ctx) {
    const turns = extractRecentParentTurns(parent, sharedHistoryN)
    const rendered = renderTurnsForContext(turns)
    if (rendered) sharedHistoryBlock = rendered
  }
  return [
    'You are a Hermes-dispatched sub-agent. The orchestrator (Hermes) sent you to do ONE focused task.',
    'Stay narrow; do not delegate; do not invent state outside the task.',
    '',
    '--- hermes-foundation (auto-injected, SOUL only since v0.2.2) ---',
    foundationSlice || '(empty)',
    '--- end hermes-foundation ---',
    projectMemorySlice ? '' : '',
    projectMemorySlice ? '--- hermes project-memory (cwd-scoped, opt-in per dispatch_task) ---' : '',
    projectMemorySlice ? projectMemorySlice : '',
    projectMemorySlice ? '--- end hermes project-memory ---' : '',
    '',
    '--- task envelope (from Hermes) ---',
    'task_id: ' + args.task_id,
    'skill: ' + args.skill,
    'task: ' + args.task,
    'args: ' + JSON.stringify(args.args || {}),
    'model_tier: ' + (args.model_tier || 'flash'),
    'mode: ' + mode,
    'provider: ' + provider,
    sharedHistoryN > 0 ? 'shared_history_n: ' + sharedHistoryN : '',
    'knowledge_subset:',
    knowledgeLines.length ? knowledgeLines.join('\n') : '  (none)',
    '--- end task envelope ---',
    sharedHistoryBlock ? '--- parent shared history (last ' + sharedHistoryN + ' turns) ---' : '',
    sharedHistoryBlock ? sharedHistoryBlock : '',
    sharedHistoryBlock ? '--- end parent shared history ---' : '',
    '',
    'Output: complete the task using the single tool attached to your context (' + args.skill + ').',
    'Return a concise, structured summary; Hermes will relay it to the user.',
    'Do NOT call tools beyond the one allowed tool. Do NOT spawn further sub-agents.',
    '',
    '--- encoding rules (v0.2.3) ---',
    '- The task text is UTF-8. If any CJK text looks garbled (mojibake like ' + String.fromCharCode(0x00ef, 0x00bf, 0x00bd) + ' or ' + String.fromCharCode(0x00b1, 0x00c4, 0x00d0, 0x00d0) + '), do NOT guess-reconstruct it: quote the raw text verbatim in your output and state that it arrived corrupted.',
    '- Copy any user-provided sentinel strings, IDs, and quoted content into tool arguments VERBATIM -- never paraphrase, translate, or "fix" them.',
  ].join('\n')
}

export function extractRecentParentTurns(parent, n) {
  if (!n || n <= 0) return []
  if (!parent || !parent.session) return []
  const events = sessionEvents(parent.session)
  const turns = []
  let lastTurnEnd = null
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e && e.type === 'turn/end') {
      if (lastTurnEnd !== null) {
        const slice = events.slice(i + 1, lastTurnEnd + 1)
        if (slice.length > 0) turns.unshift(slice)
      }
      lastTurnEnd = i
      if (turns.length >= n) break
    }
  }
  if (turns.length < n && lastTurnEnd !== null) {
    const slice = events.slice(0, lastTurnEnd + 1)
    if (slice.length > 0) turns.unshift(slice)
  }
  return turns
}

export function renderTurnsForContext(turns) {
  const lines = []
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    lines.push('--- parent turn ' + (i + 1) + ' ---')
    for (const e of turn) {
      if (!e) continue
      if (e.type === 'user/message' && e.data && e.data.message && Array.isArray(e.data.message.content)) {
        const text = e.data.message.content
          .map((b) => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '')
          .filter(Boolean).join(' ')
        if (text) lines.push('USER: ' + truncate(text, 2000))
      } else if (e.type === 'assistant/message' && e.data && e.data.message && Array.isArray(e.data.message.content)) {
        const text = e.data.message.content
          .map((b) => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '')
          .filter(Boolean).join(' ')
        if (text) lines.push('ASSISTANT: ' + truncate(text, 2000))
      } else if (e.type === 'tool-result' && e.data && e.data.isError) {
        lines.push('TOOL_ERROR: ' + truncate(JSON.stringify(e.data.content), 300))
      }
    }
  }
  return lines.join('\n')
}

export function measureRealTokens(ctx, agent) {
  try {
    if (agent && ctx.tokenMeter) {
      const m = ctx.tokenMeter.measure(agent.session)
      return {
        total_tokens: m.totalTokens,
        surface_tokens: m.surfaceTokens,
        projected_tokens: m.projectedTokens,
        pressure_tokens: m.pressureTokens,
        baseline: m.baseline,
      }
    }
  } catch (e) {
    return { error: 'measure failed: ' + (e && e.message || e) }
  }
  return null
}

export function extractOutputText(content) {
  const parts = []
  for (const block of content || []) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block && block.type === 'reasoning' && typeof block.text === 'string') parts.push('> ' + block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Every live agent a dispatch could use as the parent, most-session-like first.
 *
 * dsh 0.2.x can expose ghost agents whose cordis fiber is no longer admitting
 * work; spawning from one fails with
 *   'cannot get required service "tools" in inactive context'
 * (seen on the Windows cross-machine deployment). The caller therefore tries
 * candidates in order instead of trusting roots()[0].
 */
export function pickParentAgents(ctx) {
  const out = []
  const push = (agent) => { if (agent && !out.includes(agent)) out.push(agent) }
  try { for (const a of (ctx.agents && typeof ctx.agents.roots === 'function' && ctx.agents.roots()) || []) push(a) } catch {}
  try { for (const a of (ctx.agents && typeof ctx.agents.list === 'function' && ctx.agents.list()) || []) push(a) } catch {}
  return out
}

export function pickParentAgent(ctx) {
  return pickParentAgents(ctx)[0] || null
}

/**
 * Run one spawn attempt per parent candidate until one is accepted. Failures
 * that do not look like a dead/inactive parent context are rethrown at once so
 * real dispatch errors keep their original message.
 * @returns {Promise<{parent: object, value: any}>}
 */
export async function spawnWithParentCandidates(candidates, attempt) {
  const list = Array.isArray(candidates) ? candidates : []
  const errors = []
  for (const candidate of list) {
    try {
      return { parent: candidate, value: await attempt(candidate) }
    } catch (e) {
      const message = String((e && e.message) || e)
      errors.push(message)
      if (!/inactive context|not live|required service "tools"|UNAUTHORIZED|NO_LIVE_AGENT/i.test(message)) throw e
    }
  }
  throw new Error('no usable parent agent: ' + (errors.join(' | ') || 'none available'))
}

function truncate(s, max) {
  if (s == null) return ''
  return s.length > max ? s.slice(0, max) + '\n...(' + (s.length - max) + ' chars truncated)' : s
}
