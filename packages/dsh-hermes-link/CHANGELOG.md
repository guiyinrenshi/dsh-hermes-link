# dsh-hermes-link

## 0.8.3

### Fixed: the repair command wrote unreadable session files

0.8.1/0.8.2 shipped `hermes-link-repair-agent-preset` with a framing bug: it
re-compressed the whole log into ONE zstd frame, while the jsonl backend requires
the header to be its own first frame ("first frame is not exactly one header
line"). Running it made sessions disappear from the Hermes workspace.

- The rewrite now emits **two frames**: header + newline as frame one, events as
  frame two, and self-checks that frame one decodes to exactly the header line.
- `tests/test-agent-preset-repair.mjs` pins the frame contract (a test now fails
  if a future change collapses the frames again).
- If you already ran the broken command, restore the `.bak-agentpreset-<stamp>`
  backups (or delete the affected `hermes-*` directories and let the startup sync
  re-import them), then run the 0.8.3 command.

## 0.8.2

Re-publish of 0.8.1. The 0.8.1 npm release accepted its metadata but never
finished uploading the tarball (`.../dsh-hermes-link-0.8.1.tgz` answers 404), so
`npm i dsh-hermes-link@0.8.1` fails. Nothing else changed: install 0.8.2.

## 0.8.1

### Fixed: imported conversations could not be resumed

0.7.0/0.8.0 recorded `agentPreset: 'hermes-imported'` on every imported session.
dsh never ships that preset (`standard`, `ptc`, `minimal`, `cordis` are the
built-ins), so opening an imported conversation failed with

```
resume failed for session "hermes-...": RemoteError: Unknown agent preset: hermes-imported
```

- The importer no longer pins a preset blindly: `decideImportPreset()` asks the
  host's `agentPresets` registry and only keeps the id when it is declared —
  otherwise the header omits `agentPreset`, so the session resumes under the
  host default preset exactly like a GUI-created session.
- Sessions already on disk are repaired by a new command:

  ```sh
  npx hermes-link-repair-agent-preset --dry-run   # report only
  npx hermes-link-repair-agent-preset             # rewrite + .bak-agentpreset-<stamp> backups
  npx hermes-link-repair-agent-preset --to standard   # pin a specific preset instead
  ```

  It rewrites only the header line of `session.v4.jsonl.zstd`, keeps every event,
  backs each file up first, and is idempotent (a second run reports 0 changes).

### Tests

- `scripts/test-agent-preset-repair.mjs`: registry probing, strip semantics,
  header rewrite (events preserved), `--to`, unrelated presets, malformed input.

## 0.8.0

### New: delegate TO Hermes (`hermes_dispatch`)

Until now the bridge was one-directional in practice: Hermes could dispatch into
DSH (`dispatch_task`), but DSH could only ask Hermes a question
(`consult_hermes`, a file-based Q&A with no tools and no continuation).

0.8.0 registers **`hermes` as a real dsh subagent provider** and adds the
`hermes_dispatch` tool, so the direction is symmetric:

- `ctx.subagents.registerProvider({ name: 'hermes', start(request) })` — an
  external backend that runs Hermes' documented one-shot mode
  (`hermes -z "<prompt>" --in <cwd> ...`), so the child keeps Hermes' tools,
  memory, rules and `AGENTS.md`.
- `hermes_dispatch(task, workdir?, model?, provider?, reasoning?, toolset?,
  resume?, timeout_ms?)` starts that subagent, waits for the final text and
  returns it. `resume` defaults to `latest`, i.e. the run continues the newest
  Hermes session for the given working directory (`new` starts fresh).
- `config.hermesBin` (or `HERMES_BIN`) overrides the CLI path; otherwise the
  usual install locations and `PATH` are probed.
- Abort/timeout and teardown go through the normal activation lifecycle, so the
  child is killed rather than leaked.

Also: `config.hermesHome` now accepts `hermesBin` alongside it, and the provider
logs the resolved binary at boot.

## 0.7.0

### Compatibility release for dsh 0.2.x (verified on 0.2.1-rc.5)

This fork keeps every file channel (consult, outbox, persona, heartbeat,
session list/mirror) untouched and repairs the paths that hard-failed on a
0.2.x host.

- **Dispatch works again: the subagents facade moved.** dsh 0.2.x replaced
  `start / startContinuable / followup` with `startActivation / prompt` (+ an
  unchanged `interrupt`). `services/host-compat.mjs` now resolves the surface
  at call time: the native 0.1.x API is used as-is when present, and a bridge
  maps the old calls onto `startActivation({ delivery: 'caller' | 'parent' })`
  and `prompt({ mode: 'continuable', delivery: 'queue' })` when only the new
  facade exists. Previously every dispatch died with
  `E_DISPATCH_FAILED: ctx.subagents.start is not a function`.
- **Import writes again: session format v4.** `SESSION_FORMAT_VERSION` moved
  3 → 4 in 0.2.x, and the header literal stayed at 3, so `create()` succeeded
  and the first `append()`/`flush()` refused the log
  (`session header version must be 4, got 3`) — every import reported
  `create_failed`. The fallback is 4 now, and the write self-heals: when a
  codec rejection names the expected version, the partial artifact is removed,
  the header is rebuilt with the host's number and the write is retried once
  (so a future v5 does not need a release).
- **Cross-machine capabilities, useful on one host too.** Ported from a
  Windows deployment where Hermes lived on another machine:
  `config.hermesHome` (config > `HERMES_HOME` > platform default, with a
  warning + fallback when the directory is missing), a `read_hermes_memory`
  tool for `memories/MEMORY.md` + `memories/USER.md` (the files the persona
  slice deliberately omits; reading is capped and unit-tested in
  `services/hermes-memory.mjs`), a `tools.schemas()` fallback for every host
  whose catalog has no `view().restrictableNames` (no more
  `E_TOOL_CATALOG_UNAVAILABLE`), and dispatch retrying the other live parent
  agents when one has an inactive context.
- **Optional remote deployment**: `bridge/hermes-bridge.py` mirrors a remote
  Hermes Home over SSH (bidirectional, reduced `state.db` snapshot, optional
  reverse tunnel + DSH export) and `docs/CROSS-MACHINE.md` walks through all
  three topologies with systemd units, verification commands, security notes
  and a troubleshooting table.

- **Import: canonical v4 event ordering.** A stored v4 log is replayed through
  the relationship validator on read, and that validator is strict about order:
  `request/header` must sit inside an open turn, steps are 1-based, an
  `assistant/message` must advertise its tool calls as `tool-call` content
  blocks before the log-only `tool/call` events, and every `tool/result` must
  close an advertised call. The converter emitted the released-v3 order instead
  (header first, step 0, tool/call before the message), so imports LOOKED fine
  until the session was opened, then failed with
  `request/header is outside an open turn`. The order now matches a real DSH
  log, unresolved calls are closed with an honest placeholder result, and
  orphan results are dropped and counted.
- **Import failures are finally readable.** The `import_hermes_session` output
  schema was `additionalProperties: false` without an `error` member, so the
  importer's actual failure reason was dropped and users only saw `status`.
  `error` is part of the contract now.
- **Import: tool results are first-class tool-role messages.** Format v4
  replaced the v3 user-role message wrapping one `tool-result` block with
  `{ role:'tool', toolCallId, source:{kind:'tool',callId}, content:[…] }`, and
  refuses the old shape on write (`format v4 tool/result at seq N requires a
  tool-role message`). The converter emits the v4 message now, and a regression
  test loads the converted events through the host's own `Session.fromRestore`.
- **followup delivers through the host-adapter face.** 0.2.x's `prompt()` is the
  remote-control face: it derives its source from `this.ctx.invocation`, so a
  plugin calling it out of band fails inside the host and surfaces only
  `subagent prompt failed`. The compat layer uses
  `sendMessage(liveParent, childId, content, {signal})` (an idle child starts a
  turn) with `prompt()` as fallback, and reports both failure reasons.
- **Session logs are read through the host API.** 0.2.x retired
  `session.events` in favour of `session.snapshotEvents()` plus a `seq` getter,
  so every direct read returned undefined and the followup reply wait crashed
  with `Cannot read properties of undefined (reading 'length')`. A
  `services/host-session.mjs` accessor now serves all twelve call sites
  (dispatch control/task, continuations, status, inbox, session mirror, import).
- **The model route is host configuration.** `provider: 'deepseek-official'` +
  `deepseek-v4-flash/pro` were hardcoded, which only resolves on the upstream
  author's machine. Default is now to send no `agentOptions` at all (the child
  inherits the parent's live route); pin tiers with
  `HERMES_LINK_MODEL_TIERS='{"flash":"coding-plan/qwen3.8-flash"}'` and/or
  `HERMES_LINK_LLM_PROVIDER`.
- **Boot no longer dies in the temporal dead zone.** `createConsultClient`
  read `metrics` before its `const` declaration; on hosts where the error
  surfaced, `apply()` aborted with `Cannot access 'metrics' before
  initialization` and nothing mounted.
- **The bundle patch name is scoped.** The plugin is published unscoped
  (`dsh-hermes-link`), matching `cordis.patch.yml`, so the
  disable-this-entry-and-insert-another workaround is no longer needed on any
  host (upstream issue #3).
- Known semantic delta, logged once at runtime: 0.2.x has no per-activation
  `toolFilter`/`persona` ("the selected preset owns persona and tool
  composition"). Persona is folded into the prompt's leading text block, and
  the allow-list is passed to the child as advisory guidance — it is NOT
  enforced by the host.

## 0.6.11

### Patch Changes

- **Imported conversations now say what they are.** Every Hermes import is titled `[Hermes] …`, and a relabel pass runs right after the startup auto-sync so the ~180 sessions imported before the marker existed get labelled too (idempotent: a session already carrying the target title is skipped, so later starts write nothing). This is the cheap half of the P0-3 finding in `docs/ux-plan-v0.7.md`: a user reading a Hermes conversation in DSH could reasonably assume that replying there reaches Hermes — it does not, and the misunderstanding silently forks the conversation. (`hermes_followup`, a channel that would actually deliver a line back to Hermes, is still open.)
- Tests: `test-import-migration` case (l) pins the prefix and the title budget.

## 0.6.10

### Minor Changes

- **`npx dsh-hermes-link-setup`: onboarding is one command.** Wiring the bridge up used to be six steps spread across the README — copy the Hermes plugin, enable it there, restart Hermes, restart DSH, verify, troubleshoot — and two of them being skipped silently is exactly what the 2026-09-15 audit found. The wizard inspects the Hermes home and `config.yaml`, installs or refreshes the plugin, enables it through the Hermes CLI when one is reachable (otherwise it prints the exact command), probes the running DSH plugin, and ends with the short list only a human can do: the restarts. `--dry-run` prints the plan without touching anything; `--json` for scripts.
- The copy step moved to `services/hermes-plugin-install.mjs`, shared by the wizard and `hermes-link-install-hermes-plugin` (one copy path, one set of guards), and the planner lives in `services/setup.mjs` as pure functions so the whole decision table is tested without a real Hermes install (`scripts/test-setup.mjs`, 7 cases).

## 0.6.9

### Minor Changes

- **`hermes_link_status`: the one-glance answer.** The doctor is a check list (eleven probes, built for scripts); people ask a different question — "is it working, and what do I do next?". The new tool renders one line per channel (Hermes notifications, session import, session mirror, consult), the counters since plugin load, and the actions to take when something is off; `json=true` returns the same object for machines. The logic lives in `services/status.mjs` as pure functions, so the tool and the tests render identically.
- **Consult answers are now accounted for.** The Hermes plugin already recorded the model's token usage in its reply; the client books it into `hermes_link_consult_tokens_total{kind}` as it consumes the reply, and the status/doctor surfaces show it — "what does asking Hermes cost me?" finally has an answer.
- **`npx hermes-link-consult-admin`** — consult inbox status, plus the opt-in cleanup the TTL sweep deliberately never did: `--purge-expired` (dry run) removes only tickets that are past the TTL, have no reply, AND already carry an `.expired.json` marker (`--apply` to delete). Used here to clear the three tickets the 2026-09-15 audit found: the doctor then reported `9 ok, 0 warn, 0 fail` for the first time.
- `docs/ux-plan-v0.7.md` — the user-experience plan: five scenarios users complain about, the P0→P2 work with acceptance criteria, and the metrics that say whether it worked.

## 0.6.8

### Patch Changes

- **The Hermes bridge no longer announces sessions the importer cannot read.** Live evidence (2026-09-18 00:20): a fan-out spawned sub-agent sessions, every turn end produced an `import` notification, none of them had — or would get — a `request_dump`, and the consumer parked ten of them as `failed-*` with `not_found`, leaving a permanent `[warn] Hermes->DSH outbox` for something that was never importable. The plugin now writes the import notification only when `<Hermes Home>/sessions/request_dump_<sid>_*.json` exists; sessions whose dump lands later are covered by the DSH-side watcher and the startup sync, and short races by the v0.6.7 retry window. **Plugin version 0.3.0** — reinstall with `npx hermes-link-install-hermes-plugin` and start a new Hermes session (or restart it) to load it.
- **Fixed: a sticky `last_error`.** One resolved failure kept the doctor's `[warn] Hermes->DSH outbox` on screen forever; it is cleared by the next successful execution.

## 0.6.7

### Patch Changes

- **A failing notification now has a time budget, not just an attempt budget.** Live evidence: the Hermes bridge notifies on every turn end, but the `request_dump` the importer needs is written *later* — the cron session `..._233221` ended around 23:32 and its dump appeared at 23:52. Three attempts inside ~10s parked the notification as `failed-*` with `not_found`, and the session stayed invisible in DSH until a second notification arrived. `not_found` is a "not yet", not a "never": the consumer now keeps retrying until BOTH the attempt budget and a wall-clock window (`retryWindowMs`, default 30 minutes) are spent, and legacy numeric attempt records from older state files are upgraded rather than dropped.
- **Fixed: cron sessions were never imported by the "new dump" watcher.** `request_dump_<sid>_<YYYYMMDD>_<HHMMSS>_<micro>.json` was parsed with a lazy "shortest id" pattern, so a cron session -- whose id already ends in `_<YYYYMMDD>_<HHMMSS>` -- came out as `cron_<job>` instead of `cron_<job>_<stamp>`. The watcher then asked the importer for a session id that does not exist, so every cron session had to arrive through the startup sync or a Hermes-side notification. Both parsers (the watcher's and the converter's filename fallback) are now anchored at the END of the name, where the dump stamp always sits, and malformed names return `null` instead of a guess.

## 0.6.6

### Patch Changes

- **Fixed: imports silently pinned no model route in production.** The importer's route resolver read `ctx.agentDefaultModel` directly, and that service turned out to be unreachable from the plugin's context — so every import since the pin shipped (33 sessions) appended no `model/selection` while every test stayed green (the tests inject the service by hand). The resolver now tries, in order: the injected service, the registry lookup `ctx.get('agentDefaultModel')`, and finally the deployment's own `agent-default-model` block in `$DSH_HOME/settings.yaml` (`HERMES_LINK_IMPORT_MODEL` still wins over all three). The live pin scan is what caught it — 33/178 sessions without a route — and `scripts/repair-imported-model-selection.mjs --apply` has pinned them.
- **`GET /mcp/collab/health` now reports `import_model_route`** — the route the next import would pin, or `null` when none resolves. An import that pins nothing leaves the conversation's model and mode selectors blocked, and until now that was only visible after the fact.
- Test: `test-import-migration` case (k) covers the settings fallback (no `agentDefaultModel` on the context at all).

## 0.6.5

### Minor Changes

- **The doctor now reports `signals`: what each channel has actually DONE, not just whether it can work.** "No failures" and "no traffic" used to look identical in the report — which is exactly how three dead channels survived an audit that read the code. The `signals` check carries dispatches, imports, consults, mirror sessions auto-enabled, outbox notifications, skipped events, expiry markers, queue depth, SSE channels and uptime.
  - One parser (`parsePrometheus`, exported) serves both the in-process registry (`metrics.serialize()`) and the CLI reading `GET /mcp/collab/metrics` over HTTP, so the two can never drift into reporting different numbers for the same metric. Labels collapse into one number on purpose; per-label detail stays one curl away.
  - Wired through all three surfaces: `GET /mcp/collab/doctor`, the session tool `hermes_link_doctor`, and `npx hermes-link-doctor --url <host> [--token <t>]` (which falls back to reading `/metrics` directly when the live probe is unavailable or auth-gated). `renderDoctor` prints the numbers as a table under the checks.

### Patch Changes

- **Fixed: the metric collector had been failing silently since v0.3.2.** Its whole cycle sat inside one `try/catch` that swallowed everything, and it called `set()` on metrics registered as COUNTERS (`hermes_link_outbox_flush_runs_total`, the dropped-`*` totals, `hermes_link_continuables_registered_total`) — which the registry refuses by contract — so everything after them (`sse_clients`, `sse_channels`, `active_dispatchers`, `uptime_seconds`, `build_info`) was never written. Every scrape reported 0 and nothing said why. The collector now lives in `services/metric-collector.mjs` (testable), writes gauges through a per-value guard, exports externally-owned totals as monotonic counter deltas, records each rejected metric once, and `hermes_link_continuables_registered_total` is incremented where continuables actually register.

## 0.6.4

### Minor Changes

- **The Hermes-side bridge now answers consults too** (`hermes-plugin/dsh-link`, renamed from `dsh-outbox`). `consult_hermes` has been writing tickets into `inbox/dsh/consult/` since v0.2.0 and nothing on the Hermes side ever answered one — the audit found three tickets that had been sitting for three weeks. The plugin now runs a background poller that answers each pending ticket with `ctx.llm.complete(...)` (the host-owned LLM facade: the user's active model, no API keys in the plugin) and writes `consult-reply/<ticket>-<secret>.json` where the DSH client expects it, plus a durable `<ticket>.answered.json` marker. `/dsh-consult [n]` drains the queue on demand; tickets older than `ttl_hours` are left to DSH's own expiry sweep. Config: `plugins.entries.dsh-link.consult.{enabled,interval_seconds,ttl_hours,max_tokens,max_per_cycle,system_prompt}`.

### Patch Changes

- **The channel health check no longer cries dead once a reply has been consumed**: it reads the `<ticket>.answered.json` marker as answer evidence, so abandoned tickets (the three from the audit) report `degraded` — "Hermes answered recently, these are abandoned" — instead of `dead`, and the consult pre-flight stops trimming every future call to 2s.
- The consult sweep counts an answered ticket once (the marker is evidence, not a second ticket).

## 0.6.3

### Minor Changes

- **The reverse channel finally has a producer.** `Hermes Home/outbox/hermes/` was promised by `docs/DSH-HERMES-LINK-PLAN.md` and the DSH-side consumer shipped in 0.6.0 — but nothing on the Hermes side ever wrote a file, so the channel sat idle (a consumer with no producer looks exactly like "nothing to do"). `npx hermes-link-install-hermes-plugin` installs `hermes-plugin/dsh-outbox` into `<Hermes Home>/plugins/dsh-outbox/`, the documented out-of-tree plugin location, where it registers `on_session_end` and the `/dsh-notify <message>` slash command:
  - one `import` notification per Hermes **turn end** → DSH imports/refreshes that session immediately instead of waiting for its own dump watcher;
  - a `notify` when a turn failed or was interrupted (also published on DSH's `hermes-outbox` SSE channel);
  - a `producer_ready` ping at load, so "no notifications" can be told apart from "no producer".
  Hermes must be **restarted** after installing (plugins are discovered at start-up); `GET /mcp/collab/doctor` reports whether the producer is present.

### Patch Changes

- **Consumer hardening**: scans can no longer overlap (the fs.watch debounce, the safety poll and the start-up pass used to race), and a notification that vanishes between listing and reading is counted as `gone` instead of sticking into `last_error` and raising a doctor warning for a benign race.
- **New doctor check `hermes_producer`**, plus the installer hardening it exposed (`copyFileSync` + a post-copy existence check).

## 0.6.2

### Patch Changes

- **`hermes_link_doctor` tool** — the runtime self-check is now callable from inside a DSH session, not only from a shell or curl. Same module behind `npx hermes-link-doctor`, `GET /mcp/collab/doctor` and the tool.
- **Consult pre-flight** — `consult_hermes` checks the channel before waiting. With a backlog and no reply for days (the state the audit found: three tickets, three weeks) it waits 2s instead of the full 15s and says why, instead of making every caller rediscover a dead channel. An explicit `timeout_ms` still wins.
- **The mirror scope is editable the safe way** — `session_mirror` gains `action=projects|add-project|remove-project` (`path=<dir>`), writing `<DSH_HOME>/dsh-hermes-link/mirror-projects.json` as bare UTF-8 and applying it to the next event without a restart. Hand-writing that file is what produced the BOM that silently disabled the mirror.
- **Fixed: `GET /mcp/collab/metrics` returned 503 in production** — `index.mjs` never passed the metrics registry into the HTTP layer, and the e2e suite builds its own deps so CI stayed green. A wiring guard now asserts that every `deps.*` the HTTP layer reads is provided by the production call.
- **Fixed: the mirror scope file is BOM-tolerant**, and a file that exists but cannot be parsed is reported (`policyStatus().projects_file_error` + a doctor warning) instead of being silently ignored.
- **Fixed: decision diagnostics** no longer glue the packed config revision onto the reported `cwd`.

## 0.6.1

### Patch Changes

- **The doctor and the model-pin repair tool now ship with the package.** `bin/hermes-link-doctor.mjs` and `bin/repair-imported-model-selection.mjs` are exposed as the `hermes-link-doctor` and `hermes-link-repair-model-pins` bins, so an npm install can run `npx hermes-link-doctor` (or `npx hermes-link-repair-model-pins --apply`) without cloning the repository. The repository's `scripts/hermes-link-doctor.mjs` and `scripts/repair-imported-model-selection.mjs` remain as thin wrappers; `GET /mcp/collab/doctor` is still the in-process surface.

## 0.6.0

### Minor Changes

- **Both sync directions now work end to end (audit phases A–D).**
  - **Hermes → DSH import** migrated to the DSH 0.1.5 handle-based persistence API (`stat`/`list` + the write handle `create()` returns: `append`/`flush`/`close`). Failures no longer degrade to `already_imported`, imported history is anchored in one workspace (`HERMES_LINK_IMPORT_WORKSPACE`, with `HERMES_LINK_IMPORT_PER_PROJECT=1` restoring per-project inference), and a Windows cwd that is not fully qualified is never handed to DSH.
  - **Imported sessions get a live model route.** Imports now append a `model/selection` event pointing at the deployment's own route (`ctx.agentDefaultModel`). DSH reads a session's current model from its last `request/header`, and the synthetic `dsh-hermes-link` provider recorded there is served by no adapter — which blocked the whole composer (model *and* agent preset unchangeable). Existing sessions: `node scripts/repair-imported-model-selection.mjs --apply`; override the route with `HERMES_LINK_IMPORT_MODEL=provider/model[#effort]`.
  - **Session mirror that is actually reachable.** `HERMES_LINK_MIRROR_POLICY=off|scoped|all` (default `scoped`), plus `HERMES_LINK_MIRROR_PROJECTS` and the plugin-owned `<DSH_HOME>/dsh-hermes-link/mirror-projects.json` for local paths whose Hermes project key is stale or missing (re-read live — no restart). `GET /mcp/collab/session-mirror/status` now returns the resolved policy and per-session decisions, so "why is nothing mirrored?" is answerable. Mirror lines carry `{ts, cursor, source, origin_session_id, event}`; resume with `GET /mcp/collab/session-stream?session_id=<sid>&since_seq=<cursor>`.
  - **Hermes → DSH notification channel (new).** `Hermes Home/outbox/hermes/**/*.json` is consumed with the verified amend-watcher shape (fs.watch + debounce + safety poll): `kind:"import"` runs the importer, `notify`/`ping` publish on the `hermes-outbox` SSE channel, every file leaves the scan set (executed → `done/`, redelivery → `duplicate-*`, echo/malformed/unsupported/failed → prefixed), and `(source,id)` is remembered across restarts. Status: `GET /mcp/collab/hermes-outbox/status`.
  - **Runtime doctor + consult TTL.** `npm run doctor` (or `GET /mcp/collab/doctor`) measures heartbeat freshness, mirror liveness, consult backlog with per-ticket age, amend writability and outbox state — plus `--pin-scan` for imported-session model pins. Consult tickets unanswered past 24h get a non-destructive `<ticket>.expired.json` marker, counted by `hermes_link_consult_expired_total`.

### Patch Changes

- Per-token rate limiting and a daily token budget for `dispatch_task` (one `check()` per request, guarded metrics), plus a real-tokenizer path for `dispatch_dry_run`/`dispatch_task` budgets.
- Telemetry can no longer break a request path: `http/_util.mjs` exports guarded `incMetric`/`setMetric` (the registry throws on unregistered names), with a permanent regression gate in `scripts/test-telemetry-resilience.mjs`.
- Housekeeping tools: `scripts/prune-empty-workspaces.mjs` (must run with DSH stopped), `scripts/repair-imported-model-selection.mjs`, `scripts/hermes-link-doctor.mjs`.

## 0.5.0

### Patch Changes

- 8df0e6a: docs(changelog): add a "Published-vs-documented version map" header that explicitly marks `0.3.1`–`0.3.4` as **never published to npm** and points readers to `0.3.5` (the actual consolidating release). Also adds the same pointer to the package-level `CHANGELOG.md`. No runtime changes.
- 8df0e6a: ci(test): wrap `npm ci` in a 3-attempt retry via `nick-fields/retry@v3` to absorb intermittent `EPERM` / `ENOTEMPTY` failures on `macos-26-arm64` runners (the npm temp dir under `/var/folders` interacting with the homebrew node shim has produced occasional fs hiccups). All existing jobs still preserve real install failures on the 3rd attempt. No runtime changes.
- 8df0e6a: ci(release): drop the `NODE_AUTH_TOKEN` env from the publish step and document the npm trusted-publishing setup at `npmjs.com → settings → Publishing access → Trusted Publishers`. The `permissions: id-token: write` block above already wires the OIDC token; once the trusted-publisher entry exists, `--provenance` will produce a real attestation. No runtime changes.

> **Versions 0.3.1, 0.3.2, 0.3.3, and 0.3.4 were documented in the monorepo CHANGELOG (`../../CHANGELOG.md`) but never published to npm. See the "Published-vs-documented version map (2026-08-26)" section there. Use `0.3.5` (or later) for the consolidating release.**

## 0.5.0

### Minor Changes

- - Add opt-in automatic DSH session mirror (V4 opt-in): new `session_mirror` tool with `enable` / `disable` / `status`, default OFF, per-session persistence, and shared secret redaction.
  - Add Hermes real-time session sync / session-projection: `GET /mcp/collab/session-stream` SSE feed, `GET /mcp/collab/session-mirror/status`, and `mirror_status` in `list_hermes_sessions` / `GET /mcp/collab/sessions`.
  - Add `scripts/test-session-mirror.mjs`, extend smoke/import/e2e coverage, and add `session_mirror` to docs/skill/readme.

## 0.2.6

### Patch Changes

- fe4d389: fix(import): preserve Hermes AI replies and tool calls in OpenAI-style dumps
