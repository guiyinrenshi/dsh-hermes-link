// services/tool-catalog.mjs
//
// v0.7.0 - read the visible tool names from whichever catalog API this host
// exposes.
//
// dsh 0.1.5 had `ctx.tools.view().restrictableNames`. Some 0.2.x builds expose
// only `ctx.tools.schemas()`, and calling the old one throws
// E_TOOL_CATALOG_UNAVAILABLE (observed on Windows dsh 0.2.1 during the
// cross-machine deployment). Both are projections of the same registry, so a
// caller that just needs names should try both before giving up.

/**
 * @param {object} ctx cordis context (tools service optional)
 * @returns {string[]|null} sorted visible tool names, or null when unavailable
 */
export function listToolNames(ctx) {
  const tools = ctx && ctx.tools
  if (!tools) return null
  try {
    if (typeof tools.view === 'function') {
      let view = null
      try { view = tools.view() } catch {}
      if (!view || !view.restrictableNames) {
        try { view = tools.view({}) } catch {}
      }
      if (view && view.restrictableNames) return [...view.restrictableNames].sort()
    }
  } catch {}
  try {
    if (typeof tools.schemas === 'function') {
      const schemas = tools.schemas()
      if (Array.isArray(schemas)) {
        const names = schemas.map((s) => s && s.name).filter((n) => typeof n === 'string' && n.length > 0)
        if (names.length > 0) return [...new Set(names)].sort()
      }
    }
  } catch {}
  return null
}
