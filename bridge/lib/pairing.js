const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const c = require('compact-encoding')
const blind = require('blind-pairing-core')
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
    // so the phone can find us without relying on DHT findPeer.
    let additionalNodes = null
    try {
      const addr = this.bridge.dht.remoteAddress()
      if (addr && addr.host && addr.port) {
        additionalNodes = [{ host: addr.host, port: addr.port }]
        console.error('[pairing] Including additionalNode: %s:%d', addr.host, addr.port)
      } else {
        // Fallback: use the actual socket address
        const sockAddr = this.bridge.dht.io.serverSocket.address()
        if (sockAddr && sockAddr.port) {
          const host = this.bridge.dht.host || sockAddr.host
          additionalNodes = [{ host, port: sockAddr.port }]
          console.error('[pairing] Including additionalNode (fallback): %s:%d', host, sockAddr.port)
        }
      }
    } catch (e) {
      console.error('[pairing] Could not determine additionalNode:', e.message)
    }

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
    // Determine relay addresses for the invite DHT server.
    // Without relayAddresses, the announce record contains no IP/port
    // so remote clients cannot connect (findPeer succeeds but connect fails).
    let relayAddresses = []
    try {
      const sockAddr = this.dht.io.serverSocket.address()
      if (sockAddr && sockAddr.port) {
        const host = this.dht.host || sockAddr.host
        relayAddresses.push({ host, port: sockAddr.port })
        console.error('[pairing] Server relayAddress: %s:%d', host, sockAddr.port)
      }
    } catch (e) {
      console.error('[pairing] Could not determine relayAddress:', e.message)
    }

    const server = this.dht.createServer({ relayAddresses })
    server.on('connection', noiseSocket => {
      const remoteKey = noiseSocket.remotePublicKey
        ? b4a.toString(noiseSocket.remotePublicKey, 'hex').slice(0, 16)
        : 'unknown'
      console.error('[pairing] INCOMING CONNECTION ticket=%s remote=%s',
        ticket.slice(0, 16), remoteKey)
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
    server.listen(keyPair).then(() => {
      // Periodically refresh the announcer so the DHT record stays alive.
      // Without this the announcement may expire when firewalled=true.
      this._refreshIntervals = this._refreshIntervals || new Map()
      const intervalId = setInterval(() => {
        if (this._servers.has(ticket)) {
          const s = this._servers.get(ticket)
          if (s._announcer) {
            s._announcer.refresh()
            console.error('[pairing] Refreshed announce ticket=%s', ticket.slice(0, 16))
          }
        }
      }, 25_000)
      this._refreshIntervals.set(ticket, intervalId)
    }).catch(err => {
      console.error('[pairing] listen error ticket=%s: %s',
        ticket.slice(0, 16), err.message)
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
