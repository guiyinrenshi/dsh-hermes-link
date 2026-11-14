// services/agent-preset-repair.mjs
//
// v0.8.1 — imported sessions used to pin `agentPreset: 'hermes-imported'`.
//
// dsh resolves that field when a session is resumed; on a host that never
// declared such a preset the resume fails with
//   Unknown agent preset: hermes-imported
// (dsh 0.2.x ships `standard`, `ptc`, `minimal`, `cordis` — nothing else).
//
// Two fixes live here:
//   - decideImportPreset(): keep the pin only when the host actually declares it
//   - stripAgentPreset()/rewriteStoredHeader(): migrate sessions that already
//     carry the stale pin back to the host default (omit the field)
//
// Both are pure apart from the explicit zstd codec calls, so they are unit
// testable without a running dsh.

import zlib from 'node:zlib'
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyStoredPins,
  presetRosterState,
  scanStoredPins,
  usablePresetIds,
} from './preset-health.mjs'

/** The preset id early versions pinned on every import. */
export const LEGACY_IMPORT_PRESET = 'hermes-imported'

/** Imported sessions carry this id prefix; the repair never looks at the rest. */
export const IMPORTED_SESSION_PREFIX = 'hermes-'

/**
 * The host's preset roster, or null when it cannot be read.
 * @param {object} ctx cordis context
 * @returns {Promise<any[]|null>}
 */
export async function presetRows(ctx) {
  const registry = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
  if (!registry || typeof registry.list !== 'function') return null
  try {
    const rows = await registry.list()
    return Array.isArray(rows) ? rows : null
  } catch {
    return null
  }
}

/**
 * Pick the agent preset to record on a freshly imported session.
 *
 * v0.8.1 checked only that the host DECLARES the id. That is not enough: a
 * declared preset whose plugin tree failed to mount is reported with `broken`,
 * and resuming a session that pins it fails exactly like an unknown one
 * (`agent-preset/invalid` from the registry's retain()), which the GUI renders as
 * the sidebar row disappearing. 2026-11-14 hit precisely that: the compatibility
 * alias was declared, one of its rows named `@deepseek-ai/dsh-tool-subagent-control/list-agents`,
 * dsh 0.2.1-rc.3 removed that subpath export (upstream issue #1940), the alias
 * never mounted, and all eleven imported sessions became unopenable while sessions
 * created in the GUI kept working.
 *
 * @param {object} ctx cordis context (optional agentPresets service)
 * @param {string} wanted preset id to keep when available
 * @returns {Promise<string|undefined>} the id to pin, or undefined (host default)
 */
export async function decideImportPreset(ctx, wanted = LEGACY_IMPORT_PRESET) {
  return decideImportPresetFrom(await presetRows(ctx), wanted)
}

/** The same decision against an already-read roster (null = roster unknown). */
export function decideImportPresetFrom(rows, wanted = LEGACY_IMPORT_PRESET) {
  if (!Array.isArray(rows)) return undefined
  return usablePresetIds(rows).includes(wanted) ? wanted : undefined
}

/**
 * Self-heal the sessions on disk whose pinned preset the running host cannot
 * resume — the situation the 2026-11-14 incident left behind, where every click
 * on an imported conversation failed at activation and the row vanished.
 *
 * Only the header's `agentPreset` field changes (to `to`, or omitted when `to` is
 * empty), each file is copied to `<file>.bak-agentpreset-<stamp>` first, and the
 * roster decides: a pin the host declares and mounts is never touched, so this is
 * safe to run at every start. Callers that want a report without changing anything
 * pass `dryRun: true`.
 *
 * @param {object} opts
 * @param {any[]|null} opts.rows the host roster (null = unknown: nothing is repaired)
 * @param {string} opts.sessionsRoot <dshHome>/sessions
 * @param {string} [opts.prefix='hermes-'] which session ids to consider
 * @param {string} [opts.to=''] preset id to pin instead of omitting the field
 * @param {boolean} [opts.dryRun=false]
 * @param {(msg: string) => void} [opts.log]
 * @returns {{scanned: number, unusable: number, repaired: string[], skipped: string[], reason: Record<string,string>}}
 */
