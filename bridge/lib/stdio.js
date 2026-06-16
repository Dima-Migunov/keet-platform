const b4a = require('b4a')

// Pear Runtime (Bare) compat — process is not a global
let process_
try { process_ = require('bare-process') } catch {
  process_ = typeof process !== 'undefined' ? process : null
}
if (!process_) process_ = { stdin: null, stdout: null }

class JsonStdio {
  constructor (bridge) {
    this.bridge = bridge
    this._buffer = ''
  }

  start () {
    if (!process_.stdin) return
    process_.stdin.on('data', (data) => {
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

    process_.stdin.on('end', () => {
      console.error('[stdio] Stdin closed')
    })

    console.error('[stdio] JSON stdio protocol ready')
  }

  send (event) {
    if (!process_.stdout) return
    const json = JSON.stringify(event) + '\n'
    process_.stdout.write(json, 'utf-8')
  }

  _handleCommand (msg) {
    const { command, ...params } = msg

    switch (command) {
      case 'send_message':
        this._cmdSendMessage(params.chat_id, params.text)
        break

      case 'status':
        this._cmdStatus()
        break

      case 'get_identity':
        this._cmdGetIdentity()
        break

      default:
        this.send({ type: 'error', command, message: 'unknown_command' })
    }
  }

  async _cmdSendMessage (chatId, text) {
    try {
      const count = await this.bridge.sendMessage(chatId, text)
      this.send({ type: 'send_result', chat_id: chatId, status: 'ok', peers: count })
    } catch (err) {
      this.send({ type: 'error', command: 'send_message', message: err.message })
    }
  }

  _cmdStatus () {
    try {
      const peerCount = this.bridge.getPeerCount()
      const topicHex = this.bridge.getTopicHex()
      this.send({
        type: 'status',
        status: this.bridge._listening ? 'online' : 'offline',
        mode: 'hyperdrive',
        invite_url: this.bridge.getInviteUrl(),
        topic_key: topicHex.slice(0, 16) + '...',
        peerCount
      })
    } catch (err) {
      this.send({ type: 'error', command: 'status', message: err.message })
    }
  }

  _cmdGetIdentity () {
    this.send({
      type: 'identity',
      public_key: this.bridge.getInviteUrl() || '',
      topic_key: this.bridge.getTopicHex() || ''
    })
  }

  stop () {
    this.send({ type: 'shutdown' })
  }
}

module.exports = JsonStdio
