#!/usr/bin/env python3
"""hermes-bridge doctor — one command that checks every link in the chain.

  python verify.py                 # checks SSH, mirror, daemon, Hermes plugin, DSH endpoint
  python verify.py --dsh-url http://127.0.0.1:59928

Exit code 0 = all core checks green; 1 = something needs attention.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import importlib.util

spec = importlib.util.spec_from_file_location("bridge_mod", HERE / "hermes-bridge.py")
bridge_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_mod)

OK, WARN, BAD = "OK  ", "WARN", "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, status: str, detail: str) -> None:
    results.append((status, name, detail))


def http_json(url: str, timeout: float = 4.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsh-url", default=os.environ.get("HERMES_LINK_DSH_URL", "http://127.0.0.1:59928"))
    args = ap.parse_args()
    cfg = bridge_mod.load_config()
    state = bridge_mod.load_state()

    # 1. local files
    local_home = Path(bridge_mod.expand(cfg["local_home"]))
    check("mirror dir", OK if local_home.is_dir() else BAD, str(local_home))
    sessions = list((local_home / "sessions").glob("*.json")) if (local_home / "sessions").is_dir() else []
    check("mirrored sessions", OK if sessions else BAD, f"{len(sessions)} files")
    db = local_home / "state.db"
    check("state.db snapshot", OK if db.is_file() and db.stat().st_size > 4096 else BAD,
          f"{db.stat().st_size} bytes" if db.is_file() else "missing")
    mem = local_home / "memories" / "MEMORY.md"
    check("Hermes memory", OK if mem.is_file() else WARN, str(mem))

    # 2. daemon
    lock = HERE / "bridge.lock"
    alive = False
    if lock.exists():
        try:
            alive = bridge_mod._pid_alive(int(json.loads(lock.read_text())["pid"]))
        except Exception:
            alive = False
    check("bridge daemon", OK if alive else WARN, "running" if alive else "not running (start-bridge.cmd)")

    # 3. ssh + remote files
    bridge = bridge_mod.Bridge(cfg)
    try:
        bridge.connect()
        out = bridge.run("hostname; ls -d " +
                         bridge_mod.shquote(bridge.remote_path("plugins/dsh-link")) + " 2>/dev/null")
        check("SSH to Hermes host", OK, out.strip().replace("\n", " | ") or "connected")
        plugin = bridge.run("ls " + bridge_mod.shquote(bridge.remote_path("plugins/dsh-link")) + " 2>/dev/null")
        check("Hermes dsh-link plugin", OK if "__init__.py" in plugin else BAD, plugin.strip().replace("\n", ", "))
        enabled = bridge.run("grep -c 'dsh-link' " + bridge_mod.shquote(bridge.remote_path("config.yaml")))
        check("plugin enabled in config.yaml", OK if enabled.strip() not in ("", "0") else WARN, enabled.strip())
        outbox = bridge.run("ls " + bridge_mod.shquote(bridge.remote_path("outbox/hermes")) + " 2>/dev/null | wc -l")
        check("Hermes outbox files", OK, outbox.strip())
        share = bridge.run("du -sh /root/dsh-share 2>/dev/null")
        check("DSH share on Hermes host", OK if share.strip() else WARN, share.strip())
        tunnel_cfg = cfg.get("tunnel") or {}
        if tunnel_cfg.get("enabled"):
            rport = int(tunnel_cfg.get("remote_port", 13080))
            probe = bridge.run(
                f"curl -s -m 5 http://127.0.0.1:{rport}/mcp/collab/health"
            )
            ok = '"version"' in probe
            check("reverse tunnel (Hermes -> DSH)", OK if ok else BAD,
                  f"127.0.0.1:{rport} -> {probe[:60]}" if ok else f"127.0.0.1:{rport} not answering")
        mcp_entry = bridge.run(
            "grep -c 'dsh-bridge' " + bridge_mod.shquote(bridge.remote_path("config.yaml"))
        )
        check("Hermes MCP server dsh-bridge", OK if mcp_entry.strip() not in ("", "0") else WARN,
              "configured" if mcp_entry.strip() not in ("", "0") else "missing")
        bridge.close()
    except Exception as exc:
        check("SSH to Hermes host", BAD, str(exc))
        try:
            bridge.close()
        except Exception:
            pass

    # 4. DSH plugin endpoint
    try:
        health = http_json(args.dsh_url.rstrip("/") + "/mcp/collab/health")
        check("DSH collab endpoint", OK,
              f"version={health.get('version')} hermes_home={health.get('hermes_home')}")
        try:
            sessions_api = http_json(args.dsh_url.rstrip("/") + "/mcp/collab/sessions?limit=1", 8)
            check("DSH sees Hermes sessions", OK if sessions_api.get("count") else WARN,
                  f"count={sessions_api.get('count')}")
        except Exception as exc:
            check("DSH sees Hermes sessions", WARN, str(exc))
    except Exception as exc:
        check("DSH collab endpoint", WARN,
              f"{exc} — the plugin is installed but activates only after a DSH restart")

    # 5. freshness
    pulled = state.get("pulled") or {}
    if pulled:
        newest = max(pulled.values(), key=lambda v: v[1])
        age = time.time() - float(newest[1])
        check("mirror freshness", OK if age < 600 else WARN, f"newest file {age/60:.1f} min old")

    width = max(len(name) for _, name, _ in results) + 2
    print()
    for status, name, detail in results:
        print(f"[{status}] {name:<{width}} {detail}")
    bad = [r for r in results if r[0] == BAD]
    print(f"\n{len(results) - len(bad)}/{len(results)} checks passed.")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
