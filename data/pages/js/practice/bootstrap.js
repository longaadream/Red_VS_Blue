/* A fresh worker owns each match. No window, DOM, synchronous network or shared rule globals. */
self.onmessage = function (event) {
  try {
    if (!event.data || event.data.type !== 'initialize') throw new Error('练习初始化指令无效')
    const files = event.data.files
    if (!files || !files['data/rules/rule-lucky-coin-gamestart.json']) throw new Error('练习缺少后手开局规则')
    for (const directory of ['pieces', 'skills', 'cards', 'maps', 'rules', 'status-effects', 'tiles']) {
      const manifest = files && files['data/' + directory + '/manifest.json']
      if (!Array.isArray(manifest) || !manifest.length) throw new Error('练习资源清单缺失: ' + directory)
      for (const id of manifest) {
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)
          || !Object.hasOwn(files, 'data/' + directory + '/' + id + '.json')) throw new Error('练习资源缺失: ' + directory + '/' + id)
      }
    }
    self.__RVB_PRACTICE_FILES__ = files
    self.__RVB_PRACTICE_PROFILE__ = event.data.profile
    self.process = { env: { NODE_ENV: 'production' }, cwd: function () { return '' } }
    self.importScripts('engine.js')
  } catch (error) { self.postMessage({ error: { message: error.message }, fatal: true }) }
}
