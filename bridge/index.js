const b4a = require('b4a')
const hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')

const IdentityManager = require('./lib/identity')
const RoomManager = require('./lib/room')
const WsServer = require('./lib/ws-server')

const STORAGE = process.env.KEET_BRIDGE_STORAGE || './data'
const WS_PORT = parseInt(process.env.KEET_BRIDGE_WS_PORT || '5335', 10)

class KeetBridge {
  constructor () {
    this.identity = null
    this.swarm = null
    this.rooms = new Map()     // chatId -> RoomManager
    this.ws = null
    this._listening = false
  }

  async start () {
    console.log('[bridge] Starting Keet Bridge...')

    // 1. Load or create identity
    this.identity = new IdentityManager(STORAGE)
    await this.identity.load()
    console.log('[bridge] Identity:', b4a.toString(this.identity.publicKey, 'hex'))

    // 2. Setup HyperDHT (for direct peer connections)
    this.dht = new DHT()

    // 3. Setup Hyperswarm (for room discovery)
    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (conn, info) => {
      console.log('[bridge] Swarm connection:', info.client ? 'outgoing' : 'incoming')
      this._handleConnection(conn, info)
    })

    // 4. Start WebSocket API server
    this.ws = new WsServer(WS_PORT, this)
    await this.ws.start()
    console.log('[bridge] WebSocket API on port', WS_PORT)

    // 5. Announce bridge on a known topic (so Keet users can find it)
    await this._announce()

    this._listening = true
    console.log('[bridge] Ready')
  }

  async _announce () {
    // Announce the bridge's public key as a HyperDHT server
    // This allows direct peer-to-peer connections
    this.dhtServer = this.dht.createServer((conn) => {
      console.log('[bridge] DHT connection')
      this._handleConnection(conn, { client: false })
    })
    await this.dhtServer.listen(this.identity.keyPair)
    console.log('[bridge] DHT server listening on key:', b4a.toString(this.identity.keyPair.publicKey, 'hex'))
  }

  _handleConnection (conn, info) {
    // Incoming peer connections from Keet users
    // The protocol multiplexes multiple room streams over one connection
    // For now, we register the raw connection for room replication
    this._replicateRoom(conn, info)
  }

  _replicateRoom (conn, info) {
    // Each connection can replicate multiple rooms
    // Protomux multiplexer handles room-specific streams
    const mux = conn
    // When a room stream comes in, attach it to the corresponding room
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
      // Create/replicate the room
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
    if (this.ws) await this.ws.stop()
    for (const room of this.rooms.values()) {
      await room.close()
    }
    console.log('[bridge] Stopped')
  }
}

// Start when run via Pear
const bridge = new KeetBridge()
bridge.start().catch((err) => {
  console.error('[bridge] Fatal:', err)
  process.exit(1)
})

// Clean shutdown
process.on('SIGINT', () => bridge.stop().then(() => process.exit(0)))
process.on('SIGTERM', () => bridge.stop().then(() => process.exit(0)))
