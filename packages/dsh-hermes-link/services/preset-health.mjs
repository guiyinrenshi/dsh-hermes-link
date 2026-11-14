// services/preset-health.mjs
//
// v0.8.6 -- the guard the 2026-11-14 incident proved necessary.
//
// What happened: every imported session header pins an agent preset
// (services/agent-preset-repair.mjs, v0.8.1). dsh resolves that field on resume.
// A host that never declares the id fails with `Unknown agent preset: X`
// (RemoteError agent-preset/not-found); a host that DECLARES the id but cannot
// MOUNT its plugin tree fails with RemoteError agent-preset/invalid instead.
// Both throw at activation, and dsh-api-session-controller turns a failed
// activation into 'session/disposed' -> 'api-session/removed', so the row simply
// vanishes from the sidebar. Nothing on disk is wrong, which is why no amount of
// reading around the session file explains it.
//
// On that machine the mount failure came from one row of the compatibility alias
// declared in ~/.dsh/profiles/web/cordis.patch.yml:
//
//   - id: tool-subagent-list-agents
//     name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
//
// dsh 0.2.1-rc.3 removed that subpath export (upstream issue #1940; the
// registration moved into the package's own apply()), so importing the row threw
// ERR_PACKAGE_PATH_NOT_EXPORTED, the WHOLE preset was marked `broken`, and the
// eleven sessions that pinned it became unopenable -- while every session created
// in the GUI kept working, because the builtin presets do not name that row.
//
// Two things follow, and both live here so the importer, the doctor and the CLI
// share ONE implementation:
//
//   1. rosterRowIsUsable()/usablePresetIds() -- a roster row is usable only when
//      the host did not attach a mount failure to it. Presence is NOT enough.
//   2. auditPresetConfigs() -- a preset declared in the profile can be checked
//      OFFLINE, before any session touches it: every plugin row's package and
//      subpath must resolve in the installed trees. This is the check that would
//      have named the bad row at boot instead of at the first click.
//
// Pure apart from the explicit fs/zstd reads, so all of it is unit testable
// without a running dsh (scripts/test-preset-health.mjs).

import zlib from 'node:zlib'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The cordis plugin whose config block DECLARES an agent preset. */
export const PRESET_PLUGIN_NAME = '@deepseek-ai/dsh-agent-preset'

/** Session log file names, newest format first (dsh 0.2.x writes v4). */
const SESSION_FILE_NAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']

// -----------------------------------------------------------------------------
// 1. the roster: what a running host says
// -----------------------------------------------------------------------------

/**
 * Is one `agentPresets.list()` row actually resumable?
 *
 * The host keeps a row whose tree failed to mount in the roster and marks it:
 * dsh-agent-preset-registry/src/index.ts does `record.broken = error.message`
 * and `diagnostic()` returns that message while the record has no generation.
 * A broken row is as unopenable as a missing one -- and the failure is FINAL for
 * the process: nothing re-mounts it until dsh restarts. So presence alone is not
 * enough (that was the 0.8.1 guard's blind spot).
 *
 * @param {any} row
 * @returns {boolean}
 */
export function rosterRowIsUsable(row) {
  if (!row || typeof row !== 'object') return false
  if (typeof row.id !== 'string' || row.id === '') return false
  if (row.enabled === false) return false
  return row.broken === undefined || row.broken === null || row.broken === false
}

/** The ids a session may safely pin: declared AND mountable. */
export function usablePresetIds(rows) {
  return (Array.isArray(rows) ? rows : []).filter(rosterRowIsUsable).map((row) => row.id)
}

/**
 * What the roster says about one preset id.
 * @param {any[]|null|undefined} rows null/undefined = the roster was not readable
 * @param {string} id
 * @returns {{state: 'unknown'|'ok'|'broken'|'undeclared', reason: string|null}}
 */
export function presetRosterState(rows, id) {
  // Nothing pinned means the host default, which is always resumable: report
  // 'unknown' so no caller mistakes it for an undeclared id.
  if (typeof id !== 'string' || id === '') return { state: 'unknown', reason: null }
  if (!Array.isArray(rows)) return { state: 'unknown', reason: null }
  const row = rows.find((r) => r && r.id === id)
  if (!row) return { state: 'undeclared', reason: 'the host does not declare this preset id' }
  if (row.enabled === false) return { state: 'undeclared', reason: 'the preset is declared but disabled' }
  const broken = row.broken
  if (broken === undefined || broken === null || broken === false) return { state: 'ok', reason: null }
  // `broken: true` without a message still counts as broken.
  return { state: 'broken', reason: typeof broken === 'string' && broken ? broken : 'the preset failed to mount' }
}

