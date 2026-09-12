/* Colyseus owns connection recovery; the page only submits actor-bound commands. */
window.RvBAdventureNetwork = {
  async connect(options = {}) {
    const host = window.RvBHost || window.electronAPI
    let localServer
    if (host?.ensureLocalAuthority && !options.roomId && !options.server) {
      const result = await host.ensureLocalAuthority()
      if (result?.ok === false) throw new Error(result.error || '本机服务启动失败')
      localServer = result?.localUrl || (await host.getMode?.())?.localUrl
    }
    const server = String(options.server || localServer || window.RvBUtils?.getServerUrl?.() || 'http://127.0.0.1:2567').replace(/\/+$/, '')
    const identity = await RvBIdentity.ensureIdentity()
    const profileResponse = await fetch('./__tutorial-profile.json', { cache: 'no-store' })
    if (!profileResponse.ok) throw new Error('无法读取本机资源身份')
    const profileIdentity = await profileResponse.json()
    const client = new Colyseus.Client(server)
    const tokenKey = 'rvb-adventure:' + server + ':' + (options.roomId || '') + ':' + profileIdentity.resolvedProfileHash
    const token = options.roomId && sessionStorage.getItem(tokenKey)
    let room
    if (token) {
      try { room = await client.reconnect(token) }
      catch (error) {
        if (!/reconnection token|reconnection expired|seat reservation expired|room .*not found/i.test(error.message)) throw error
        sessionStorage.removeItem(tokenKey)
      }
    }
    if (!room) {
      const challenge = await fetch(server.replace(/^ws/, 'http') + '/admission/challenge').then(r => { if (!r.ok) throw new Error('无法验证玩家身份'); return r.json() })
      const payload = { type: 'rvb-colyseus-admission-v1', nonce: challenge.nonce, playerId: identity.id, roomId: options.roomId || 'create' }
      const join = { playerId: identity.id, name: identity.displayName, profileIdentity,
        auth: { payload, publicKey: identity.publicKey, signature: await RvBIdentity.sign(payload) },
        seed: options.seed, saveId: options.saveId, familyId: options.familyId }
      room = options.roomId ? await client.joinById(options.roomId, join) : await client.create('adventure', join)
    }
    const key = 'rvb-adventure:' + server + ':' + room.roomId + ':' + profileIdentity.resolvedProfileHash
    const pending = new Map(), listeners = new Set(), connectionListeners = new Set()
    let connected = true, lastState, disposed = false
    const remember = () => sessionStorage.setItem(key, room.reconnectionToken)
    remember()
    room.reconnection.enabled = true; room.reconnection.minUptime = 0
    room.reconnection.minDelay = 100; room.reconnection.maxDelay = 2000; room.reconnection.maxRetries = 20
    room.reconnection.maxEnqueuedMessages = 0
    room.onMessage('adventure.state', value => { lastState = value; for (const listener of listeners) listener(value) })
    room.onMessage('adventure.error', value => { for (const listener of connectionListeners) listener(false, value.message) })
    room.onMessage('adventure.reply', value => {
      const item = pending.get(value.requestId); if (!item) return
      clearTimeout(item.timer); pending.delete(value.requestId)
      if (value.error) item.reject(Object.assign(new Error(value.error.message), value.error))
      else item.resolve(value.result)
    })
    room.onDrop(() => { connected = false; for (const listener of connectionListeners) listener(false, '连接中断，正在重连…') })
    room.onReconnect(() => { connected = true; remember(); for (const listener of connectionListeners) listener(true); void api.request('snapshot').then(value => { lastState = value; for (const listener of listeners) listener(value) }) })
    room.onLeave(() => { connected = false; sessionStorage.removeItem(key); for (const listener of connectionListeners) listener(false, '连接已结束，请从存档继续') })
    const api = { roomId: room.roomId, server, playerId: identity.id,
      subscribe(listener) { listeners.add(listener); if (lastState) listener(lastState); return () => listeners.delete(listener) },
      onConnection(listener) { connectionListeners.add(listener) },
      request(type, payload = {}, actionId = crypto.randomUUID()) {
        if (!connected || disposed) return Promise.reject(new Error('请等待连接恢复'))
        const requestId = crypto.randomUUID()
        return new Promise((resolve, reject) => {
          pending.set(requestId, { resolve, reject, timer: setTimeout(async () => {
            pending.delete(requestId)
            if (['human', 'interact', 'supply'].includes(type) && connected) {
              try {
                const receipt = await api.request('receipt', { actionId })
                if (receipt.status === 'applied') { resolve(await api.request('snapshot')); return }
                if (receipt.status === 'rejected') { reject(new Error(receipt.error)); return }
              } catch { /* The original command remains uncertain; never resend it as a new command. */ }
            }
            reject(new Error('指令确认超时，请同步当前进度后重试'))
          }, 10000) })
          room.send('adventure.rpc', { requestId, actionId, type, payload, profileIdentity })
        })
      },
      async dispose() { disposed = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('已离开冒险')) } pending.clear(); await room.leave() },
    }
    lastState = await api.request('snapshot')
    return api
  },
}
