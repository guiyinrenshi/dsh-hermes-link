// tools/read-hermes-memory.mjs
//
// v0.7.0 - expose Hermes long-term memory that the persona slice deliberately
// omits. Thin tool wrapper: all reading/capping lives in
// services/hermes-memory.mjs so it can be unit-tested without a host.
//
// Why this exists: up to 0.6.11 the only memory paths were
//   load_hermes_persona          -> SOUL.md + config slices only
//   load_hermes_project_memory   -> MEMORY.md lines scoped to the CURRENT cwd
// With Hermes on another machine (mirrored Hermes Home) there is no cwd
// overlap, so MEMORY.md/USER.md were unreachable from DSH.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readHermesMemory } from '../services/hermes-memory.mjs'

export function createReadHermesMemoryTool({ hermesHome }) {
  return defineTool({
    name: 'read_hermes_memory',
    description:
      'Read Hermes Agent long-term memory (memories/MEMORY.md) and the Hermes user profile (memories/USER.md) from the Hermes Home this plugin reads. Read-only. Use this when the user asks what Hermes remembers about them or about past projects, or when a task needs context that only exists in Hermes memory.',
    parameters: {
      which: {
        type: 'string',
        enum: ['all', 'memory', 'user'],
        description: 'Which memory file(s) to read. Default: all.',
      },
      max_bytes: {
        type: 'integer',
        description: 'Per-file byte cap (default 32768, max 131072).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: typeof value.text === 'string' ? value.text : JSON.stringify(value) }]
      },
    },
    async execute(args) {
      const result = readHermesMemory({
        hermesHome,
        which: args && args.which ? String(args.which) : 'all',
        maxBytes: args && args.max_bytes,
      })
      return { text: result.text }
    },
  })
}