/**
 * Classify the preset ids stored in session headers against the roster.
 * @param {Array<{sessionId: string, preset: string|null}>} pins from scanStoredPins()
 * @param {any[]|null} rows
 * @returns {{checked: number, unusable: Array<{sessionId: string, preset: string, state: string, reason: string|null}>, presets: Record<string, number>}}
 */
export function classifyStoredPins(pins, rows) {
  const list = Array.isArray(pins) ? pins : []
  const unusable = []
  const presets = {}
  for (const pin of list) {
    if (!pin || typeof pin.preset !== 'string' || pin.preset === '') continue
    presets[pin.preset] = (presets[pin.preset] || 0) + 1
    const state = presetRosterState(rows, pin.preset)
    if (state.state === 'ok' || state.state === 'unknown') continue
    unusable.push({ sessionId: pin.sessionId, preset: pin.preset, state: state.state, reason: state.reason })
  }
  return { checked: list.length, unusable, presets }
}

// -----------------------------------------------------------------------------
// 2. the offline audit: does a declared preset RESOLVE in what is installed?
// -----------------------------------------------------------------------------

/**
 * Pull every declared agent preset out of one cordis YAML document.
 *
 * Deliberately line/indent based rather than a real YAML parse: the plugin has no
 * YAML dependency (cordis ships one, but the doctor CLI and the tests must run
 * standalone), and the shape to read is the narrow one dsh writes -- a list of
 * `- id: / name: / config: { id:, plugins: [ - id:, name: ] }` entries. Only
 * blocks whose plugin is '@deepseek-ai/dsh-agent-preset' are returned.
 *
 * @param {string} text YAML source
 * @param {string} [file] reported back verbatim
 * @returns {Array<{file: string, entryId: string, preset: string, rows: Array<{id: string, name: string, disabled: boolean}>}>}
 */
export function extractDeclaredPresets(text, file = '') {
  const lines = String(text || '').split(/\r?\n/)
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const nameMatch = /^(\s*)name:\s*['"]?(@?[^'"\s#]+(?:\/[^'"\s#]+)?)['"]?\s*$/.exec(lines[i])
    if (!nameMatch || nameMatch[2] !== PRESET_PLUGIN_NAME) continue
    const nameIndent = nameMatch[1].length
    const entryIndent = Math.max(nameIndent - 2, 0)
    let end = i + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line.trim() === '') { end++; continue }
      const indent = line.match(/^\s*/)[0].length
      if (indent <= entryIndent) break
      end++
    }
    const block = lines.slice(i, end)
    const entryId = capture(lines[i - 1], /\bid:\s*['"]?([^'"\s#]+)['"]?/) || ''
    const preset = captureAll(block, /^\s{2,}id:\s*['"]?([^'"\s#]+)['"]?/)
    const rows = pluginRowsInBlock(block)
    if (preset) found.push({ file, entryId, preset, rows })
    i = end - 1
  }
  return found
}

function capture(line, re) {
  const m = re.exec(String(line || ''))
  return m ? m[1] : null
}

function captureAll(lines, re) {
  for (const line of lines) {
    const m = re.exec(line)
    if (m) return m[1]
  }
  return null
}

/**
 * Every `- id: <row>\n  name: <package>[/subpath]` pair under a block's
 * `plugins:` list, with `disabled: true` / `enabled: false` carried through.
 */
function pluginRowsInBlock(block) {
  const rows = []
  let inPlugins = false
  let pluginsIndent = -1
  let pending = null
  const flush = () => { if (pending && pending.name) rows.push(pending); pending = null }
  for (const line of block) {
    if (!line.trim()) continue
    const indent = line.match(/^\s*/)[0].length
    if (!inPlugins) {
      if (/^\s*plugins:\s*$/.test(line)) { inPlugins = true; pluginsIndent = indent }
      continue
    }
    if (indent <= pluginsIndent && !/^\s*-\s/.test(line)) { inPlugins = false; flush(); continue }
    const rowStart = /^\s*-\s+id:\s*['"]?([^'"\s#]+)['"]?/.exec(line)
    if (rowStart) { flush(); pending = { id: rowStart[1], name: '', disabled: false }; continue }
    if (!pending) continue
    const name = /^\s*name:\s*['"]?([^'"\s#]+)['"]?/.exec(line)
    if (name) { pending.name = name[1]; continue }
    const off = /^\s*(?:enabled:\s*false|disabled:\s*true)\b/.exec(line)
    if (off) pending.disabled = true
  }
  flush()
  return rows
}

