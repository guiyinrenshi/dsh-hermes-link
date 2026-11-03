# Deploying dsh-hermes-link

Three supported topologies. Pick the first one that matches your machines;
everything after it is additive.

| # | Topology | What works | Extra pieces |
|---|---|---|---|
| A | **DSH and Hermes on the same host** (default) | everything: session import, persona, consult, outbox, session mirror, Hermes→DSH dispatch | none |
| B | **Hermes on another host** (DSH only reads Hermes) | session import, persona, memory, consult-by-file, outbox | `bridge/hermes-bridge.py` mirror + `config.hermesHome` |
| C | **B + reverse tunnel** (Hermes can also dispatch into DSH) | everything, including `dispatch_task` driven from Hermes | B + SSH reverse port forward + `mcp_servers.dsh-bridge` on the Hermes host |

---

## A. Same host (recommended default)

1. Install the plugin into the DSH profile:

   ```sh
   dsh plugin --profile web add dsh-hermes-link
   ```

   (or, from a checkout: `dsh plugin --profile web add /path/to/packages/dsh-hermes-link`.)

2. Make sure DSH can find Hermes Home. The plugin resolves it in this order:

   - `config.hermesHome` in the cordis patch entry (see B),
   - `HERMES_HOME` in the DSH environment,
   - the platform default (`$LOCALAPPDATA/hermes` on Windows, `~/.local/share/hermes` on POSIX).

   For a normal install `HERMES_HOME` is all you need:

   ```sh
   # /etc/dsh/env  (systemd EnvironmentFile) or your shell profile
   HERMES_HOME=/root/.hermes
   ```

3. Restart DSH once so the plugin mounts. Then:

   ```sh
   npx hermes-link-doctor          # 8 ok / 1 warn / 0 fail is the healthy baseline
   npx hermes-link-status          # one line per channel
   ```

4. Hermes side (so Hermes can answer `consult_hermes` and fire turn notifications):

   ```sh
   npx hermes-link-install-hermes-plugin
   hermes plugins list | grep dsh-link        # enabled
   ```

**Nothing else is required for A.** The exported sessions appear in the DSH
sidebar; the plugin warms the projection cache at import time, so titles show
without opening each session.

---

## B. Hermes on another host (read-only mirror)

The plugin is filesystem-based: it reads `<Hermes Home>/sessions`, `state.db`,
`SOUL.md`, `memories/`, and writes hand-off files into `<Hermes Home>/inbox/dsh`.
The bridge keeps that directory tree mirrored from the Hermes host over SSH, and
`config.hermesHome` points the plugin at the mirror.

1. **Prepare key auth** (once, from the DSH host):

   ```sh
   ssh-keygen -t ed25519 -N '' -f ~/.hermes-bridge/bridge_key
   ssh-copy-id -i ~/.hermes-bridge/bridge_key.pub hermes@hermes.example.lan
   ```

2. **Configure the bridge**:

   ```sh
   cd packages/dsh-hermes-link/bridge
   cp config.example.json config.json
   $EDITOR config.json     # host / user / key_path / remote_home / local_home
   ```

   Key fields:

   | field | meaning |
   |---|---|
   | `remote_home` | Hermes Home **on the Hermes host** (e.g. `/root/.hermes`) |
   | `local_home` | mirror directory **on the DSH host** (e.g. `~/.hermes-mirror`) |
   | `pull_roots` | directories copied remote → local (`sessions`, `memories`, `outbox/hermes`, …) |
   | `push_roots` | hand-off directories copied local → remote (`inbox/dsh/consult`, `…/amend`, …) |
   | `state_db_interval_seconds` | how often `state.db` is pulled as a *reduced* snapshot (sessions table only) |
   | `tunnel` | reverse port forward used by topology C; leave `enabled:false` for B only |
   | `dsh_export` | optional: publish DSH sessions + workspace manifest to the Hermes host |

3. **First sync** (diagnostic, one pass):

   ```sh
   python3 hermes-bridge.py once      # prints what moved; exit 0 on success
   python3 verify.py                  # 15/15 when B (and C) are complete
   ```

