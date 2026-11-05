#!/usr/bin/env node
// scripts/test-hermes-provider.mjs
//
// v0.8.0: the `hermes` subagent provider (external backend) and its arg builder.
// No real Hermes process is started: spawn is injected.
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const pkg = join(new URL('..', import.meta.url).pathname, 'packages/dsh-hermes-link')
const { buildHermesArgs, promptText, createHermesProvider, hermesPath, resolveHermesBin } =
  await import(pathToFileURL(join(pkg, 'services/hermes-provider.mjs')).href)

let pass = 0, fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message || e)) }
}
const eq = (a, b, m) => { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error((m || 'mismatch') + ': ' + A + ' !== ' + B) }

await t('buildHermesArgs: minimal run is one-shot with no resume', () => {
  eq(buildHermesArgs({ prompt: 'hi' }), ['-z', 'hi'])
})

await t('buildHermesArgs: full option set maps to documented flags', () => {
  eq(buildHermesArgs({ prompt: 'do x', resume: 'latest', model: 'm1', provider: 'p1', reasoning: 'high', toolset: 'a,b', extraArgs: ['--yolo'] }),
    ['-z', 'do x', '--resume', 'latest', '-m', 'm1', '--provider', 'p1', '--reasoning', 'high', '-t', 'a,b', '--yolo'])
})

await t('promptText: joins text blocks and ignores others', () => {
  eq(promptText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
  eq(promptText('plain'), 'plain')
  eq(promptText(undefined), '')
})

await t('hermesPath: appends ~/.local/bin so systemd can find the CLI', () => {
  const p = hermesPath('/usr/bin')
  if (!p.split(':').includes(join(process.env.HOME || '', '.local', 'bin'))) throw new Error('missing ~/.local/bin: ' + p)
})

await t('resolveHermesBin: honours an explicit existing path', () => {
  const bin = resolveHermesBin('/bin/sh')
  if (bin !== '/bin/sh') throw new Error('got ' + bin)
})

function fakeSpawn(record, { code = 0, out = '', err = '' } = {}) {
  return (bin, args, opts) => {
    record.push({ bin, args, opts })
    const child = new EventEmitter()
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.killed = false
    child.kill = (sig) => { child.killed = true; record.push({ kill: sig }); return true }
    setImmediate(() => {
      if (out) child.stdout.emit('data', out)
      if (err) child.stderr.emit('data', err)
      child.emit('close', code, null)
    })
    return child
  }
}

await t('provider: runs `hermes -z` and returns completed output', async () => {
  const calls = []
  const provider = createHermesProvider({ bin: '/fake/hermes', spawnImpl: fakeSpawn(calls, { out: 'answer text\n' }) })
  if (provider.name !== 'hermes') throw new Error('provider name must be hermes')
  const run = provider.start({ prompt: [{ type: 'text', text: 'hello' }], cwd: '/tmp', resume: 'latest' })
  const settled = await run.result
  eq(settled.stopReason, 'completed')
  eq(settled.output, [{ type: 'text', text: 'answer text' }])
  eq(calls[0].args, ['-z', 'hello', '--resume', 'latest'])
  eq(calls[0].opts.cwd, '/tmp')
})

await t('provider: non-zero exit is an error result with stderr tail', async () => {
  const calls = []
  const provider = createHermesProvider({ bin: '/fake/hermes', spawnImpl: fakeSpawn(calls, { code: 2, err: 'boom' }) })
  const settled = await provider.start({ prompt: 'x' }).result
  eq(settled.stopReason, 'error')
  if (!/boom/.test(settled.error)) throw new Error('stderr missing from error: ' + settled.error)
})

await t('provider: empty prompt resolves an error without spawning', async () => {
  const calls = []
  const provider = createHermesProvider({ bin: '/fake/hermes', spawnImpl: fakeSpawn(calls) })
  const settled = await provider.start({ prompt: [] }).result
  eq(calls.length, 0)
  eq(settled.stopReason, 'error')
})

await t('provider: dispose kills the child', async () => {
  const calls = []
  const provider = createHermesProvider({ bin: '/fake/hermes', spawnImpl: (bin, args, opts) => {
    calls.push({ bin, args, opts })
    const child = new EventEmitter()
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.kill = (sig) => { calls.push({ kill: sig }); return true }
    return child
  } })
  const run = provider.start({ prompt: 'long' })
  await run.dispose()
  if (!calls.some((c) => c.kill === 'SIGTERM')) throw new Error('dispose did not SIGTERM the child')
})

console.log('\nTotal: ' + (pass + fail) + '  Passed: ' + pass + '  Failed: ' + fail)
process.exit(fail === 0 ? 0 : 1)
