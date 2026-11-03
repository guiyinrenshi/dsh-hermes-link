#!/usr/bin/env python3
"""hermes-bridge — keep a local mirror of a remote Hermes Agent home in sync.

The DSH plugin `@tianbuyu-wwx/dsh-hermes-link` is filesystem based: it reads
<HERMES_HOME>/sessions, state.db, SOUL.md, memories/... and writes hand-off
files into <HERMES_HOME>/inbox/dsh.  This bridge makes `HERMES_HOME` a live
mirror of a Hermes Agent living on another machine (here: 192.168.10.106),
so every DSH tool keeps working unchanged.

Directions
----------
remote -> local : sessions/, memories/, SOUL.md, AGENTS.md, config.yaml,
                  state.db (reduced snapshot, sessions table only),
                  outbox/hermes/, inbox/dsh/consult-reply/,
                  inbox/dsh/dispatch-result/
local  -> remote: inbox/dsh/{consult,amend,session-mirror,dispatch-result}/
                  (the hand-off files the DSH side produces)
optional        : DSH sessions + workspace manifest -> remote /root/dsh-share
                  so Hermes can read what DSH is doing.

Usage
-----
  python hermes-bridge.py setup-key     # one-time: install our public key
  python hermes-bridge.py once          # one sync pass (diagnostics)
  python hermes-bridge.py sync          # daemon loop (default)

Password auth is only used by `setup-key`; afterwards the daemon uses the
generated key at ~/.hermes-bridge/id_ed25519.
"""
from __future__ import annotations

import argparse
import json
import os
import posixpath
import select
import shutil
import socket
import subprocess
import sys
import time
import traceback
import urllib.request
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import paramiko

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"
STATE_PATH = HERE / "state.json"
LOG_PATH = HERE / "bridge.log"

DEFAULT_CONFIG = {
    "host": "192.168.10.106",
    "port": 22,
    "user": "root",
    "key_path": "C:/Users/23071/.hermes-bridge/bridge_key",
    "remote_home": "/root/.hermes",
    "local_home": "C:/Users/23071/.hermes-mirror",
    "poll_seconds": 3,
    "pull_batch_files": 120,
    "pull_batch_bytes": 64 * 1024 * 1024,
    "state_db_interval_seconds": 120,
    "pull_roots": [
        "sessions",
        "memories",
        "outbox/hermes",
        "inbox/dsh/consult-reply",
        "inbox/dsh/dispatch-result",
    ],
    "pull_files": ["SOUL.md", "AGENTS.md", "config.yaml"],
    "push_roots": ["inbox/dsh/consult", "inbox/dsh/amend", "inbox/dsh/session-mirror"],
    "skip_suffixes": [".lock", "-shm", "-wal", ".tmp"],
    "dsh_export": {
        "enabled": True,
        "remote_dir": "/root/dsh-share",
        "local_sessions": "C:/Users/23071/.dsh/sessions",
        "local_workspace": "D:/文档/deepseek-harness/default-workspace",
        "interval_seconds": 60,
        "manifest_max_files": 4000,
        "skip_dirs": [".git", "node_modules", ".venv", "__pycache__", ".tools", ".uitest"],
    },
    # Reverse SSH tunnel: makes the loopback-only DSH web server reachable from
    # the Hermes host as http://127.0.0.1:<remote_port>, so Hermes can add it as
    # an MCP server and dispatch tasks back into DSH.
    "tunnel": {
        "enabled": True,
        "bind": "127.0.0.1",
        "remote_port": 13080,
        "local_port": 59928,
        "candidate_ports": [59928, 60999, 3080],
        "probe_seconds": 10,
    },
}


def log(msg: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + msg
    print(line, flush=True)
    try:
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    else:
        CONFIG_PATH.write_text(json.dumps(DEFAULT_CONFIG, indent=2, ensure_ascii=False), encoding="utf-8")
    return cfg


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"pulled": {}, "pushed": {}, "exported": {}, "last_state_db": 0, "last_export": 0}


def save_state(state: dict) -> None:
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
    os.replace(tmp, STATE_PATH)


def expand(path: str) -> str:
    return os.path.expanduser(str(path).replace("/", os.sep))


# ---------------------------------------------------------------------------
# transport
# ---------------------------------------------------------------------------

