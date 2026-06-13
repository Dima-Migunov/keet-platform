const b4a = require('b4a')
const hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const path = require('path')
const fs = require('fs')
const c = require('compact-encoding')

const MessageEncoding = {
  preencode (state, m) {
    state.end = 1 + 32 + 8 + 4 + (m.content ? Buffer.byteLength(m.content, 'utf-8') : 0)
  },
  encode (state, m) {
    const buf = state.buffer
    let off = state.start
    buf[off++] = m.type || 0
    b4a.copy(m.sender, buf, off); off += 32
    buf.writeBigUInt64BE(BigInt(m.timestamp || Date.now()), off); off += 8
    const content = typeof m.content === 'string' ? b4a.from(m.content, 'utf-8') : m.content
    buf.writeUInt32BE(content.byteLength, off); off += 4
    b4a.copy(content, buf, off); off += content.byteLength
    state.start = off
  },
  decode (state) {
    const buf = state.buffer
    let off = state.start
    const type = buf[off++]
    const sender = buf.subarray(off, off + 32); off += 32
    const timestamp = Number(buf.readBigUInt64BE(off)); off += 8
    const len = buf.readUInt32BE(off); off += 4
    const content = b4a.toString(buf.subarray(off, off + len), 'utf-8'); off += len
    state.start = off
    return { type, sender, timestamp, content }
  }
}

class RoomManager {
  /**
   * @param {Buffer} identityKey - Bridge's identity public key (core key)
   * @param {Object} identityKeyPair - Bridge's identity keypair {publicKey, secretKey}
   * @param {string} storagePath - Base storage directory
   * @param {Buffer|null} topicKey - Swarm topic key for discovery (room key from config)
   */
  constructor (identityKey, identityKeyPair, storagePath, topicKey) {
    this.identityKey = identityKey
    this.identityKeyPair = identityKeyPair
    this.topicKey = topicKey || identityKey  // fallback to identity key as topic
    this.storagePath = path.join(storagePath, 'rooms', b4a.toString(this.topicKey, 'hex'))
    this.core = null
    this.swarm = null
    this._replicates = []
    this._onmessage = null
    this._onready = null
    this._lastSeq = 0
  }

  set onmessage (fn) {
    this._onmessage = fn
  }

  set onready (fn) {
    this._onready = fn
  }

  get keyHex () {
    return b4a.toString(this.topicKey, 'hex')
  }

  async init (swarm) {
    try { fs.mkdirSync(this.storagePath, { recursive: true }) } catch {}

    // Core is always keyed by the bridge's identity → bridge is owner → can write
    this.core = new hypercore(this.storagePath, this.identityKey, {
      keyPair: this.identityKeyPair,
      encodeBatch: false
    })

    await this.core.ready()
    this._lastSeq = this.core.length
    console.error('[room] Core ready, length:', this.core.length)

    // Join swarm topic = discoveryKey(topicKey) for room discovery
    const topic = crypto.discoveryKey(this.topicKey)
    const discovery = swarm.join(topic, { client: true, server: true })
    await discovery.flushed()
    console.error('[room] Joined swarm topic:', b4a.toString(topic, 'hex'))

    // Listen for appended blocks (replicated from peers or our own writes)
    this.core.on('append', () => {
      this._processNewBlocks()
    })

    if (this._onready) this._onready()
    return this
  }

  async _processNewBlocks () {
    const length = this.core.length
    if (length <= this._lastSeq) return

    for (let i = this._lastSeq; i < length; i++) {
      try {
        const block = await this.core.get(i)
        if (block) {
          const msg = MessageEncoding.decode({ buffer: block, start: 0 })
          // Skip our own messages (already logged on send)
          if (this._onmessage) {
            this._onmessage(msg, i, this.topicKey)
          }
        }
      } catch (err) {
        console.error('[room] get block', i, 'not ready:', err.message)
      }
    }

    this._lastSeq = Math.max(this._lastSeq, length)
  }

  async append (msg) {
    if (!this.core.writable) {
      console.error('[room] Core not writable, cannot append')
      return null
    }

    const contentBuf = typeof msg.content === 'string' ? b4a.from(msg.content, 'utf-8') : msg.content
    const buf = b4a.alloc(1 + 32 + 8 + 4 + contentBuf.length)
    const state = { buffer: buf, start: 0 }
    MessageEncoding.encode(state, {
      type: msg.type || 0,
      sender: msg.sender,
      timestamp: msg.timestamp || Date.now(),
      content: msg.content
    })

    const seq = await this.core.append(buf.slice(0, state.start))
    console.error('[room] Appended block', seq, 'to room', this.keyHex.slice(0, 16))
    this._lastSeq = seq + 1
    return seq
  }

  close () {
    if (this.core) this.core.close()
    this._replicates.forEach(r => r())
  }
}

module.exports = RoomManager
