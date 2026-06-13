const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const blind = require('blind-pairing-core')
const z32 = require('z32')

const { CandidateRequest, MemberRequest, createInvite, decodeInvite } = blind

const DEFAULT_TTL = 72 * 60 * 60 * 1000 // 72 hours

class PairingManager {
  constructor(dht, bridge) {
    this.dht = dht
    this.bridge = bridge
    this.sessions = new Map()     // ticket hex → InviteSession
    this.pending = new Map()      // candidateId → { req, noiseSocket, ticket }
    this._servers = new Map()     // discoveryKey hex → dht server (reused per room)
  }

  /**
   * Create an invite for a given topic key.
   */
  async createInvite(topicKey, opts = {}) {
    const ttl = opts.ttl || DEFAULT_TTL
    const expires = Date.now() + ttl

    // Ensure the room exists
    let room = this.bridge.rooms.get(b4a.toString(topicKey, 'hex'))
    if (!room) {
      room = await this.bridge.createRoom(topicKey)
    }

    // Create the blind-pairing invite.
    // The `key` here is the room topicKey; discoveryKey is derived from it.
    const invite = createInvite(topicKey, {
      discoveryKey: crypto.discoveryKey(topicKey),
      expires,
      additionalNodes: opts.additionalNodes
    })

    const ticket = b4a.toString(invite.publicKey, 'hex')
    const url = 'keet://chat/' + z32.encode(invite.invite)
    const dkHex = b4a.toString(invite.discoveryKey, 'hex')

    // Store session
    this.sessions.set(ticket, {
      ticket,
      invite,
      topicKey,
      roomKey: b4a.toString(topicKey, 'hex'),
      createdAt: Date.now(),
      expires,
      status: 'active'
    })

    // Start DHT listener for this discoveryKey (only once per room)
    if (!this._servers.has(dkHex)) {
      this._startServer(invite.discoveryKey, dkHex)
    }

    return { url, ticket, roomKey: b4a.toString(topicKey, 'hex') }
  }

  /**
   * Start listening on the DHT for incoming candidate connections.
   *
   * In HyperDHT v6 the server is automatically bound to the DHT node –
   * we need to listen on a unique ephemeral keypair so we don't conflict
   * with the bridge's own identity or profile servers.
   */
  _startServer(discoveryKey, dkHex) {
    const keyPair = require('hypercore-crypto').keyPair()
    const server = this.dht.createServer()
    server.on('connection', noiseSocket => {
      noiseSocket.on('data', rawBuf => {
        this._handleIncoming(rawBuf, noiseSocket)
      })
      noiseSocket.on('error', () => {})
    })
    server.listen(keyPair).catch(err => {
      console.error('[pairing] listen error:', err.message)
    })
    this._servers.set(dkHex, server)
  }

  /**
   * Handle incoming candidate data on the DHT noise pipe.
   * Try each active session that matches this discoveryKey.
   */
  async _handleIncoming(rawBuf, noiseSocket) {
    // Find which session this request belongs to by trying each
    for (const [ticket, session] of this.sessions) {
      if (session.status !== 'active') continue
      try {
        const req = MemberRequest.from(rawBuf)
        const userData = req.open(session.invite.publicKey)
        // If open() succeeded, this session matches
        const candidateId = b4a.toString(req.id, 'hex')
        this.pending.set(candidateId, { req, noiseSocket, ticket })

        // Auto-accept by default
        await this._autoAccept(candidateId, session, req, noiseSocket)
        return
      } catch {
        // Not this session's invite, try next
      }
    }
  }

  /**
   * Auto-accept a candidate: respond with room key and encryptionKey.
   */
  async _autoAccept(candidateId, session, req, noiseSocket) {
    const roomKey = session.topicKey
    const encryptionKey = crypto.randomBytes(32)

    req.confirm({ key: roomKey, encryptionKey, additional: null })

    if (req.response) {
      noiseSocket.write(req.response)
    }

    this.pending.delete(candidateId)

    this.bridge.stdio.send({
      type: 'member_joined',
      pubkey: b4a.toString(req.publicKey, 'hex'),
      room_key: session.roomKey,
      status: 'accepted'
    })
  }

  async acceptCandidate(candidateId) {
    const pending = this.pending.get(candidateId)
    if (!pending) return false
    const { req, noiseSocket, ticket } = pending
    const session = this.sessions.get(ticket)
    if (!session) return false
    await this._autoAccept(candidateId, session, req, noiseSocket)
    return true
  }

  async declineCandidate(candidateId) {
    const pending = this.pending.get(candidateId)
    if (!pending) return false
    const { req, noiseSocket } = pending
    req.deny({ status: 1 })
    if (req.response) noiseSocket.write(req.response)
    noiseSocket.end(b4a.from([]))
    this.pending.delete(candidateId)
    this.bridge.stdio.send({
      type: 'pairing_result',
      candidate_id: candidateId,
      status: 'declined'
    })
    return true
  }

  getSessions() {
    const now = Date.now()
    const result = []
    for (const [ticket, s] of this.sessions) {
      result.push({
        ticket,
        room_key: s.roomKey,
        status: s.status,
        created_at: s.createdAt,
        expires: s.expires,
        expired: now > s.expires
      })
    }
    return result
  }

  getPending() {
    return Array.from(this.pending.values()).map(p => ({
      candidate_id: b4a.toString(p.req.id, 'hex'),
      pubkey: b4a.toString(p.req.publicKey, 'hex'),
      ticket: p.ticket
    }))
  }

  cancelInvite(ticket) {
    const session = this.sessions.get(ticket)
    if (!session) return false
    session.status = 'cancelled'
    return true
  }

  cleanup() {
    const now = Date.now()
    for (const [ticket, session] of this.sessions) {
      if (session.expires && now > session.expires) {
        session.status = 'expired'
      }
    }
  }

  /**
   * Close all pending servers and cleanup.
   */
  close() {
    for (const [, server] of this._servers) {
      try { server.close() } catch {}
    }
    this._servers.clear()
    this.sessions.clear()
    this.pending.clear()
  }
}

module.exports = PairingManager