class Bridge:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.client: paramiko.SSHClient | None = None
        self.sftp: paramiko.SFTPClient | None = None
        self.remote_home = cfg["remote_home"].rstrip("/")
        self.local_home = Path(expand(cfg["local_home"]))
        self.local_home.mkdir(parents=True, exist_ok=True)

    # -- connection ---------------------------------------------------------
    def connect(self) -> None:
        cfg = self.cfg
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        key = expand(cfg["key_path"]) if cfg.get("key_path") else ""
        common = dict(
            hostname=cfg["host"],
            port=int(cfg.get("port", 22)),
            username=cfg["user"],
            timeout=20,
            banner_timeout=30,
            auth_timeout=30,
            look_for_keys=False,
            allow_agent=False,
        )
        last = None
        if key and os.path.exists(key):
            try:
                client.connect(key_filename=key, **common)
            except Exception as exc:  # fall back to password when key is stale
                last = exc
                client = paramiko.SSHClient()
                client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        if not client.get_transport() or not client.get_transport().is_authenticated():
            password = os.environ.get("HERMES_BRIDGE_PASSWORD") or cfg.get("password")
            if not password:
                raise RuntimeError(f"SSH auth failed ({last}); no password available either")
            client.connect(password=password, **common)
        self.client = client
        self.sftp = client.open_sftp()
        log(f"connected to {cfg['user']}@{cfg['host']}:{cfg.get('port', 22)}")

    def close(self) -> None:
        try:
            if self.sftp:
                self.sftp.close()
        except Exception:
            pass
        try:
            if self.client:
                self.client.close()
        except Exception:
            pass
        self.sftp = None
        self.client = None

    def ensure(self) -> None:
        if not self.client or not self.client.get_transport() or not self.client.get_transport().is_active():
            self.close()
            self.connect()

    def run(self, command: str, timeout: int = 120) -> str:
        self.ensure()
        stdin, stdout, stderr = self.client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        rc = stdout.channel.recv_exit_status()
        if rc != 0 and err.strip():
            log(f"remote command rc={rc}: {err.strip()[:400]}")
        return out

    # -- path helpers -------------------------------------------------------
    def remote_path(self, rel: str) -> str:
        return posixpath.join(self.remote_home, rel)

    def local_path(self, rel: str) -> Path:
        return self.local_home / rel.replace("/", os.sep)

    def mkdir_remote(self, rel_dir: str) -> None:
        self.run(f"mkdir -p {shquote(self.remote_path(rel_dir))}")

    def upload_text(self, text: str, remote_path: str) -> None:
        """Write a text blob remotely without hitting ARG_MAX on long content."""
        self.upload_bytes(text.encode("utf-8"), remote_path)

    def upload_bytes(self, data: bytes, remote_path: str) -> None:
        import io

        self.run(f"mkdir -p {shquote(posixpath.dirname(remote_path))}")
        tmp = remote_path + ".part"
        self.sftp.putfo(io.BytesIO(data), tmp)
        self.run(f"mv -f {shquote(tmp)} {shquote(remote_path)}")

    # -- pull ---------------------------------------------------------------
    def list_remote(self) -> dict[str, tuple[int, float]]:
        roots = [r for r in self.cfg["pull_roots"]] + self.cfg["pull_files"]
        quoted = " ".join(shquote(self.remote_path(r)) for r in roots)
        cmd = (
            f"cd {shquote(self.remote_home)} 2>/dev/null || exit 1; "
            f"find {quoted} -type f -printf '%T@\\t%s\\t%p\\n' 2>/dev/null"
        )
        out = self.run(cmd, timeout=120)
        entries: dict[str, tuple[int, float]] = {}
        prefix = self.remote_home.rstrip("/") + "/"
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) != 3:
                continue
            mtime, size, full = parts
            rel = full[len(prefix):] if full.startswith(prefix) else full
            if any(rel.endswith(sfx) for sfx in self.cfg["skip_suffixes"]):
                continue
            try:
                entries[rel] = (int(size), float(mtime))
            except ValueError:
                continue
        return entries

    def pull(self, state: dict) -> None:
        entries = self.list_remote()
        if not entries:
            return
        pulled: dict = state.setdefault("pulled", {})
        todo = [rel for rel, meta in entries.items() if pulled.get(rel) != [meta[0], round(meta[1], 3)]]
        todo.sort(key=lambda r: entries[r][1])  # oldest first
        budget_files = int(self.cfg.get("pull_batch_files", 120))
        budget_bytes = int(self.cfg.get("pull_batch_bytes", 64 * 1024 * 1024))
        used_bytes = 0
        done = 0
        for rel in todo:
            size, mtime = entries[rel]
            if done >= budget_files or (done and used_bytes + size > budget_bytes):
                break
            local = self.local_path(rel)
            local.parent.mkdir(parents=True, exist_ok=True)
            tmp = local.with_name(local.name + ".part")
            try:
                self.sftp.get(self.remote_path(rel), str(tmp))
                os.replace(tmp, local)
                pulled[rel] = [size, round(mtime, 3)]
                used_bytes += size
                done += 1
            except Exception as exc:
                log(f"pull failed {rel}: {exc}")
                try:
                    tmp.unlink()
                except OSError:
                    pass
        if done:
            log(f"pulled {done} file(s), {used_bytes/1048576:.1f} MiB (pending {len(todo)-done})")
            save_state(state)

    # -- push ---------------------------------------------------------------
    def push(self, state: dict) -> None:
        pushed: dict = state.setdefault("pushed", {})
        uploaded = 0
        for root in self.cfg["push_roots"]:
            base = self.local_path(root)
            if not base.is_dir():
                continue
            self.mkdir_remote(root)
            for path in sorted(base.rglob("*")):
                if not path.is_file():
                    continue
                rel = path.relative_to(self.local_home).as_posix()
                if any(str(rel).endswith(sfx) for sfx in self.cfg["skip_suffixes"]):
                    continue
                st = path.stat()
                meta = [st.st_size, round(st.st_mtime, 3)]
                if pushed.get(rel) == meta:
                    continue
                remote = self.remote_path(rel)
                tmp = remote + ".part"
                try:
                    self.sftp.put(str(path), tmp)
                    self.run(f"mv -f {shquote(tmp)} {shquote(remote)}")
                    pushed[rel] = meta
                    uploaded += 1
                except Exception as exc:
                    log(f"push failed {rel}: {exc}")
        if uploaded:
            log(f"pushed {uploaded} file(s) to {self.remote_home}")
            save_state(state)

    # -- state.db snapshot --------------------------------------------------
    def snapshot_state_db(self, state: dict) -> None:
        now = time.time()
        interval = int(self.cfg.get("state_db_interval_seconds", 120))
        if now - float(state.get("last_state_db", 0)) < interval:
            return
        tmp_remote = "/tmp/.hermes-bridge-state.db"
        script = (
            "import sqlite3, os\n"
            "tmp = '" + tmp_remote + "'\n"
            "try: os.unlink(tmp)\n"
            "except FileNotFoundError: pass\n"
            "dst = sqlite3.connect(tmp)\n"
            "dst.execute(\"ATTACH DATABASE 'file:" + self.remote_path("state.db") + "?mode=ro' AS src\")\n"
            "dst.execute('CREATE TABLE main.sessions AS SELECT * FROM src.sessions')\n"
            "dst.commit(); dst.close()\n"
        )
        try:
            self.run("python3 - <<'PY'\n" + script + "PY", timeout=300)
            local = self.local_path("state.db")
            tmp = local.with_name("state.db.part")
            self.sftp.get(tmp_remote, str(tmp))
            if tmp.stat().st_size < 4096:
                raise RuntimeError(f"snapshot too small ({tmp.stat().st_size} bytes)")
            os.replace(tmp, local)
            state["last_state_db"] = now
            save_state(state)
            log(f"state.db snapshot updated ({local.stat().st_size/1024:.0f} KiB)")
        except Exception as exc:
            log(f"state.db snapshot failed: {exc}")

    # -- DSH -> Hermes export ----------------------------------------------
    def export_dsh(self, state: dict) -> None:
        cfg = self.cfg.get("dsh_export") or {}
        if not cfg.get("enabled"):
            return
        now = time.time()
        if now - float(state.get("last_export", 0)) < int(cfg.get("interval_seconds", 60)):
            return
        remote_dir = cfg.get("remote_dir", "/root/dsh-share")
        self.run(f"mkdir -p {shquote(remote_dir + '/sessions')} {shquote(remote_dir + '/workspace')}")
        exported: dict = state.setdefault("exported", {})
        n = 0
        # 1. DSH session transcripts -> remote.
        #    DSH stores `session.v4.jsonl.zstd`; ship both the raw artifact and a
        #    plain-text `.jsonl` so Hermes can read it without zstd support.
        sessions_root = Path(expand(cfg.get("local_sessions", "")))
        zstd_exe = cfg.get("zstd_path") or "zstd"
        if sessions_root.is_dir():
            for path in sorted(sessions_root.rglob("*")):
                if not path.is_file() or ".jsonl" not in path.name:
                    continue
                rel = path.relative_to(sessions_root).as_posix()
                st = path.stat()
                meta = [st.st_size, round(st.st_mtime, 3)]
                if exported.get("sessions/" + rel) == meta:
                    continue
                remote = f"{remote_dir}/sessions/{rel}"
                try:
                    self.run(f"mkdir -p {shquote(posixpath.dirname(remote))}")
                    self.sftp.put(str(path), remote + ".part")
                    self.run(f"mv -f {shquote(remote + '.part')} {shquote(remote)}")
                    exported["sessions/" + rel] = meta
                    n += 1
                except Exception as exc:
                    log(f"export session failed {rel}: {exc}")
                    continue
                if path.name.endswith(".zstd"):
                    plain_rel = rel[: -len(".zstd")]
                    plain_remote = f"{remote_dir}/sessions/{plain_rel}"
                    try:
                        import subprocess

                        raw = subprocess.run([zstd_exe, "-dc", str(path)], capture_output=True, timeout=120)
                        if raw.returncode == 0:
                            self.upload_bytes(raw.stdout, plain_remote)
                            exported["sessions/" + plain_rel] = [len(raw.stdout), meta[1]]
                            n += 1
                    except Exception as exc:
                        log(f"export decompressed session failed {rel}: {exc}")
        # 1b. workspace AGENTS.md (DSH's project memory / rules) if present
        ws = Path(expand(cfg.get("local_workspace", "")))
        for candidate in ("AGENTS.md", "CLAUDE.md", "README.md"):
            src = ws / candidate
            if src.is_file():
                try:
                    self.upload_bytes(src.read_bytes(), f"{remote_dir}/workspace/{candidate}")
                except Exception as exc:
                    log(f"export {candidate} failed: {exc}")
        # 2. workspace manifest (names only; no file bodies)
        if ws.is_dir():
            lines = []
            skip_dirs = set(cfg.get("skip_dirs", []))
            max_files = int(cfg.get("manifest_max_files", 4000))
            for root, dirs, files in os.walk(ws):
                dirs[:] = [d for d in dirs if d not in skip_dirs]
                for name in files:
                    if len(lines) >= max_files:
                        break
                    full = Path(root) / name
                    try:
                        st = full.stat()
                    except OSError:
                        continue
                    rel = full.relative_to(ws).as_posix()
                    lines.append(f"{st.st_size:>12}  {time.strftime('%Y-%m-%d %H:%M', time.localtime(st.st_mtime))}  {rel}")
                if len(lines) >= max_files:
                    break
            manifest = "# DSH workspace manifest\n# " + str(ws) + "\n" + "\n".join(sorted(lines)) + "\n"
            remote = f"{remote_dir}/workspace/MANIFEST.txt"
            try:
                self.upload_text(manifest, remote)
            except Exception as exc:
                log(f"export manifest failed: {exc}")
        # 3. README explaining the layout to Hermes
        readme = (
            "# DSH share\n\n"
            "This directory is written by `hermes-bridge` on the DeepSeek Harness host.\n\n"
            "- `sessions/` — DSH session transcripts (JSONL, read-only).\n"
            "- `workspace/MANIFEST.txt` — files in the DSH working directory (size, mtime, path).\n\n"
            "Hermes can read any of these files with its normal file tools.\n"
            "Write requests back to DSH through /root/.hermes/outbox/hermes/*.json (dsh-link plugin)\n"
            "or the DSH HTTP bridge when a reverse tunnel is running.\n"
        )
        try:
            self.upload_text(readme, remote_dir + "/README.md")
        except Exception:
            pass
        state["last_export"] = now
        save_state(state)
        if n:
            log(f"exported {n} DSH session file(s) to {remote_dir}")


