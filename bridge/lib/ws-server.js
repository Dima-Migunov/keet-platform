const http = require('bare-http')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

// Minimal WebSocket implementation for Bare
// In Pear Runtime, we use hypercore-crypto and built-in streams
class WsServer {
  constructor (port, bridge) {
    this.port = port
    this.bridge = bridge
    this.server = null
    this.clients = new Set()
  }

  async start () {
    // Pear Terminal apps don't have a full Node.js http module
    // For the bridge, we use a simple TCP-based JSON protocol
    // Alternatively, we can use WebSocket via Pear's sidecar
    console.log('[ws] WebSocket server would listen on port', this.port)

    // Since Bare (the Pear runtime) doesn't have http/ws modules,
    // we'll use a simple TCP line-based JSON protocol
    // This will be enhanced when run in sidecar mode
    console.log('[ws] Using stdio JSON protocol for Hermes communication')
    this._setupStdio()
  }

  _setupStdio () {
    // Read JSON commands from stdin
    // Write JSON events to stdout
    // This works both in Pear Terminal and as a child process for Hermes

    // Buffer for incoming data
    let buffer = ''

    process.stdin.on('data', (data) => {
      buffer += b4a.toString(data, 'utf-8')
      const lines = buffer.split('\n')
      buffer = lines.pop() // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          this._handleCommand(msg)
        } catch (err) {
          console.error('[ws] Invalid JSON:', line)
        }
      }
    })

    process.stdin.on('end', () => {
      console.log('[ws] Stdin closed')
    })
  }

  _handleCommand (msg) {
    const { command, ...params } = msg
    console.log('[ws] Command:', command, params)

    switch (command) {
      case 'send_message':
        this._cmdSendMessage(params.chat_id, params.text)
        break
      case 'send_image':
        this._cmdSendImage(params.chat_id, params.path)
        break
      case 'list_chats':
        this._cmdListChats()
        break
      case 'get_chat_info':
        this._cmdGetChatInfo(params.chat_id)
        break
      default:
        this._send({ error: 'unknown_command', command })
    }
  }

  send (event) {
    const json = JSON.stringify(event) + '\n'
    const process = require('bare-process')
    process.stdout.write(b4a.from(json, 'utf-8'))
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
        sender: this.bridge.identity.publicKey
      })
      this.send({ type: 'send_result', chat_id: chatId, seq })
    } catch (err) {
      this.send({ type: 'error', chat_id: chatId, message: err.message })
    }
  }

  async _cmdSendImage (chatId, path) {
    // TODO: implement image sending
    this.send({ type: 'send_result', chat_id: chatId, status: 'not_implemented' })
  }

  async _cmdListChats () {
    const chats = []
    for (const [key, room] of this.bridge.rooms) {
      chats.push({
        id: b4a.toString(key, 'hex'),
        name: key.slice(0, 8).toString('hex') + '...',
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

  async stop () {
    this.send({ type: 'shutdown' })
  }
}

module.exports = WsServer
