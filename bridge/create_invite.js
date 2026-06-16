const { spawn } = require('child_process')

const BRIDGE_DIR = '/home/agent/.hermes/profiles/coder/plugins/keet-platform/bridge'

const bridge = spawn('node', ['index.js'], {
  cwd: BRIDGE_DIR,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
})

let output = ''
bridge.stdout.on('data', d => { output += d.toString(); process.stdout.write(d) })
bridge.stderr.on('data', d => { output += d.toString(); process.stderr.write(d) })

const start = Date.now()
const check = setInterval(() => {
  if (output.includes('"welcome_room_ready"')) {
    clearInterval(check)
    console.log('\n[script] Bridge ready, creating invite...')
    bridge.stdin.write(JSON.stringify({ command: 'create_invite' }) + '\n')
  }
  if (Date.now() - start > 25000) {
    clearInterval(check)
    console.log('\n[script] Timeout')
    cleanup()
  }
}, 500)

function cleanup() {
  bridge.stdin.write(JSON.stringify({ command: 'status' }) + '\n')
  setTimeout(() => {
    bridge.kill()
    process.exit(0)
  }, 1000)
}

process.once('SIGINT', cleanup)

bridge.on('exit', code => { clearInterval(check); process.exit(code || 0) })
