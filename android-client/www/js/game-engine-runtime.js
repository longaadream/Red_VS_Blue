;(function () {
  if (window.RvBGameEngine && window.RvBGameEngine.ensure) return

  var nativeRequire = window.require
  var nativeProcess = window.process
  var xhrCache = Object.create(null)
  var loadPromise = null

  function cleanPath(value) {
    return String(value || '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
  }

  function joinPath() {
    var parts = Array.prototype.slice.call(arguments)
      .filter(function (part) { return part !== undefined && part !== null && String(part) !== '' })
      .map(cleanPath)
    var stack = []
    parts.join('/').split('/').forEach(function (part) {
      if (!part || part === '.') return
      if (part === '..') stack.pop()
      else stack.push(part)
    })
    return stack.join('/')
  }

  function requestText(path) {
    var normalized = cleanPath(path)
    var candidates = []
    if (normalized) {
      candidates.push(normalized)
      if (normalized.indexOf('data/') !== 0) candidates.push('data/' + normalized)
    }
    if (normalized.indexOf('resource-pack/data/') === 0) {
      candidates.push(normalized.replace(/^resource-pack\/data\//, 'data/'))
    }

    for (var i = 0; i < candidates.length; i++) {
      var url = candidates[i]
      if (xhrCache[url] !== undefined) {
        if (xhrCache[url] !== null) return xhrCache[url]
        continue
      }
      try {
        var xhr = new XMLHttpRequest()
        xhr.open('GET', url, false)
        xhr.send(null)
        if ((xhr.status >= 200 && xhr.status < 300) || (xhr.status === 0 && xhr.responseText)) {
          xhrCache[url] = xhr.responseText
          return xhr.responseText
        }
      } catch (_) {}
      xhrCache[url] = null
    }
    throw new Error('File not found: ' + path)
  }

  function readManifest(dir) {
    var ids = JSON.parse(requestText(joinPath(dir, 'manifest.json')))
    return Array.isArray(ids) ? ids : []
  }

  var fsShim = {
    existsSync: function (path) {
      try {
        var normalized = cleanPath(path)
        if (!normalized) return true
        if (!/\.[^/]+$/.test(normalized)) {
          readManifest(normalized)
          return true
        }
        requestText(normalized)
        return true
      } catch (_) {
        return false
      }
    },
    readFileSync: function (path) {
      return requestText(path)
    },
    readdirSync: function (path, options) {
      var names = readManifest(path).map(function (id) { return id + '.json' })
      if (options && options.withFileTypes) {
        return names.map(function (name) {
          return {
            name: name,
            isFile: function () { return true },
            isDirectory: function () { return false }
          }
        })
      }
      return names
    },
    mkdirSync: function () {},
    appendFileSync: function () {},
    writeFileSync: function () {}
  }

  var pathShim = {
    sep: '/',
    join: joinPath,
    resolve: joinPath,
    normalize: cleanPath,
    dirname: function (path) {
      var parts = cleanPath(path).split('/')
      parts.pop()
      return parts.join('/') || '.'
    },
    basename: function (path) {
      var parts = cleanPath(path).split('/')
      return parts[parts.length - 1] || ''
    },
    extname: function (path) {
      var name = pathShim.basename(path)
      var index = name.lastIndexOf('.')
      return index > 0 ? name.slice(index) : ''
    }
  }

  window.process = nativeProcess || { env: {}, cwd: function () { return '' } }
  if (!window.process.env) window.process.env = {}
  if (!window.process.cwd) window.process.cwd = function () { return '' }

  window.require = function (name) {
    if (name === 'fs') return fsShim
    if (name === 'path') return pathShim
    if (name === 'crypto') {
      return { randomUUID: function () { return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2) } }
    }
    if (name === 'zlib') return {}
    if (name === 'adm-zip') return function () {}
    if (typeof nativeRequire === 'function') return nativeRequire(name)
    throw new Error('Dynamic require of "' + name + '" is not supported')
  }

  function getEngine() {
    return window.GameEngine || (typeof globalThis !== 'undefined' ? globalThis.GameEngine : null)
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script')
      script.src = src
      script.async = false
      script.onload = resolve
      script.onerror = function () { reject(new Error('Failed to load ' + src)) }
      document.head.appendChild(script)
    })
  }

  window.RvBGameEngine = {
    ensure: function () {
      var current = getEngine()
      if (current && current.applyBattleAction) return Promise.resolve(current)
      if (loadPromise) return loadPromise
      loadPromise = (async function () {
        var candidates = ['js/game-engine.js', '../../www/js/game-engine.js', '../www/js/game-engine.js', '/js/game-engine.js']
        for (var i = 0; i < candidates.length; i++) {
          try {
            await loadScript(candidates[i])
            var engine = getEngine()
            if (engine && engine.applyBattleAction) return engine
          } catch (error) {
            console.warn('[game-engine-runtime] load candidate failed:', candidates[i], error)
          }
        }
        throw new Error('GameEngine 未加载：本地 game-engine.js 未找到或初始化失败')
      })()
      return loadPromise
    }
  }
})()
