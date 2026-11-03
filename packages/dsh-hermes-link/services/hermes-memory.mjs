// services/hermes-memory.mjs
//
// Pure reader for Hermes long-term memory files. No host dependencies, so the
// behaviour is unit-testable outside a running dsh.
//
// Hermes stores cross-project memory in <Hermes Home>/memories/MEMORY.md and a
// user profile in <Hermes Home>/memories/USER.md. `load_hermes_persona` returns
// only SOUL.md + config slices, and `load_hermes_project_memory` only returns
// MEMORY.md lines whose surrounding context matches the current DSH cwd. When
// Hermes runs on another host there is usually no cwd overlap, so without this
// reader the memory is unreachable.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MEMORY_FILES = {
  memory: 'memories/MEMORY.md',
  user: 'memories/USER.md',
}

export const DEFAULT_MAX_BYTES = 32768
export const MAX_MAX_BYTES = 131072

/**
 * Read one or both Hermes memory files.
 * @param {object} options
 * @param {string} options.hermesHome Hermes Home directory.
 * @param {'all'|'memory'|'user'} [options.which] Default: all.
 * @param {number} [options.maxBytes] Per-file cap (1 KiB … 128 KiB).
 * @returns {{text: string, files: Array<{file: string, present: boolean, bytes: number, error?: string}>}}
 */
export function readHermesMemory({ hermesHome, which = 'all', maxBytes } = {}) {
  const cap = Math.min(Math.max(Number(maxBytes || DEFAULT_MAX_BYTES), 1024), MAX_MAX_BYTES)
  const wanted = which === 'all' ? ['memory', 'user'] : [which]
  const parts = []
  const files = []
  for (const key of wanted) {
    const rel = MEMORY_FILES[key]
    if (!rel) continue
    const path = join(hermesHome, rel)
    if (!existsSync(path)) {
      files.push({ file: rel, present: false, bytes: 0 })
      continue
    }
    let raw = ''
    try {
      raw = readFileSync(path, 'utf8')
    } catch (e) {
      files.push({ file: rel, present: true, bytes: 0, error: String((e && e.message) || e) })
      continue
    }
    const clipped = raw.length > cap
      ? raw.slice(0, cap) + `\n<!-- truncated at ${cap} bytes; full file: ${path} -->`
      : raw
    parts.push(`<!-- Hermes ${rel} (${path}) -->\n${clipped}`)
    files.push({ file: rel, present: true, bytes: raw.length })
  }
  const text = parts.length === 0
    ? 'No Hermes memory files found in ' + hermesHome + '\n' + JSON.stringify(files, null, 2)
    : parts.join('\n\n')
  return { text, files }
}