/**
 * Where an installed dsh keeps the packages a preset row can name: the profile's
 * own node_modules (the plugin, plus every profile dependency) and the app
 * bundle under the global launcher (dsh's own node_modules).
 *
 * @returns {string[]} existing directories only, most specific first
 */
export function packageSearchRoots({ dshHome = null, profile = null, env = process.env } = {}) {
  const roots = []
  const push = (p) => { if (p && existsSync(p) && !roots.includes(p)) roots.push(p) }
  if (dshHome) {
    const profilesDir = join(dshHome, 'profiles')
    if (profile) push(join(profilesDir, profile, 'node_modules'))
    else {
      try {
        for (const e of readdirSync(profilesDir, { withFileTypes: true })) if (e.isDirectory()) push(join(profilesDir, e.name, 'node_modules'))
      } catch (_e) { /* no profiles dir */ }
    }
  }
  // The global install that owns the app packages:
  //   /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*
  // DSH_INSTALL_DIR points the audit at a non-standard install.
  const guesses = []
  if (env.DSH_INSTALL_DIR) guesses.push(join(env.DSH_INSTALL_DIR, 'node_modules'))
  guesses.push(join(dirname(process.execPath), '..', 'lib', 'node_modules'))
  for (const g of guesses) {
    push(join(g, '@deepseek-ai', 'dsh', 'node_modules'))
    push(g)
  }
  // Running from inside a checkout: <repo>/node_modules and the plugin's own.
  try {
    const here = dirname(new URL(import.meta.url).pathname)
    push(join(here, '..', '..', '..', 'node_modules'))
    push(join(here, '..', '..', '..', '..', '..', 'node_modules'))
  } catch (_e) { /* not a file URL */ }
  return roots
}

/**
 * Resolve one plugin row name (`pkg` or `pkg/subpath`) the way node would: with
 * an `exports` map present, that map is authoritative -- which is exactly the
 * rule the retired ./list-agents row broke.
 *
 * @param {string} name
 * @param {string[]} roots
 * @returns {{found: boolean, dir: string|null, subpath: string|null, reason: string|null}}
 */
export function resolvePluginRow(name, roots) {
  const raw = String(name || '').trim()
  if (!raw) return { found: false, dir: null, subpath: null, reason: 'empty plugin name' }
  const parts = raw.split('/')
  const pkgName = raw.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = raw.length > pkgName.length ? '.' + raw.slice(pkgName.length) : null
  let lookedIn = 0
  for (const root of roots) {
    const dir = join(root, ...pkgName.split('/'))
    if (!existsSync(join(dir, 'package.json'))) continue
    lookedIn++
    let pkg = null
    try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch (_e) {
      return { found: true, dir, subpath, reason: pkgName + '/package.json is not readable JSON' }
    }
    if (!subpath) return { found: true, dir, subpath, reason: null }
    if (pkg.exports === undefined) {
      const guess = join(dir, subpath.slice(1))
      const present = existsSync(guess) || existsSync(guess + '.js') || existsSync(guess + '.mjs') ||
        existsSync(join(guess, 'index.js')) || existsSync(join(guess, 'index.mjs'))
      return { found: true, dir, subpath, reason: present ? null : 'subpath ' + subpath + ' is not present in ' + pkgName }
    }
    if (exportsIncludes(pkg.exports, subpath, dir)) return { found: true, dir, subpath, reason: null }
    return {
      found: true, dir, subpath,
      reason: 'Package subpath ' + JSON.stringify(subpath) + ' is not defined by "exports" in ' +
        ((pkg.name || pkgName) + '/package.json') + ' -- a preset row naming it makes the whole preset fail to mount',
    }
  }
  return {
    found: false, dir: null, subpath,
    reason: lookedIn > 0
      ? pkgName + ' is not installed with the shape this row needs (searched ' + roots.length + ' node_modules)'
      : pkgName + ' is not installed (searched ' + roots.length + ' node_modules)',
  }
}

