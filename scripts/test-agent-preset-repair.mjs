#!/usr/bin/env node
// scripts/test-agent-preset-repair.mjs
//
// v0.8.1: imported sessions used to pin `agentPreset: 'hermes-imported'`, which
// dsh never ships, so resuming failed with "Unknown agent preset". Covers the
// pure helpers plus the stored-header rewrite.
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const pkg = join(new URL('..', import.meta.url).pathname, 'packages/dsh-hermes-link')
const { decideImportPreset, stripAgentPreset, rewriteStoredHeader, LEGACY_IMPORT_PRESET } =
  await import(pathToFileURL(join(pkg, 'services', 'agent-preset-repair.mjs')).href)

let pass = 0, fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message || e)) }
}
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'mismatch') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)) }

const ctxWith = (ids) => ({ get: (name) => name === 'agentPresets' ? { list: async () => ids.map((id) => ({ id })) } : undefined })

await t('decideImportPreset: keeps the pin only when the host declares it', async () => {
  eq(await decideImportPreset(ctxWith(['standard', LEGACY_IMPORT_PRESET])), LEGACY_IMPORT_PRESET)
  eq(await decideImportPreset(ctxWith(['standard', 'ptc'])), undefined)
})

await t('decideImportPreset: no registry or a throwing registry means "host default"', async () => {
  eq(await decideImportPreset({}), undefined)
  eq(await decideImportPreset(null), undefined)
  eq(await decideImportPreset({ get: () => ({ list: async () => { throw new Error('boom') } }) }), undefined)
})

await t('stripAgentPreset: removes only the requested pin', () => {
  eq(stripAgentPreset({ id: 'a', agentPreset: LEGACY_IMPORT_PRESET }), { id: 'a' })
  eq(stripAgentPreset({ id: 'a', agentPreset: 'standard' }), { id: 'a', agentPreset: 'standard' })
  eq(stripAgentPreset({ id: 'a' }), { id: 'a' })
  eq(stripAgentPreset({ id: 'a', agentPreset: 'standard' }, null), { id: 'a' })
})

function makeLog(header, events) {
  return zlib.zstdCompressSync(Buffer.from([JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n'), 'utf8'))
}
function readLog(buf) {
  return zlib.zstdDecompressSync(buf).toString('utf8').split('\n').map((l) => JSON.parse(l))
}

await t('rewriteStoredHeader: drops the stale pin and keeps every event', () => {
  const header = { type: 'session', version: 4, id: 'hermes-x', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/root/x', agentPreset: LEGACY_IMPORT_PRESET }
  const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }, { type: 'session/title', seq: 1, time: 2, data: { title: 't' } }]
  const out = rewriteStoredHeader(makeLog(header, events), {})
  if (!out.changed) throw new Error('expected a change')
  const lines = readLog(out.data)
  eq(lines.length, 3, 'line count')
  eq(Object.prototype.hasOwnProperty.call(lines[0], 'agentPreset'), false, 'pin removed')
  eq(lines[0].id, 'hermes-x')
  eq(lines[2], events[1], 'events untouched')
})

await t('rewriteStoredHeader: --to pins another preset instead of omitting', () => {
  const header = { type: 'session', version: 4, id: 'hermes-y', agentPreset: LEGACY_IMPORT_PRESET }
  const out = rewriteStoredHeader(makeLog(header, []), { to: 'standard' })
  eq(readLog(out.data)[0].agentPreset, 'standard')
})

await t('rewriteStoredHeader: an unrelated preset is left alone', () => {
  const header = { type: 'session', version: 4, id: 'hermes-z', agentPreset: 'standard' }
  const out = rewriteStoredHeader(makeLog(header, []), {})
  eq(out.changed, false)
  eq(out.skipped, 'preset-not-pinned')
})

await t('rewriteStoredHeader: malformed input is reported, never thrown', () => {
  const gz = zlib.zstdCompressSync(Buffer.from('not-json\n'))
  eq(rewriteStoredHeader(gz, {}).skipped, 'header-not-json')
  eq(rewriteStoredHeader(zlib.zstdCompressSync(Buffer.from('')), {}).skipped, 'empty')
})

console.log('\nTotal: ' + (pass + fail) + '  Passed: ' + pass + '  Failed: ' + fail)
process.exit(fail === 0 ? 0 : 1)
