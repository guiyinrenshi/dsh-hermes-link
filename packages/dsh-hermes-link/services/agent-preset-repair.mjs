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

/** The preset id early versions pinned on every import. */
export const LEGACY_IMPORT_PRESET = 'hermes-imported'

/**
 * Pick the agent preset to record on a freshly imported session.
 * @param {object} ctx cordis context (optional agentPresets service)
 * @param {string} wanted preset id to keep when available
 * @returns {Promise<string|undefined>} the id to pin, or undefined (host default)
 */
export async function decideImportPreset(ctx, wanted = LEGACY_IMPORT_PRESET) {
  const registry = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
  if (!registry || typeof registry.list !== 'function') {
    // No registry in this composition: do not pin an id that may not resolve.
    return undefined
  }
  try {
    const rows = await registry.list()
    const ids = (Array.isArray(rows) ? rows : []).map((row) => row && row.id)
    return ids.includes(wanted) ? wanted : undefined
  } catch {
    return undefined
  }
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
