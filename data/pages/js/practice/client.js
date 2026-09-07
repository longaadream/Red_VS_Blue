(function (root) {
  'use strict'
  const TIMEOUT_MS = 12000
  async function json(path) {
    const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error('练习资源尚未就绪，请从客户端打开（' + response.status + '）')
    return response.json()
  }
  root.RvBPracticeClient = {
    async create() {
      const [bundle, profile] = await Promise.all([json('./__battle-data.json'), json('./__tutorial-profile.json')])
      if (bundle.schemaVersion !== 'rvb-client-battle-data/v1' || !bundle.files) throw new Error('练习资源格式无效')
      // The official setup loads this singleton directly; it is not in the rule manifest.
      // URL objects bypass pack-fetch's relative-path IDB overrides: keep the desktop Profile as authority.
      bundle.files['data/rules/rule-lucky-coin-gamestart.json'] = await json(new URL('./data/rules/rule-lucky-coin-gamestart.json', location.href))
      const worker = new Worker('js/practice/bootstrap.js')
      let sequence = 0
      let disposed = false
      const pending = new Map()
      function dispose(message) {
        disposed = true; worker.terminate()
        pending.forEach(item => { clearTimeout(item.timer); item.reject(new Error(message || '练习已退出')) })
        pending.clear()
      }
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { dispose(); reject(new Error('练习初始化超时')) }, 20000)
        pending.set('ready', { resolve, reject, timer })
      })
      worker.onmessage = event => {
        const data = event.data
        const key = data.ready || data.fatal ? 'ready' : data.id
        const entry = pending.get(key)
        if (!entry || disposed) return
        clearTimeout(entry.timer); pending.delete(key)
        if (data.error) entry.reject(Object.assign(new Error(data.error.message), data.error, { practicePaused: data.paused }))
        else entry.resolve(data.result && data.result.state
          ? Object.assign(data.result, { requestMs: performance.now() - entry.started }) : data.result)
      }
      worker.onerror = event => { event.preventDefault(); dispose('练习引擎出错：' + event.message) }
      worker.postMessage({ type: 'initialize', files: bundle.files, profile })
      try { await ready } catch (error) { dispose(); throw error }
      return {
        files: bundle.files,
        request(type, payload) {
          if (disposed) return Promise.reject(new Error('练习已退出，请重新开局'))
          if (pending.size) return Promise.reject(new Error('上一条指令尚未完成'))
          return new Promise((resolve, reject) => {
            const id = ++sequence
            const timer = setTimeout(() => dispose('计算等待过长，练习已停止，可返回重新开局'), TIMEOUT_MS)
            pending.set(id, { resolve, reject, timer, started: performance.now() })
            worker.postMessage({ id, type, payload })
          })
        },
        dispose,
      }
    },
  }
})(window)
