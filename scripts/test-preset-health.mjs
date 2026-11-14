#!/usr/bin/env node
// scripts/test-preset-health.mjs
//
// v0.8.6: after a dsh upgrade the profile row that named the retired
// '@deepseek-ai/dsh-tool-subagent-control/list-agents' subpath made the whole
// 'hermes-imported' preset fail to mount. The host kept the row, marked it
// broken, and every stored session pinning it became unopenable -- which is how
// "clicking a synced session makes it vanish" happened. Covers the three sources
// this plugin now reads (live roster, profile config, stored headers), the
// repair that follows from them, and the doctor surface.
import zlib from 'node:zlib'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pkg = join(new URL('..', import.meta.url).pathname, 'packages/dsh-hermes-link')
const H = await import(pathToFileURL(join(pkg, 'services', 'preset-health.mjs')).href)
const R = await import(pathToFileURL(join(pkg, 'services', 'agent-preset-repair.mjs')).href)
const D = await import(pathToFileURL(join(pkg, 'services', 'doctor.mjs')).href)

let pass = 0, fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.stack || e)) }
}
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'mismatch') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)) }
const ok = (v, m) => { if (!v) throw new Error(m || 'expected truthy') }

const dirs = []
function home() { const d = mkdtempSync(join(tmpdir(), 'preset-health-')); dirs.push(d); return d }

// -----------------------------------------------------------------------------
// 1. the live roster: a declared preset is not a resumable one
// -----------------------------------------------------------------------------
await t('rosterRowIsUsable: a mount failure disqualifies the row', () => {
  ok(H.rosterRowIsUsable({ id: 'standard' }), 'plain row')
  ok(!H.rosterRowIsUsable({ id: 'hermes-imported', broken: 'tool-subagent-list-agents: never started' }), 'broken row')
  ok(!H.rosterRowIsUsable({ id: 'x', broken: true }), 'broken: true still counts')
  ok(H.rosterRowIsUsable({ id: 'x', broken: null }), 'broken: null is clean')
  ok(!H.rosterRowIsUsable({ id: 'x', enabled: false }), 'disabled row')
  ok(!H.rosterRowIsUsable({ id: '' }), 'empty id')
  ok(!H.rosterRowIsUsable(null), 'null row')
})

await t('usablePresetIds / presetRosterState: the four states', () => {
  const rows = [{ id: 'standard' }, { id: 'hermes-imported', broken: 'never started' }, { id: 'off', enabled: false }]
  eq(H.usablePresetIds(rows), ['standard'], 'usable ids')
  eq(H.presetRosterState(rows, 'standard'), { state: 'ok', reason: null })
  eq(H.presetRosterState(rows, 'hermes-imported'), { state: 'broken', reason: 'never started' })
  eq(H.presetRosterState(rows, 'off').state, 'undeclared', 'a disabled preset cannot be resumed')
  eq(H.presetRosterState(rows, 'nope').state, 'undeclared')
  eq(H.presetRosterState(null, 'standard'), { state: 'unknown', reason: null }, 'no roster read')
  eq(H.presetRosterState(rows, undefined).state, 'unknown', 'header pinned nothing')
})

await t('classifyStoredPins: only real problems are reported', () => {
  const pins = [
    { sessionId: 'hermes-a', preset: 'hermes-imported' },
    { sessionId: 'hermes-b', preset: 'hermes-imported' },
    { sessionId: 'hermes-c', preset: 'standard' },
    { sessionId: 'hermes-d', preset: null },
  ]
  const broken = [{ id: 'standard' }, { id: 'hermes-imported', broken: 'tool-subagent-list-agents (...) never started' }]
  const bad = H.classifyStoredPins(pins, broken)
  eq(bad.checked, 4)
  eq(bad.unusable.map((u) => u.sessionId), ['hermes-a', 'hermes-b'])
  eq(bad.unusable[0].state, 'broken')
  eq(bad.presets, { 'hermes-imported': 2, standard: 1 }, 'pin census')
  // Unknown roster (offline CLI without --dshHome config) must never claim damage.
  eq(H.classifyStoredPins(pins, null).unusable, [])
  eq(H.classifyStoredPins(pins, [{ id: 'standard' }, { id: 'hermes-imported' }]).unusable, [], 'healthy roster')
})

