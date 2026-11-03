// services/host-session.mjs
//
// v0.7.0 - Session event accessors that work on both host generations.
//
// dsh 0.1.5 exposed `session.events` (a live array) and no snapshot API; dsh
// 0.2.x replaced it with `session.snapshotEvents(from?, to?)` plus a `seq`
// getter, so every `agent.session.events` read returned undefined and callers
// crashed with "Cannot read properties of undefined (reading 'length')" (the
// followup reply wait was the first one users could feel).
//
// Everything that walks a session log should go through these two helpers.

/** Snapshot of a session's events, newest host first, 0.1.x fallback second. */
export function sessionEvents(session) {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    } catch {
      return []
    }
  }
  return Array.isArray(session.events) ? session.events : []
}

/** Current log length (next seq) of a session. */
export function sessionSeq(session) {
  if (!session) return 0
  if (typeof session.seq === 'number' && Number.isFinite(session.seq)) return session.seq
  return sessionEvents(session).length
}

/** Latest assistant message content blocks in a session log, or null. */
export function lastAssistantContent(session) {
  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e && e.type === 'assistant/message') {
      return (e.data && e.data.message && e.data.message.content) || null
    }
  }
  return null
}
