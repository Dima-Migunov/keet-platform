const b4a = require('b4a')

class JsonStdio {
  constructor (bridge) {
    this.bridge = bridge
    this._buffer = ''
  }

  start () {
    process.stdin.on('data', (data) => {
      this._buffer += b4a.toString(data, 'utf-8')
      const lines = this._buffer.split('\n')
      this._buffer = lines.pop()

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          this._handleCommand(msg)
        } catch (err) {
          console.error('[stdio] Invalid JSON:', line)
        }
      }
    })

    process.stdin.on('end', () => {
      console.error('[stdio] Stdin closed')
    })

    console.error('[stdio] JSON stdio protocol ready')
  }

  send (event) {
    const json = JSON.stringify(event) + '\n'
    process.stdout.write(json, 'utf-8')
  }

  _handleCommand (msg) {
    const { command, ...params } = msg

    switch (command) {
      case 'send_message':
        this._cmdSendMessage(params.chat_id, params.text)
        break
      case 'send_image':
        this._cmdSendImage(params.chat_id, params.path, params.caption)
        break
      case 'list_chats':
        this._cmdListChats()
        break
      case 'get_chat_info':
        this._cmdGetChatInfo(params.chat_id)
        break
      case 'get_identity':
        this._cmdGetIdentity()
        break
      case 'join_room':
        this._cmdJoinRoom(params.room_key)
        break
      case 'connect_to_user':
        this._cmdConnectToUser(params.pubkey, params.room_key)
        break
      case 'send_welcome':
        this._cmdSendWelcome(params.pubkey)
        break
      case 'create_invite':
        this._cmdCreateInvite(params.room_key)
        break
      case 'pairing_list':
        this._cmdPairingList()
        break
      case 'accept_pairing':
        this._cmdAcceptPairing(params.candidate_id)
        break
      case 'decline_pairing':
        this._cmdDeclinePairing(params.candidate_id)
        break
      case 'cancel_invite':
        this._cmdCancelInvite(params.ticket)
        break
      case 'ping':
        this.send({ type: 'pong' })
        break
      default:
        this.send({ type: 'error', command, message: 'unknown_command' })
    }
  }

  _cmdGetIdentity () {
    if (!this.bridge.identity) {
      this.send({ type: 'error', command: 'get_identity', message: 'not_ready' })
      return
    }
    this.send({
      type: 'identity',
      public_key: b4a.toString(this.bridge.identity.publicKey, 'hex'),
      profile_discovery_key: b4a.toString(this.bridge.identity.identity.profileDiscoveryPublicKey, 'hex')
    })
  }

  async _cmdJoinRoom (roomKeyHex) {
    try {
      const key = b4a.from(roomKeyHex, 'hex')
      if (this.bridge.rooms.has(roomKeyHex)) {
        this.send({ type: 'join_result', room_key: roomKeyHex, status: 'already_joined' })
        return
      }
      const room = await this.bridge.createRoom(key)
      this.send({ type: 'join_result', room_key: roomKeyHex, status: 'joined' })
    } catch (err) {
      this.send({ type: 'error', command: 'join_room', message: err.message })
    }
  }

  async _cmdConnectToUser (pubkeyHex, roomKeyHex) {
    try {
      const pubkey = b4a.from(pubkeyHex, 'hex')
      console.error('[stdio] Connecting to user:', pubkeyHex.slice(0, 16) + '...')
      await this.bridge.connectToPeer(pubkey, roomKeyHex ? b4a.from(roomKeyHex, 'hex') : null)
      this.send({ type: 'connect_result', pubkey: pubkeyHex, status: 'connected' })
    } catch (err) {
      this.send({ type: 'error', command: 'connect_to_user', message: err.message })
    }
  }

  async _cmdSendWelcome (pubkeyHex) {
    try {
      const pubkey = b4a.from(pubkeyHex, 'hex')
      console.error('[stdio] Sending welcome to:', pubkeyHex.slice(0, 16) + '...')

      // Connect to peer using their pubkey as both peer and room key
      await this.bridge.connectToPeer(pubkey, pubkey)

      // Create/get the room keyed by the user's pubkey
      let room = this.bridge.rooms.get(pubkeyHex)
      if (!room) {
        room = await this.bridge.createRoom(pubkey)
      }

      // Append welcome message
      const seq = await room.append({
        type: 0,
        content: 'Hello! You are now connected to the Keet bot.',
        sender: this.bridge.identity.publicKey,
        timestamp: Date.now()
      })

      this.send({ type: 'send_welcome_result', pubkey: pubkeyHex, status: 'ok' })
    } catch (err) {
      this.send({ type: 'error', command: 'send_welcome', message: err.message })
    }
  }

  async _cmdCreateInvite (roomKeyHex) {
    try {
      const topicKey = roomKeyHex
        ? b4a.from(roomKeyHex, 'hex')
        : require('hypercore-crypto').randomBytes(32)

      const result = await this.bridge.pairing.createInvite(topicKey)
      this.send({ type: 'invite_created', ...result })
    } catch (err) {
      this.send({ type: 'error', command: 'create_invite', message: err.message })
    }
  }

  _cmdPairingList () {
    try {
      const pm = this.bridge.pairing
      this.send({
        type: 'pairing_list',
        sessions: pm.getSessions(),
        pending: pm.getPending()
      })
    } catch (err) {
      this.send({ type: 'error', command: 'pairing_list', message: err.message })
    }
  }

  async _cmdAcceptPairing (candidateId) {
    try {
      const ok = await this.bridge.pairing.acceptCandidate(candidateId)
      this.send({ type: 'pairing_result', candidate_id: candidateId, status: ok ? 'accepted' : 'not_found' })
    } catch (err) {
      this.send({ type: 'error', command: 'accept_pairing', message: err.message })
    }
  }

  async _cmdDeclinePairing (candidateId) {
    try {
      const ok = await this.bridge.pairing.declineCandidate(candidateId)
      this.send({ type: 'pairing_result', candidate_id: candidateId, status: ok ? 'declined' : 'not_found' })
    } catch (err) {
      this.send({ type: 'error', command: 'decline_pairing', message: err.message })
    }
  }

  async _cmdCancelInvite (ticket) {
    try {
      const ok = this.bridge.pairing.cancelInvite(ticket)
      this.send({ type: 'cancel_invite_result', ticket, status: ok ? 'cancelled' : 'not_found' })
    } catch (err) {
      this.send({ type: 'error', command: 'cancel_invite', message: err.message })
    }
  }

  async _cmdSendMessage (chatId, text) {
    try {
      const key = b4a.from(chatId, 'hex')
      let room = this.bridge.rooms.get(chatId)
      if (!room) {
        room = await this.bridge.createRoom(key)
      }
      const seq = await room.append({
        type: 0,
        content: text,
        sender: this.bridge.identity.publicKey,
        timestamp: Date.now()
      })
      this.send({ type: 'send_result', chat_id: chatId, seq })
    } catch (err) {
      this.send({ type: 'error', chat_id: chatId, message: err.message })
    }
  }

  async _cmdSendImage (chatId, path, caption) {
    this.send({ type: 'send_result', chat_id: chatId, status: 'not_implemented' })
  }

  async _cmdListChats () {
    const chats = []
    for (const [key, room] of this.bridge.rooms) {
      const keyHex = typeof key === 'string' ? key : b4a.toString(key, 'hex')
      chats.push({
        id: keyHex,
        name: keyHex.slice(0, 8) + '...',
        type: 'room',
        message_count: room.core ? room.core.length : 0
      })
    }
    this.send({ type: 'chat_list', chats })
  }

  async _cmdGetChatInfo (chatId) {
    const room = this.bridge.rooms.get(chatId)
    if (!room) {
      this.send({ type: 'chat_info', chat_id: chatId, error: 'not_found' })
      return
    }
    this.send({
      type: 'chat_info',
      chat_id: chatId,
      message_count: room.core ? room.core.length : 0
    })
  }

  stop () {
    this.send({ type: 'shutdown' })
  }
}

module.exports = JsonStdio
