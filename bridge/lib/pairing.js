const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const blind = require('blind-pairing-core')
const Hyperswarm = require('hyperswarm')
const z32 = require('z32')

const { CandidateRequest, MemberRequest, createInvite, decodeInvite } = blind

const DEFAULT_TTL = 72 * 60 * 60 * 1000 // 72 hours

/**
 * Wrap a standard blind-pairing invite into the Keet-compatible format.
 * Keet mobile app expects flags=97 (bits 0, 5, 6) and a 33-byte
 * extension: c.uint(148) prefix + 32-byte encryption key.
 */
function wrapKeetInvite(invite, encKey) {
  // invite.invite is the standard 66-byte Invite buffer (version+flags+seed+discoveryKey)
  const base = invite.invite
  // New buffer: 66 (base) + 33 (extension) = 99 bytes
  const keetBuf = b4a.alloc(99)
  b4a.copy(base, keetBuf, 0, 0, base.length)

  // Set flags byte to 97 (bits 0, 5, 6 set)
  // In compact-encoding, c.uint(97) = 0x61
  keetBuf[1] = 97

  // Append extension: c.uint(148) + fixed32(encKey) = 1 + 32 = 33 bytes
  keetBuf[66] = 148
  keetBuf.set(encKey, 67)

  return { ...invite, invite: keetBuf }
}

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

    // Derive the bridge's own DHT address for additionalNodes
    // so the phone has alternative routes to find us.
    // NOTE: We only include additionalNodes if we're confident the address
    // works for inbound connections. Behind symmetric NAT the STUN port
    // is transient — skip it and rely on DHT announce + relay instead.
    let additionalNodes = null

    // Create the blind-pairing invite.
    // The `key` here is the room topicKey; discoveryKey is derived from it.
    const invite = createInvite(topicKey, {
      discoveryKey: crypto.discoveryKey(topicKey),
      additionalNodes
    })

    // Generate encryption key for the room and wrap invite into Keet format
    const encKey = crypto.randomBytes(32)
    const keetInvite = wrapKeetInvite(invite, encKey)

    const ticket = b4a.toString(invite.publicKey, 'hex')
    const url = 'keet://chat/' + z32.encode(keetInvite.invite)
    const dkHex = b4a.toString(invite.discoveryKey, 'hex')

    // Store session
    this.sessions.set(ticket, {
      ticket,
      invite,
      topicKey,
      roomKey: b4a.toString(topicKey, 'hex'),
      encKey,                        // stored encryption key for confirm()
      createdAt: Date.now(),
      expires,
      status: 'active'
    })

    // Start a Hyperswarm swarm for this invite that joins the
    // discoveryKey topic. The phone's Keet app does the same:
    // swarm.join(discoveryKey, { server: false }), and Hyperswarm
    // connects them through DHT relay/holepunching.
    const inviteKP = crypto.keyPair(invite.seed)
    this._startServer(inviteKP, ticket, invite.discoveryKey)

    return { url, ticket, roomKey: b4a.toString(topicKey, 'hex') }
  }

  /**
   * Start listening for incoming candidate connections via Hyperswarm.
   *
   * Creates a dedicated Hyperswarm instance for this invite that joins
   * the discoveryKey topic. This is how Keet/Pear Runtime natively
   * handles invites — the phone's Keet app does swarm.join(discoveryKey,
   * { server: false }) and Hyperswarm handles DHT discovery, relay, and
   * holepunching automatically through the global DHT network.
   */
  _startServer(keyPair, ticket, discoveryKey) {
    const swarm = new Hyperswarm({
      keyPair,
      dht: this.dht,
      maxClientConnections: 4
    })

    swarm.on('connection', (noiseSocket, info) => {
      const remoteKey = noiseSocket.remotePublicKey
        ? b4a.toString(noiseSocket.remotePublicKey, 'hex').slice(0, 16)
        : 'unknown'
      console.error('[pairing] INCOMING CONNECTION ticket=%s remote=%s client=%s',
        ticket.slice(0, 16), remoteKey, info.client)

      noiseSocket.on('data', rawBuf => {
        const len = rawBuf.length
        const first = rawBuf[0]
        console.error('[pairing] DATA ticket=%s len=%d first_byte=%d',
          ticket.slice(0, 16), len, first)
        this._handleIncoming(rawBuf, noiseSocket, ticket)
      })
      noiseSocket.on('error', (err) => {
        console.error('[pairing] conn error ticket=%s: %s',
          ticket.slice(0, 16), err.message)
      })
      noiseSocket.on('close', () => {
        console.error('[pairing] conn CLOSED ticket=%s',
          ticket.slice(0, 16))
      })
    })

    // Join the discoveryKey topic — Hyperswarm handles DHT announce +
    // relay node connections automatically.
    swarm.join(discoveryKey, { server: true })
    // Also flush immediately so the announce propagates faster
    swarm.flush()

    console.error('[pairing] Swarm joined discoveryKey for ticket=%s', ticket.slice(0, 16))

    this._servers.set(ticket, swarm)
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
    const encryptionKey = session.encKey || crypto.randomBytes(32)

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
    // Close this invite's swarm
    const swarm = this._servers.get(ticket)
    if (swarm) {
      try { swarm.leave(swarm._topic); swarm.destroy() } catch {}
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
    for (const [, swarm] of this._servers) {
      try { swarm.destroy() } catch {}
    }
    this._servers.clear()
    this.sessions.clear()
    this.pending.clear()
  }
}

module.exports = PairingManager
