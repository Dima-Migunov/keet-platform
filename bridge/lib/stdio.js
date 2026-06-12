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
      console.log('[stdio] Stdin closed')
    })

    console.log('[stdio] JSON stdio protocol ready')
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
      case 'ping':
        this.send({ type: 'pong' })
        break
      default:
        this.send({ type: 'error', command, message: 'unknown_command' })
    }
  }

  async _cmdSendMessage (chatId, text) {
    try {
      const key = b4a.from(chatId, 'hex')
      let room = this.bridge.rooms.get(chatId)
      if (!room) {
        room = await this.bridge.createRoom(key, this.bridge.identity.keyPair)
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
