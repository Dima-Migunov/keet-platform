# Keet Channel for Hermes Agent

A Hermes Agent gateway channel for the [Keet](https://keet.io) P2P messenger.

## Architecture

```
Hermes Agent ←→ Keet Bridge Daemon ←→ Keet P2P Network
(Python plugin)   (Pear Runtime app)     (Hyperswarm/Hypercore)
```

## Requirements

- **Hermes Agent** (any installation method)
- **Pear Runtime** — via `npm i -g pear` (installed with Keet 4.16.3+)
- **Node.js >= 18** — required by Pear Runtime
- Linux: `sudo apt install libatomic1` (for sodium-native)

> Pear Runtime is already bundled with Keet Desktop. Only standalone installs need `npm i -g pear`.
>
> After installing Pear, finalize the setup:
> ```bash
> pear run pear://runtime
> ```
> This configures the PATH so Pear's own tools are found without warnings.

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
during `hermes plugins install`, and spawns the bridge as a subprocess. No manual setup needed.

Optionally restrict access to specific contacts:
```bash
hermes config set env_KEET_ALLOWED_USERS "pubkey1,pubkey2"
```

## Auto-Install Flow

The plugin comes with an auto-install system that reduces friction for new users:

### Automatic dependency management

1. **Pear as npm dependency** — `package.json` declares `"pear": "^2.0.4"` as a direct dependency.
   This means `npm install` in the plugin root installs Pear locally into
   `node_modules/.bin/pear`, so no global install is required.

2. **Auto-install on plugin install** — `hermes plugins install` automatically runs
   `npm install --no-audit --no-fund` if the plugin has a `package.json`.
   This means dependencies are ready before the gateway even starts.

3. **Smart Pear discovery** — `_pear_cmd()` searches for the `pear` binary in this order:
   1. System PATH (`shutil.which("pear")`)
   2. Plugin-local `node_modules/.bin/pear`
   3. Fallback to bare `"pear"` (trusts it will be available at runtime)

4. **PATH management** — `_add_bin_to_path()` adds the plugin's `node_modules/.bin`
   directory to `os.environ['PATH']` at adapter init time, so locally-installed
   tools are found without requiring a global install.

### Setup script

Run `bash scripts/setup.sh` for an interactive guided setup:

```
Keet Platform setup
Plugin directory: /path/to/keet-platform

Checking Node.js... Node.js v20.11.0 found
Checking npm... npm 10.2.4 found
Checking Pear Runtime...
Pear Runtime not found.
Install Pear Runtime now? (Y/n): Y
Installing Pear Runtime...
Pear Runtime installed locally in node_modules

Setting up Keet Bridge...
Bridge dependencies already installed
Setup completed successfully!
```

The setup script:
- Checks Node.js >= 18
- Checks/installs Pear Runtime (with user confirmation)
- Installs bridge dependencies
- Verifies the installation

### Gateway setup integration

`hermes gateway setup` invokes `_setup_fn()`, which runs `scripts/setup.sh`
automatically when the platform is configured.

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
| Bridge Daemon | `bridge/` | Pear Runtime app — Keet P2P networking over stdio JSON |
| Auto-install script | `scripts/setup.sh` | Interactive guided setup |
| Post-install guide | `after-install.md` | Next steps shown after plugin install |
| Protocol spec | `docs/protocol.md` | Bridge ↔ Adapter JSON protocol |
| Technical spec | `docs/spec.md` | Full technical specification |

## Current status

- ✅ Phase 1: Research (keet-identity-key, Hypercore, Hyperswarm)
- ✅ Protocol spec (`docs/protocol.md`)
- ✅ Bridge Daemon — Pear Runtime app with shared DHT and storage
- ✅ Hermes Plugin — auto-spawns bridge via `pear run`
- ✅ Auto-install — Pear as npm dep, PATH management, setup script
- ✅ Post-install guide (`after-install.md`)
- ⬜ Phase 3: Bridge testing with a running Keet client
- ⬜ Phase 4: Full documentation

## Links

- [Keet](https://keet.io) — P2P messenger
- [Hypercore Protocol](https://hypercore-protocol.org) — P2P data structures
- [Holepunch](https://holepunch.to) — Keet developers
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs)
