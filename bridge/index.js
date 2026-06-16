#!/usr/bin/env node
/**
 * Keet Bridge — Pear Runtime + Blind-Pairing
 *
 * Архитектура:
 * 1. Bridge создаёт blind-pairing инвайт
 * 2. DHT сервер анонсируется через Pear DHT (те же ноды что у Keet)
 * 3. Телефон открывает keet://chat/<z32> → находит bridge в DHT
 * 4. Blind-pairing handshake → P2P сокет (NoiseSocket)
 * 5. Текстовые сообщения релеятся через stdio в Hermes
 */
const blindPairing = require('blind-pairing-core')
const DHT = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const crypto = require('hypercore-crypto')
const z32 = require('z32')
const b4a = require('b4a')

const JsonStdio = require('./lib/stdio')

class KeetBlindBridge {
  constructor () {
    this.dht = null
    this.swarm = null
    this.stdio = null
    this._server = null
    this._invite = null
    this._inviteUrl = null
    this._listening = false
    this._sockets = new Map()
  }

  getInviteUrl () { return this._inviteUrl || '' }
  getTopicHex () { return this._invite ? b4a.toString(this._invite.discoveryKey, 'hex') : '' }

  async start () {
    console.error('[bridge] Starting Keet Bridge (blind-pairing + Pear DHT)...')

    // 1. Конфигурация DHT — Pear DHT ноды или fallback
    let bootstrap = null
    if (typeof Pear !== 'undefined' && Pear.config && Pear.config.dht && Pear.config.dht.nodes) {
      bootstrap = Pear.config.dht.nodes
      console.error('[bridge] Using Pear DHT with %d bootstrap nodes', bootstrap.length)
    }

    this.dht = new DHT({ bootstrap })
    await this.dht.ready()
    console.error('[bridge] DHT ready')

    // 2. Создание blind-pairing инвайта (ручная сборка — Keet требует ASCII '1' и flags=97)
    const inviteSeed = crypto.randomBytes(32)
    const inviteKeyPair = crypto.keyPair(inviteSeed)
    const discoKey = crypto.discoveryKey(inviteSeed)  // from seed, not publicKey (old working bridge used this)

    // Собираем буфер: version(1) + flags(1) + seed(32) + discoveryKey(32) = 66 bytes
    const inviteBuf = b4a.alloc(66)
    inviteBuf[0] = 1        // version = 1 (binary) — Keet принимает и 1 и '1', но наша старая ссылка работала с 1
    inviteBuf[1] = 0x61     // flags = 97 (0x61) — Keet's expected flags
    b4a.copy(inviteSeed, inviteBuf, 2)
    b4a.copy(discoKey, inviteBuf, 34)

    this._invite = { invite: inviteBuf, seed: inviteSeed, publicKey: inviteKeyPair.publicKey, discoveryKey: discoKey }

    // 3. DHT сервер — слушает invite keyPair
    this._server = this.dht.createServer()
    this._server.on('connection', (socket) => {
      console.error('[bridge] Incoming DHT connection')
      this._handleSocket(socket)
    })
    await this._server.listen(inviteKeyPair)
    console.error('[bridge] DHT server listening on invite key')

    // 4. Явный announce invite discoveryKey → invite keyPair
    // (чтобы телефон мог найти bridge через dht.lookup(discoveryKey))
    await this.dht.announce(discoKey, inviteKeyPair)
    console.error('[bridge] Announced discoveryKey on DHT')
    console.error('[bridge] DHT host: %s (firewalled: %s)', this.dht.host, this.dht.firewalled)

    // Periodic re-announce (DHT announce expires)
    this._announceInterval = setInterval(() => {
      this.dht.announce(discoKey, inviteKeyPair).catch(() => {})
      console.error('[bridge] Re-announced discoveryKey')
    }, 30000)  // every 30 seconds

    // 5. Кодируем URL: keet://chat/<z32(invite + extension)>
    const extKey = crypto.randomBytes(32)
    const extTypeByte = b4a.alloc(1)
    extTypeByte[0] = 148  // 0x94 — encryption key type
    const extension = b4a.concat([extTypeByte, extKey])
    const fullPayload = b4a.concat([this._invite.invite, extension])
    const encoded = z32.encode(fullPayload)
    this._inviteUrl = `keet://chat/${encoded}`
    console.error('')
    console.error('==================================================')
    console.error('INVITE LINK (send to phone):')
    console.error(this._inviteUrl)
    console.error('==================================================')
    console.error('')

    // 6. Stdio протокол
    this.stdio = new JsonStdio(this)
    this.stdio.start()
    this._listening = true

    // 7. Сигналы адаптеру
    this.stdio.send({
      type: 'identity',
      public_key: b4a.toString(this._invite.publicKey, 'hex'),
      profile_discovery_key: this.getTopicHex()
    })
    this.stdio.send({
      type: 'welcome_room_ready',
      room_key: this.getTopicHex(),
      invite_url: this._inviteUrl
    })
    console.error('[bridge] Ready!')
  }

  _handleSocket (socket) {
    const id = Math.random().toString(36).slice(2, 10)
    this._sockets.set(id, socket)

    this.stdio.send({
      type: 'member_joined',
      pubkey: id,
      room_key: this.getTopicHex()
    })

    socket.on('data', (data) => {
      const text = data.toString('utf-8').trim()
      if (!text) return
      console.error('[bridge] Message: %s', text.slice(0, 80))
      this.stdio.send({
        type: 'message',
        chat_id: this.getTopicHex(),
        from: id,
        text,
        ts: Date.now()
      })
    })

    socket.on('error', (err) => {
      console.error('[bridge] Socket error: %s', err.message)
    })

    socket.on('close', () => {
      this._sockets.delete(id)
      this.stdio.send({ type: 'member_left', pubkey: id, room_key: this.getTopicHex() })
    })
  }

  sendMessage (chatId, text) {
    let count = 0
    for (const [id, socket] of this._sockets) {
      try {
        socket.write(b4a.from(text, 'utf-8'))
        count++
      } catch (err) {
        console.error('[bridge] Send error: %s', err.message)
      }
    }
    return count
  }

  getPeerCount () { return this._sockets.size }
  getActiveAddress () {
    return this._inviteUrl ? { host: 'blind-pairing', port: this._inviteUrl.slice(0, 30) } : null
  }

  async stop () {
    this._listening = false
    if (this._announceInterval) clearInterval(this._announceInterval)
    for (const [, s] of this._sockets) try { s.destroy() } catch {}
    this._sockets.clear()
    if (this._server) await this._server.close()
    if (this.swarm) await this.swarm.destroy()
    if (this.dht) await this.dht.destroy()
    if (this.stdio) await this.stdio.stop()
    console.error('[bridge] Stopped')
  }
}

let bridge = null
if (require.main === module) {
  bridge = new KeetBlindBridge()
  bridge.start().catch((err) => {
    console.error('[bridge] Fatal:', err)
    if (typeof process !== 'undefined') process.exit(1)
  })
}
module.exports = KeetBlindBridge

if (typeof process !== 'undefined') {
  process.on('SIGINT', () => { if (bridge) bridge.stop().then(() => process.exit(0)) })
  process.on('SIGTERM', () => { if (bridge) bridge.stop().then(() => process.exit(0)) })
}
