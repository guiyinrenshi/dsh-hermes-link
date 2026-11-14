#!/usr/bin/env node
// bin/hermes-link-repair-agent-preset.mjs
//
// v0.8.1 maintenance command: sessions imported by dsh-hermes-link 0.7.x/0.8.0
// pinned `agentPreset: 'hermes-imported'`, which dsh never ships. Opening such a
// conversation fails with
//   resume failed ... Unknown agent preset: hermes-imported
// This command rewrites the stored header of those sessions so they resume under
// the host default preset (or a preset you name with --to).
//
// Safety: every file is copied to '<file>.bak-agentpreset-<stamp>' before the
// rewrite; pass --dry-run to only report what would change.
//
// v0.8.6 adds:
//   --check        run the doctor's agent-preset health check (profile config +
//                  stored pins) and exit 1 when something is unresumable, so this
//                  doubles as a post-upgrade smoke test.
//   --from auto    unpin every preset the profile does not declare (and that is
//                  not a dsh builtin) instead of only 'hermes-imported'. Use it
//                  after an upgrade that broke a custom preset for another reason.
// A preset whose plugin tree failed to mount is reported as BROKEN by the running
// host, which an offline scan cannot see: run hermes_link_doctor inside DSH for
// that verdict (or --url). See services/preset-health.mjs.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { rewriteStoredHeader, LEGACY_IMPORT_PRESET } from '../services/agent-preset-repair.mjs'
import { auditPresetConfigs, collectPresetHealth, presetHealthCheck, scanStoredPins } from '../services/preset-health.mjs'

// Presets dsh itself ships (0.2.x): never stale, whatever the profile says.
const HOST_BUILTIN_PRESETS = new Set(['standard', 'ptc', 'minimal', 'cordis'])

function argOf(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0 || i + 1 >= process.argv.length) return fallback
  const v = process.argv[i + 1]
  return v.startsWith('--') ? fallback : v
}
const has = (name) => process.argv.includes('--' + name)

const dshHome = argOf('dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh'))
const from = argOf('from', LEGACY_IMPORT_PRESET)
const to = argOf('to', '')
const dryRun = has('dry-run')
const asJson = has('json')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

const sessionsRoot = join(dshHome, 'sessions')
const report = { dshHome, from, to: to || '(host default)', dryRun, scanned: 0, changed: 0, skipped: 0, failed: 0, files: [] }

// --check: the same verdict every other surface gives, from the offline inputs.
if (has('check')) {
  const check = presetHealthCheck(await collectPresetHealth({ dshHome }))
  console.log('[' + check.status.toUpperCase() + '] ' + check.title + ' -- ' + check.detail)
  if (check.hint) console.log('  hint: ' + check.hint)
  for (const p of (check.data.problems || [])) console.log('  [row] ' + p.preset + '/' + p.rowId + ' (' + p.rowName + '): ' + p.reason)
  for (const u of (check.data.unusable || [])) console.log('  [pin] ' + u.sessionId + ' -> ' + u.preset + ': ' + u.state)
  process.exit(check.status === 'fail' ? 1 : 0)
}

// --from auto: which pinned presets are NOT declared anywhere in the profile?
let autoStale = null
if (from === 'auto') {
  const declared = new Set()
  let audit = null
  try { audit = auditPresetConfigs({ dshHome }) } catch (_e) { audit = null }
  for (const p of (audit && audit.declared) || []) declared.add(p)
  // A preset the profile declares but cannot mount is just as unopenable as one
  // it never names, so its id joins the stale set -- the row is reported below so
  // the operator fixes the declaration too, not only the data.
  const unusable = new Set(declared)
  for (const p of (audit && audit.problems) || []) unusable.add(p.preset)
  const scan = scanStoredPins(sessionsRoot, { prefix: '' })
  autoStale = new Map()
  let pinned = 0
  for (const pin of scan.pins) {
    if (!pin.preset) continue
    pinned++
    if (HOST_BUILTIN_PRESETS.has(pin.preset) && unusable.has(pin.preset) === false) continue
    if (declared.has(pin.preset) && unusable.has(pin.preset) === false) continue
    autoStale.set(pin.sessionId, pin.preset)
  }
  console.log('auto: ' + pinned + '/' + scan.scanned + ' session(s) carry a pin, ' + declared.size + ' preset(s) declared in the profile, ' + autoStale.size + ' stale')
  if ((audit && audit.problems.length) > 0) {
    console.log('WARNING: the profile declares a preset that cannot mount, so sessions pinning it are unpinned here AND the row still needs fixing:')
    for (const p of audit.problems) console.log('  ' + p.preset + '/' + p.rowId + ' -> ' + p.reason)
    console.log('  restart dsh after fixing the row: a preset mount failure is final for the process')
  }
}
const pinnedPresetOf = (file) => { const sid = basename(dirnameOf(file)); return autoStale && autoStale.has(sid) ? autoStale.get(sid) : null }
function dirnameOf(file) { return file.slice(0, file.lastIndexOf('/')) }

function walk(dir) {
  let out = []
  let entries = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) out = out.concat(walk(p))
    else if (name === 'session.v4.jsonl.zstd') out.push(p)
  }
  return out
}

if (!existsSync(sessionsRoot)) {
  console.error('no sessions directory at ' + sessionsRoot)
  process.exit(2)
}

for (const file of walk(sessionsRoot)) {
  report.scanned++
  let result
  const activeFrom = from === 'auto' ? pinnedPresetOf(file) : from
  if (from === 'auto' && !activeFrom) {
    report.skipped++
    continue
  }
  try {
    result = rewriteStoredHeader(readFileSync(file), { from: activeFrom, to })
  } catch (e) {
    report.failed++
    report.files.push({ file, status: 'error', error: String((e && e.message) || e) })
    continue
  }
  if (!result.changed) {
    report.skipped++
    if (result.skipped && result.skipped !== 'preset-not-pinned' && result.skipped !== 'no-preset') {
      report.files.push({ file, status: 'skipped', reason: result.skipped })
    }
    continue
  }
  report.changed++
  const entry = { file, status: dryRun ? 'would-rewrite' : 'rewritten', headerPreset: result.header && result.header.agentPreset }
  if (!dryRun) {
    const backup = file + '.bak-agentpreset-' + stamp
    try {
      copyFileSync(file, backup)
      writeFileSync(file, result.data)
      entry.backup = backup
    } catch (e) {
      report.failed++
      entry.status = 'write-failed'
      entry.error = String((e && e.message) || e)
    }
  }
  report.files.push(entry)
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('dsh home        : ' + report.dshHome)
  console.log('pinned preset   : ' + report.from + ' -> ' + report.to)
  console.log('mode            : ' + (dryRun ? 'dry run' : 'apply'))
  console.log('scanned         : ' + report.scanned)
  console.log('rewritten       : ' + report.changed)
  console.log('untouched       : ' + report.skipped)
  console.log('failed          : ' + report.failed)
  for (const f of report.files.slice(0, 20)) console.log('  [' + f.status + '] ' + f.file + (f.backup ? '  (backup: ' + f.backup + ')' : ''))
  if (report.files.length > 20) console.log('  ... ' + (report.files.length - 20) + ' more')
  if (report.changed > 0 && !dryRun) console.log('\nRestart dsh (or just reopen the conversation) to pick up the new header.')
}
process.exit(report.failed > 0 ? 1 : 0)
