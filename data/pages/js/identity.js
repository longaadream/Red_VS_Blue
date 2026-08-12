;(function () {
  'use strict'

  // Depends on js/crypto-lib.js (window.CryptoLib)

  const STORAGE_KEY = 'rvb_identity_v2'

  function _toHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  function _fromHex(hex) {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return bytes
  }

  function _normalizeIdentity(data) {
    if (!data || !data.id || !data.publicKey || !data.privateKey || !data.mnemonic) return null
    return {
      id: data.id,
      displayName: data.displayName || '玩家',
      publicKey: data.publicKey,
      privateKey: data.privateKey,
      mnemonic: Array.isArray(data.mnemonic) ? data.mnemonic : String(data.mnemonic).trim().split(/\s+/),
    }
  }

  function _saveStore(store) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)) } catch {}
  }

  function _loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const data = raw ? JSON.parse(raw) : null
      if (!data) return null
      if (Array.isArray(data.identities)) {
        const identities = data.identities.map(_normalizeIdentity).filter(Boolean)
        if (!identities.length) return null
        const activeId = data.activeId && identities.some(item => item.id === data.activeId)
          ? data.activeId
          : identities[0].id
        return { version: 3, activeId, identities }
      }
      const legacy = _normalizeIdentity(data)
      if (!legacy) return null
      const migrated = { version: 3, activeId: legacy.id, identities: [legacy] }
      _saveStore(migrated)
      return migrated
    } catch {
      return null
    }
  }

  function _getActiveEntry() {
    const store = _loadStore()
    if (!store) return null
    return store.identities.find(item => item.id === store.activeId) || store.identities[0] || null
  }

  function _saveIdentityEntry(entry, makeActive) {
    const normalized = _normalizeIdentity(entry)
    if (!normalized) throw new Error('Invalid identity data')
    const store = _loadStore() || { version: 3, activeId: normalized.id, identities: [] }
    const existingIndex = store.identities.findIndex(item => item.id === normalized.id)
    if (existingIndex >= 0) {
      const prev = store.identities[existingIndex]
      store.identities[existingIndex] = {
        ...prev,
        ...normalized,
        displayName: normalized.displayName || prev.displayName || '玩家',
      }
    } else {
      store.identities.push(normalized)
    }
    if (makeActive !== false || !store.activeId) {
      store.activeId = normalized.id
    }
    _saveStore(store)
    return normalized
  }

  async function _deriveKeypair(mnemonicStr) {
    const { getPublicKeyAsync, mnemonicToSeed } = window.CryptoLib
    const seed = await mnemonicToSeed(mnemonicStr)
    const privateKey = seed.slice(0, 32)
    const publicKey = await getPublicKeyAsync(privateKey)
    return { privateKey, publicKey }
  }

  async function _publicKeyToId(publicKey) {
    const hashBuf = await crypto.subtle.digest('SHA-256', publicKey)
    return _toHex(new Uint8Array(hashBuf)).slice(0, 8)
  }

  function getIdentity() {
    const data = _getActiveEntry()
    if (!data || !data.id) return null
    return { id: data.id, displayName: data.displayName || '玩家', publicKey: data.publicKey }
  }

  async function createIdentity(displayName) {
    const { generateMnemonic, englishWordlist } = window.CryptoLib
    const mnemonicStr = generateMnemonic(englishWordlist)
    const words = mnemonicStr.split(' ')
    return _importFromWords(words, displayName)
  }

  async function importFromMnemonic(input, displayName) {
    const words = Array.isArray(input) ? input : input.trim().split(/\s+/)
    if (words.length !== 12) throw new Error('助记词必须是 12 个英文单词')
    const { validateMnemonic, englishWordlist } = window.CryptoLib
    if (!validateMnemonic(words.join(' '), englishWordlist)) throw new Error('助记词无效，请检查拼写')
    return _importFromWords(words, displayName)
  }

  async function _importFromWords(words, displayName) {
    const mnemonicStr = words.join(' ')
    const { privateKey, publicKey } = await _deriveKeypair(mnemonicStr)
    const id = await _publicKeyToId(publicKey)
    const existing = _getActiveEntry()
    const name = (displayName || '').trim() || (existing && existing.displayName) || '玩家'

    _saveIdentityEntry({
      id,
      displayName: name,
      publicKey: _toHex(publicKey),
      privateKey: _toHex(privateKey),
      mnemonic: words,
    }, true)

    return { id, displayName: name }
  }

  function listIdentities() {
    const store = _loadStore()
    if (!store) return []
    return store.identities.map(item => ({
      id: item.id,
      displayName: item.displayName || '玩家',
      publicKey: item.publicKey,
      isActive: item.id === store.activeId,
    }))
  }

  function switchIdentity(id) {
    const store = _loadStore()
    if (!store) return null
    const target = store.identities.find(item => item.id === id)
    if (!target) throw new Error('Identity not found')
    store.activeId = target.id
    _saveStore(store)
    return { id: target.id, displayName: target.displayName || '玩家', publicKey: target.publicKey }
  }

  function setDisplayName(name) {
    const store = _loadStore()
    const data = _getActiveEntry()
    if (!store || !data) return null
    data.displayName = (name || '').trim() || '玩家'
    store.identities = store.identities.map(item => item.id === data.id ? data : item)
    _saveStore(store)
    return { id: data.id, displayName: data.displayName }
  }

  function getMnemonic() {
    const data = _getActiveEntry()
    return data ? (data.mnemonic || null) : null
  }

  function getPublicKey() {
    const data = _getActiveEntry()
    return data ? (data.publicKey || '') : ''
  }

  async function sign(payload) {
    const data = _getActiveEntry()
    if (!data || !data.privateKey) throw new Error('No identity to sign with')
    const { signAsync } = window.CryptoLib
    const message = new TextEncoder().encode(JSON.stringify(payload))
    const sig = await signAsync(message, _fromHex(data.privateKey))
    return _toHex(sig)
  }

  async function verify(payload, signatureHex, publicKeyHex) {
    const { verifyAsync } = window.CryptoLib
    const message = new TextEncoder().encode(JSON.stringify(payload))
    return verifyAsync(_fromHex(signatureHex), message, _fromHex(publicKeyHex))
  }

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
    listIdentities,
    switchIdentity,
    setDisplayName,
    getMnemonic,
    getPublicKey,
    sign,
    verify,
  }
})()