# ---------------------------------------------------------------------------
# reverse tunnel: Hermes host -> this machine's loopback DSH web server
# ---------------------------------------------------------------------------

def _tcp_ok(target: tuple[str, int], timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection(target, timeout=timeout):
            return True
    except OSError:
        return False


def _collab_health_ok(port: int, timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{int(port)}/mcp/collab/health", timeout=timeout) as resp:
            body = resp.read(400)
            return resp.status == 200 and b'"version"' in body
    except Exception:
        return False


def _dsh_listen_ports() -> list[int]:
    """Listening ports owned by the running DeepSeek Harness Electron process."""
    try:
        listing = subprocess.run(
            ["tasklist", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=15
        ).stdout
    except Exception:
        return []
    pids = set()
    for line in listing.splitlines():
        if "DeepSeek Harness" in line:
            parts = [p.strip('"') for p in line.split('","')]
            if len(parts) > 1 and parts[1].isdigit():
                pids.add(parts[1])
    if not pids:
        return []
    try:
        netstat = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return []
    ports: list[int] = []
    for line in netstat.splitlines():
        fields = line.split()
        if len(fields) >= 5 and fields[0].upper() == "TCP" and fields[3].upper() == "LISTENING" and fields[4] in pids:
            addr = fields[1]
            host, _, port = addr.rpartition(":")
            if host in ("127.0.0.1", "0.0.0.0", "[::]", "[::1]") and port.isdigit():
                ports.append(int(port))
    return ports


def resolve_dsh_target(tunnel_cfg: dict) -> tuple[str, int] | None:
    candidates: list[int] = []
    if tunnel_cfg.get("local_port"):
        candidates.append(int(tunnel_cfg["local_port"]))
    candidates += [int(p) for p in tunnel_cfg.get("candidate_ports", [])]
    candidates += _dsh_listen_ports()
    seen = set()
    for port in candidates:
        if port in seen:
            continue
        seen.add(port)
        if _collab_health_ok(port):
            return ("127.0.0.1", port)
    return None


class ReverseTunnel:
    """Ask sshd on the Hermes host to listen on 127.0.0.1:<remote_port> and
    forward every connection back here, to the DSH web server.

    The DSH desktop port is not stable across restarts, so the target is
    rediscovered (by probing /mcp/collab/health on the DSH process's listening
    ports) whenever the current one stops answering.
    """

    def __init__(self, bridge: "Bridge", cfg: dict):
        self.bridge = bridge
        self.cfg = cfg or {}
        self.bind = str(self.cfg.get("bind", "127.0.0.1"))
        self.port = int(self.cfg.get("remote_port", 13080))
        self.target: tuple[str, int] | None = None
        self.bound = False
        self._transport = None
        self._last_probe = 0.0
        self._warned = False

    def stop(self) -> None:
        if self._transport is not None:
            try:
                self._transport.cancel_port_forward(self.bind, self.port)
            except Exception:
                pass
        self.bound = False
        self._transport = None

    def _bind(self) -> None:
        transport = self.bridge.client.get_transport() if self.bridge.client else None
        if transport is None or not transport.is_active():
            return
        try:
            transport.request_port_forward(self.bind, self.port, self._handle)
            self._transport = transport
            self.bound = True
            self._warned = False
            log(f"reverse tunnel up: {self.bind}:{self.port}@hermes -> {self.target[0]}:{self.target[1]}")
        except Exception as exc:
            if not self._warned:
                log(f"reverse tunnel bind failed (is {self.bind}:{self.port} free on the Hermes host?): {exc}")
                self._warned = True

    def ensure(self) -> None:
        now = time.time()
        probe = float(self.cfg.get("probe_seconds", 10))
        if now - self._last_probe < probe:
            return
        self._last_probe = now
        transport = self.bridge.client.get_transport() if self.bridge.client else None
        if transport is None or not transport.is_active() or transport is not self._transport:
            self.bound = False
            self.target = None
        if self.target and _tcp_ok(self.target):
            if not self.bound:
                self._bind()
            return
        new_target = resolve_dsh_target(self.cfg)
        if new_target is None:
            if not self._warned:
                log("reverse tunnel: no DSH /mcp/collab/health found; retrying")
                self._warned = True
            self.stop()
            return
        if new_target != self.target:
            log(f"reverse tunnel target = {new_target[0]}:{new_target[1]}")
            self.stop()
            self.target = new_target
        self._bind()

    def _handle(self, channel, origin, server) -> None:
        # paramiko calls this on the transport's own thread; blocking here would
        # stall every other channel, so pump each forwarded connection on its
        # own thread (same shape as paramiko's rforward demo).
        import threading

        threading.Thread(target=self._pump, args=(channel,), daemon=True).start()

    def _pump(self, channel) -> None:
        target = self.target
        if target is None:
            channel.close()
            return
        try:
            upstream = socket.create_connection(target, timeout=8)
        except Exception:
            channel.close()
            return
        try:
            while True:
                readable, _, _ = select.select([channel, upstream], [], [], 120)
                if channel in readable:
                    data = channel.recv(65536)
                    if not data:
                        break
                    upstream.sendall(data)
                if upstream in readable:
                    data = upstream.recv(65536)
                    if not data:
                        break
                    channel.sendall(data)
        except Exception:
            pass
        finally:
            try:
                upstream.close()
            except Exception:
                pass
            try:
                channel.close()
            except Exception:
                pass


def shquote(value: str) -> str:
    return "'" + str(value).replace("'", "'\"'\"'") + "'"


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

def cmd_setup_key(cfg: dict) -> int:
    password = os.environ.get("HERMES_BRIDGE_PASSWORD") or cfg.get("password")
    if not password:
        print("set HERMES_BRIDGE_PASSWORD or put \"password\" in config.json", file=sys.stderr)
        return 2
    key_path = Path(expand(cfg["key_path"]))
    pub = key_path.with_name(key_path.name + ".pub")
    if not key_path.exists() or not pub.exists():
        print(
            f"missing key pair: {key_path}\n"
            f"generate it first, e.g.  ssh-keygen -t ed25519 -N \"\" -C hermes-bridge -f {key_path}",
            file=sys.stderr,
        )
        return 2
    pubkey = pub.read_text(encoding="utf-8").strip()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=cfg["host"], port=int(cfg.get("port", 22)), username=cfg["user"],
        password=password, look_for_keys=False, allow_agent=False, timeout=20,
    )
    cmd = (
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && "
        f"(grep -qxF {shquote(pubkey)} ~/.ssh/authorized_keys || echo {shquote(pubkey)} >> ~/.ssh/authorized_keys)"
    )
    stdin, stdout, stderr = client.exec_command(cmd)
    rc = stdout.channel.recv_exit_status()
    client.close()
    log(f"authorized_keys updated rc={rc}")
    return 0 if rc == 0 else 1


def cmd_once(cfg: dict) -> int:
    bridge = Bridge(cfg)
    state = load_state()
    bridge.connect()
    for sub in cfg["push_roots"]:
        bridge.mkdir_remote(sub)
    bridge.pull(state)
    bridge.push(state)
    bridge.snapshot_state_db(state)
    bridge.export_dsh(state)
    bridge.close()
    log("one-shot sync complete")
    return 0


def _pid_alive(pid: int) -> bool:
    """Is `pid` running? os.kill(pid, 0) is NOT safe on Windows (it calls
    TerminateProcess), so use OpenProcess + GetExitCodeProcess there."""
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return False
        try:
            code = ctypes.c_ulong(0)
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def acquire_instance_lock() -> bool:
    """Single-instance guard: two sync loops would fight over state.json and
    double-push hand-off files. A stale lock (dead PID) is reclaimed."""
    lock = HERE / "bridge.lock"
    if lock.exists():
        try:
            data = json.loads(lock.read_text(encoding="utf-8"))
            pid = int(data.get("pid", 0))
        except Exception:
            pid = 0
        if _pid_alive(pid):
            log(f"another hermes-bridge is already running (pid {pid}); exiting")
            return False
        try:
            lock.unlink()
        except OSError:
            pass
    lock.write_text(json.dumps({"pid": os.getpid(), "started": time.time()}), encoding="utf-8")
    return True


def cmd_sync(cfg: dict) -> int:
    if not acquire_instance_lock():
        return 0
    poll = max(1, int(cfg.get("poll_seconds", 3)))
    state = load_state()
    bridge = Bridge(cfg)
    tunnel_cfg = cfg.get("tunnel") or {}
    tunnel = ReverseTunnel(bridge, tunnel_cfg) if tunnel_cfg.get("enabled") else None
    log("hermes-bridge daemon starting")
    while True:
        try:
            bridge.ensure()
            if tunnel is not None:
                tunnel.ensure()
            for sub in cfg["push_roots"]:
                bridge.mkdir_remote(sub)
            bridge.pull(state)
            bridge.push(state)
            bridge.snapshot_state_db(state)
            bridge.export_dsh(state)
        except KeyboardInterrupt:
            if tunnel is not None:
                tunnel.stop()
            bridge.close()
            return 0
        except Exception as exc:
            log(f"sync loop error: {exc}\n{traceback.format_exc(limit=2)}")
            if tunnel is not None:
                tunnel.stop()
            bridge.close()
            time.sleep(min(30, poll * 3))
        time.sleep(poll)


def main() -> int:
    parser = argparse.ArgumentParser(description="hermes-bridge")
    parser.add_argument("command", choices=["setup-key", "once", "sync"], nargs="?", default="sync")
    args = parser.parse_args()
    cfg = load_config()
    if args.command == "setup-key":
        return cmd_setup_key(cfg)
    if args.command == "once":
        return cmd_once(cfg)
    return cmd_sync(cfg)


if __name__ == "__main__":
    raise SystemExit(main())
