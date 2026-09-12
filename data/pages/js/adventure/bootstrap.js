self.onmessage = function (event) {
  try {
    if (event.data?.type !== 'initialize') throw new Error('冒险初始化指令无效')
    const files = event.data.files
    for (const directory of ['pieces','skills','cards','maps','rules','status-effects','tiles']) {
      const manifest = files?.['data/' + directory + '/manifest.json']
      if (!Array.isArray(manifest) || !manifest.length) throw new Error('冒险资源清单缺失：' + directory)
      for (const id of manifest) if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)
        || !Object.hasOwn(files, 'data/' + directory + '/' + id + '.json')) throw new Error('冒险资源缺失：' + id)
    }
    if (!files['data/rules/rule-lucky-coin-gamestart.json']) throw new Error('缺少开局规则')
    // Reuse the read-only resource adapter, not the practice session or training API.
    self.__RVB_PRACTICE_FILES__ = files
    self.__RVB_PRACTICE_PROFILE__ = event.data.profile
    self.process = { env: { NODE_ENV: 'production' }, cwd: function () { return '' } }
    self.importScripts('engine.js')
  } catch (error) { self.postMessage({ fatal: true, error: { message: error.message } }) }
}
