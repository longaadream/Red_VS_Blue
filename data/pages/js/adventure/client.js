window.RvBAdventureClient = {
  async create() {
    async function json(url) {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) })
      if (!response.ok) throw new Error('冒险资源读取失败：' + response.status)
      return response.json()
    }
    const [bundle, profile] = await Promise.all([json('./__battle-data.json'), json('./__tutorial-profile.json')])
    if (bundle.schemaVersion !== 'rvb-client-battle-data/v1' || !bundle.files) throw new Error('冒险资源格式无效')
    bundle.files['data/rules/rule-lucky-coin-gamestart.json'] = await json(new URL('./data/rules/rule-lucky-coin-gamestart.json', location.href))
    const params = new URLSearchParams(location.search)
    if (params.get('roomId')) {
      const network = await RvBAdventureNetwork.connect({ roomId: params.get('roomId'), server: params.get('server') })
      return { files: bundle.files, network, dispose: () => network.dispose(),
        async request(type, payload) {
          const result = await network.request(type === 'start' ? 'snapshot' : type, payload)
          if (!result.snapshot) throw new Error('等待房主开始冒险')
          return result.snapshot
        },
      }
    }
    const worker = new Worker('js/adventure/bootstrap.js')
    const pending = new Map()
    let sequence = 0, disposed = false
    function dispose(message) {
      disposed = true; worker.terminate()
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(message || '冒险已退出')) }
      pending.clear()
    }
    const ready = new Promise((resolve, reject) => pending.set('ready', { resolve, reject,
      timer: setTimeout(() => dispose('冒险初始化超时'), 20000) }))
    worker.onmessage = event => {
      const data = event.data, key = data.ready || data.fatal ? 'ready' : data.id
      const item = pending.get(key)
      if (!item || disposed) return
      clearTimeout(item.timer); pending.delete(key)
      if (data.error) item.reject(Object.assign(new Error(data.error.message), data.error))
      else item.resolve(data.result && { ...data.result, requestMs: performance.now() - item.started })
    }
    worker.onerror = event => { event.preventDefault(); dispose('冒险引擎出错：' + event.message) }
    worker.postMessage({ type: 'initialize', files: bundle.files, profile })
    try { await ready } catch (error) { dispose(); throw error }
    return { files: bundle.files, dispose,
      request(type, payload = {}) {
        if (disposed || pending.size) return Promise.reject(new Error('请等待当前动作完成'))
        return new Promise((resolve, reject) => {
          const id = ++sequence
          pending.set(id, { resolve, reject, started: performance.now(), timer: setTimeout(() => dispose('冒险动作等待超时，请返回重试'), 10000) })
          worker.postMessage({ id, type, payload })
        })
      },
    }
  },
}
