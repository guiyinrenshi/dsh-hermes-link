#!/usr/bin/env node
// scripts/test-v070-additions.mjs
//
// Covers the 0.7.0 additions ported from the Windows cross-machine deployment:
//   - read_hermes_memory (MEMORY.md / USER.md, caps, missing files)
//   - the tool-catalog fallback (view().restrictableNames -> schemas())
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const pkg = join(root, 'packages/dsh-hermes-link')
let pass = 0, fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message || e)) }
}

const { readHermesMemory } = await import(pathToFileURL(join(pkg, 'services', 'hermes-memory.mjs')).href)
const { listToolNames } = await import(pathToFileURL(join(pkg, 'services', 'tool-catalog.mjs')).href)

function homeWith(files) {
  const home = mkdtempSync(join(tmpdir(), 'hermes-mem-'))
  for (const [rel, text] of Object.entries(files)) {
    const p = join(home, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text, 'utf8')
  }
  return home
}

await t('readHermesMemory returns both files with their paths', async () => {
  const home = homeWith({ 'memories/MEMORY.md': '# memory\nkey=value\n', 'memories/USER.md': '# user\nname=x\n' })
  try {
    const out = readHermesMemory({ hermesHome: home, which: 'all' })
    if (!out.text.includes('MEMORY.md') || !out.text.includes('key=value')) throw new Error('MEMORY.md missing from output')
    if (!out.text.includes('USER.md') || !out.text.includes('name=x')) throw new Error('USER.md missing from output')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

await t('readHermesMemory reports a missing file instead of throwing', async () => {
  const home = homeWith({ 'memories/USER.md': 'only user\n' })
  try {
    const out = readHermesMemory({ hermesHome: home, which: 'memory' })
    if (!/No Hermes memory files found/.test(out.text)) throw new Error('expected the not-found report, got: ' + out.text.slice(0, 120))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

await t('readHermesMemory caps output at max_bytes', async () => {
  const home = homeWith({ 'memories/MEMORY.md': 'x'.repeat(5000) })
  try {
    const out = readHermesMemory({ hermesHome: home, which: 'memory', maxBytes: 1024 })
    if (!/truncated at 1024 bytes/.test(out.text)) throw new Error('expected a truncation marker')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

await t('listToolNames falls back to schemas() when view() throws', async () => {
  const ctx = { tools: {
    view() { throw new Error('restrictableNames unavailable') },
    schemas() { return [{ name: 'read' }, { name: 'write' }, { name: 'read' }] },
  } }
  const names = listToolNames(ctx)
  if (!names || names.join(',') !== 'read,write') throw new Error('unexpected names: ' + JSON.stringify(names))
})

await t('listToolNames prefers view().restrictableNames when present', async () => {
  const ctx = { tools: {
    view() { return { restrictableNames: new Set(['b', 'a']) } },
    schemas() { throw new Error('should not be needed') },
  } }
  const names = listToolNames(ctx)
  if (!names || names.join(',') !== 'a,b') throw new Error('unexpected names: ' + JSON.stringify(names))
})

await t('listToolNames returns null without a tools service', async () => {
  if (listToolNames({}) !== null) throw new Error('expected null')
  if (listToolNames(null) !== null) throw new Error('expected null for null ctx')
})

console.log('\nTotal: ' + (pass + fail) + '  Passed: ' + pass + '  Failed: ' + fail)
process.exit(fail === 0 ? 0 : 1)
