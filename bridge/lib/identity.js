const b4a = require('b4a')
const path = require('path')
const fs = require('fs')
const IdentityKey = require('keet-identity-key')

const IDENTITY_FILE = 'identity.seed'

class IdentityManager {
  constructor (storagePath) {
    this.storagePath = storagePath
    this.identity = null
    this.keyPair = null
    this.mnemonic = null
  }

  get publicKey () {
    return this.identity ? this.identity.identityPublicKey : null
  }

  async load () {
    const seedPath = path.join(this.storagePath, IDENTITY_FILE)

    let seed
    try {
      seed = fs.readFileSync(seedPath)
      this.mnemonic = IdentityKey.deriveSeed(seed)
      console.log('[identity] Loaded from:', seedPath)
    } catch (err) {
      // Generate new identity
      this.mnemonic = IdentityKey.generateMnemonic()
      seed = IdentityKey.deriveSeed(this.mnemonic)

      // Save seed
      try {
        fs.mkdirSync(this.storagePath, { recursive: true })
      } catch {}
      fs.writeFileSync(seedPath, seed)
      console.log('[identity] Generated new identity')
    }

    this.identity = await IdentityKey.from({ seed })
    this.keyPair = {
      publicKey: this.identity.identityPublicKey,
      secretKey: this.identity.keyChain._getSecretKey(
        this.identity.keyChain._derive(this.identity.keyChain.seed, [48, 5338, 0, 0, 0])
      )
    }

    console.log('[identity] Public key:', b4a.toString(this.publicKey, 'hex'))
    return this.identity
  }

  getDiscoveryKeyPair () {
    return {
      publicKey: this.identity.profileDiscoveryPublicKey,
      secretKey: null
    }
  }

  static generateMnemonic () {
    return IdentityKey.generateMnemonic()
  }
}

module.exports = IdentityManager
