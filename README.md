# Keet Channel for Hermes Agent

A Hermes Agent gateway channel for the [Keet](https://keet.io) P2P messenger.

## Architecture

```
Hermes Agent ←→ Keet Bridge Daemon ←→ Keet P2P Network
(Python plugin)   (Pear Terminal app)   (Hyperswarm/Hypercore)
```

## Requirements

- **Hermes Agent** (any installation method)
- **Node.js >= 20** — required by the Bridge daemon
- **Pear Runtime** — `npm i -g pear`
- Linux: `sudo apt install libatomic1`

> Node.js is already included with Hermes Desktop and the Hermes Docker image.
> Only pip-based installations may lack it.

## Install

```bash
# 1. Install the plugin
hermes plugins install https://github.com/migunov/keet-channel

# 2. Enable the plugin
hermes plugins enable keet-platform

# 3. Optionally restrict access to specific contacts
hermes config set env_KEET_ALLOWED_USERS "pubkey1,pubkey2"

# 4. Restart gateway
hermes gateway restart
```

The plugin auto-detects the bridge path and installs Node dependencies on first start.
No manual path configuration needed — just install, enable, restart.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `KEET_ALLOWED_USERS` | Comma-separated allowed contact public keys | unset (all allowed) |
| `KEET_ALLOW_ALL_USERS` | Allow all contacts (dev only) | `false` |
| `KEET_HOME_CHANNEL` | Default channel for cron/notifications | unset |
| `KEET_BRIDGE_CMD` | Override auto-detected bridge command | auto |

## Repository structure

| Component | Path | Description |
|-----------|------|-------------|
| Plugin manifest | `plugin.yaml` | Hermes plugin metadata |
| Python adapter | `adapter.py` | Hermes Gateway platform adapter |
| Bridge Daemon | `bridge/` | Pear Terminal app — Keet P2P networking |
| Protocol spec | `docs/protocol.md` | Bridge ↔ Adapter JSON protocol |
| Technical spec | `docs/spec.md` | Full technical specification |

## Current status

- ✅ Phase 1: Research (keet-identity-key, Pear Runtime, Hypercore, Hyperswarm)
- ✅ Protocol spec (`docs/protocol.md`)
- ✅ Bridge Daemon — initial implementation
- ✅ Hermes Plugin — initial implementation
- ⬜ Phase 3: Bridge testing with a running Keet client
- ⬜ Phase 4: Full documentation

## Links

- [Keet](https://keet.io) — P2P messenger
- [Pear Runtime](https://docs.pears.com) — P2P platform
- [Holepunch](https://holepunch.to) — Keet developers
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs)
