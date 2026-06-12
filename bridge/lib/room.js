const b4a = require('b4a')
const hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const path = require('bare-path')
const fs = require('bare-fs')
const c = require('compact-encoding')

// Message encoding schema
const Message = {
  encode (msg) {
    const buf = b4a.alloc(1 + 32 + 8 + 4 + msg.content.length)
    let off = 0
    buf[off++] = msg.type || 0          // type (0=text, 1=image, 2=typing, etc)
    b4a.copy(msg.sender, buf, off); off += 32  // sender pubkey
    buf.writeUInt32BE(msg.timestamp || Date.now(), off); off += 8 // wait, 8 bytes
    // Actually let's use compact-encoding properly
    return c.encode(MessageEncoding, msg)
  },
  decode (buf) {
    return c.decode(MessageEncoding, buf)
  }
}

const MessageEncoding = {
  preencode (state, m) {
    state.end = 1 + 32 + 8 + 4 + (m.content ? m.content.byteLength || Buffer.byteLength(m.content) : 0)
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
  constructor (key, keyPair, storagePath) {
    this.key = key
    this.keyPair = keyPair
    this.storagePath = path.join(storagePath, 'rooms', b4a.toString(key, 'hex'))
    this.core = null
    this.swarm = null
    this._replicates = []
    this._onmessage = null
  }

  set onmessage (fn) {
    this._onmessage = fn
  }

  async init (swarm) {
    // Create storage dir
    try { fs.mkdirSync(path.join(this.storagePath), { recursive: true }) } catch {}

    // Create/replicate Hypercore
    this.core = hypercore(this.storagePath, this.key, {
      keyPair: this.keyPair,
      encodeBatch: false
    })

    await this.core.ready()
    console.log('[room] Core ready, length:', this.core.length)

    // Join Hyperswarm topic
    const topic = crypto.discoveryKey(this.key)
    const discovery = swarm.join(topic, { client: true, server: true })
    await discovery.flushed()

    console.log('[room] Joined swarm topic:', b4a.toString(topic, 'hex'))

    // Handle incoming connections for this room
    this._replicate = swarm.on('connection', (conn, info) => {
      const stream = this.core.replicate(info.client)
      conn.pipe(stream).pipe(conn)
    })

    // Watch for new blocks
    this.core.on('append', () => {
      this._processNewBlocks()
    })

    return this
  }

  async _processNewBlocks () {
    const length = this.core.length
    for (let i = 0; i < length; i++) {
      try {
        const block = await this.core.get(i)
        if (block) {
          const msg = MessageEncoding.decode({ buffer: block, start: 0 })
          if (this._onmessage) this._onmessage(msg, i, this.key)
        }
      } catch (err) {
        // Block not available yet
        console.log('[room] get block', i, 'failed:', err.message)
      }
    }
  }

  async append (msg) {
    if (!this.core.writable) {
      console.log('[room] Core not writable, cannot append')
      return null
    }

    const buf = b4a.alloc(1 + 32 + 8 + 4 + msg.content.length)
    const state = { buffer: buf, start: 0 }
    MessageEncoding.encode(state, {
      type: msg.type || 0,
      sender: msg.sender,
      timestamp: msg.timestamp || Date.now(),
      content: msg.content
    })

    const seq = await this.core.append(buf.slice(0, state.start))
    console.log('[room] Appended block', seq)
    return seq
  }

  async close () {
    if (this.core) await this.core.close()
    if (this.swarm) this._replicates.forEach(r => r())
  }
}

module.exports = RoomManager
