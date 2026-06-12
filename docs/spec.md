# Technical Specification: Keet Channel Plugin for Hermes Agent

Version 0.1.0 | Author: migunov

## 1. Overview

Keet Channel Plugin (keet-platform) is a Hermes Agent platform adapter that
integrates the Keet P2P messenger via a Bridge Daemon running as a plain Node.js process.

## 2. Architecture

```
Hermes Agent ←→ Keet Bridge Daemon ←→ Keet P2P Network
| Hermes Agent ←→ Keet Bridge Daemon ←→ Keet P2P Network
|(Python plugin)   (Node.js process)     (Hyperswarm/Hypercore)|

| Component | Path | Description |
|-----------|------|-------------|
| Plugin manifest | `plugin.yaml` | Hermes plugin metadata |
| Python adapter | `adapter.py` | Gateway platform adapter — stdio JSON bridge |
| Bridge Daemon | `bridge/` | Node.js process — P2P networking layer |
| Protocol spec | `docs/protocol.md` | Bridge ↔ Adapter JSON protocol |

## 3. Functional Requirements

### 3.1 Auto-Detection of Bridge

|- Plugin locates `bridge/` relative to `adapter.py` automatically
|- Bridge launch command: `node <detected_path>/index.js`
|- User **never** specifies the bridge path in standard setups

### 3.2 Auto-Installation of Dependencies

- On `connect()`, plugin checks for `bridge/node_modules`
- Runs `npm install` automatically if missing
- Logs success or failure

### 3.3 Message Send and Receive

- Incoming messages from allowed contacts → Hermes Agent
- Replies from Hermes Agent → original Keet chat/room
- Supports text messages and images
- Max message length: 4096 characters
- Format: plain text (no markdown rendering)

### 3.4 Access Control

| Variable | Effect |
|----------|--------|
| `KEET_ALLOWED_USERS` | Comma-separated public keys of allowed contacts |
| `KEET_ALLOW_ALL_USERS=true` | Accept from all contacts (dev mode) |
| Not configured | Accept from all |

### 3.5 Cron / Notification Delivery

- `KEET_HOME_CHANNEL` — room key (hex) for automated delivery
- Without it, cron and notifications are unavailable
- Interactive chat works regardless

## 4. Non-Functional Requirements

| Requirement | Value |
|-------------|-------|
| Compatibility | Hermes Agent (any installation method) |
|| Node.js | >= 18 |
|| Linux dep | `libatomic1` (apt) |
| Max message length | 4096 characters |
| PII Safe | Yes |
| Message format | Plain text |

## 5. Configuration

### Required environment variables

**None** — plugin works without mandatory configuration.

### Optional environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `KEET_ALLOWED_USERS` | Allowed contacts (comma-separated pubkeys) | all |
| `KEET_ALLOW_ALL_USERS` | Allow all contacts | `false` |
|| `KEET_HOME_CHANNEL` | Cron/notifications room key (hex) | unset |

## 6. User Installation

```bash
# 1. Install plugin
hermes plugins install https://github.com/Dima-Migunov/keet-channel

# 2. Enable
hermes plugins enable keet-platform

# 3. Restart gateway
hermes gateway restart
```

## 7. Bridge ↔ Adapter Protocol

### Adapter → Bridge (stdin, JSON lines)

```json
{"command": "send_message", "chat_id": "<room_key>", "text": "<message>"}
{"command": "send_image", "chat_id": "<room_key>", "path": "<url>", "caption": "<text>"}
```

### Bridge → Adapter (stdout, JSON lines)

```json
{"type": "message", "chat_id": "<room>", "from": "<pubkey>", "text": "<msg>", "ts": 1234567}
{"type": "chat_list", "chats": [...]}
{"type": "error", "message": "<error>"}
{"type": "send_result", "seq": "<id>"}
```

## 8. Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
|| Phase 1 | ✅ | Research (Keet, Hypercore/Hyperswarm) |
| Phase 2 | ✅ | Implementation (Protocol spec, Bridge, Plugin) |
| Phase 3 | ⬜ | Integration testing with live Keet client |
| Phase 4 | ⬜ | Documentation and publication |