/** Is this plugin name an npm specifier (vs 'cordis:group' or a local path)? */
export function isNpmSpecifier(name) {
  const raw = String(name || '').trim()
  if (!raw) return false
  if (raw.includes(':')) return false           // cordis:group, node:..., plugin:...
  if (raw.startsWith('.') || raw.startsWith('/')) return false
  return true
}

/** Exports-map membership test: string / array / conditional object / patterns. */
function exportsIncludes(exportsMap, subpath, dir) {
  const seen = new Set()
  const walk = (value) => {
    if (value === undefined || value === null) return false
    if (typeof value === 'string') {
      const rel = value.replace(/^\.\/+/, '')
      const target = join(dir, rel)
      return existsSync(target) || existsSync(target + '.js') || existsSync(target + '.mjs') ||
        existsSync(join(target, 'index.js')) || existsSync(join(target, 'index.mjs'))
    }
    if (Array.isArray(value)) return value.some(walk)
    if (typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)
    const keys = Object.keys(value)
    if (keys.some((k) => k.startsWith('.'))) {
      if (value[subpath] !== undefined) return walk(value[subpath])
      for (const pattern of keys.filter((k) => k.includes('*'))) {
        const prefix = pattern.split('*')[0]
        if (!subpath.startsWith(prefix)) continue
        const rest = subpath.slice(prefix.length)
        const target = String(value[pattern])
        return walk(target.includes('*') ? target.replace('*', rest) : target)
      }
      return false
    }
    const chosen = value.default !== undefined ? value.default : (value.import !== undefined ? value.import : value.require)
    return walk(chosen)
  }
  return walk(exportsMap)
}

/**
 * Audit the preset definitions a profile declares, with no running host.
 *
 * @param {object} [opts]
 * @param {string} [opts.dshHome]
 * @param {string} [opts.profile]           only this profile directory
 * @param {string[]} [opts.roots]           search roots (default packageSearchRoots())
 * @param {Array<{file: string, text: string}>} [opts.documents] pre-read YAML (tests)
 * @returns {{presets: number, rows: number, declared: string[], problems: Array<{file: string, preset: string, rowId: string, rowName: string, reason: string}>}}
 */
export function auditPresetConfigs({ dshHome = null, profile = null, roots = null, documents = null } = {}) {
  const docs = documents || readProfileYamls({ dshHome, profile })
  const searchRoots = roots || packageSearchRoots({ dshHome, profile })
  const problems = []
  const declared = new Set()
  let presets = 0, rows = 0
  for (const doc of docs) {
    for (const preset of extractDeclaredPresets(doc.text, doc.file)) {
      presets++
      declared.add(preset.preset)
      for (const row of preset.rows) {
        // A disabled row is never imported, so it cannot break the mount; a
        // non-npm name is cordis' own syntax ('cordis:group' for a nested group,
        // './local.mjs' for a file) and resolves through the host, not node.
        if (row.disabled || !isNpmSpecifier(row.name)) continue
        rows++
        const res = resolvePluginRow(row.name, searchRoots)
        if (res.reason) problems.push({ file: doc.file, preset: preset.preset, rowId: row.id, rowName: row.name, reason: res.reason })
      }
    }
  }
  // `declared` is what --from auto compares stored pins against: any pinned id
  // the composed config never names (and dsh never ships) is a stale pin.
  return { presets, rows, declared: [...declared], problems }
}

/**
 * The YAML documents that can declare a preset: each profile's cordis.yml and
 * cordis.patch.yml, plus every installed plugin's own bundle patch / presets dir
 * (dsh-ops ships presets/ops-ptc.patch.yml, @linxin666/dsh-liangshen ships
 * presets/liangshen/agent.cordis.yml -- both declare presets and both can break
 * exactly the same way).
 */
