# Fork notes — what changed vs upstream 0.6.11

This repository is a **compatibility fork** of
[`@tianbuyu-wwx/dsh-hermes-link`](https://github.com/Tianbuyu-wwx/dsh-hermes-link) 0.6.11
(published 2026-09-17), maintained because the upstream project has seen no
commits since then and its open issue
[#3](https://github.com/Tianbuyu-wwx/dsh-hermes-link/issues/3) (bundle patch name +
undeclared host dependencies) never received a response.

The fork is published to npm as the unscoped package **`dsh-hermes-link`** so it can
be installed next to the original without a scope collision, and its bundle patch
entry (`cordis.patch.yml` → `name: dsh-hermes-link`) now matches the published
package name.

Verified against **dsh 0.2.1-rc.5** on Linux; the upstream plugin targets dsh
0.1.5-rc.2.

---

## 1. Compatibility fixes (the reason this fork exists)

Upstream 0.6.11 does not work on dsh 0.2.x. Each row is a failure observed on a
real deployment, with its root cause and the fix in this fork.

| # | Symptom on 0.2.x | Root cause | Fix |
|---|---|---|---|
| 1 | `E_DISPATCH_FAILED: ctx.subagents.start is not a function` — every dispatch fails | 0.2.x replaced the subagents surface: `start` / `startContinuable` / `followup` became `startActivation` / `prompt`, `interrupt` kept its shape | new `services/host-compat.mjs`: detects the surface at call time, keeps the native 0.1.x path, and bridges onto `startActivation({ delivery: 'caller' \| 'parent' })` and `sendMessage(...)` when only the new façade exists |
| 2 | `followup` → `subagent prompt failed` (opaque) | `prompt()` is the **remote-control** face: it derives its source from `ctx.invocation`, which a plugin has no way to supply | followup uses the host-adapter face `sendMessage(liveParent, childId, content, {signal})` (idle child starts a turn), with `prompt()` as fallback and both failure reasons reported |
| 3 | `followup` crashes with `Cannot read properties of undefined (reading 'length')` | 0.2.x retired `session.events` in favour of `session.snapshotEvents()` + a `seq` getter; twelve call sites read the removed field | new `services/host-session.mjs` (`sessionEvents` / `sessionSeq` / `lastAssistantContent`) used everywhere |
| 4 | Every import → `create_failed`, reason hidden | (a) session format moved 3 → 4 and the header literal stayed at 3; (b) `import_hermes_session`'s output schema was `additionalProperties: false` without an `error` member, so the cause was dropped | version fallback is 4, plus **self-healing**: a codec rejection naming the expected version rebuilds the header and retries once (future v5 needs no release). `error` is part of the tool contract now |
| 5 | Import succeeds but opening the session says `stored log is corrupt: request/header is outside an open turn` | format v4 validates **ordering and tool lifecycle** on read: `request/header` must sit inside an open turn, steps are 1-based, an `assistant/message` must advertise its calls as `tool-call` content blocks *before* the log-only `tool/call`, and a `tool/result` must close an advertised call | converter rewritten to the canonical v4 order, unresolved calls closed with an honest placeholder result, orphan results dropped and counted; regression test loads converted events through the host's own `Session.fromRestore` **and** `restoreReleasedV4Artifact` (the real read path) |
| 6 | `format v4 tool/result at seq N requires a tool-role message` | v4 made tool results first-class `role:'tool'` messages with a message-level `toolCallId`; the v3 user-role wrapper is refused | `createToolResultMessage` emits the v4 shape (no nested `tool-result` block) |
| 7 | Plugin mounts nowhere: `Cannot access 'metrics' before initialization` | TDZ in `apply()`: `createConsultClient({... metrics})` ran three lines before `const metrics = ...` | registry created before its first reader |
| 8 | `ERR_MODULE_NOT_FOUND 'dsh-hermes-link'` on boot | the bundle patch used an unscoped name for a scoped package (upstream issue #3) | published unscoped and the patch name matches `(dsh-hermes-link)` |
| 9 | Imported conversations are listed as *unnamed* until opened | the sidebar reads the **projection cache** (a zero-I/O checkpoint), and imports only write the log | import warms the cache with `ctx.session.get('sessionProjectionCache').coldSnapshot(header, 0, events)`, the same cold-read the GUI would do on open |

## 2. Capabilities ported from a cross-machine deployment

Originally built for a Windows DSH + remote Hermes setup; all of them also help a
single-host install.

- **`config.hermesHome`** — resolve Hermes Home from the cordis patch entry
  (`config > HERMES_HOME > platform default`), with a warning + fallback when the
  configured directory is missing.
- **`read_hermes_memory`** — read `memories/MEMORY.md` and `memories/USER.md`
  (per-file byte cap, unit-tested in `services/hermes-memory.mjs`). Upstream
  deliberately keeps them out of the persona slice, and
  `load_hermes_project_memory` only matches the current cwd — with Hermes on
  another host there is no overlap, so the memory was unreachable.
- **Tool-catalog fallback** — some 0.2.x builds expose only `tools.schemas()`, not
  `view().restrictableNames`; `dispatch_probe` / `dispatch_dry_run` now try both
  instead of failing with `E_TOOL_CATALOG_UNAVAILABLE`.
- **Parent-agent retry** — spawning from a ghost agent fails with
  `cannot get required service "tools" in inactive context`; dispatch now tries
  the other live agents in order.
- **Host-configurable model tiers** — the hardcoded `deepseek-official` +
  `deepseek-v4-flash/pro` route is gone. Default is to send no `agentOptions` (the
  child inherits the parent's live route); pin tiers with
  `HERMES_LINK_MODEL_TIERS='{"flash":"provider/model"}'` and/or
  `HERMES_LINK_LLM_PROVIDER`.

## 3. New: optional cross-machine deployment

- `bridge/hermes-bridge.py` — SSH mirror daemon (ed25519 key auth, single instance,
  reconnect): bidirectional incremental sync of a remote Hermes Home
  (`sessions/`, `memories/`, `SOUL.md`, `AGENTS.md`, `config.yaml`, outbox,
  hand-off dirs), a **reduced** `state.db` snapshot (sessions table only), an
  optional reverse tunnel (`remote:127.0.0.1:13080 → local dsh web`) with port
  re-probing after a DSH restart, and an optional DSH-session export to the Hermes
  host.
- `bridge/config.example.json`, `bridge/verify.py` (15-point health check).
- `docs/CROSS-MACHINE.md` — three topologies (same host / remote read-only / remote
  + reverse tunnel), systemd units, verification commands, security notes
  (`HERMES_LINK_TOKEN` + Bearer, low-privilege SSH account) and a troubleshooting
  table.

## 4. Verification performed for this release

- Import: 11/11 Hermes sessions imported (`imported=11 skipped=0 failed=0`) and
  **every stored artifact validated through the host's read path**
  (`restoreReleasedV4Artifact`), including a 4,410-event session.
- Sidebar: all 11 projection-cache rows present with titles, without opening them.
- Dispatch: one-shot (`stop_reason=completed`, D1 result written), continuable
  (child_id + message_id + amend nonce), followup (`followup_completed`, real token
  accounting), interrupt (live child `interrupted`, finished child marked orphan).
- Tools: `dispatch_probe` reads 92 global tools through the fallback path;
  `dispatch_dry_run` returns budget + warnings; `read_hermes_memory` returns the
  real `USER.md`.
- Suites: `npm test` **27/27** (adds a v4 read-path regression, the memory reader,
  and the catalog fallback).

## 5. Known differences / limitations

- 0.2.x has **no per-activation `toolFilter` / `persona`** ("the selected preset
  owns persona and tool composition"). The fork folds the persona into the prompt's
  leading text block and passes the allow-list to the child as *advisory* guidance;
  the host does not enforce it. Logged once at runtime.
- `measureRealTokens` is best-effort: the new activation receipt exposes no live
  agent, so the shim resolves `ctx.agents.get(childId)` while the child is resident
  and reports `(unavailable)` afterwards.
- `` the plugin's HTTP surface is unauthenticated unless `HERMES_LINK_TOKEN` is set;
  see `docs/CROSS-MACHINE.md` §C.

## 6. Upgrading from upstream 0.6.11

1. Remove the scoped package and install this one:
   `dsh plugin --profile web remove @tianbuyu-wwx/dsh-hermes-link` then
   `dsh plugin --profile web add dsh-hermes-link`.
2. Drop the workaround patch entries (`disabled: true` for `dsh-hermes-link` and the
   `dsh-hermes-link-scoped` insert) — this fork's bundle patch resolves on its own.
3. Restart DSH once. Previously imported sessions that were written with the broken
   v4 order are **unreadable**; delete the affected `hermes-*` session directories
   (or call `import_hermes_session` again for the ones you care about) and the
   startup auto-sync rebuilds them in the correct order.
4. Run `npx hermes-link-doctor` — the healthy baseline is `8 ok, 1 warn, 0 fail`
   (the single warning is the empty session-mirror state).

---

## 中文摘要（与上游 0.6.11 的差异）

- **为什么 fork**：上游 2026-09-17 后停更，issue #3 无回应；0.6.11 面向 dsh
  0.1.5-rc.2，在 0.2.x 上派单、导入、followup 全部不可用。
- **兼容修复 9 项**：subagents 接口改名（`startActivation`/`prompt`/`sendMessage`）、
  followup 改走宿主适配面、`session.events` → `snapshotEvents()`、会话格式 v4
  （版本号 + 自愈重试 + 错误透传）、v4 事件顺序与工具生命周期、工具结果改
  `role:'tool'` 一等消息、TDZ 启动崩溃、bundle 包名、导入后预热投影缓存让标题立刻显示。
- **合并的跨机器能力**（单机也有用）：`config.hermesHome`、`read_hermes_memory`
  工具、工具目录 `schemas()` 回退、父 agent 多候选重试、模型路由改为宿主配置。
- **新增可选跨机器部署**：`bridge/hermes-bridge.py`（SSH 镜像守护 + 可选反向隧道 +
  DSH 导出）、`bridge/verify.py`、`docs/CROSS-MACHINE.md`（三种拓扑、systemd、
  安全与排错）。
- **验证**：11/11 会话导入且通过宿主读取校验（含 4410 事件的大会话）、侧边栏无需点开
  即有标题、一次性/可持续/followup/interrupt 全部实测、`npm test` 27/27。
- **已知限制**：0.2.x 不再支持逐次派单的 `toolFilter`/`persona`（persona 折进
  prompt，白名单仅作提示，不强制）。
