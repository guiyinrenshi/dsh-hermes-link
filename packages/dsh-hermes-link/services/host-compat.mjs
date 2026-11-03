// services/host-compat.mjs
//
// v0.7.0 - subagents-service compatibility layer for the dsh 0.2.x host.
//
// The plugin was written against the dsh 0.1.5 subagents surface:
//   start(name, request) -> { id, result, dispose(), localAgent }
//   startContinuable({ provider, label, signal, request }) -> { childId, messageId }
//   followup(liveParent, childId, content, { signal, source }) -> messageId
//   interrupt(childId, { kind: 'ancestor', agent: parent })
//
// dsh 0.2.x renamed and reshaped the service (observed on 0.2.1-rc.5,
// @deepseek-ai/dsh-subagent/lib/index.js):
//   startActivation({ provider, label, request, signal, childId?, delivery })
//       -> { childId, messageId?, result, dispose() }
//       delivery: 'caller' awaits the result with no parent notice; 'parent'
//       publishes the model-facing completion notice.
//   prompt({ parentSessionId, childSessionId, mode:'continuable',
//            delivery:'queue'|'steer', content }, signal) -> { messageId }
//   interrupt(targetSessionId, authority)        -- SAME shape as before.
//   waitForChildren / drainDescendants / listChildren / list / getProvider
//
// resolveSubagents(ctx) returns the native service unchanged when the old
// methods exist, or a bridge object exposing the old surface when only the
// new methods exist. Unknown shapes pass through unchanged so a future host
// fails at its own call site with a real stack, not inside this shim.
//
// Known 0.2.x semantic deltas this shim CANNOT fully hide (logged once):
//   - per-activation `toolFilter` is not a request field any more
//     ("The selected preset owns persona and tool composition" -
//      dsh-subagent-spawn-in-process README). The allow-list is not enforced;
//      the child runs with its preset/parent tool scope.
//   - per-activation `persona` is likewise request-dead; the shim folds it
//     into the prompt as a leading text block, which preserves the Hermes
//     task-envelope semantics (the child reads it as user content, not as
//     system prompt).

let once = ''
function warnOnce(key, message) {
  if (once.includes(key)) return
  once += key + ';'
  try { console.warn('[dsh-hermes-link] ' + message) } catch {}
}

function asBlocks(prompt) {
  if (typeof prompt === 'string') return [{ type: 'text', text: prompt }]
  if (Array.isArray(prompt)) return prompt.slice()
  return []
}

/** Compact one-line rendering of a host error, keeping its code when present. */
function describeError(e) {
  if (!e) return 'unknown error'
  const code = e.code || (e.data && e.data.reason) || ''
  const msg = e.message || String(e)
  return code ? code + ': ' + msg : msg
}

function normalizeContent(content) {
  // followup content arrives as MCP ContentBlock[] (or a plain string);
  // the host prompt schema accepts strict { type:'text', text } and images.
  const blocks = asBlocks(content)
  const out = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text })
    else if (b.type === 'image') out.push(b)
    else if (typeof b.text === 'string') out.push({ type: 'text', text: b.text })
  }
  return out
}

function foldPersona(request) {
  const blocks = asBlocks(request.prompt)
  let persona = typeof request.persona === 'string' ? request.persona : ''
  if (request.toolFilter && typeof request.toolFilter === 'object') {
    const allow = Array.isArray(request.toolFilter.allow) ? request.toolFilter.allow.join(', ') : ''
    const deny = Array.isArray(request.toolFilter.deny) ? request.toolFilter.deny.join(', ') : ''
    if (allow || deny) {
      warnOnce('toolfilter',
        'host 0.2.x ignores per-activation toolFilter (allow=' + (allow || '(none)') +
        ' deny=' + (deny || '(none)') + '); the dispatched child runs with its preset/parent tool scope. ' +
        'Persona is folded into the prompt instead of a system section.')
    }
    // Tool-scope guidance that used to be enforced is at least stated to the child.
    if (allow) persona += '\nTool policy (advisory, NOT enforced by the host): use only: ' + allow + '.\n'
  }
  if (persona) blocks.unshift({ type: 'text', text: persona })
  return blocks
}

function pickAgentOptions(ao) {
  if (!ao || typeof ao !== 'object') return undefined
  const out = {}
  if (typeof ao.provider === 'string' && ao.provider) out.provider = ao.provider
  if (typeof ao.model === 'string' && ao.model) out.model = ao.model
  if (typeof ao.reasoningEffort === 'string' && ao.reasoningEffort) out.reasoningEffort = ao.reasoningEffort
  if (Number.isInteger(ao.maxTokens) && ao.maxTokens > 0) out.maxTokens = ao.maxTokens
  return Object.keys(out).length > 0 ? out : undefined
}

function baseRequest(request) {
  const out = {
    parent: request.parent,
    prompt: foldPersona(request),
  }
  if (typeof request.cwd === 'string' && request.cwd) out.cwd = request.cwd
  if (typeof request.agentPreset === 'string' && request.agentPreset) out.agentPreset = request.agentPreset
  const ao = pickAgentOptions(request.agentOptions)
  if (ao) out.agentOptions = ao
  if (Number.isInteger(request.maxDepth)) out.maxDepth = request.maxDepth
  if (request.outputSchema && typeof request.outputSchema === 'object') out.outputSchema = request.outputSchema
  return out
}

function signalOf(sig) {
  return sig && typeof sig.aborted === 'boolean' ? sig : new AbortController().signal
}

