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
    this.rooms = new Map()
    this.stdio = null
    this._listening = false
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
      this._handleConnection(conn, info)
    })

    // stdio JSON protocol instead of WebSocket
    this.stdio = new JsonStdio(this)
    this.stdio.start()

    await this._announce()

    this._listening = true
    console.log('[bridge] Ready')
    console.log('[bridge] Public key:', b4a.toString(this.identity.publicKey, 'hex'))
  }

  async _announce () {
    this.dhtServer = this.dht.createServer((conn) => {
      console.log('[bridge] DHT connection')
      this._handleConnection(conn, { client: false })
    })
    await this.dhtServer.listen(this.identity.keyPair)
  }

  _handleConnection (conn, info) {
    this._replicateRoom(conn, info)
  }

  _replicateRoom (conn, info) {
    // Protomux multiplexer placeholder for room streams
  }

  async createRoom (key, keyPair) {
    if (this.rooms.has(key)) return this.rooms.get(key)
    const room = new RoomManager(key, keyPair, STORAGE)
    await room.init(this.swarm)
    this.rooms.set(key, room)
    return room
  }

  async sendMessage (chatId, text) {
    let room = this.rooms.get(chatId)
    if (!room) {
      const key = b4a.from(chatId, 'hex')
      room = await this.createRoom(key)
    }
    const block = await room.append({ type: 'text', content: text, sender: this.identity.publicKey })
    return block
  }

  async stop () {
    this._listening = false
    if (this.swarm) await this.swarm.destroy()
    if (this.dht) await this.dht.destroy()
    if (this.stdio) await this.stdio.stop()
    for (const room of this.rooms.values()) {
      await room.close()
    }
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
