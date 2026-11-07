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
// Safety: every file is copied to `<file>.bak-agentpreset-<stamp>` before the
// rewrite; pass --dry-run to only report what would change.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { rewriteStoredHeader, LEGACY_IMPORT_PRESET } from '../services/agent-preset-repair.mjs'

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
  try {
    result = rewriteStoredHeader(readFileSync(file), { from, to })
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
