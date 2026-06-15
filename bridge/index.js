#!/usr/bin/env node
const b4a = require('b4a')
const path = require('path')
const hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')

const IdentityManager = require('./lib/identity')
const RoomManager = require('./lib/room')
const PairingManager = require('./lib/pairing')
const JsonStdio = require('./lib/stdio')

process.title = 'keet-bridge'

// Storage directory: env var or default to ./data next to this script
const STORAGE = process.env.KEET_STORAGE_DIR || path.join(__dirname, 'data')

class KeetBridge {
  // Return the listening address (Buffer or string) from the active DHT server.
  // Preference: identity server (`dhtServer`) → profile server (`profileServer`).
  // If no server is listening yet, returns null.
  getActiveAddress () {
    const srv = this.dhtServer || this.profileServer
    if (srv && typeof srv.address === 'function') {
      try {
        const a = srv.address()
        if (a) return a
      } catch (e) { /* ignore */ }
    }
    // Fall back to the DHT node's own socket address
    if (this.dht && typeof this.dht.address === 'function') {
      try { return this.dht.address() } catch (e) { /* ignore */ }
    }
    return null
  }
  constructor () {
    this.identity = null
    this.swarm = null
    this.dht = null
    this.rooms = new Map()
    this.pairing = null
    this.stdio = null
    this._listening = false
    this._peerConnections = new Map()
    this._pendingRooms = new Set() // keys being initialized
  }

  async start () {
    console.error('[bridge] Starting Keet Bridge...')

    this.identity = new IdentityManager(STORAGE)
    await this.identity.load()
    console.error('[bridge] Identity:', b4a.toString(this.identity.publicKey, 'hex'))

    // Use a fixed DHT port so remoteAddress() can resolve correctly.
    // Port 49737 is typically taken by the gateway manager's DHT.
    const DHT_PORT = 60001

    // Create DHT using the identity key pair with an explicit port.
    this.dht = new DHT({
      keyPair: this.identity.keyPair,
      port: DHT_PORT,
    })

    // Wait for DHT to fully bootstrap (socket bound, peers discovered).
    // Then feed the NatSampler so remoteAddress() returns a valid
    // {host, port} pair.  Without this dht.port stays 0 and the
    // announcer never adds relay addresses, so the invite-keypair
    // announcement expires immediately after creation.
    await this.dht.ready()
    try {
      const sockAddr = this.dht.io.serverSocket.address()
      if (sockAddr && sockAddr.port) {
        const host = this.dht.host || sockAddr.host
        const port = sockAddr.port
        // Force the NatSampler to adopt our address (bypass consensus).
        // Symmetric NAT means DHT peers see us on varying source ports,
        // so the sampler cannot agree on a consistent port on its own.
        this.dht._nat.host = host
        this.dht._nat.port = port
        // Also feed 5 consistent samples so internal logic doesn't revert
        for (let i = 0; i < 5; i++) this.dht._nat.add(host, port)
        console.error('[bridge] DHT nat set: %s:%d', host, port)
      }
    } catch (e) {
      console.error('[bridge] DHT nat setup failed:', e.message)
    }

    // Blind-pairing for invite links
    this.pairing = new PairingManager(this.dht, this)

    this.swarm = new Hyperswarm({
      keyPair: this.identity.keyPair,
    })
    this.swarm.on('connection', (conn, info) => {
      console.error('[bridge] Swarm connection:', info.client ? 'outgoing' : 'incoming')
      this._handleSwarmConnection(conn, info)
    })

    // stdio JSON protocol
    this.stdio = new JsonStdio(this)
    this.stdio.start()

    await this._announce()
    await this._announceProfileDiscovery()

    // Announce bridge identity via stdio
    const pubkeyHex = b4a.toString(this.identity.publicKey, 'hex')
    let profileKeyHex = ''
    try {
      const discoveryPair = this.identity.getDiscoveryKeyPair()
      if (discoveryPair && discoveryPair.publicKey) {
        profileKeyHex = b4a.toString(discoveryPair.publicKey, 'hex')
      }
    } catch (e) {}
    this.stdio.send({
      type: 'identity',
      public_key: pubkeyHex,
      profile_discovery_key: profileKeyHex
    })

    // Create welcome room (keyed by own public key) so users can discover it
    const welcomeKey = this.identity.publicKey
    await this.createRoom(welcomeKey)
    this.stdio.send({
      type: 'welcome_room_ready',
      room_key: b4a.toString(welcomeKey, 'hex')
    })

    this._listening = true
    console.error('[bridge] Ready')
    console.error('[bridge] Public key:', b4a.toString(this.identity.publicKey, 'hex'))
  }

