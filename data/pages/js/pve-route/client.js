(function () {
  'use strict'

  const REQUIRED_DIRECTORIES = ['pieces', 'skills', 'cards', 'maps', 'rules', 'status-effects', 'tiles']

  async function readJson(url) {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error('固定路线资源读取失败：' + response.status)
    return response.json()
  }

  function validateResources(bundle, profile) {
    if (!bundle || bundle.schemaVersion !== 'rvb-client-battle-data/v1' || !bundle.files) {
      throw new Error('固定路线战斗资源格式无效')
    }
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error('固定路线 Profile 资源无效')
    }
    for (const directory of REQUIRED_DIRECTORIES) {
      const manifest = bundle.files['data/' + directory + '/manifest.json']
      if (!Array.isArray(manifest) || !manifest.length) throw new Error('固定路线资源清单缺失：' + directory)
      for (const id of manifest) {
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)
          || !Object.hasOwn(bundle.files, 'data/' + directory + '/' + id + '.json')) {
          throw new Error('固定路线资源缺失：' + id)
        }
      }
    }
  }

  function createWorkerClient(files, profile) {
    const worker = new Worker('js/pve-route/bootstrap.js')
    const pending = new Map()
    const listeners = new Set()
    let sequence = 0
    let disposed = false
    let initializing = true

    function failAll(message) {
      if (disposed) return
      disposed = true
      try { worker.terminate() } catch {}
      for (const item of pending.values()) {
        clearTimeout(item.timer)
        item.reject(new Error(message || '固定路线已退出'))
      }
      pending.clear()
    }

    function deliver(result) {
      if (!result) return
      for (const listener of listeners) {
        try { listener(result) } catch (error) { console.warn('[pve-route] snapshot listener failed', error) }
      }
    }

    worker.onmessage = event => {
      const data = event.data || {}
      const key = data.ready || data.fatal ? 'ready' : data.id
      const item = pending.get(key)
      if (!item || disposed) return
      clearTimeout(item.timer)
      pending.delete(key)
      if (data.error) item.reject(Object.assign(new Error(data.error.message || '固定路线 Worker 错误'), data.error))
      else {
        if (data.result) deliver(data.result)
        item.resolve(data.result)
      }
    }
    worker.onerror = event => {
      event.preventDefault()
      failAll('固定路线引擎出错：' + (event.message || 'unknown'))
    }

    const ready = new Promise((resolve, reject) => {
      pending.set('ready', { resolve, reject, timer: setTimeout(() => failAll('固定路线初始化超时'), 20000) })
    })
    worker.postMessage({ type: 'initialize', files, profile })

    return {
      files,
      profile,
      async ready() {
        await ready
        initializing = false
      },
      onSnapshot(listener) {
        if (typeof listener !== 'function') return () => {}
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      request(type, payload = {}) {
        if (disposed) return Promise.reject(new Error('固定路线已退出'))
        if (initializing && type !== 'snapshot') return ready.then(() => this.request(type, payload))
        return new Promise((resolve, reject) => {
          const id = ++sequence
          const timer = setTimeout(() => failAll('固定路线动作等待超时，请重试'), 20000)
          pending.set(id, { resolve, reject, timer })
          worker.postMessage({ id, type, payload })
        })
      },
      dispose() {
        failAll('固定路线已退出')
      },
    }
  }

  window.RvBPveRouteClient = {
    async loadResources() {
      const [bundle, profile] = await Promise.all([
        readJson('./__battle-data.json'),
        readJson('./__tutorial-profile.json'),
      ])
      validateResources(bundle, profile)
      bundle.files['data/rules/rule-lucky-coin-gamestart.json'] = await readJson(
        new URL('./data/rules/rule-lucky-coin-gamestart.json', location.href),
      )
      if (!bundle.files['data/rules/rule-lucky-coin-gamestart.json']) throw new Error('缺少开局规则')
      return { files: bundle.files, profile }
    },
    async create() {
      const { files, profile } = await this.loadResources()
      const client = createWorkerClient(files, profile)
      await client.ready()
      return client
    },
  }
})()