export function isNativeOldSurface(sa) {
  return !!sa && typeof sa.start === 'function' && typeof sa.startContinuable === 'function' && typeof sa.followup === 'function'
}

export function isBridgeable02x(sa) {
  return !!sa && !isNativeOldSurface(sa) && typeof sa.startActivation === 'function' && typeof sa.prompt === 'function'
}

/**
 * Resolve the subagents surface the plugin call sites should use.
 * Never throws and never mutates ctx: call sites simply switch from
 * `ctx.subagents.X` to `resolveSubagents(ctx).X`.
 */
export function resolveSubagents(ctx) {
  const sa = ctx && ctx.subagents
  if (!sa) return sa
  if (isNativeOldSurface(sa)) return sa
  if (!isBridgeable02x(sa)) {
    warnOnce('unknown', 'ctx.subagents exposes neither the 0.1.x surface (start/startContinuable/followup) nor the 0.2.x surface (startActivation/prompt); dispatch will fail at the call site with the host error.')
    return sa
  }

  const chooseProvider = (wanted) => {
    // Registered names on 0.2.1-rc.5: 'spawn' and 'fork' (defaults of
    // dsh-subagent-spawn-in-process / dsh-subagent-fork-in-process).
    // getProvider is a facade method; if the wanted name is absent, fall back.
    let found = null
    try { found = typeof sa.getProvider === 'function' ? sa.getProvider(wanted) : null } catch { found = null }
    if (found) return wanted
    for (const alt of ['spawn', 'fork']) {
      try { if (typeof sa.getProvider === 'function' ? sa.getProvider(alt) : null) return alt } catch {}
    }
    return wanted // let the host raise its own NOT_FOUND with a real message
  }

  const bridge = {
    __hermesLinkCompat: '0.2.x',
    list() { try { return typeof sa.list === 'function' ? sa.list() : [] } catch { return [] } },
    getProvider(name) { try { return sa.getProvider(name) } catch { return undefined } },

    // one-shot: old start(name, request) -> run { id, result, dispose, localAgent }
    async start(name, request) {
      const provider = chooseProvider(name)
      const act = await sa.startActivation({
        provider,
        label: request.label || 'dsh-hermes-link',
        request: baseRequest(request),
        signal: signalOf(request.signal),
        delivery: 'caller',
      })
      const run = {
        id: act.childId,
        childId: act.childId,
        result: act.result,
        dispose: async () => { await act.dispose() },
      }
      // measureRealTokens(ctx, run.localAgent) - the receipt has no agent, so
      // expose the live child when it is still resident; null -> "(unavailable)".
      Object.defineProperty(run, 'localAgent', {
        enumerable: false,
        get() { try { return ctx.agents ? ctx.agents.get(act.childId) || null : null } catch { return null } },
      })
      return run
    },

    // continuable: old startContinuable({provider,label,signal,request}) -> {childId,messageId}
    async startContinuable(spec) {
      const provider = chooseProvider(spec.provider)
      const act = await sa.startActivation({
        provider,
        label: spec.label || (spec.request && spec.request.label) || 'dsh-hermes-link',
        request: baseRequest(spec.request || {}),
        signal: signalOf(spec.signal || (spec.request && spec.request.signal)),
        delivery: 'parent',
      })
      return { childId: act.childId, messageId: act.messageId }
    },

    // followup: old followup(liveParent, childId, content, {signal, source}) -> messageId
    //
    // 0.2.x exposes two faces for the same delivery:
    //   - prompt(...)      the REMOTE-CONTROL face (browser / JSON-RPC). It builds
    //                      its source from `this.ctx.invocation`, so a plugin
    //                      calling it out of band throws inside the host and the
    //                      caller only sees the opaque "subagent prompt failed".
    //   - sendMessage(...) the HOST-ADAPTER face: an exact live Agent sender and
    //                      no invocation context required. This is the one a
    //                      plugin must use.
    // sendMessage delivers as a steer (an idle child starts a turn), which is
    // what a followup wants; prompt() stays as a fallback, and both errors are
    // surfaced instead of being collapsed into "spawn failed".
    async followup(liveParent, childId, content, opts) {
      opts = opts || {}
      const signal = signalOf(opts.signal)
      const blocks = normalizeContent(content)
      const failures = []
      if (typeof sa.sendMessage === 'function') {
        try {
          const id = await sa.sendMessage(liveParent, childId, blocks, { signal })
          if (id) return id
          failures.push('sendMessage returned no message id')
        } catch (e) { failures.push('sendMessage: ' + describeError(e)) }
      } else failures.push('sendMessage unavailable')
      if (typeof sa.prompt === 'function') {
        try {
          const delivery = opts.delivery === 'steer' ? 'steer' : 'queue'
          const res = await sa.prompt({
            parentSessionId: liveParent.id,
            childSessionId: childId,
            mode: 'continuable',
            delivery,
            content: blocks,
          }, signal)
          if (res && res.messageId) return res.messageId
          failures.push('prompt returned no message id')
        } catch (e) { failures.push('prompt: ' + describeError(e)) }
      }
      throw new Error('followup delivery failed on the 0.2.x host - ' + failures.join('; '))
    },

    // interrupt: identical shape on both surfaces - bridge straight through.
    interrupt(childId, authority) { return sa.interrupt(childId, authority) },
    waitForChildren(parent) { return sa.waitForChildren(parent) },
    drainDescendants(parents) { return sa.drainDescendants(parents) },
    listChildren(parentSessionId, signal) { return sa.listChildren(parentSessionId, signalOf(signal)) },
  }
  return bridge
}
