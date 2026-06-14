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
    this._servers = new Map()     // ticket hex → dht server (one per invite)
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

    // Start a DHT server listening on the seed-derived keyPair so the
    // Keet app (which derives the same key from the invite seed) can
    // connect and send the pairing request.
    const inviteKP = crypto.keyPair(invite.seed)
    this._startServer(inviteKP, ticket)

    return { url, ticket, roomKey: b4a.toString(topicKey, 'hex') }
  }

  /**
   * Start listening on the DHT for incoming candidate connections.
   *
   * Listens on the invite's seed-derived keyPair so the Keet app
   * (which derives the same key from the invite seed) can find us
   * on the DHT and send the pairing request.
   */
  _startServer(keyPair, ticket) {
    const server = this.dht.createServer()
    server.on('connection', noiseSocket => {
      noiseSocket.on('data', rawBuf => {
        this._handleIncoming(rawBuf, noiseSocket, ticket)
      })
      noiseSocket.on('error', () => {})
    })
    server.listen(keyPair).catch(err => {
      console.error('[pairing] listen error:', err.message)
    })
    this._servers.set(ticket, server)
  }

  /**
   * Handle incoming candidate data on the DHT noise pipe.
   */
  async _handleIncoming(rawBuf, noiseSocket, ticket) {
    const session = this.sessions.get(ticket)
    if (!session || session.status !== 'active') return

    // Check expiry
    if (session.expires && Date.now() > session.expires) {
      console.error('[pairing] Expired invite (%s), denying', ticket.slice(0, 16))
      session.status = 'expired'
      // Send INVITE_EXPIRED (status: 3)
      try {
        const req = MemberRequest.from(rawBuf)
        req.deny({ status: 3 })
        if (req.response) noiseSocket.write(req.response)
      } catch {}
      noiseSocket.end()
      return
    }

    try {
      const req = MemberRequest.from(rawBuf)
      const userData = req.open(session.invite.publicKey)
      const candidateId = b4a.toString(req.id, 'hex')
      this.pending.set(candidateId, { req, noiseSocket, ticket })

      // Auto-accept by default
      await this._autoAccept(candidateId, session, req, noiseSocket)
    } catch (e) {
      console.error('[pairing] Rejected for ticket %s: %s', ticket.slice(0, 16), e.message)
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
    // Close this invite's DHT server
    const server = this._servers.get(ticket)
    if (server) {
      try { server.close() } catch {}
      this._servers.delete(ticket)
    }
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