4. **Run it as a service** (systemd example):

   ```ini
   # /etc/systemd/system/hermes-bridge.service
   [Unit]
   Description=Hermes Home mirror for dsh-hermes-link
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=root
   WorkingDirectory=/opt/dsh-hermes-link/bridge
   ExecStart=/usr/bin/python3 hermes-bridge.py sync
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

   ```sh
   systemctl daemon-reload && systemctl enable --now hermes-bridge
   journalctl -u hermes-bridge -f
   ```

5. **Point the plugin at the mirror** — in the DSH profile's `cordis.patch.yml`:

   ```yaml
   - id: dsh-hermes-link
     name: 'dsh-hermes-link'
     config:
       hermesHome: /root/.hermes-mirror
   ```

   Then restart DSH and run `npx hermes-link-doctor` (it prints the Hermes home
   it resolved).

> `config.hermesHome` is checked first; an existing `HERMES_HOME` keeps working
> as the fallback. If the configured directory is missing the plugin logs a
> warning and falls back to detection instead of failing to boot.

### What B gives you

- `list_hermes_sessions` / `import_hermes_session` — the whole Hermes archive
  becomes DSH sessions (titles included).
- `load_hermes_persona`, `load_hermes_project_memory`, **`read_hermes_memory`**
  (new in 0.7.0: `memories/MEMORY.md` + `memories/USER.md`, the files upstream
  deliberately keeps out of the persona slice).
- `consult_hermes` — DSH writes a ticket into the mirror's `inbox/dsh/consult`,
  the bridge pushes it to Hermes, the Hermes-side `dsh-link` plugin answers, the
  bridge pulls the reply back.
- Turn notifications from Hermes arrive through the mirrored
  `outbox/hermes` directory.

---

## C. Let Hermes dispatch into DSH (reverse tunnel)

Hermes hosts usually cannot reach the DSH web server (DSH binds loopback). Open
an SSH **reverse** forward from the Hermes host to the DSH host:

```
hermes-host:127.0.0.1:13080  ──SSH──▶  dsh-host:127.0.0.1:3091  (/mcp/collab)
```

The bridge does this for you when `tunnel.enabled` is true: it opens
`remote_port` on the Hermes host and forwards to the DSH web port, re-probing the
local port every `probe_seconds` (DSH picks a new port after a restart) and
rebuilding the forward after SSH reconnects.

1. Enable the tunnel in `bridge/config.json`:

   ```json
   "tunnel": { "enabled": true, "bind": "127.0.0.1", "remote_port": 13080, "local_port": 3091 }
   ```

2. Register DSH as an MCP server **on the Hermes host** (`~/.hermes/config.yaml`):

   ```yaml
   mcp_servers:
     dsh-bridge:
       url: http://127.0.0.1:13080/mcp/collab
       connect_timeout: 20.0
       enabled: true
   ```

3. Restart the Hermes gateway, then verify **on the Hermes host**:

   ```sh
   hermes mcp test dsh-bridge      # ✓ connected, ✓ 11 tools discovered
   curl -s http://127.0.0.1:13080/mcp/collab/health
   ```

4. From a Hermes session, dispatch a real task:

   ```
   use dsh-bridge dispatch_probe with skill "read"
   use dsh-bridge dispatch_task  task_id=t1 skill=read task="..."
   ```

**Requirement:** a live DSH session must exist, otherwise `dispatch_task`
answers `E_NO_LIVE_AGENT` by design.

### Security for C

- The tunnel binds `127.0.0.1` on the Hermes host only — it is not exposed to the
  network.
- The plugin's HTTP surface is unauthenticated by default. On a shared host set a
  token on the DSH side and send it from Hermes:

  ```sh
  # DSH host: /etc/dsh/env
  HERMES_LINK_TOKEN=<random-32-bytes>
  ```

  ```yaml
  # Hermes host: ~/.hermes/config.yaml
  mcp_servers:
    dsh-bridge:
      url: http://127.0.0.1:13080/mcp/collab
      headers:
        Authorization: "Bearer <random-32-bytes>"
  ```

- Prefer a dedicated low-privilege account for the SSH key instead of `root`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `E_TOOL_CATALOG_UNAVAILABLE` | fixed in 0.7.0 (falls back to `tools.schemas()`); on older builds the tool list is read via `view().restrictableNames` only |
| `dispatch_task` → `cannot get required service "tools" in inactive context` | ghost parent agent; 0.7.0 retries the other live agents automatically |
| `E_NO_LIVE_AGENT` | no DSH session is open — open one in the GUI first |
| imported session shows no title until opened | 0.7.0 warms the projection cache at import time; for older versions run any import once after upgrading |
| `stored log is corrupt: request/header is outside an open turn` | pre-0.7.0 import order; delete the affected `hermes-*` session dir and let the auto-sync rebuild it |
| bridge keeps reconnecting | `journalctl -u hermes-bridge`; check key auth with `ssh -i ~/.hermes-bridge/bridge_key user@host true` |
| DSH restarted → tunnel dead | expected for one probe interval (`probe_seconds`); the bridge re-locates the port automatically |

---

## 中文速查（摘要）

- **同机（最常见）**：装插件 → `/etc/dsh/env` 里写 `HERMES_HOME=/root/.hermes` → 重启 dsh → `npx hermes-link-doctor`。
- **Hermes 在另一台机器**：`bridge/hermes-bridge.py` 用 SSH 把对方的 Hermes Home 镜像到本机（`config.json` 里配 `remote_home` / `local_home`），DSH 的 cordis patch 条目加 `config.hermesHome: /你的/镜像目录`。首次 `python3 hermes-bridge.py once`，然后 `verify.py`。
- **要让 Hermes 反过来给 DSH 派活**：打开 `tunnel.enabled`（在 Hermes 主机上开 `127.0.0.1:13080` 转发到 DSH 的 3091），并在 Hermes 的 `config.yaml` 里加 `mcp_servers.dsh-bridge`；`hermes mcp test dsh-bridge` 应报 11 个工具。
- **安全**：隧道只绑回环；共享机器上给 DSH 设 `HERMES_LINK_TOKEN`，Hermes 侧加 Bearer 头；SSH 用专用低权账号，别用 root。