// -----------------------------------------------------------------------------
// 2. the profile config: does every declared row resolve in what is installed?
// -----------------------------------------------------------------------------
const ALIAS_YAML = `
- insert:
    id: preset-hermes-imported
    name: '@deepseek-ai/dsh-agent-preset'
    config:
      id: hermes-imported
      name: 'Hermes import (compat alias)'
      order: 99
      plugins:
        - id: persona
          name: '@deepseek-ai/dsh-plugin-persona'
        - id: tool-subagent-list-agents
          name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
        - id: delegation
          name: cordis:group
        - id: tool-bash
          name: '@deepseek-ai/dsh-tool-bash'
          enabled: false
`

await t('extractDeclaredPresets: reads the alias block dsh writes', () => {
  const found = H.extractDeclaredPresets(ALIAS_YAML, 'cordis.patch.yml')
  eq(found.length, 1, 'one declared preset')
  eq(found[0].preset, 'hermes-imported')
  eq(found[0].entryId, 'preset-hermes-imported')
  eq(found[0].file, 'cordis.patch.yml')
  eq(found[0].rows.map((r) => r.id), ['persona', 'tool-subagent-list-agents', 'delegation', 'tool-bash'])
  eq(found[0].rows[3].disabled, true, 'enabled: false carried through')
  eq(found[0].rows[2].name, 'cordis:group', 'a group row is not an npm package')
  eq(H.extractDeclaredPresets('', 'x'), [], 'empty document')
  eq(H.extractDeclaredPresets('- id: a\n  name: some-other-plugin\n', 'x'), [], 'no preset block')
})