export function repairStalePins({ rows, sessionsRoot, prefix = IMPORTED_SESSION_PREFIX, to = '', dryRun = false, log = null } = {}) {
  const say = (msg) => { if (typeof log === 'function') log(msg) }
  if (!Array.isArray(rows)) {
    say('agent-preset repair: the host roster is unavailable, so nothing was rewritten')
    return { scanned: 0, unusable: 0, repaired: [], skipped: [], reason: {}, error: 'roster-unavailable' }
  }
  const scan = scanStoredPins(sessionsRoot, { prefix })
  const verdict = classifyStoredPins(scan.pins, rows)
  const reason = {}
  for (const problem of verdict.unusable) reason[problem.sessionId] = problem.state + ': ' + (problem.reason || '')
  const out = { scanned: scan.scanned, unusable: verdict.unusable.length, repaired: [], skipped: [], reason }
  if (verdict.unusable.length === 0) return out
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const problem of verdict.unusable) {
    const dir = findSessionDir(sessionsRoot, problem.sessionId)
    if (!dir) { out.skipped.push(problem.sessionId + ': file not found'); continue }
    let compressed
    try { compressed = readFileSync(dir.file) } catch (e) { out.skipped.push(problem.sessionId + ': ' + (e && e.message || e)); continue }
    const rewritten = rewriteStoredHeader(compressed, { from: problem.preset, to })
    if (!rewritten.changed) { out.skipped.push(problem.sessionId + ': ' + (rewritten.skipped || 'no change')); continue }
    // The ids stay clean in the result; the dry-run wording belongs to the log.
    if (dryRun) { out.repaired.push(problem.sessionId); say('would unpin ' + problem.sessionId + ' from ' + problem.preset + ' (dry run) -- ' + reason[problem.sessionId]); continue }
    try {
      copyFileSync(dir.file, dir.file + '.bak-agentpreset-' + stamp)
      const tmp = dir.file + '.tmp-agentpreset'
      writeFileSync(tmp, rewritten.data)
      renameSync(tmp, dir.file)
      out.repaired.push(problem.sessionId)
      say('unpinned ' + problem.sessionId + ' from ' + problem.preset + ' (' + reason[problem.sessionId] + ')')
    } catch (e) {
      out.skipped.push(problem.sessionId + ': ' + (e && e.message || e))
      try { if (existsSync(dir.file + '.tmp-agentpreset')) renameSync(dir.file + '.tmp-agentpreset', dir.file + '.failed-' + stamp) } catch (_e) { /* leave it */ }
    }
  }
  return out
}

/** Locate one session's log file by id, whichever project owns it. */
function findSessionDir(sessionsRoot, sessionId) {
  const names = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']
  let projects = []
  try { projects = readdirSync(sessionsRoot, { withFileTypes: true }) } catch { return null }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    for (const n of names) {
      const file = join(sessionsRoot, p.name, sessionId, n)
      if (existsSync(file)) return { file, project: p.name }
    }
  }
  return null
}

/** Copy a header without its agentPreset pin (never mutates the input). */
export function stripAgentPreset(header, from = LEGACY_IMPORT_PRESET) {
  if (!header || typeof header !== 'object') return header
  if (typeof header.agentPreset !== 'string') return header
  if (from !== null && header.agentPreset !== from) return header
  const { agentPreset, ...rest } = header
  void agentPreset
  return rest
}

/**
 * Rewrite the header line of one stored session log.
 * @param {Buffer} compressed the `.jsonl.zstd` file bytes
 * @param {object} opts
 * @param {string|null} [opts.from] only rewrite when the header pins this id (null = any)
 * @param {string} [opts.to] preset id to pin instead of omitting the field
 * @returns {{changed: boolean, skipped?: string, header?: object, data?: Buffer}}
 */
export function rewriteStoredHeader(compressed, { from = LEGACY_IMPORT_PRESET, to = '' } = {}) {
  const text = zlib.zstdDecompressSync(compressed).toString('utf8')
  const lines = text.split('\n')
  if (lines.length === 0 || lines[0].trim() === '') return { changed: false, skipped: 'empty' }
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    return { changed: false, skipped: 'header-not-json' }
  }
  if (!header || typeof header !== 'object') return { changed: false, skipped: 'header-not-object' }
  if (from !== null && header.agentPreset !== from) return { changed: false, skipped: 'preset-not-pinned' }
  if (typeof header.agentPreset !== 'string' && to === '') return { changed: false, skipped: 'no-preset' }
  const nextHeader = to
    ? { ...header, agentPreset: to }
    : stripAgentPreset(header, null)
  const nextHeaderJson = JSON.stringify(nextHeader)
  // The jsonl backend stores the header in its OWN zstd frame and asserts that
  // this first frame decodes to exactly one line:
  //   "corrupt Zstandard session log: first frame is not exactly one header line"
  // (plaintext must end with the only newline). Compressing header+events into
  // one frame silently makes the session unreadable, so emit two frames.
  const frameHeader = zlib.zstdCompressSync(Buffer.from(nextHeaderJson + '\n', 'utf8'))
  const decodedHeader = zlib.zstdDecompressSync(frameHeader).toString('utf8')
  if (decodedHeader !== nextHeaderJson + '\n') {
    throw new Error('agent-preset repair: header frame self-check failed')
  }
  const rest = lines.slice(1).join('\n')
  const frames = [frameHeader]
  if (rest.length > 0) frames.push(zlib.zstdCompressSync(Buffer.from(rest, 'utf8')))
  return { changed: true, header: nextHeader, data: Buffer.concat(frames) }
}
