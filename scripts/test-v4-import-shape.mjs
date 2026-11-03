#!/usr/bin/env node
// scripts/test-v4-import-shape.mjs
//
// v0.7.0 regression guard: the importer's converted events must pass the HOST's
// own loader validation (Session.fromRestore), not just the plugin's expectations.
//
// Why this exists: dsh 0.2.x moved the on-disk session format to v4 and changed
// the tool/result representation from a user-role message wrapping one
// `tool-result` block to a first-class tool-role message with a message-level
// toolCallId. The plugin's unit tests kept asserting the v3 shape, so the
// conversion looked fine while every real import failed with
//   "format v4 tool/result at seq N requires a tool-role message".
// This test converts a synthetic Hermes dump (text + tool_use + tool_result) and
// loads it through the installed harness, which is what create()/append() do.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + ': ' + (e && e.message || e)) }
}

function findDshPackage(name) {
  const roots = [
    process.env.DSH_CHECKOUT,
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
    join(process.env.npm_config_prefix || '', 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
  ].filter(Boolean)
  for (const root of roots) {
    const p = join(root, name)
    if (existsSync(join(p, 'package.json'))) return p
  }
  return null
}

const root = new URL('..', import.meta.url).pathname
const sessionPath = findDshPackage('dsh-session')
const converterUrl = pathToFileURL(join(root, 'packages/dsh-hermes-link/import/request-dump-to-events.mjs')).href

if (!sessionPath) {
  console.log('  SKIP: no @deepseek-ai host checkout found (set DSH_CHECKOUT to point at one)')
  console.log('\nTotal: 0  Passed: 0  Failed: 0  Skipped: 1')
  process.exit(0)
}

const { requestDumpToEvents } = await import(converterUrl)
const { Session, SessionId, SessionLogOffset, KNOWN_SESSION_EVENT_TYPES } = await import(pathToFileURL(join(sessionPath, 'lib/index.js')).href)
// The READ path (persistence load) is restoreReleasedV4Artifact: it runs the
// turn/step/tool lifecycle validator that Session.fromRestore alone does not.
const formatPath = findDshPackage('dsh-session-format-v3-to-v4')
const { restoreReleasedV4Artifact } = formatPath
  ? await import(pathToFileURL(join(formatPath, 'lib/index.js')).href)
  : { restoreReleasedV4Artifact: null }

function mkDump() {
  return {
    request: { body: {
      model: 'deepseek-flash',
      tools: [{ name: 'browser_navigate', description: 'open a url', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'go look at the page' },
        { role: 'assistant', content: [
          { type: 'text', text: 'opening it' },
          { type: 'tool_use', id: 'call_abc', name: 'browser_navigate', input: { url: 'https://x' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_abc', content: [{ type: 'text', text: '{"ok":true}' }] },
          { type: 'text', text: 'now summarize' },
        ] },
        { role: 'assistant', content: 'done' },
      ],
    } },
    error: null,
  }
}

await t('converted events load through the installed Session (format v4)', async () => {
  const { events } = requestDumpToEvents(mkDump(), Date.now())
  const all = events.map((e, i) => ({ ...e, seq: i }))
  const last = all.length ? all[all.length - 1].time : Date.now()
  all.push({ type: 'session/title', seq: all.length, time: last, ignorable: true,
    data: { title: '[Hermes] shape', messageSeqs: [], source: { kind: 'user' } } })
  const header = {
    version: 4, id: 'hermes-shape-test', createdAt: all[0].time,
    isSeeded: false, delegationDepth: 0, cwd: '/tmp', agentPreset: 'hermes-imported',
  }
  // Throws on any envelope/message/surface/seed violation - exactly what the
  // persistence backend does when it materialises the session.
  Session.fromRestore(SessionId(header.id), all, header, SessionLogOffset(0), 'detached')
  // ... and what the read path does when it loads it back (turn/step/tool order).
  if (restoreReleasedV4Artifact) {
    restoreReleasedV4Artifact({ header, events: all, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
  }
})

await t('tool/result carries the v4 first-class tool-role message', async () => {
  const { events } = requestDumpToEvents(mkDump(), Date.now())
  const tr = events.filter((e) => e.type === 'tool/result')
  if (tr.length !== 1) throw new Error('expected exactly one tool/result, got ' + tr.length)
  const m = tr[0].data.message
  if (m.role !== 'tool') throw new Error("tool/result message.role must be 'tool', got " + m.role)
  if (m.toolCallId !== m.source.callId) throw new Error('message.toolCallId must equal source.callId')
  if (m.content.some((b) => b && b.type === 'tool-result')) throw new Error('content must not carry a tool-result wrapper')
})

console.log('\nTotal: ' + (pass + fail) + '  Passed: ' + pass + '  Failed: ' + fail)
process.exit(fail === 0 ? 0 : 1)
