# Plan: Keet Channel for Hermes Agent

## Context

**Keet** — P2P messenger by Holepunch, built on **Pear Runtime**
(Hypercore, Hyperswarm, HyperDHT). 100% P2P, no servers.
Key-value store via Hyperbee, chat rooms on Hypercore.

**Hermes Agent** has a gateway plugin architecture.
The adapter lives in `~/.hermes/plugins/platforms/keet/`.

Keet **has no public Bot API / HTTP gateway**. All communication is P2P.

---

## Architecture

```
┌─────────────────────┐     WS/JSON      ┌──────────────────────────┐
│  Hermes Agent       │ ◄──────────────► │  Keet Bridge Daemon      │
│  (platform plugin)  │                  │  (Pear Terminal App)     │
│  hermes-plugin/     │                  │                          │
└─────────────────────┘                  │  - HyperDHT discovery    │
                                          │  - Hyperswarm swarm      │
         ▲                               │  - Hypercore replication │
         │ P2P                           │  - Keet chat protocol    │
         ▼                               └──────────┬───────────────┘
┌─────────────────────┐                              │ P2P
│  Keet Desktop/      │◄───── HyperDHT ──────────────┘
│  Mobile clients     │       Hyperswarm
└─────────────────────┘       Hypercore
```

Two components:
1. **Keet Bridge Daemon** (`bridge/`) — Pear Terminal app connected to Keet P2P network
2. **Hermes Keet Plugin** (`hermes-plugin/`) — Python adapter for Hermes

---

## Bridge Daemon (`bridge/`)

Pear Terminal application on Node.js/Bare.

### Responsibilities
- Register in Keet P2P network via HyperDHT
- Participate in room and direct-chat swarms
- Replicate Keet data structures
- Expose WebSocket API on `127.0.0.1:5335`

### WebSocket API (JSON-RPC)

**Inbound (Keet → Hermes):**
```json
{ "type": "message",       "chat_id": "...", "from": "...", "text": "...", "ts": ... }
{ "type": "image",         "chat_id": "...", "from": "...", "url": "...", "ts": ... }
{ "type": "contact_request","from": "...", "name": "...", "key": "..." }
{ "type": "group_invite",  "chat_id": "...", "inviter": "...", "name": "..." }
{ "type": "chat_list",     "chats": [{"id": "...", "name": "...", "type": "dm|room"}] }
```

**Outbound (Hermes → Keet):**
```json
{ "command": "send_message",   "chat_id": "...", "text": "..." }
{ "command": "send_image",     "chat_id": "...", "path": "..." }
{ "command": "get_chat_info",  "chat_id": "..." }
{ "command": "accept_contact", "contact_id": "..." }
{ "command": "list_chats" }
```

### Dependencies
- `pear` (CLI runtime)
- `@holepunchto/hyperdht`
- `@holepunchto/hyperswarm`
- `@holepunchto/hypercore`
- `@holepunchto/hyperbee`
- `@holepunchto/keet-identity-key` (key generation)

---

## Hermes Plugin (`hermes-plugin/`)

Structure:
```
hermes-plugin/
├── plugin.yaml       # metadata
├── __init__.py       # register(ctx)
└── adapter.py        # KeetAdapter(BasePlatformAdapter)
```

### plugin.yaml
```yaml
name: keet-platform
label: Keet
kind: platform
version: 1.0.0
requires_env:
  - name: KEET_WS_URL
    description: "WebSocket URL of the Keet Bridge daemon"
    default: "ws://127.0.0.1:5335"
optional_env:
  - name: KEET_ALLOWED_USERS
  - name: KEET_ALLOW_ALL_USERS
  - name: KEET_HOME_CHANNEL
```

### adapter.py
Extends `BasePlatformAdapter`:
- `connect()` — WS client to Bridge Daemon
- `send(chat_id, text)` — `send_message`
- `send_image(chat_id, url)` — `send_image`
- Handle inbound messages → `MessageEvent`
- Reconnect, self-message filtering, image cache

---

## Phases

### Phase 1: Research
- [ ] Fork/read `keet-appling-next`
- [ ] Understand Keet chat data structures:
  - Hypercore → message format
  - Hyperbee → indexes
  - Identity → keypair from seed phrase
  - Rooms vs 1:1
- [ ] Write protocol spec

### Phase 2: Bridge Daemon
- [ ] Pear Terminal project setup + dependencies
- [ ] Keet identity (seed → keypair)
- [ ] HyperDHT discovery
- [ ] Swarm join for rooms
- [ ] Receive messages from Hypercore
- [ ] Send messages (append)
- [ ] WebSocket API
- [ ] Test with live Keet client

### Phase 3: Hermes Plugin
- [ ] `plugin.yaml`, `__init__.py`, `adapter.py`
- [ ] WebSocket client with reconnect
- [ ] MessageEvent mapping
- [ ] Send, send_image
- [ ] Contact request handling
- [ ] Cron delivery

### Phase 4: Documentation
- [ ] `README.md` — install, run
- [ ] `docs/protocol.md` — Bridge ↔ Hermes protocol

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Keet closed protocol | Fork keet-appling-next, Pear Runtime tooling |
| E2E encryption | Bridge is a full network participant with its own identity |
| NAT traversal | Hyperswarm relay nodes |
| Message format changes | Versioning |
