(function (root) {
  'use strict'

  function publicState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('教程 AI 请求缺少有效战局状态')
    }
    // skillsById is a browser presentation cache. Keep the authoritative trace,
    // RNG metadata, and every gameplay field while avoiding a second large clone
    // of data the worker never reads.
    const copy = Object.assign({}, state)
    delete copy.skillsById
    try {
      // A few rule definitions carry compiled callbacks for the browser's
      // presentation path. The worker rebuilds those callbacks from its
      // canonical profile; JSON serialization removes only the callbacks while
      // retaining replay, RNG, and authority metadata in the payload.
      return JSON.parse(JSON.stringify(copy))
    } catch (error) {
      throw new Error('教程 AI 战局状态无法序列化：' + (error && error.message || String(error)))
    }
  }

  function fromPractice(practice) {
    if (!practice || typeof practice.request !== 'function' || typeof practice.dispose !== 'function') {
      throw new Error('教程 AI 搜索客户端不可用')
    }
    let disposed = false
    return Object.freeze({
      request(type, payload) {
        if (type !== 'tutorial-plan') return Promise.reject(new Error('教程 AI 客户端只支持 tutorial-plan'))
        if (disposed) return Promise.reject(new Error('教程 AI 搜索已退出，请重新开局'))
        const body = Object.assign({}, payload, { state: publicState(payload && payload.state) })
        return practice.request('tutorial-plan', body)
      },
      dispose(message) {
        if (disposed) return
        disposed = true
        practice.dispose(message || '教程已退出')
      },
    })
  }

  async function create() {
    if (!root.RvBPracticeClient || typeof root.RvBPracticeClient.create !== 'function') {
      throw new Error('教程 AI 搜索客户端不可用')
    }
    return fromPractice(await root.RvBPracticeClient.create())
  }

  root.RvBTutorialSearchClient = Object.freeze({ create, fromPractice })
})(window)