function fakeRoot(packages) {
  // <root>/node_modules/<name>/package.json + the files its exports point at
  const root = join(home(), 'node_modules')
  for (const [name, exports] of Object.entries(packages)) {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', exports }, null, 2))
    const targets = new Set()
    const walk = (v) => {
      if (typeof v === 'string') targets.add(v)
      else if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(exports)
    for (const target of targets) {
      const rel = target.replace(/\*\/?.*$/, '').replace(/^\.\/+/, '')
      const file = target.includes('*') ? rel : rel.replace(/\$/, '')
      if (!file) continue
      if (file.includes('.')) {
        const target = join(dir, file)
        mkdirSync(join(target, '..'), { recursive: true })
        writeFileSync(target, '// stub\n')
      } else {
        mkdirSync(join(dir, file), { recursive: true })
        writeFileSync(join(dir, file, 'index.js'), '// stub\n')
      }
    }
  }
  return root
}

await t('auditPresetConfigs: the retired subpath is a problem, the live entry is not', () => {
  const root = fakeRoot({
    '@deepseek-ai/dsh-plugin-persona': { '.': './lib/index.js' },
    '@deepseek-ai/dsh-tool-subagent-control': { '.': './lib/index.js', './src/*': './src/*' },
  })
  mkdirSync(join(root, '@deepseek-ai/dsh-plugin-persona', 'lib'), { recursive: true })
  writeFileSync(join(root, '@deepseek-ai/dsh-plugin-persona', 'lib', 'index.js'), '// stub\n')
  mkdirSync(join(root, '@deepseek-ai/dsh-tool-subagent-control', 'lib'), { recursive: true })
  writeFileSync(join(root, '@deepseek-ai/dsh-tool-subagent-control', 'lib', 'index.js'), '// stub\n')
  const documents = [{ file: 'cordis.patch.yml', text: ALIAS_YAML }]
  const audit = H.auditPresetConfigs({ documents, roots: [root] })
  eq(audit.presets, 1)
  eq(audit.declared, ['hermes-imported'], 'what --from auto compares against')
  eq(audit.problems.length, 1, 'exactly the list-agents row')
  eq(audit.problems[0].rowId, 'tool-subagent-list-agents')
  eq(audit.problems[0].preset, 'hermes-imported')
  ok(audit.problems[0].reason.includes('list-agents'), 'reason names the subpath: ' + audit.problems[0].reason)
  // A disabled row is never imported, so it cannot break the mount.
  ok(!audit.problems.some((p) => p.rowId === 'tool-bash'), 'disabled row not flagged')
  // The same document with the row removed (the fix we shipped) is clean.
  const fixed = ALIAS_YAML.split('\n').filter((l) => !/tool-subagent-list-agents|dsh-tool-subagent-control\/list-agents/.test(l)).join('\n')
  eq(H.auditPresetConfigs({ documents: [{ file: 'cordis.patch.yml', text: fixed }], roots: [root] }).problems, [])
})

await t('auditPresetConfigs: a pattern export and a missing package are both judged', () => {
  const root = fakeRoot({ '@deepseek-ai/dsh-thing': { '.': './lib/index.js', './src/*': './src/*' } })
  mkdirSync(join(root, '@deepseek-ai/dsh-thing', 'src'), { recursive: true })
  writeFileSync(join(root, '@deepseek-ai/dsh-thing', 'src', 'plugin.js'), '// stub\n')
  const doc = `- insert:
    id: p1
    name: '@deepseek-ai/dsh-agent-preset'
    config:
      id: patterned
      plugins:
        - id: a
          name: '@deepseek-ai/dsh-thing/src/plugin.js'
        - id: b
          name: '@deepseek-ai/does-not-exist'
`
  const audit = H.auditPresetConfigs({ documents: [{ file: 'd.yml', text: doc }], roots: [root] })
  eq(audit.problems.map((p) => p.rowId), ['b'], 'the pattern hit resolves, the stranger does not')
  ok(audit.problems[0].reason.includes('not installed') || audit.problems[0].reason.includes('Cannot find'), audit.problems[0].reason)
})

await t('isNpmSpecifier: cordis syntax is not a package', () => {
  eq(H.isNpmSpecifier('@scope/name'), true)
  eq(H.isNpmSpecifier('dsh-ops'), true)
  eq(H.isNpmSpecifier('cordis:group'), false)
  eq(H.isNpmSpecifier('./local.mjs'), false)
  eq(H.isNpmSpecifier('/abs/path.mjs'), false)
  eq(H.isNpmSpecifier(''), false)
})

// -----------------------------------------------------------------------------
// 3. the stored headers: what every imported session actually pins
// -----------------------------------------------------------------------------
function writeSession(sessionsRoot, id, header, events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]) {
  const dir = join(sessionsRoot, '--root-Hermes--', id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  const head = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/root/Hermes', ...header }) + '\n'))
  writeFileSync(file, Buffer.concat([head, zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'))]))
  return file
}

await t('scanStoredPins: only the imported sessions, and their pins', () => {
  const sessionsRoot = join(home(), 'sessions')
  writeSession(sessionsRoot, 'hermes-a', { agentPreset: 'hermes-imported' })
  writeSession(sessionsRoot, 'hermes-b', { agentPreset: 'standard' })
  writeSession(sessionsRoot, 'session-0001', { agentPreset: 'ptc' })
  mkdirSync(join(sessionsRoot, '--root-Hermes--', 'hermes-empty'), { recursive: true })
  const scan = H.scanStoredPins(sessionsRoot)
  eq(scan.scanned, 2, 'hermes- prefix only')
  eq(scan.pins.map((p) => p.sessionId).sort(), ['hermes-a', 'hermes-b'])
  eq(scan.pins.find((p) => p.sessionId === 'hermes-a').preset, 'hermes-imported')
  eq(scan.pins.find((p) => p.sessionId === 'hermes-a').project, '--root-Hermes--')
  eq(H.scanStoredPins(sessionsRoot, { prefix: null }).scanned, 3, 'prefix null reads every session')
  eq(H.scanStoredPins(join(home(), 'nope')).scanned, 0, 'missing root is not an error')
  ok(H.scanStoredPins(join(home(), 'nope')).error, 'but it is reported')
})

await t('presetHealthCheck: config fault beats everything, then an unresumable pin', () => {
  const scan = { scanned: 2, pins: [{ sessionId: 'hermes-a', preset: 'hermes-imported' }, { sessionId: 'hermes-b', preset: 'hermes-imported' }] }
  const rowsBroken = [{ id: 'standard' }, { id: 'hermes-imported', broken: 'tool-subagent-list-agents (...) never started' }]
  const withFault = H.presetHealthCheck({ rows: rowsBroken, scan, audit: { presets: 1, rows: 26, declared: ['hermes-imported'], problems: [{ file: 'cordis.patch.yml', preset: 'hermes-imported', rowId: 'tool-subagent-list-agents', rowName: '@x/list-agents', reason: 'subpath not defined' }] } })
  eq(withFault.status, 'fail')
  eq(withFault.id, 'imported_agent_preset')
  ok(withFault.detail.includes('tool-subagent-list-agents'), 'names the row')
  ok(withFault.hint.includes('restart dsh'), 'tells the operator a restart is required')
  const pinFault = H.presetHealthCheck({ rows: rowsBroken, scan, audit: { presets: 1, rows: 26, declared: ['hermes-imported'], problems: [] } })
  eq(pinFault.status, 'fail')
  ok(pinFault.detail.includes('hermes-imported x2'), 'counts the affected sessions: ' + pinFault.detail)
  ok(pinFault.data.unusable.length === 2, 'data carries the list')
  eq(H.presetHealthCheck({ rows: [{ id: 'standard' }, { id: 'hermes-imported' }], scan, audit: null }).status, 'ok')
  const unverified = H.presetHealthCheck({ rows: null, scan, audit: null })
  eq(unverified.status, 'warn', 'nothing readable must not claim health')
  ok(unverified.detail.includes('UNVERIFIED'))
  eq(H.presetHealthCheck({ rows: null, scan: null, audit: null }).status, 'warn')
  eq(H.presetHealthCheck({}).detail.includes('none pinned') || true, true, 'a bare call never throws')
})

// -----------------------------------------------------------------------------
// 4. the repair: pin the sessions onto something that mounts
// -----------------------------------------------------------------------------
await t('decideImportPreset: a broken alias is no longer pinned (the 0.8.1 blind spot)', async () => {
  const ctx = (rows) => ({ get: (name) => name === 'agentPresets' ? { list: async () => rows } : undefined })
  eq(await R.decideImportPreset(ctx([{ id: 'standard' }, { id: 'hermes-imported' }])), 'hermes-imported', 'healthy alias keeps working')
  eq(await R.decideImportPreset(ctx([{ id: 'standard' }, { id: 'hermes-imported', broken: 'never started' }])), undefined, 'broken alias is skipped')
  eq(R.decideImportPresetFrom(null), undefined, 'no roster = host default')
  eq(R.decideImportPresetFrom([{ id: 'standard' }], 'standard'), 'standard')
  eq(R.decideImportPresetFrom([{ id: 'standard', enabled: false }], 'standard'), undefined, 'disabled is not usable')
})

await t('repairStalePins: dry run changes nothing, apply rewrites the header', () => {
  const sessionsRoot = join(home(), 'sessions')
  const fileA = writeSession(sessionsRoot, 'hermes-a', { agentPreset: 'hermes-imported' })
  const fileB = writeSession(sessionsRoot, 'hermes-b', { agentPreset: 'standard' })
  const rows = [{ id: 'standard' }, { id: 'hermes-imported', broken: 'tool-subagent-list-agents (...) never started' }]
  const before = readFileSync(fileA)

  const dry = R.repairStalePins({ rows, sessionsRoot, dryRun: true })
  eq(dry.scanned, 2)
  eq(dry.unusable, 1, 'only hermes-a is unresumable')
  eq(dry.repaired, ['hermes-a'], 'dry run reports what it would touch')
  ok(dry.reason['hermes-a'].startsWith('broken:'), 'and why: ' + JSON.stringify(dry.reason))
  eq(Buffer.compare(readFileSync(fileA), before), 0, 'dry run left the bytes alone')
  eq(readdirSync(join(sessionsRoot, '--root-Hermes--', 'hermes-a')).filter((n) => n.includes('.bak-')).length, 0, 'no backup yet')

  const applied = R.repairStalePins({ rows, sessionsRoot })
  eq(applied.repaired, ['hermes-a'])
  eq(applied.unusable, 1)
  const header = JSON.parse(zlib.zstdDecompressSync(readFileSync(fileA)).toString('utf8').split('\n')[0])
  eq(Object.prototype.hasOwnProperty.call(header, 'agentPreset'), false, 'the stale pin is gone')
  eq(header.id, 'hermes-a', 'identity kept, so the sidebar row survives')
  const left = readdirSync(join(sessionsRoot, '--root-Hermes--', 'hermes-a'))
  ok(left.some((n) => n.startsWith('session.v4.jsonl.zstd.bak-agentpreset-')), 'a backup was written next to the log: ' + left.join(' '))
  ok(!left.some((n) => n.includes('.tmp-agentpreset')) && !left.some((n) => n.includes('.failed-')), 'no temp or failed residue: ' + left.join(' '))
  eq(zlib.zstdDecompressSync(readFileSync(fileB)).toString('utf8').split('\n')[0].includes('"agentPreset":"standard"'), true, 'a usable pin is never touched')
  eq(R.repairStalePins({ rows: null, sessionsRoot }).error, 'roster-unavailable', 'refuses to guess without a roster')
})

// -----------------------------------------------------------------------------
// 5. the doctor surface
// -----------------------------------------------------------------------------
await t('runDoctor: the preset check shows up on the wired surfaces only', async () => {
  const h = home()
  const hermesHome = join(h, 'hermes'); mkdirSync(hermesHome, { recursive: true })
  const dshHome = join(h, '.dsh'); mkdirSync(dshHome, { recursive: true })
  const rows = [{ id: 'standard' }, { id: 'hermes-imported', broken: 'never started' }]
  const bad = await D.runDoctor({ hermesHome, dshHome, presetHealth: async () => ({ rows, scan: { scanned: 1, pins: [{ sessionId: 'hermes-a', preset: 'hermes-imported' }] }, audit: null }) })
  const c = bad.checks.find((x) => x.id === 'imported_agent_preset')
  ok(c, 'the check is reported')
  eq(c.status, 'fail')
  eq(bad.summary.fail, (bad.summary.fail || 0) >= 1 ? bad.summary.fail : 1, 'and it counts in the summary')
  ok(bad.ok === false, 'a broken pin fails the run')

  const clean = await D.runDoctor({ hermesHome, dshHome, presetHealth: async () => ({ rows: [{ id: 'standard' }], scan: { scanned: 1, pins: [{ sessionId: 'hermes-a', preset: 'standard' }] }, audit: { presets: 1, rows: 20, declared: ['standard'], problems: [] } }) })
  eq(clean.checks.find((x) => x.id === 'imported_agent_preset').status, 'ok')

  const unwired = await D.runDoctor({ hermesHome, dshHome })
  eq(unwired.checks.some((x) => x.id === 'imported_agent_preset'), false, 'no injection = no check, like scanImportedPins')

  const threw = await D.runDoctor({ hermesHome, dshHome, presetHealth: async () => { throw new Error('kaboom') } })
  const tc = threw.checks.find((x) => x.id === 'imported_agent_preset')
  eq(tc.status, 'warn', 'a broken probe must not take the doctor down')
  ok(tc.detail.includes('kaboom') || tc.detail.includes('threw'), tc.detail)
})

for (const d of dirs) rmSync(d, { recursive: true, force: true })
console.log('\nTotal: ' + (pass + fail) + '  Passed: ' + pass + '  Failed: ' + fail)
process.exit(fail === 0 ? 0 : 1)
