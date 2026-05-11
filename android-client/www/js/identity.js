;(function () {
  'use strict'

  // Depends on js/crypto-lib.js (window.CryptoLib)

  const STORAGE_KEY = 'rvb_identity_v2'

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function _toHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  function _fromHex(hex) {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return bytes
  }

  function _save(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)) } catch {}
  }

  function _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }

  // ── Core crypto ───────────────────────────────────────────────────────────────

  async function _deriveKeypair(mnemonicStr) {
    const { getPublicKeyAsync, mnemonicToSeed } = window.CryptoLib
    // BIP39: mnemonic → 64-byte seed
    const seed = await mnemonicToSeed(mnemonicStr)
    // Ed25519: first 32 bytes as private key
    const privateKey = seed.slice(0, 32)
    const publicKey  = await getPublicKeyAsync(privateKey)
    return { privateKey, publicKey }
  }

  async function _publicKeyToId(publicKey) {
    const hashBuf = await crypto.subtle.digest('SHA-256', publicKey)
    return _toHex(new Uint8Array(hashBuf)).slice(0, 8)
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  // Synchronous — reads cached data from localStorage.
  // Returns null if no identity has been created yet.
  function getIdentity() {
    const data = _load()
    if (!data || !data.id) return null
    return { id: data.id, displayName: data.displayName || '玩家', publicKey: data.publicKey }
  }

  // Create a brand-new identity from a freshly generated mnemonic.
  async function createIdentity(displayName) {
    const { generateMnemonic, englishWordlist } = window.CryptoLib
    const mnemonicStr = generateMnemonic(englishWordlist)          // 12 words, space-separated
    const words = mnemonicStr.split(' ')
    return _importFromWords(words, displayName)
  }

  // Restore an identity from 12 mnemonic words (array or space-separated string).
  async function importFromMnemonic(input, displayName) {
    const words = Array.isArray(input) ? input : input.trim().split(/\s+/)
    if (words.length !== 12) throw new Error('助记词必须是12个单词')
    const { validateMnemonic, englishWordlist } = window.CryptoLib
    if (!validateMnemonic(words.join(' '), englishWordlist)) throw new Error('助记词无效，请检查拼写')
    return _importFromWords(words, displayName)
  }

  async function _importFromWords(words, displayName) {
    const mnemonicStr = words.join(' ')
    const { privateKey, publicKey } = await _deriveKeypair(mnemonicStr)
    const id = await _publicKeyToId(publicKey)

    // Preserve existing displayName if not provided
    const existing = _load()
    const name = (displayName || '').trim() || (existing && existing.displayName) || '玩家'

    _save({
      id,
      displayName: name,
      publicKey:  _toHex(publicKey),
      privateKey: _toHex(privateKey),
      mnemonic:   words,
    })
    return { id, displayName: name }
  }

  function setDisplayName(name) {
    const data = _load()
    if (!data) return null
    data.displayName = (name || '').trim() || '玩家'
    _save(data)
    return { id: data.id, displayName: data.displayName }
  }

  function getMnemonic() {
    const data = _load()
    return data ? (data.mnemonic || null) : null
  }

  function getPublicKey() {
    const data = _load()
    return data ? (data.publicKey || '') : ''
  }

  // Sign an object. Returns hex-encoded Ed25519 signature.
  async function sign(payload) {
    const data = _load()
    if (!data || !data.privateKey) throw new Error('No identity to sign with')
    const { signAsync } = window.CryptoLib
    const message = new TextEncoder().encode(JSON.stringify(payload))
    const sig = await signAsync(message, _fromHex(data.privateKey))
    return _toHex(sig)
  }

  // Verify a hex-encoded signature against a public key (hex).
  async function verify(payload, signatureHex, publicKeyHex) {
    const { verifyAsync } = window.CryptoLib
    const message = new TextEncoder().encode(JSON.stringify(payload))
    return verifyAsync(_fromHex(signatureHex), message, _fromHex(publicKeyHex))
  }

  // Ensure an identity exists, auto-creating one if needed. Returns identity object.
  async function ensureIdentity() {
    const existing = getIdentity()
    if (existing) return existing
    return createIdentity('玩家')
  }

  window.RvBIdentity = {
    getIdentity,
    ensureIdentity,
    createIdentity,
    importFromMnemonic,
    setDisplayName,
    getMnemonic,
    getPublicKey,
    sign,
    verify,
  }
})()