export function readProfileYamls({ dshHome, profile = null } = {}) {
  const out = []
  if (!dshHome) return out
  const profilesDir = join(dshHome, 'profiles')
  let names = []
  try {
    names = readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (_e) { return out }
  if (profile) names = names.filter((n) => n === profile)
  for (const name of names) {
    const dir = join(profilesDir, name)
    for (const f of ['cordis.yml', 'cordis.patch.yml']) {
      try { out.push({ file: join(dir, f), text: readFileSync(join(dir, f), 'utf8') }) } catch (_e) { /* optional */ }
    }
    for (const doc of readBundlePatches(join(dir, 'node_modules'))) out.push(doc)
  }
  return out
}

function readBundlePatches(nodeModulesDir) {
  const out = []
  let entries = []
  try { entries = readdirSync(nodeModulesDir, { withFileTypes: true }) } catch (_e) { return out }
  const dirs = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('@')) {
      try {
        for (const s of readdirSync(join(nodeModulesDir, e.name), { withFileTypes: true })) if (s.isDirectory()) dirs.push(join(nodeModulesDir, e.name, s.name))
      } catch (_e) { /* skip scope */ }
    } else dirs.push(join(nodeModulesDir, e.name))
  }
  for (const d of dirs) {
    let pkg = null
    try { pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) } catch (_e) { continue }
    const declared = (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) || (pkg.cordis && pkg.cordis.patch)
    const candidates = []
    if (typeof declared === 'string') candidates.push(join(d, declared.replace(/^\.\/+/, '')))
    else {
      // Conventional location: a plugin that ships presets/*.yml without naming
      // it in package.json is still part of the composed preset tree.
      try {
        for (const e of readdirSync(join(d, 'presets'), { withFileTypes: true })) if (e.isFile() && /\.ya?ml$/.test(e.name)) candidates.push(join(d, 'presets', e.name))
      } catch (_e) { /* no presets dir */ }
    }
    for (const c of candidates) {
      try { out.push({ file: c, text: readFileSync(c, 'utf8') }) } catch (_e) { /* unreadable */ }
    }
  }
  return out
}

// -----------------------------------------------------------------------------
// 3. what the stored sessions actually pin
// -----------------------------------------------------------------------------

/**
 * Read the agent preset each session header pins, straight off disk. Cheap
 * enough for a 145-session store: only the first line is parsed (the whole file
 * is zstd-decompressed, which for these logs is a few hundred KB at most).
 *
 * @param {string} sessionsRoot <dshHome>/sessions
 * @param {object} [opts]
 * @param {string|null} [opts.prefix] only session ids with this prefix (default 'hermes-'; null = every session)
 * @returns {{scanned: number, unreadable: number, pins: Array<{sessionId: string, project: string, preset: string|null}>}}
 */
export function scanStoredPins(sessionsRoot, { prefix = 'hermes-' } = {}) {
  const pins = []
  let scanned = 0, unreadable = 0
  let projects = []
  try { projects = readdirSync(sessionsRoot, { withFileTypes: true }) } catch (_e) {
    return { scanned: 0, unreadable: 0, pins, error: 'sessions root unreadable: ' + sessionsRoot }
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions = []
    try { sessions = readdirSync(join(sessionsRoot, project.name), { withFileTypes: true }) } catch (_e) { continue }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      if (prefix && !s.name.startsWith(prefix)) continue
      const file = SESSION_FILE_NAMES.map((n) => join(sessionsRoot, project.name, s.name, n)).find((p) => existsSync(p))
      if (!file) continue
      scanned++
      try {
        const header = readHeaderLine(file)
        pins.push({ sessionId: s.name, project: project.name, preset: header && typeof header.agentPreset === 'string' ? header.agentPreset : null })
      } catch (_e) { unreadable++ }
    }
  }
  return { scanned, unreadable, pins }
}

// -----------------------------------------------------------------------------
// 4. the report the doctor renders
// -----------------------------------------------------------------------------

/** The command that fixes a stored pin the host cannot resume. */
export const REPAIR_HINT = 'node node_modules/dsh-hermes-link/bin/hermes-link-repair-agent-preset.mjs --to standard   (then restart dsh: a mount failure is final for the process)'

/**
 * One doctor check from the three sources of truth.
 *
 * @param {object} input
 * @param {any[]|null} [input.rows] the live host roster (null = not running / not readable)
 * @param {{scanned: number, unreadable?: number, pins: Array<{sessionId: string, preset: string|null}>}|null} [input.scan]
 * @param {{presets: number, rows: number, problems: Array<object>}|null} [input.audit] the offline declaration audit
 * @returns {{id: string, status: 'ok'|'warn'|'fail', title: string, detail: string, hint?: string, data?: object}}
 */
