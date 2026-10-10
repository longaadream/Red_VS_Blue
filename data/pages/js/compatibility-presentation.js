;(function (root) {
  'use strict'

  var OPEN_FLAG = 'rvb_compatibility_update_entry'
  var OFFICIAL_COMPATIBILITY_MESSAGE = '游戏版本与服务器不兼容，请更新后再匹配'
  var TYPES = { client: true, resource: true, generic: true, server: true }
  var PAGE_NAMES = { home: 'index.html', resource: 'pack.html', android: 'android-maintenance.html' }
  var LABELS = {
    client: '前往客户端更新',
    resource: '打开资源包管理',
    generic: '打开更新与资源',
  }

  function messageOf(error) {
    return typeof error === 'string'
      ? error
      : error && error.message
        ? String(error.message)
        : String(error || '')
  }

  function classify(error, field) {
    var code = error && typeof error.code === 'string' ? error.code : ''
    var context = error && error.context && typeof error.context === 'object' ? error.context : {}
    var mismatchField = field || context.field
    if (code === 'ENGINE_ABI_MISMATCH' || code === 'RUNNER_REVISION_MISMATCH') return 'client'
    if (code === 'PINNED_PROFILE_UNAVAILABLE') return 'server'
    if (code === 'PROFILE_REQUIRED' || code === 'PROFILE_INVALID' || code === 'PROFILE_HASH_MISMATCH') return 'resource'
    if (code === 'PROFILE_IDENTITY_MISMATCH') {
      return mismatchField === 'engineAbi' || mismatchField === 'runnerRevision' ? 'client' : 'resource'
    }
    if (messageOf(error) === OFFICIAL_COMPATIBILITY_MESSAGE) return 'generic'
    return null
  }

  function clear(host) {
    if (!host) return
    if (typeof host.replaceChildren === 'function') host.replaceChildren()
    else host.innerHTML = ''
    host.hidden = true
    if (host.dataset) delete host.dataset.compatibilityKind
  }

  function safeSessionStorage() {
    try {
      if (!root.sessionStorage) return null
      var origin = root.location && root.location.origin
      if (origin && origin !== 'null') {
        if (String(origin).indexOf('rvb-client:') === 0 && origin !== 'rvb-client://app') return null
        return root.sessionStorage
      }
      var href = root.location && root.location.href
      if (!href) return null
      var current = new URL(href)
      if (current.protocol !== 'rvb-client:' || current.host !== 'app') return null
      return root.sessionStorage
    } catch {
      return null
    }
  }

  function sameOriginPage(page) {
    if (!Object.values(PAGE_NAMES).includes(page)) return false
    try {
      var current = root.location || {}
      var currentHref = current.href || page
      var currentUrl = new URL(currentHref)
      var destination = new URL(page, currentHref)
      var origin = current.origin
      var samePrivilegedOrigin = currentUrl.protocol === 'rvb-client:' && currentUrl.host === 'app'
        && destination.protocol === 'rvb-client:' && destination.host === 'app'
      var sameFileOrigin = currentUrl.protocol === 'file:' && destination.protocol === 'file:'
        && currentUrl.host === destination.host
      var sameWebOrigin = origin && origin !== 'null' && destination.origin === origin
      if (!samePrivilegedOrigin && !sameFileOrigin && !sameWebOrigin) return false
      if (destination.search || destination.hash) return false
      root.location.href = page
      return true
    } catch {
      return false
    }
  }

  function open(type) {
    if (!TYPES[type] || type === 'server') return false
    var android = root.Capacitor && typeof root.Capacitor.isNativePlatform === 'function' && root.Capacitor.isNativePlatform()
    if (android) {
      var storage = safeSessionStorage()
      if (storage) storage.setItem('rvb_maintenance_section', type === 'resource' ? 'resources' : 'updates')
      return sameOriginPage(PAGE_NAMES.android)
    }
    if (type === 'resource') return sameOriginPage(PAGE_NAMES.resource)
    var storage = safeSessionStorage()
    if (storage) storage.setItem(OPEN_FLAG, type)
    return sameOriginPage(PAGE_NAMES.home)
  }

  function consumeHomepageRequest() {
    var storage = safeSessionStorage()
    if (!storage) return null
    try {
      var type = storage.getItem(OPEN_FLAG)
      storage.removeItem(OPEN_FLAG)
      return TYPES[type] && type !== 'server' ? type : null
    } catch {
      return null
    }
  }

  function render(host, error, options) {
    if (!host) return null
    options = options || {}
    clear(host)
    var type = classify(error, options.field)
    if (!type) return null
    host.hidden = false
    if (host.dataset) host.dataset.compatibilityKind = type
    var text = document.createElement('p')
    text.dataset.compatibilityMessage = ''
    text.textContent = options.message || messageOf(error)
    host.appendChild(text)
    if (type === 'server') {
      var note = document.createElement('p')
      note.dataset.compatibilityServer = ''
      note.textContent = '服务器当前固定的对局资源不可用，请稍后重试或联系服务器维护者。'
      host.appendChild(note)
      return type
    }
    var button = document.createElement('button')
    button.type = 'button'
    button.className = options.buttonClass || 'button primary'
    button.dataset.compatibilityEntry = type
    button.textContent = LABELS[type]
    button.onclick = function () { open(type) }
    host.appendChild(button)
    return type
  }

  root.RvBCompatibilityPresentation = {
    classify: classify,
    clear: clear,
    consumeHomepageRequest: consumeHomepageRequest,
    open: open,
    render: render,
    officialCompatibilityMessage: OFFICIAL_COMPATIBILITY_MESSAGE,
  }
})(window)
