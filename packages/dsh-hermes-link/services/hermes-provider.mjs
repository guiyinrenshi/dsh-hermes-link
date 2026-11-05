// services/hermes-provider.mjs
//
// v0.8.0 — use Hermes Agent as a real DSH SUBAGENT provider.
//
// dsh 0.2.x lets a plugin register an external subagent backend:
//   ctx.subagents.registerProvider({ name, capabilities, start(request) })
// The manager then routes `startActivation({ provider: 'hermes', ... })` to
// `start(request)` and treats the returned `{ result, dispose }` like any other
// child activation (telemetry, abort, teardown).
//
// The backend shells out to Hermes' documented one-shot mode:
//   hermes -z "<prompt>" --in <cwd> [--resume latest|<id>] [args]
// `-z` prints ONLY the final response text, loads tools/memory/rules as usual
// and auto-bypasses approvals, which is exactly the "child agent" semantic we
// want. The provider is deliberately stateless: continuity is Hermes' own
// session mechanism (`--in DIR --resume latest`), so nothing has to be kept in
// DSH between calls.

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Prompt blocks -> one plain string for the Hermes CLI. */
export function promptText(prompt) {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  return prompt
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * Build the argv for one Hermes one-shot run.
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.resume] 'latest', a session id/title, or '' for a fresh session
 * @param {string} [opts.model]
 * @param {string} [opts.provider]
 * @param {string} [opts.reasoning]
 * @param {string} [opts.toolset]
 * @param {string[]} [opts.extraArgs]
 * @returns {string[]}
 */
export function buildHermesArgs({ prompt, resume = '', model = '', provider = '', reasoning = '', toolset = '', extraArgs = [] } = {}) {
  const args = ['-z', String(prompt == null ? '' : prompt)]
  if (resume) args.push('--resume', String(resume))
  if (model) args.push('-m', String(model))
  if (provider) args.push('--provider', String(provider))
  if (reasoning) args.push('--reasoning', String(reasoning))
  if (toolset) args.push('-t', String(toolset))
  for (const a of Array.isArray(extraArgs) ? extraArgs : []) {
    if (typeof a === 'string' && a.length > 0) args.push(a)
  }
  return args
}

/** PATH with the usual Hermes CLI locations appended, so a systemd unit finds it. */
export function hermesPath(basePath) {
  const parts = String(basePath || process.env.PATH || '').split(':').filter(Boolean)
  const extra = [join(homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin']
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir)
  return parts.join(':')
}

/** Locate the Hermes CLI: explicit bin, HERMES_BIN, then common install paths. */
export function resolveHermesBin(explicit) {
  const candidates = [explicit, process.env.HERMES_BIN, join(homedir(), '.local', 'bin', 'hermes'), '/usr/local/bin/hermes']
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0 && existsSync(c)) return c
  }
  return 'hermes'
}

/**
 * Create the `hermes` subagent provider.
 * @param {object} opts
 * @param {string} opts.bin resolved Hermes CLI path
 * @param {object} [opts.env] extra environment variables
 * @param {Function} [opts.spawnImpl] injectable spawn (tests)
 * @param {number} [opts.killGraceMs]
 * @returns {object} a dsh SubagentProvider for external execution
 */
export function createHermesProvider({ bin, env = {}, spawnImpl = nodeSpawn, killGraceMs = 2000 } = {}) {
  return {
    name: 'hermes',
    // The backend executes an external CLI: it neither understands DSH agent
    // options nor presets, and it has no bounded recursion of its own.
    capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, agentPreset: false },
    inheritsParentContext: false,
    start(request) {
      const prompt = promptText(request && request.prompt)
      if (!prompt) {
        return {
          result: Promise.resolve({ output: [], stopReason: 'error', error: 'empty prompt' }),
          async dispose() {},
        }
      }
      // '' or 'new' means a fresh session; anything else is a Hermes session id/title
      // (or 'latest' for the newest session in this workdir).
      const rawResume = typeof request.resume === 'string' ? request.resume.trim() : 'latest'
      const resume = rawResume === 'new' ? '' : rawResume
      const args = buildHermesArgs({
        prompt,
        resume,
        model: request.model,
        provider: request.provider,
        reasoning: request.reasoning,
        toolset: request.toolset,
        extraArgs: request.extraArgs,
      })
      const child = spawnImpl(bin, args, {
        cwd: typeof request.cwd === 'string' && request.cwd ? request.cwd : process.cwd(),
        env: { ...process.env, ...env, PATH: hermesPath((env && env.PATH) || process.env.PATH) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let settled = false
      let killTimer = null
      if (child.stdout) child.stdout.setEncoding('utf8')
      if (child.stderr) child.stderr.setEncoding('utf8')
      if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk })
      if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk })

      const terminate = () => {
        try { child.kill('SIGTERM') } catch {}
        killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, killGraceMs)
        if (killTimer && typeof killTimer.unref === 'function') killTimer.unref()
      }
      const onAbort = () => terminate()
      if (request.signal && typeof request.signal.addEventListener === 'function') {
        if (request.signal.aborted) terminate()
        else request.signal.addEventListener('abort', onAbort, { once: true })
      }

      const result = new Promise((resolve) => {
        const finish = (stopReason, error) => {
          if (settled) return
          settled = true
          if (killTimer) clearTimeout(killTimer)
          if (request.signal && typeof request.signal.removeEventListener === 'function') {
            request.signal.removeEventListener('abort', onAbort)
          }
          resolve({
            output: stdout.trim().length > 0 ? [{ type: 'text', text: stdout.trim() }] : [],
            stopReason,
            ...(error ? { error: String(error) } : {}),
          })
        }
        child.on('error', (e) => finish('error', e && e.message ? e.message : String(e)))
        child.on('close', (code, sig) => {
          if (code === 0) return finish('completed')
          finish('error', 'hermes exited with ' + (code === null ? 'signal ' + sig : 'code ' + code) +
            (stderr.trim() ? ': ' + stderr.trim().slice(-2000) : ''))
        })
      })

      return {
        result,
        async dispose() {
          terminate()
        },
      }
    },
  }
}