  async _announce () {
    // Announce bridge identity key — direct DHT connections
    this.dhtServer = this.dht.createServer((conn) => {
      console.error('[bridge] DHT connection (identity key)')
      this._handleDhtConnection(conn, false)
    })
    await this.dhtServer.listen(this.identity.keyPair)
  }

  async _announceProfileDiscovery () {
    // Announce profile discovery key — Keet users can find us via contact search
    const discoveryPair = this.identity.getDiscoveryKeyPair()
    if (!discoveryPair || !discoveryPair.publicKey) {
      console.error('[bridge] No profile discovery key available')
      return
    }
    console.error('[bridge] Profile discovery key:', b4a.toString(discoveryPair.publicKey, 'hex'))
    this.profileServer = this.dht.createServer((conn) => {
      console.error('[bridge] DHT connection (profile discovery)')
      this._handleDhtConnection(conn, true)
    })
    await this.profileServer.listen(discoveryPair)
  }

  _handleDhtConnection (conn, isProfile) {
    // Replicate ALL rooms over this connection
    // Each room's core.replicate() creates a protomux channel automatically
    for (const room of this.rooms.values()) {
      const rstream = room.core.replicate(!isProfile)
      // Forward data bidirectionally
      const fwdConnToStream = (data) => { try { rstream.write(data) } catch (e) {} }
      const fwdStreamToConn = (data) => { try { conn.write(data) } catch (e) {} }
      conn.on('data', fwdConnToStream)
      rstream.on('data', fwdStreamToConn)
      conn.on('close', () => {
        rstream.destroy()
        conn.off('data', fwdConnToStream)
        rstream.off('data', fwdStreamToConn)
      })
      rstream.on('end', () => {
        conn.off('data', fwdConnToStream)
        rstream.off('data', fwdStreamToConn)
      })
    }
  }

  _handleSwarmConnection (conn, info) {
    // Swarm connection — replicate all active rooms
    // Each room's core.replicate() multiplexes via protomux internally
    for (const room of this.rooms.values()) {
      const rstream = room.core.replicate(info.client !== undefined ? info.client : true)
      const fwdConnToStream = (data) => { try { rstream.write(data) } catch (e) {} }
      const fwdStreamToConn = (data) => { try { conn.write(data) } catch (e) {} }
      conn.on('data', fwdConnToStream)
      rstream.on('data', fwdStreamToConn)
      conn.on('close', () => {
        rstream.destroy()
        conn.off('data', fwdConnToStream)
        rstream.off('data', fwdStreamToConn)
      })
      rstream.on('end', () => {
        conn.off('data', fwdConnToStream)
        rstream.off('data', fwdStreamToConn)
      })
    }
  }

