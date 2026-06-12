#!/usr/bin/env node
const b4a = require('b4a')
const hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')

const IdentityManager = require('./lib/identity')
const RoomManager = require('./lib/room')
const JsonStdio = require('./lib/stdio')

const STORAGE = process.env.KEET_BRIDGE_STORAGE || './data'

class KeetBridge {
  constructor () {
    this.identity = null
    this.swarm = null
    this.dht = null
    this.rooms = new Map()
    this.stdio = null
    this._listening = false
    this._peerConnections = new Map()
    this._pendingRooms = new Set() // keys being initialized
  }

  async start () {
    console.log('[bridge] Starting Keet Bridge...')

    this.identity = new IdentityManager(STORAGE)
    await this.identity.load()
    console.log('[bridge] Identity:', b4a.toString(this.identity.publicKey, 'hex'))

    this.dht = new DHT()

    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (conn, info) => {
      console.log('[bridge] Swarm connection:', info.client ? 'outgoing' : 'incoming')
      this._handleSwarmConnection(conn, info)
    })

    // stdio JSON protocol
    this.stdio = new JsonStdio(this)
    this.stdio.start()

    await this._announce()
    await this._announceProfileDiscovery()

    this._listening = true
    console.log('[bridge] Ready')
    console.log('[bridge] Public key:', b4a.toString(this.identity.publicKey, 'hex'))
  }

  async _announce () {
    // Announce bridge identity key — direct DHT connections
    this.dhtServer = this.dht.createServer((conn) => {
      console.log('[bridge] DHT connection (identity key)')
      this._handleDhtConnection(conn, false)
    })
    await this.dhtServer.listen(this.identity.keyPair)
  }

  async _announceProfileDiscovery () {
    // Announce profile discovery key — Keet users can find us via contact search
    const discoveryPair = this.identity.getDiscoveryKeyPair()
    if (!discoveryPair || !discoveryPair.publicKey) {
      console.log('[bridge] No profile discovery key available')
      return
    }
    console.log('[bridge] Profile discovery key:', b4a.toString(discoveryPair.publicKey, 'hex'))
    this.profileServer = this.dht.createServer((conn) => {
      console.log('[bridge] DHT connection (profile discovery)')
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
      console.log('[bridge] Already connected to peer:', pubkeyHex.slice(0, 16))
      return
    }

    console.log('[bridge] Connecting to peer:', pubkeyHex.slice(0, 16))
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
    console.log('[bridge] Creating room:', keyHex.slice(0, 16))

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
    if (this.dht) await this.dht.destroy()
    if (this.profileServer) await this.profileServer.close()
    if (this.stdio) await this.stdio.stop()
    for (const room of this.rooms.values()) {
      room.close()
    }
    for (const [key, conn] of this._peerConnections) {
      try { conn.destroy() } catch (e) {}
    }
    this._peerConnections.clear()
    console.log('[bridge] Stopped')
  }
}

const bridge = new KeetBridge()
bridge.start().catch((err) => {
  console.error('[bridge] Fatal:', err)
  process.exit(1)
})

process.on('SIGINT', () => bridge.stop().then(() => process.exit(0)))
process.on('SIGTERM', () => bridge.stop().then(() => process.exit(0)))