export function presetHealthCheck({ rows = null, scan = null, audit = null } = {}) {
  const id = 'imported_agent_preset'
  const title = 'imported session agent-preset pins'
  const pinned = {}
  for (const pin of (scan && scan.pins) || []) {
    if (pin && typeof pin.preset === 'string' && pin.preset) pinned[pin.preset] = (pinned[pin.preset] || 0) + 1
  }
  const summary = Object.keys(pinned).length === 0
    ? 'none pinned (host default preset)'
    : Object.entries(pinned).map(([k, v]) => k + '=' + v).join(', ')
  const base = (scan ? scan.scanned + ' imported session(s): ' + summary : '') +
    (audit ? (scan ? '; ' : '') + audit.presets + ' preset(s) declared in the profile, ' + audit.rows + ' plugin row(s) resolved' : '')
  const verdict = classifyStoredPins((scan && scan.pins) || [], Array.isArray(rows) ? rows : null)
  const data = { pins: pinned, unusable: verdict.unusable.slice(0, 20), problems: audit ? audit.problems.slice(0, 10) : [], roster: Array.isArray(rows) ? rows.map((r) => r && r.id) : null }

  // A declared preset whose plugin cannot be imported: the mount WILL fail, so
  // every session pinning it is unopenable. Say which row and why.
  if (audit && audit.problems.length > 0) {
    const first = audit.problems[0]
    return {
      id, status: 'fail', title,
      detail: base + '; UNRESOLVABLE ROW ' + first.rowId + " ('" + first.rowName + "') in preset '" + first.preset + "': " + first.reason +
        (audit.problems.length > 1 ? ' (+' + (audit.problems.length - 1) + ' more)' : ''),
      hint: 'remove or repoint that row in ' + first.file + ' and restart dsh, or unpin the sessions: ' + REPAIR_HINT,
      data,
    }
  }
  if (verdict.unusable.length > 0) {
    const byPreset = {}
    for (const u of verdict.unusable) (byPreset[u.preset] = byPreset[u.preset] || []).push(u.sessionId)
    const why = verdict.unusable[0].state === 'broken'
      ? 'the host declared it but its plugin tree never mounted: ' + (verdict.unusable[0].reason || '')
      : verdict.unusable[0].reason || 'the host does not declare it'
    return {
      id, status: 'fail', title,
      detail: Object.keys(byPreset).length + ' pinned preset(s) cannot be resumed (' + Object.keys(byPreset).map((p) => p + ' x' + byPreset[p].length).join(', ') + '); ' + why,
      hint: 'opening those sessions fails and the sidebar row disappears. ' + REPAIR_HINT,
      data,
    }
  }
  if (!Array.isArray(rows) && !audit) {
    return {
      id, status: 'warn', title,
      detail: base + '; the roster was not readable and no profile config was audited, so the pins are UNVERIFIED',
      hint: 'run hermes_link_doctor inside DSH, or the shipped CLI with --dsh-home (it audits ~/.dsh/profiles/<profile>/cordis.patch.yml instead)',
      data,
    }
  }
  return { id, status: 'ok', title, detail: base + (Array.isArray(rows) ? '; every pin resolves and mounts' : '; every declared plugin row resolves'), data }
}

/**
 * Gather all three sources for one surface (the live roster is only available
 * in-process, the config audit only offline, the pins from disk).
 *
 * @param {object} [opts]
 * @param {object} [opts.ctx] cordis context (in-process only)
 * @param {string} [opts.dshHome]
 * @param {string} [opts.profile] limit the config audit to one profile
 * @param {boolean} [opts.auditConfig=true]
 * @returns {Promise<{rows: any[]|null, scan: object|null, audit: object|null}>}
 */
export async function collectPresetHealth({ ctx = null, dshHome = null, profile = null, auditConfig = true } = {}) {
  let rows = null
  const registry = ctx && typeof ctx.get === 'function' ? safeGet(ctx) : null
  if (registry && typeof registry.list === 'function') {
    try { const list = await registry.list(); rows = Array.isArray(list) ? list : null } catch (_e) { rows = null }
  }
  const scan = dshHome ? scanStoredPins(join(dshHome, 'sessions')) : null
  let audit = null
  if (auditConfig && dshHome) {
    try { audit = auditPresetConfigs({ dshHome, profile }) } catch (_e) { audit = null }
  }
  return { rows, scan, audit }
}

function safeGet(ctx) {
  try { return ctx.get('agentPresets') } catch (_e) { return null }
}


function readHeaderLine(file) {
  const bytes = readFileSync(file)
  if (bytes.length === 0) return null
  const text = file.endsWith('.zstd') ? zlib.zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8')
  const line = text.split('\n')[0]
  if (!line || !line.trim()) return null
  try { return JSON.parse(line) } catch (_e) { return null }
}