  async connectToPeer (pubkey, roomKey) {
    // Connect to a peer by their DHT public key
    const pubkeyHex = b4a.toString(pubkey, 'hex')
    if (this._peerConnections.has(pubkeyHex)) {
      console.error('[bridge] Already connected to peer:', pubkeyHex.slice(0, 16))
      return
    }

    console.error('[bridge] Connecting to peer:', pubkeyHex.slice(0, 16))
    const conn = this.dht.connect(pubkey)
    this._peerConnections.set(pubkeyHex, conn)

    // If no specific room given, replicate all active rooms
    if (!roomKey) {
      for (const room of this.rooms.values()) {
        const rstream = room.core.replicate(true)
        const fwdConnToStream = (data) => { try { rstream.write(data) } catch (e) {} }
        const fwdStreamToConn = (data) => { try { conn.write(data) } catch (e) {} }
        conn.on('data', fwdConnToStream)
        rstream.on('data', fwdStreamToConn)
        conn.on('close', () => {
          rstream.destroy()
          conn.off('data', fwdConnToStream)
          rstream.off('data', fwdStreamToConn)
          this._peerConnections.delete(pubkeyHex)
        })
        rstream.on('end', () => {
          conn.off('data', fwdConnToStream)
          rstream.off('data', fwdStreamToConn)
        })
      }
    } else {
      // Replicate specific room
      const roomKeyHex = b4a.toString(roomKey, 'hex')
      let room = this.rooms.get(roomKeyHex)
      if (!room) {
        room = await this.createRoom(roomKey)
      }
      const rstream = room.core.replicate(true)
      const fwdConnToStream = (data) => { try { rstream.write(data) } catch (e) {} }
      const fwdStreamToConn = (data) => { try { conn.write(data) } catch (e) {} }
      conn.on('data', fwdConnToStream)
      rstream.on('data', fwdStreamToConn)
      conn.on('close', () => {
        rstream.destroy()
        conn.off('data', fwdConnToStream)
        rstream.off('data', fwdStreamToConn)
        this._peerConnections.delete(pubkeyHex)
      })
      rstream.on('end', () => {
        conn.off('data', fwdConnToStream)
        rstream.off('data', fwdStreamToConn)
      })
    }
  }

  async createRoom (topicKey) {
    const keyHex = b4a.toString(topicKey, 'hex')
    if (this.rooms.has(keyHex)) return this.rooms.get(keyHex)
    if (this._pendingRooms.has(keyHex)) {
      // Wait for the pending initialization to complete
      while (this._pendingRooms.has(keyHex)) {
        await new Promise(r => setTimeout(r, 100))
      }
      return this.rooms.get(keyHex)
    }

    const identityKey = this.identity.keyPair.publicKey
    const identityKeyPair = this.identity.keyPair
    this._pendingRooms.add(keyHex)
    console.error('[bridge] Creating room:', keyHex.slice(0, 16))

    // Core keyed by bridge identity (we can write), topic key = room key (for swarm discovery)
    const room = new RoomManager(identityKey, identityKeyPair, STORAGE, topicKey)

    // Forward incoming messages from other participants to stdio
    room.onmessage = (msg, seq, roomKey) => {
      const roomKeyHex = b4a.toString(roomKey, 'hex')
      this.stdio.send({
        type: 'message',
        chat_id: roomKeyHex,
        from: b4a.toString(msg.sender, 'hex'),
        text: msg.content,
        ts: msg.timestamp
      })
    }

    try {
      await room.init(this.swarm)
      this.rooms.set(keyHex, room)
    } finally {
      this._pendingRooms.delete(keyHex)
    }
    return room
  }

  async sendMessage (chatId, text) {
    let room = this.rooms.get(chatId)
    if (!room) {
      const key = b4a.from(chatId, 'hex')
      room = await this.createRoom(key)
    }
    const block = await room.append({
      type: 0,
      content: text,
      sender: this.identity.publicKey,
      timestamp: Date.now()
    })
    return block
  }

  async stop () {
    this._listening = false
    if (this.swarm) await this.swarm.destroy()
    if (this.dht) { this.pairing?.close(); await this.dht.destroy() }
    if (this.profileServer) await this.profileServer.close()
    if (this.stdio) await this.stdio.stop()
    for (const room of this.rooms.values()) {
      room.close()
    }
    for (const [key, conn] of this._peerConnections) {
      try { conn.destroy() } catch (e) {}
    }
    this._peerConnections.clear()
    console.error('[bridge] Stopped')
  }
}

let bridge = null
if (require.main === module) {
  bridge = new KeetBridge()
  bridge.start().catch((err) => {
    console.error('[bridge] Fatal:', err)
    process.exit(1)
  })
}
module.exports = KeetBridge

process.on('SIGINT', () => {
  if (bridge) bridge.stop().then(() => process.exit(0))
  else process.exit(0)
})
process.on('SIGTERM', () => {
  if (bridge) bridge.stop().then(() => process.exit(0))
  else process.exit(0)
})
