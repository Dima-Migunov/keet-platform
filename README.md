# Keet Channel for Hermes Agent

A Hermes Agent gateway channel for the [Keet](https://keet.io) P2P messenger.

## Architecture

```
Hermes Agent ←→ Keet Bridge Daemon ←→ Keet P2P Network
(Python plugin)   (Node.js process)     (Hyperswarm/Hypercore)
```

## Requirements

- **Hermes Agent** (any installation method)
- **Node.js >= 18** — required by the Bridge daemon
- Linux: `sudo apt install libatomic1` (for sodium-native)

> Node.js is already included with Hermes Desktop and the Hermes Docker image.
> Only pip-based installations may lack it.

## Install

```bash
# 1. Install the plugin
hermes plugins install https://github.com/migunov/keet-channel

# 2. Enable the plugin
hermes plugins enable keet-platform

# 3. Restart gateway
hermes gateway restart
```

That's it. The plugin auto-detects the bridge path, installs Node.js dependencies
on first start, and spawns the bridge as a subprocess. No manual setup needed.

Optionally restrict access to specific contacts:
```bash
hermes config set env_KEET_ALLOWED_USERS "pubkey1,pubkey2"
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `KEET_ALLOWED_USERS` | Comma-separated allowed contact public keys | unset (all allowed) |
| `KEET_ALLOW_ALL_USERS` | Allow all contacts (dev only) | `false` |
| `KEET_HOME_CHANNEL` | Default channel for cron/notifications | unset |

## Repository structure

| Component | Path | Description |
|-----------|------|-------------|
| Plugin manifest | `plugin.yaml` | Hermes plugin metadata |
| Python adapter | `adapter.py` | Hermes Gateway platform adapter — spawns bridge subprocess |
| Bridge Daemon | `bridge/` | Node.js process — Keet P2P networking over stdio JSON |
| Protocol spec | `docs/protocol.md` | Bridge ↔ Adapter JSON protocol |
| Technical spec | `docs/spec.md` | Full technical specification |

## Current status

- ✅ Phase 1: Research (keet-identity-key, Hypercore, Hyperswarm)
- ✅ Protocol spec (`docs/protocol.md`)
- ✅ Bridge Daemon — plain Node.js, no Pear Runtime
- ✅ Hermes Plugin — auto-spawns bridge subprocess
- ⬜ Phase 3: Bridge testing with a running Keet client
- ⬜ Phase 4: Full documentation

## Links

- [Keet](https://keet.io) — P2P messenger
- [Hypercore Protocol](https://hypercore-protocol.org) — P2P data structures
- [Holepunch](https://holepunch.to) — Keet developers
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs)
