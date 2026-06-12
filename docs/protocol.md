# Keet Bridge Protocol Specification v0.1

## Overview

Keet uses Hypercore/Hyperswarm for P2P communication. This document
describes the protocol used by the Keet Bridge Daemon to participate in
the Keet P2P network and exchange messages.

## Identity

Keet uses BIP-48 (SLIP-48) hierarchical deterministic key derivation
with BIP-39 mnemonics.

- **Type**: `5338` (KEET_TYPE constant)
- **Identity key**: `m/48'/5338'/0'/0'`
- **Discovery key**: `m/48'/5338'/0'/1'`
- **Encryption**: SLIP-21 symmetric keys derived from the identity

```javascript
// From keet-identity-key
const identityPath = [48, 5338, 0, 0, 0]    // SLIP-48 wallet
const discoveryPath = [48, 5338, 0, 0, 1]
const encryptionPath = ['SLIP-0021', 'keet-identity-key', <hex>, 'encryption key']
```

## P2P Network

### Discovery (HyperDHT)
- Peers are identified by their public key (Ed25519)
- HyperDHT maps public keys to IP:port for NAT traversal
- Supports hole-punching for direct connections

### Swarm (Hyperswarm)
- Hyperswarm groups peers by topic (a discovery key derived from a room key)
- `topic = crypto.discoveryKey(roomKey)`
- Swarm maintains connections to all peers sharing the same topic
- Automatic reconnection on disconnect

## Chat Rooms

Each chat room (1:1 or group) is a **Hypercore**:

```javascript
const room = new Hypercore(storage, roomKey, { keyPair })
```

- **roomKey**: The public key identifying the Hypercore
- **discoveryKey**: `crypto.discoveryKey(roomKey)` - used for Hyperswarm topic
- **Messages**: Blocks appended to the Hypercore

### Message Encoding

Messages inside Hypercore blocks use compact-encoding (from `compact-encoding` npm package):

```c
// Hypothetical message structure (Keet message format - TBD by reverse engineering)
message {
  version: 0..255,
  type: enum { text, image, typing, receipt, ... }
  sender: bytes(32),      // sender's public key
  timestamp: uint64,
  content: bytes,          // payload (text, image ref, etc.)
  reply_to: optional bytes,
  ...
}
```

## Message Flow

### Sending
1. `sender` creates a Hypercore block (appends to the room core)
2. Block is replicated to all swarm members
3. If recipient is offline, a notification is created via blind-push
4. Recipient receives notification and fetches new blocks on reconnect

### Receiving
1. Peer joins Hyperswarm topic `discoveryKey(roomKey)`
2. Hypercore replication syncs new blocks
3. Each block is decrypted/decoded into a message

## Bridge Protocol

### Keet Bridge Daemon → Hermes (events)

```json
{ "type": "message",       "chat_id": "...", "from": "...", "text": "...", "ts": 1234567890 }
{ "type": "image",         "chat_id": "...", "from": "...", "path": "...", "ts": ... }
{ "type": "contact_request","from": "...", "name": "...", "key": "..." }
{ "type": "chat_list",     "chats": [{"id":"...","name":"...","type":"dm|room"}] }
```

### Hermes → Keet Bridge Daemon (commands)

```json
{ "command": "send_message",   "chat_id": "...", "text": "..." }
{ "command": "send_image",     "chat_id": "...", "path": "..." }
{ "command": "list_chats" }
{ "command": "get_chat_info",  "chat_id": "..." }
```

## Bridge Daemon Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Bridge Daemon                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │           Pear Runtime (Bare / Node.js)          │ │
│  │                                                   │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐     │ │
│  │  │HyperDHT  │ │Hyperswarm│ │ Hypercore    │     │ │
│  │  │Discovery │ │Swarm     │ │ Replication  │     │ │
│  │  └──────────┘ └──────────┘ └──────────────┘     │ │
│  │                                                   │ │
│  │  ┌─────────────────────────────────────────┐     │ │
│  │  │      WebSocket Server (port 5335)       │     │ │
│  │  └─────────────────────────────────────────┘     │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

## Dependencies

```json
{
  "dependencies": {
    "hypercore": "^10.0.0",
    "hyperswarm": "^4.0.0",
    "hyperdht": "^6.0.0",
    "hypercore-crypto": "^4.0.0",
    "keet-identity-key": "^1.0.0",
    "b4a": "^1.6.0",
    "compact-encoding": "^2.0.0",
    "bare-process": "^1.0.0"
  }
}
```
