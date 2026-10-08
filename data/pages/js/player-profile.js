;(function (global) {
  'use strict'

  var MAX_CARD_IDS = 50
  var CARD_CACHE_TTL_MS = 60000
  var PLACEHOLDER_IMAGE = 'images/tabletop/avatar-placeholder.svg'
  var state = {
    dialog: null,
    refs: null,
    epoch: 0,
    context: null,
    accountId: '',
    profile: null,
    catalog: null,
    pendingAvatarId: null,
    history: [],
    historyCursor: null,
    historyLoading: false,
    historyLoaded: false,
    statsRequest: 0,
    focused: null,
    controllers: [],
  }
  var cardQueue = Object.create(null)
  var cardCache = Object.create(null)
  var pendingCardRequests = Object.create(null)
  var cardCacheContext = ''
  var cardFlushTimer = null

  function make(tag, className, text) {
    var element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined && text !== null) element.textContent = String(text)
    return element
  }
  function clear(element) {
    if (!element) return
    if (typeof element.replaceChildren === 'function') element.replaceChildren()
    else while (element.firstChild) element.removeChild(element.firstChild)
  }
  function setText(element, value) {
    if (element) element.textContent = value == null ? '' : String(value)
  }
  function addText(parent, tag, className, value) {
    var element = make(tag, className, value)
    parent.appendChild(element)
    return element
  }
  function valueAt(source, keys, fallback) {
    source = source && typeof source === 'object' ? source : {}
    for (var index = 0; index < keys.length; index += 1) {
      var value = source[keys[index]]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return fallback
  }
  function idOf(value) {
    if (value && typeof value === 'object') value = value.id || value.accountId || value.playerId
    var result = String(value == null ? '' : value).trim()
    return result
  }
  function nameOf(value, fallback) {
    var result = value && typeof value === 'object' ? value.name : value
    result = String(result == null ? '' : result).trim()
    return result || fallback || '未知玩家'
  }
  function avatarOf(value) {
    if (!value || typeof value !== 'object') return null
    return value.avatar && typeof value.avatar === 'object' ? value.avatar : value
  }

  function normalizeOrigin(raw) {
    if (global.RvBUtils && typeof global.RvBUtils.normalizeOfficialOrigin === 'function') {
      return global.RvBUtils.normalizeOfficialOrigin(raw)
    }
    try {
      var url = new URL(String(raw || '').trim())
      var loopback = ['localhost', '127.0.0.1', '[::1]'].indexOf(url.hostname) !== -1
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) return ''
      return url.href.replace(/\/+$/, '')
    } catch {
      return ''
    }
  }

  function storedOrigin() {
    var candidates = []
    try { candidates.push(localStorage.getItem('rvb_official_url')) } catch {}
    try {
      if (global.RvBUtils && typeof global.RvBUtils.getServerUrl === 'function') candidates.push(global.RvBUtils.getServerUrl())
    } catch {}
    for (var index = 0; index < candidates.length; index += 1) {
      var origin = normalizeOrigin(candidates[index])
      if (origin) return origin
    }
    return ''
  }

  function sessionFor(origin) {
    try {
      return global.RvBUtils && typeof global.RvBUtils.readOfficialSession === 'function'
        ? global.RvBUtils.readOfficialSession(origin)
        : null
    } catch {
      return null
    }
  }

  function readContext() {
    var origin = storedOrigin()
    var session = origin ? sessionFor(origin) : null
    if (!origin || !session || !session.token) throw new Error('请先登录官方账号')
    return { origin: origin, token: String(session.token), account: session.account || null }
  }

  function currentContext(context) {
    if (!context) return false
    var latest = readContextSafe()
    return !!(latest && latest.origin === context.origin && latest.token === context.token)
  }

  function readContextSafe() {
    try { return readContext() } catch { return null }
  }

  function contextKey(context) { return context ? context.origin + '|' + context.token : '' }

  function ensureCardCache(context) {
    var key = contextKey(context)
    if (cardCacheContext !== key) {
      cardCache = Object.create(null)
      cardQueue = Object.create(null)
      pendingCardRequests = Object.create(null)
      cardCacheContext = key
    }
  }

  function cachedCard(context, id) {
    ensureCardCache(context)
    var entry = cardCache[id]
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) delete cardCache[id]
      return null
    }
    return entry.card
  }

  function storeCards(context, cards, ids, fallbackNames) {
    ensureCardCache(context)
    var expiresAt = Date.now() + CARD_CACHE_TTL_MS
    ids.forEach(function (id) { cardCache[id] = { card: cards[id] || { id: id, name: fallbackNames[id] || id }, expiresAt: expiresAt } })
  }

  function abortOwner(owner) {
    var controllers = owner && Array.isArray(owner.controllers) ? owner.controllers : []
    controllers.forEach(function (controller) {
      try { controller.abort() } catch {}
    })
    if (owner) owner.controllers = []
  }

  function abortRequests() {
    abortOwner(state)
  }

  function clearCardQueue() {
    if (cardFlushTimer !== null && typeof clearTimeout === 'function') clearTimeout(cardFlushTimer)
    cardFlushTimer = null
    cardQueue = Object.create(null)
    pendingCardRequests = Object.create(null)
  }

  function request(context, path, options, owner) {
    options = options || {}
    if (!currentContext(context)) return Promise.reject(new Error('登录状态已更改，请重试'))
    owner = owner || state
    var controller = typeof AbortController === 'function' ? new AbortController() : null
    if (controller && Array.isArray(owner.controllers)) owner.controllers.push(controller)
    var headers = {}
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    headers.Authorization = 'Bearer ' + context.token
    var init = {
      method: options.method || (options.body === undefined ? 'GET' : 'POST'),
      headers: headers,
      cache: 'no-store',
    }
    if (options.body !== undefined) init.body = JSON.stringify(options.body)
    if (controller) init.signal = controller.signal
    var promise
    try {
      promise = fetch(context.origin + path, init)
    } catch (error) {
      if (controller && Array.isArray(owner.controllers)) owner.controllers = owner.controllers.filter(function (entry) { return entry !== controller })
      return Promise.reject(error)
    }
    return Promise.resolve(promise).then(function (response) {
      return Promise.resolve(response.json()).catch(function () { return {} }).then(function (result) {
        if (!response.ok) {
          var error = new Error(result && result.error ? result.error : (response.status === 401 ? '登录状态已过期' : '请求失败'))
          error.status = response.status
          throw error
        }
        return result
      })
    }).finally(function () {
      if (controller && Array.isArray(owner.controllers)) owner.controllers = owner.controllers.filter(function (entry) { return entry !== controller })
    })
  }

  function localImage(raw) {
    var value = String(raw == null ? '' : raw).trim().replace(/^\.\//, '')
    if (!value || value[0] === '/' || value.indexOf('//') !== -1 || /^(?:[a-z]+:|\/\/)/i.test(value) || value.indexOf('..') !== -1 || value.indexOf('\\') !== -1) return ''
    if (value.indexOf('images/') === 0) value = value.slice(7)
    if (!/^[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp|gif|svg)$/i.test(value)) return ''
    return 'images/' + value
  }

  function avatarSource(value) {
    var avatar = avatarOf(value)
    return localImage(avatar && (avatar.image || avatar.src)) || PLACEHOLDER_IMAGE
  }

  function setAvatarImage(image, value, alt) {
    image.src = avatarSource(value)
    image.alt = alt ? String(alt) : ''
    image.setAttribute('aria-hidden', alt ? 'false' : 'true')
    image.onerror = function () {
      if (image.src.indexOf(PLACEHOLDER_IMAGE) === -1) image.src = PLACEHOLDER_IMAGE
      else image.hidden = true
    }
  }

  function createAvatar(value, size, alt) {
    var image = make('img', 'rvb-player-avatar' + (size ? ' rvb-player-avatar--' + size : ''))
    setAvatarImage(image, value, alt)
    return image
  }

  function displayNameForElement(element) {
    if (element && element.__rvbProfileName) return element.__rvbProfileName
    return element && element.textContent ? element.textContent.trim() : '未知玩家'
  }

  function renderDecoratedElement(element, card) {
    if (!element) return
    var name = nameOf(card, displayNameForElement(element))
    element.__rvbProfileName = name
    var avatar = avatarOf(card)
    var image = element.__rvbProfileAvatar
    var label = element.__rvbProfileLabel
    if (!image) {
      image = createAvatar(avatar || {}, 'tiny', '')
      label = make('span', 'rvb-player-label', name)
      clear(element)
      element.appendChild(image)
      element.appendChild(label)
      element.__rvbProfileAvatar = image
      element.__rvbProfileLabel = label
    } else {
      setAvatarImage(image, avatar || {}, '')
      setText(label, name)
    }
    element.setAttribute('data-player-id', idOf(card))
    element.setAttribute('aria-label', '查看玩家资料：' + name)
    element.classList.add('rvb-player-link')
  }

  function attachPlayerEvents(element, id) {
    if (!element || element.__rvbProfileEvents) return
    element.__rvbProfileEvents = true
    if (element.tagName && element.tagName.toLowerCase() === 'button') element.type = 'button'
    else {
      element.setAttribute('role', 'button')
      element.tabIndex = 0
    }
    element.addEventListener('click', function (event) { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); void open(id) })
    element.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      if (typeof event.stopPropagation === 'function') event.stopPropagation()
      void open(id)
    })
  }

  function renderBoundAvatar(element, card) {
    var image = element.tagName && element.tagName.toLowerCase() === 'img' ? element : element.__rvbProfileAvatar
    if (!image) {
      image = createAvatar(card || {}, 'tiny', '')
      if (element.tagName && element.tagName.toLowerCase() === 'img') return image
      clear(element)
      if (typeof element.appendChild === 'function') element.appendChild(image)
      element.__rvbProfileAvatar = image
    } else setAvatarImage(image, card || {}, '')
    return image
  }

  function queuePlayerCard(element, id, name, avatarOnly, preserveName) {
    var context = readContextSafe()
    if (!context) return
    var cached = cachedCard(context, id)
    if (cached) {
      if (avatarOnly || preserveName) renderBoundAvatar(element, cached)
      else renderDecoratedElement(element, cached)
      return
    }
    var queuedContext = contextKey(context)
    if (element.__rvbProfileQueuedContext === queuedContext && element.__rvbProfileQueuedId === id) return
    element.__rvbProfileQueuedContext = queuedContext
    element.__rvbProfileQueuedId = id
    var pendingKey = queuedContext + '|' + id
    var pending = pendingCardRequests[pendingKey]
    var entry = { element: element, name: name, avatarOnly: avatarOnly === true, preserveName: preserveName === true }
    if (pending) {
      pending.entries.push(entry)
      return
    }
    if (!cardQueue[id]) cardQueue[id] = []
    cardQueue[id].push(entry)
    if (cardFlushTimer === null) {
      cardFlushTimer = typeof setTimeout === 'function' ? setTimeout(flushCardQueue, 0) : 0
      if (cardFlushTimer === 0) flushCardQueue()
    }
  }

  function flushCardQueue() {
    cardFlushTimer = null
    var context = readContextSafe()
    if (!context) { cardQueue = Object.create(null); return }
    ensureCardCache(context)
    var ids = Object.keys(cardQueue)
    if (!ids.length) return
    var batch = ids.slice(0, MAX_CARD_IDS)
    var leftovers = ids.slice(MAX_CARD_IDS)
    var entries = Object.create(null)
    batch.forEach(function (id) { entries[id] = cardQueue[id]; delete cardQueue[id] })
    leftovers.forEach(function (id) { if (!cardQueue[id]) cardQueue[id] = [] })
    var requestIds = []
    batch.forEach(function (id) {
      var pendingKey = contextKey(context) + '|' + id
      if (pendingCardRequests[pendingKey]) pendingCardRequests[pendingKey].entries = pendingCardRequests[pendingKey].entries.concat(entries[id] || [])
      else {
        pendingCardRequests[pendingKey] = { context: context, entries: entries[id] || [] }
        requestIds.push(id)
      }
    })
    if (!requestIds.length) {
      if (Object.keys(cardQueue).length && cardFlushTimer === null) cardFlushTimer = setTimeout(flushCardQueue, 0)
      return
    }
    request(context, '/official/players/cards?ids=' + requestIds.map(encodeURIComponent).join(','), {}).then(function (result) {
      var pendingEntries = Object.create(null)
      requestIds.forEach(function (id) {
        var pendingKey = contextKey(context) + '|' + id
        pendingEntries[id] = pendingCardRequests[pendingKey] ? pendingCardRequests[pendingKey].entries : (entries[id] || [])
        delete pendingCardRequests[pendingKey]
      })
      if (!currentContext(context)) return
      var players = result && Array.isArray(result.players) ? result.players : []
      var byId = Object.create(null)
      players.forEach(function (player) { var id = idOf(player); if (id) byId[id] = player })
      var fallbackNames = Object.create(null)
      requestIds.forEach(function (id) { var first = pendingEntries[id] && pendingEntries[id][0]; if (first && first.name) fallbackNames[id] = first.name })
      storeCards(context, byId, requestIds, fallbackNames)
      requestIds.forEach(function (id) {
        ;(pendingEntries[id] || []).forEach(function (entry) {
          if (!entry.element || entry.element.isConnected === false) return
          var card = byId[id] || { id: id, name: entry.name }
          if (entry.avatarOnly || entry.preserveName) renderBoundAvatar(entry.element, card)
          else renderDecoratedElement(entry.element, card)
        })
      })
    }).catch(function () {
      // A lightweight card is an enhancement; keep the server supplied name when it fails.
      requestIds.forEach(function (id) { delete pendingCardRequests[contextKey(context) + '|' + id] })
    }).finally(function () {
      requestIds.forEach(function (id) { delete pendingCardRequests[contextKey(context) + '|' + id] })
      if (Object.keys(cardQueue).length && cardFlushTimer === null) cardFlushTimer = setTimeout(flushCardQueue, 0)
    })
  }

  function decoratePlayer(element, details) {
    if (!element) return element
    details = details || {}
    var id = idOf(details.id || details.accountId || details.playerId || element.getAttribute('data-player-id'))
    var name = nameOf(details.name || element.textContent, '未知玩家')
    if (!id) return element
    renderDecoratedElement(element, { id: id, name: name, avatar: details.avatar || details })
    attachPlayerEvents(element, id)
    if (!details.avatar) queuePlayerCard(element, id, name, false, details.preserveName === true)
    return element
  }

  function bindAvatar(element, details) {
    if (!element) return element
    details = details || {}
    var id = idOf(details.id || details.accountId || details.playerId || element.getAttribute('data-player-id'))
    if (!id) return element
    var context = readContextSafe()
    var card = details.avatar ? { id: id, name: details.name, avatar: details.avatar } : cachedCard(context, id)
    var ownerButton = element.closest ? element.closest('button') : null
    var interactive = !ownerButton || ownerButton === element
    renderBoundAvatar(element, card || details)
    element.setAttribute('data-player-id', id)
    element.removeAttribute('aria-hidden')
    if (interactive) {
      element.setAttribute('data-rvb-player-avatar', '')
      element.setAttribute('aria-label', '查看玩家资料：' + nameOf(details.name || (card && card.name), '未知玩家'))
      if (element.tagName && element.tagName.toLowerCase() === 'img') {
        element.alt = nameOf(details.name || (card && card.name), '玩家头像')
        element.setAttribute('aria-hidden', 'false')
      }
      attachPlayerEvents(element, id)
    } else {
      element.removeAttribute('data-rvb-player-avatar')
      element.removeAttribute('role')
      element.removeAttribute('tabindex')
      element.removeAttribute('aria-label')
      if (element.tagName && element.tagName.toLowerCase() === 'img') element.setAttribute('aria-hidden', 'true')
    }
    if (!card) queuePlayerCard(element, id, nameOf(details.name, '未知玩家'), true)
    return element
  }

  function renderIdentity(element, details, avatarClass, fallback) {
    if (!element) return element
    details = details || {}
    var id = idOf(details.id || details.accountId || details.playerId)
    if (!id) { clear(element); setText(element, fallback || '登录账号'); return element }
    var name = nameOf(details.name, fallback || '未知玩家')
    var avatar = element.querySelector ? element.querySelector('[data-rvb-identity-avatar]') : null
    var label = element.querySelector ? element.querySelector('[data-rvb-identity-label]') : null
    if (!avatar || !label) {
      clear(element)
      avatar = make('span', avatarClass || 'rvb-identity-avatar')
      avatar.setAttribute('data-rvb-identity-avatar', '')
      label = make('span', 'rvb-identity-label')
      element.appendChild(avatar); element.appendChild(label)
    }
    setText(label, name)
    bindAvatar(avatar, { id: id, name: name, avatar: details.avatar })
    return element
  }

  function ensureDialog() {
    if (state.dialog) return state.dialog
    var dialog = make('dialog', 'game-dialog rvb-player-profile-dialog')
    dialog.id = 'rvbPlayerProfileDialog'
    dialog.setAttribute('aria-labelledby', 'rvbPlayerProfileTitle')
    dialog.setAttribute('aria-describedby', 'rvbPlayerProfileStatus')
    var close = make('button', 'dialog-close', '×')
    close.type = 'button'; close.setAttribute('aria-label', '关闭玩家资料')
    dialog.appendChild(close)
    var header = make('header', 'rvb-profile-header')
    var headerAvatar = createAvatar({}, 'large', '')
    headerAvatar.id = 'rvbPlayerProfileAvatar'
    header.appendChild(headerAvatar)
    var heading = make('div', 'rvb-profile-heading')
    var title = addText(heading, 'h2', '', '玩家资料')
    title.id = 'rvbPlayerProfileTitle'
    addText(heading, 'p', 'rvb-profile-id', '')
    header.appendChild(heading)
    dialog.appendChild(header)
    var status = addText(dialog, 'p', 'rvb-profile-status', '')
    status.id = 'rvbPlayerProfileStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
    var tabs = make('div', 'rvb-profile-tabs')
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '玩家资料内容')
    ;[['overview', '概览'], ['edit', '编辑资料'], ['history', '对局历史']].forEach(function (entry) {
      var button = make('button', 'rvb-profile-tab', entry[1]); button.type = 'button'
      button.dataset.profileTab = entry[0]; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'rvb-profile-panel-' + entry[0])
      tabs.appendChild(button)
    })
    dialog.appendChild(tabs)
    tabs.addEventListener('keydown', function (event) {
      var direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
      var isHome = event.key === 'Home'; var isEnd = event.key === 'End'
      if (direction === undefined && !isHome && !isEnd) return
      var buttons = Array.prototype.filter.call(tabs.querySelectorAll('[data-profile-tab]'), function (button) { return !button.hidden })
      var index = buttons.indexOf(event.target)
      if (index < 0 || !buttons.length) return
      var next = isHome ? 0 : isEnd ? buttons.length - 1 : (index + direction + buttons.length) % buttons.length
      selectTab(buttons[next].dataset.profileTab); buttons[next].focus(); event.preventDefault()
    })
    var overview = make('section', 'rvb-profile-panel'); overview.id = 'rvb-profile-panel-overview'; overview.dataset.profilePanel = 'overview'; overview.setAttribute('role', 'tabpanel')
    var metrics = make('div', 'rvb-profile-metrics'); overview.appendChild(metrics)
    var rosters = make('section', 'rvb-profile-rosters'); addText(rosters, 'h3', '', '常用完整阵容'); var rosterGrid = make('div', 'rvb-roster-grid'); rosters.appendChild(rosterGrid); overview.appendChild(rosters)
    var recent = make('section', 'rvb-profile-recent'); addText(recent, 'h3', '', '近期对局'); var recentList = make('div', 'rvb-match-list'); recent.appendChild(recentList); overview.appendChild(recent)
    dialog.appendChild(overview)
    var edit = make('section', 'rvb-profile-panel'); edit.id = 'rvb-profile-panel-edit'; edit.dataset.profilePanel = 'edit'; edit.setAttribute('role', 'tabpanel')
    var form = make('form', 'rvb-profile-edit-form'); form.id = 'rvbPlayerProfileForm'
    var nameLabel = make('label', '', '昵称'); var nameInput = make('input'); nameInput.id = 'rvbPlayerProfileName'; nameInput.name = 'name'; nameInput.required = true; nameInput.maxLength = 24; nameInput.autocomplete = 'nickname'; nameLabel.appendChild(nameInput); form.appendChild(nameLabel)
    addText(form, 'h3', '', '选择头像')
    var picker = make('div', 'rvb-avatar-picker'); picker.id = 'rvbPlayerProfileAvatars'; picker.setAttribute('role', 'listbox'); picker.setAttribute('aria-label', '头像目录'); form.appendChild(picker)
    var editStatus = addText(form, 'p', 'rvb-profile-edit-status', ''); editStatus.setAttribute('role', 'status')
    var save = make('button', 'button primary', '保存资料'); save.type = 'submit'; save.id = 'rvbPlayerProfileSave'; form.appendChild(save)
    edit.appendChild(form); dialog.appendChild(edit)
    var history = make('section', 'rvb-profile-panel'); history.id = 'rvb-profile-panel-history'; history.dataset.profilePanel = 'history'; history.setAttribute('role', 'tabpanel')
    var historyStatus = addText(history, 'p', 'rvb-history-status', ''); historyStatus.id = 'rvbPlayerProfileHistoryStatus'; historyStatus.setAttribute('role', 'status')
    var historyList = make('div', 'rvb-match-list'); historyList.id = 'rvbPlayerProfileHistory'; history.appendChild(historyList)
    var more = make('button', 'button', '加载更多对局'); more.type = 'button'; more.id = 'rvbPlayerProfileHistoryMore'; more.hidden = true; history.appendChild(more)
    dialog.appendChild(history)
    document.body.appendChild(dialog)
    var refs = {
      close: close, avatar: headerAvatar, title: title, id: heading.lastChild, status: status,
      tabs: tabs, panels: { overview: overview, edit: edit, history: history }, metrics: metrics, rosterGrid: rosterGrid,
      recentList: recentList, form: form, nameInput: nameInput, picker: picker, editStatus: editStatus, save: save,
      historyStatus: historyStatus, historyList: historyList, more: more,
    }
    state.dialog = dialog; state.refs = refs
    close.addEventListener('click', function () { closeDialog() })
    dialog.addEventListener('click', function (event) {
      var tab = event.target.closest ? event.target.closest('[data-profile-tab]') : null
      if (tab) { selectTab(tab.dataset.profileTab); return }
      var avatarButton = event.target.closest ? event.target.closest('[data-avatar-character-id]') : null
      if (avatarButton) { selectAvatar(avatarButton.getAttribute('data-avatar-character-id')); return }
    })
    dialog.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeDialog()
    })
    dialog.addEventListener('close', function () { closeDialog(true) })
    form.addEventListener('submit', function (event) { event.preventDefault(); void saveProfile() })
    more.addEventListener('click', function () { void loadHistory(true) })
    return dialog
  }

  function openDialogElement(dialog) {
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else { dialog.open = true; dialog.setAttribute('open', '') }
    } catch {
      dialog.open = true; dialog.setAttribute('open', '')
    }
  }

  function resetDialogContent(loading) {
    if (!state.refs) return
    var refs = state.refs
    clear(refs.metrics)
    clear(refs.rosterGrid)
    clear(refs.recentList)
    clear(refs.picker)
    clear(refs.historyList)
    setAvatarImage(refs.avatar, {}, '')
    setText(refs.title, '玩家资料')
    setText(refs.id, '')
    setText(refs.status, '')
    setText(refs.editStatus, '')
    setText(refs.historyStatus, '')
    refs.nameInput.value = ''
    refs.save.disabled = true
    refs.more.hidden = true
    refs.more.disabled = false
    if (loading) {
      addText(refs.metrics, 'p', 'rvb-muted', '正在读取玩家资料…')
      addText(refs.rosterGrid, 'p', 'rvb-muted', '正在读取常用阵容…')
      addText(refs.recentList, 'p', 'rvb-muted', '正在读取近期对局…')
      setText(refs.historyStatus, '打开“对局历史”后读取')
    }
  }

  function closeDialog(fromNative) {
    if (!state.dialog) return
    if (!fromNative && state.dialog.open) {
      try {
        state.dialog.close()
        return
      } catch {
        state.dialog.open = false
        state.dialog.removeAttribute('open')
      }
    }
    state.epoch += 1; abortRequests(); state.context = null; state.accountId = ''; state.profile = null; state.catalog = null; state.history = []; state.historyCursor = null; state.historyLoaded = false; state.historyLoading = false
    clearCardQueue()
    resetDialogContent(false)
    if (!fromNative && state.dialog.open) { state.dialog.open = false; state.dialog.removeAttribute('open') }
    var focus = state.focused; state.focused = null
    if (focus && typeof focus.focus === 'function') {
      try { focus.focus() } catch {}
    }
  }

  function setStatus(text) { setText(state.refs && state.refs.status, text) }
  function selectTab(name) {
    if (!state.refs || !state.refs.panels[name]) return
    state.refs.tabs.querySelectorAll('[data-profile-tab]').forEach(function (button) {
      var selected = button.dataset.profileTab === name
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1
      button.classList.toggle('is-selected', selected)
    })
    Object.keys(state.refs.panels).forEach(function (key) { state.refs.panels[key].hidden = key !== name })
    if (name === 'edit') renderEditor()
    if (name === 'history' && !state.historyLoaded) void loadHistory(false)
  }

  function renderMetrics(profile) {
    var refs = state.refs; clear(refs.metrics)
    var values = [
      ['总场次', valueAt(profile, ['totalGames', 'games'], 0)],
      ['胜利', valueAt(profile, ['wins'], 0)],
      ['和局', valueAt(profile, ['draws'], 0)],
      ['当前 Elo', profile.season ? valueAt(profile.season, ['rating', 'elo'], '—') : '—'],
    ]
    values.forEach(function (entry) { var item = make('div', 'rvb-profile-metric'); addText(item, 'strong', '', entry[1]); addText(item, 'span', '', entry[0]); refs.metrics.appendChild(item) })
    var season = profile.season || {}
    var seasonText = nameOf(season.name, '')
    if (seasonText) addText(refs.metrics, 'p', 'rvb-profile-season', seasonText + ' · ' + valueAt(season, ['games'], 0) + ' 场 · ' + valueAt(season, ['wins'], 0) + ' 胜')
  }

  function renderRoster(roster, alignment) {
    var card = make('article', 'rvb-roster-card rvb-roster-card--' + alignment)
    addText(card, 'h4', '', alignment === 'light' ? '光方' : '暗方')
    if (!roster || typeof roster !== 'object') { addText(card, 'p', 'rvb-muted', '未记录完整阵容'); return card }
    addText(card, 'p', 'rvb-roster-record', valueAt(roster, ['games'], 0) + ' 场 · ' + valueAt(roster, ['wins'], 0) + ' 胜')
    var pieces = Array.isArray(roster.pieces) ? roster.pieces : []
    var list = make('ul', 'rvb-piece-list')
    if (!pieces.length) addText(card, 'p', 'rvb-muted', '未记录完整阵容')
    pieces.forEach(function (piece) { var item = make('li', 'rvb-piece'); item.appendChild(createAvatar(piece, 'tiny', '')); addText(item, 'span', '', nameOf(piece, '未命名棋子')); list.appendChild(item) })
    if (pieces.length) card.appendChild(list)
    return card
  }

  function renderRosters(profile) {
    clear(state.refs.rosterGrid)
    state.refs.rosterGrid.appendChild(renderRoster(profile.favoriteRosters && profile.favoriteRosters.light, 'light'))
    state.refs.rosterGrid.appendChild(renderRoster(profile.favoriteRosters && profile.favoriteRosters.dark, 'dark'))
  }

  function dateText(value) {
    if (!value) return '时间未记录'
    var date = new Date(value)
    return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString()
  }
  function deltaText(value) {
    return typeof value === 'number' && Number.isFinite(value) ? (value > 0 ? '+' : '') + value : '—'
  }
  function reasonText(value) {
    var raw = nameOf(value, '').trim()
    if (!raw) return '对局结束'
    var key = raw.toLowerCase().replace(/[\s-]+/g, '_')
    var labels = {
      surrender: '投降',
      surrendered: '投降',
      resign: '投降',
      concede: '投降',
      forfeit: '投降',
      core_destroyed: '核心被消灭',
      coredestroyed: '核心被消灭',
      core_eliminated: '核心被消灭',
      core_eliminated_by_opponent: '核心被消灭',
      base_destroyed: '核心被消灭',
      core: '核心被消灭',
      draw: '和局',
      draw_by_agreement: '和局',
      stalemate: '和局',
      timeout: '超时',
      time_out: '超时',
      time_limit: '超时',
      disconnect: '掉线判负',
      disconnect_loss: '掉线判负',
      abandoned: '掉线判负',
    }
    if (labels[key]) return labels[key]
    if (/surrend|resign|conced|forfeit/.test(key)) return '投降'
    if (/core.*(?:destroy|eliminat)|base.*(?:destroy|eliminat)/.test(key)) return '核心被消灭'
    if (/draw|stalemate/.test(key)) return '和局'
    if (/timeout|time_limit/.test(key)) return '超时'
    if (/disconnect|abandon/.test(key)) return '掉线判负'
    return /^[a-z0-9_:.]+$/.test(key) ? '对局结束' : raw
  }
  function ratingText(player) {
    player = player && typeof player === 'object' ? player : {}
    var before = typeof player.ratingBefore === 'number' && Number.isFinite(player.ratingBefore) ? player.ratingBefore : null
    var after = typeof player.ratingAfter === 'number' && Number.isFinite(player.ratingAfter) ? player.ratingAfter : null
    var delta = typeof player.delta === 'number' && Number.isFinite(player.delta) ? player.delta : null
    if (after !== null && delta !== null) return String(after) + '(' + deltaText(delta) + ')'
    if (after !== null) return String(after)
    if (before !== null && delta !== null) return String(before) + '(' + deltaText(delta) + ')'
    if (before !== null) return String(before)
    return delta === null ? '' : deltaText(delta)
  }
  function matchOutcome(match, accountId) {
    if (match && match.status && ['finished', 'complete', 'settled'].indexOf(match.status) === -1) return match.status === 'void' ? '已作废' : '未完成'
    if (!match || !match.winnerId) return '和局'
    return String(match.winnerId) === String(accountId) ? '胜利' : '失败'
  }
  function playerPieces(parent, pieces) {
    if (!Array.isArray(pieces) || !pieces.length) { addText(parent, 'span', 'rvb-muted', '阵容未记录'); return }
    var list = make('span', 'rvb-match-pieces')
    pieces.forEach(function (piece) { var item = make('span', 'rvb-piece-chip'); item.appendChild(createAvatar(piece, 'tiny', '')); addText(item, 'span', '', nameOf(piece, '未命名棋子')); list.appendChild(item) })
    parent.appendChild(list)
  }
  function renderMatch(match, accountId, replayOptions) {
    var article = make('article', 'rvb-match-row')
    var heading = make('header', 'rvb-match-heading')
    var map = match && match.map ? nameOf(match.map.name || match.map.id, '地图未记录') : '地图未记录'
    addText(heading, 'strong', '', map)
    var outcome = addText(heading, 'span', 'rvb-match-outcome', matchOutcome(match, accountId)); outcome.dataset.outcome = matchOutcome(match, accountId)
    article.appendChild(heading)
    addText(article, 'p', 'rvb-match-meta', dateText(match && (match.finishedAt || match.createdAt)) + ' · ' + reasonText(match && match.reason))
    var players = make('div', 'rvb-match-players')
    ;(Array.isArray(match && match.players) ? match.players : []).forEach(function (player) {
      var card = make('div', 'rvb-match-player')
      var name = make('span', 'rvb-match-player-name', nameOf(player, '未知玩家'))
      decoratePlayer(name, Object.assign({}, player, { preserveName: true }))
      card.appendChild(name)
      addText(card, 'span', 'rvb-match-alignment', player.alignment === 'light' ? '光方' : player.alignment === 'dark' ? '暗方' : '阵营未记录')
      playerPieces(card, player.pieces)
      var rating = ratingText(player)
      if (rating) addText(card, 'span', 'rvb-match-delta', 'Elo ' + rating)
      players.appendChild(card)
    })
    if (!players.children.length) addText(players, 'span', 'rvb-muted', '玩家信息未记录')
    article.appendChild(players)
    var actions = make('div', 'rvb-match-actions')
    if (match && match.id && match.replayAvailable === true) {
      var watch = make('button', 'button', '观看回放'); watch.type = 'button'; watch.dataset.replayAction = 'watch'
      var download = make('button', 'button', '下载回放'); download.type = 'button'; download.dataset.replayAction = 'download'
      watch.addEventListener('click', function () { void replayAction(match, 'watch', watch, article, replayOptions) })
      download.addEventListener('click', function () { void replayAction(match, 'download', download, article, replayOptions) })
      actions.appendChild(watch); actions.appendChild(download)
    } else addText(actions, 'span', 'rvb-muted', '回放不可用')
    article.appendChild(actions)
    return article
  }
  function renderMatches(list, matches, accountId, replayOptions) {
    clear(list)
    if (!Array.isArray(matches) || !matches.length) { addText(list, 'p', 'rvb-muted', '暂无已结束对局'); return }
    matches.forEach(function (match) { list.appendChild(renderMatch(match, accountId, replayOptions)) })
  }

  function renderOverview(profile) {
    renderMetrics(profile); renderRosters(profile)
    renderMatches(state.refs.recentList, profile.recentMatches || [], state.accountId)
  }

  function catalogCharacters() {
    return state.catalog && Array.isArray(state.catalog.characters) ? state.catalog.characters : []
  }
  function renderEditor() {
    var refs = state.refs
    if (!state.profile) return
    refs.nameInput.value = nameOf(state.profile.name || state.profile, '')
    refs.save.disabled = !state.catalog
    clear(refs.picker)
    var defaultButton = make('button', 'rvb-avatar-choice', '默认头像'); defaultButton.type = 'button'; defaultButton.dataset.avatarCharacterId = ''; defaultButton.setAttribute('role', 'option'); defaultButton.setAttribute('aria-selected', String(!state.pendingAvatarId)); defaultButton.appendChild(createAvatar({}, 'small', '')); refs.picker.appendChild(defaultButton)
    var characters = catalogCharacters()
    if (!characters.length) addText(refs.picker, 'p', 'rvb-muted', '角色目录暂不可用，请稍后重试')
    characters.forEach(function (character) {
      var button = make('button', 'rvb-avatar-choice'); button.type = 'button'; button.dataset.avatarCharacterId = idOf(character); button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(state.pendingAvatarId === idOf(character))); button.appendChild(createAvatar(character, 'small', '')); addText(button, 'span', '', nameOf(character, '未命名角色')); refs.picker.appendChild(button)
    })
  }
  function selectAvatar(id) {
    state.pendingAvatarId = id || null
    if (state.refs) state.refs.picker.querySelectorAll('[data-avatar-character-id]').forEach(function (button) { button.setAttribute('aria-selected', String((button.getAttribute('data-avatar-character-id') || '') === (state.pendingAvatarId || ''))) })
  }
  function profileFrom(result) { return result && result.profile && typeof result.profile === 'object' ? result.profile : result }
  function renderProfile(profile) {
    var refs = state.refs
    state.profile = profile || {}
    state.pendingAvatarId = idOf(profile && (profile.avatarCharacterId || (profile.avatar && profile.avatar.id))) || null
    var ownProfile = !!(state.context && state.context.account && idOf(state.context.account) === state.accountId)
    refs.tabs.querySelectorAll('[data-profile-tab="edit"]').forEach(function (button) { button.hidden = !ownProfile })
    if (!ownProfile) refs.panels.edit.hidden = true
    setText(refs.title, nameOf(profile, '未知玩家'))
    setText(refs.id, idOf(profile) ? '账号 ID · ' + idOf(profile) : '')
    setAvatarImage(refs.avatar, profile && profile.avatar, nameOf(profile, '玩家头像'))
    renderOverview(profile)
    renderEditor()
  }

  function loadCatalog(context, epoch) {
    return request(context, '/official/players/catalog', {}).then(function (result) {
      if (epoch !== state.epoch || !currentContext(context)) return
      state.catalog = result || {}
      if (state.refs) renderEditor()
    }).catch(function (error) {
      if (epoch === state.epoch) setText(state.refs && state.refs.editStatus, error.message || '角色目录读取失败')
    })
  }

  function loadProfile(context, accountId, epoch) {
    return request(context, '/official/players/' + encodeURIComponent(accountId), {}).then(function (result) {
      if (epoch !== state.epoch || !currentContext(context)) return
      renderProfile(profileFrom(result))
      setStatus('')
    }).catch(function (error) {
      if (epoch !== state.epoch) return
      setStatus(error.message || '玩家资料读取失败')
      if (state.refs) state.refs.save.disabled = true
    })
  }

  function open(accountId, options) {
    options = options || {}
    accountId = idOf(accountId)
    if (!accountId) return Promise.reject(new Error('缺少玩家账号 ID'))
    var dialog = ensureDialog()
    var previousFocus = options.focus === false ? null : document.activeElement
    var context
    try { context = readContext() } catch (error) {
      state.epoch += 1; abortRequests(); clearCardQueue(); state.context = null; state.accountId = ''; state.profile = null; state.catalog = null; state.history = []; state.historyLoading = false
      resetDialogContent(false)
      state.refs.tabs.querySelectorAll('[data-profile-tab="edit"]').forEach(function (button) { button.hidden = true })
      state.refs.panels.edit.hidden = true
      state.focused = previousFocus; openDialogElement(dialog); selectTab('overview'); setStatus(error.message); return Promise.resolve(false)
    }
    state.epoch += 1; abortRequests(); clearCardQueue(); state.context = context; state.accountId = accountId; state.profile = null; state.catalog = null; state.history = []; state.historyCursor = null; state.historyLoaded = false; state.historyLoading = false; state.pendingAvatarId = null; state.focused = previousFocus
    resetDialogContent(true)
    state.refs.tabs.querySelectorAll('[data-profile-tab="edit"]').forEach(function (button) { button.hidden = true })
    state.refs.panels.edit.hidden = true
    openDialogElement(dialog); selectTab('overview'); setText(state.refs.title, '读取玩家资料…'); setText(state.refs.id, '账号 ID · ' + accountId); setStatus('正在读取资料…')
    var epoch = state.epoch
    void loadCatalog(context, epoch)
    return loadProfile(context, accountId, epoch).then(function () { return true })
  }

  function loadHistory(append) {
    if (!state.context || !state.accountId || state.historyLoading) return Promise.resolve()
    var context = state.context; var epoch = state.epoch
    if (append && !state.historyCursor) return Promise.resolve()
    state.historyLoading = true; state.refs.more.disabled = true; setText(state.refs.historyStatus, append ? '正在加载更多对局…' : '正在读取对局历史…')
    var query = append && state.historyCursor ? '?cursor=' + encodeURIComponent(state.historyCursor) : ''
    return request(context, '/official/players/' + encodeURIComponent(state.accountId) + '/history' + query, {}).then(function (result) {
      if (epoch !== state.epoch || !currentContext(context)) return
      var matches = result && Array.isArray(result.matches) ? result.matches : []
      state.history = append ? state.history.concat(matches) : matches
      state.historyCursor = result && result.nextCursor ? String(result.nextCursor) : null
      state.historyLoaded = true
      renderMatches(state.refs.historyList, state.history, state.accountId)
      setText(state.refs.historyStatus, state.history.length ? '' : '暂无已结束对局')
      state.refs.more.hidden = !state.historyCursor; state.refs.more.disabled = false
    }).catch(function (error) {
      if (epoch === state.epoch) { setText(state.refs.historyStatus, error.message || '对局历史读取失败'); state.refs.more.disabled = false }
    }).finally(function () { if (epoch === state.epoch) state.historyLoading = false })
  }

  var historyViews = []
  function resetHistoryView(view) {
    if (!view) return
    clear(view.list)
    setText(view.status, '')
    view.more.hidden = true
    view.more.disabled = false
  }
  function ensureHistoryView(container) {
    var view = container && container.__rvbProfileHistoryView
    if (view && view.status && view.list && view.more && view.status.parentNode === container && view.list.parentNode === container && view.more.parentNode === container) return view
    if (view) abortOwner(view)
    view = {
      accountId: '',
      context: null,
      epoch: 0,
      cursor: null,
      matches: [],
      loaded: false,
      loading: false,
      controllers: [],
      status: null,
      list: null,
      more: null,
    }
    container.__rvbProfileHistoryView = view
    historyViews.push(view)
    clear(container)
    view.status = addText(container, 'p', 'rvb-history-status', '')
    view.status.setAttribute('role', 'status')
    view.list = make('div', 'rvb-match-list')
    view.more = make('button', 'button', '加载更多对局')
    view.more.type = 'button'
    view.more.hidden = true
    container.appendChild(view.status)
    container.appendChild(view.list)
    container.appendChild(view.more)
    view.more.addEventListener('click', function () { void loadHistoryInto(container, view.accountId, { append: true }) })
    return view
  }
  function historyViewCurrent(view, context, epoch) {
    return !!(view && view.epoch === epoch && view.context === context && currentContext(context))
  }
  function loadHistoryInto(container, accountId, options) {
    options = options || {}
    accountId = idOf(accountId)
    if (!container || !accountId) return Promise.resolve(false)
    var view = ensureHistoryView(container)
    var context
    try { context = readContext() } catch (error) {
      abortOwner(view)
      view.epoch += 1; view.context = null; view.accountId = accountId; view.cursor = null; view.matches = []; view.loaded = false; view.loading = false
      resetHistoryView(view); setText(view.status, error.message || '请先登录官方账号')
      return Promise.resolve(false)
    }
    var contextChanged = view.accountId !== accountId || contextKey(view.context) !== contextKey(context)
    if (contextChanged || options.force === true) {
      abortOwner(view)
      view.epoch += 1; view.accountId = accountId; view.context = context; view.cursor = null; view.matches = []; view.loaded = false; view.loading = false
      resetHistoryView(view)
    }
    if (view.loading) return Promise.resolve(false)
    if (options.append && !view.cursor) return Promise.resolve(true)
    if (view.loaded && !options.append && options.force !== true) return Promise.resolve(true)
    var epoch = view.epoch
    view.loading = true
    view.more.disabled = true
    setText(view.status, options.append ? '正在加载更多对局…' : '正在读取对局历史…')
    var query = options.append && view.cursor ? '?cursor=' + encodeURIComponent(view.cursor) : ''
    return request(context, '/official/players/' + encodeURIComponent(accountId) + '/history' + query, {}, view).then(function (result) {
      if (!historyViewCurrent(view, context, epoch)) return false
      var matches = result && Array.isArray(result.matches) ? result.matches : []
      view.matches = options.append ? view.matches.concat(matches) : matches
      view.cursor = result && result.nextCursor ? String(result.nextCursor) : null
      view.loaded = true
      renderMatches(view.list, view.matches, accountId, {
        context: context,
        epoch: epoch,
        owner: view,
        isCurrent: function () { return historyViewCurrent(view, context, epoch) },
      })
      setText(view.status, view.matches.length ? '' : '暂无已结束对局')
      view.more.hidden = !view.cursor
      view.more.disabled = false
      return true
    }).catch(function (error) {
      if (!historyViewCurrent(view, context, epoch)) return false
      setText(view.status, error.message || '对局历史读取失败')
      view.more.hidden = true
      view.more.disabled = false
      return false
    }).finally(function () {
      if (historyViewCurrent(view, context, epoch)) {
        view.loading = false
        view.more.disabled = false
      }
    })
  }

  function persistAccountName(profile, context) {
    if (!global.RvBUtils || typeof global.RvBUtils.saveOfficialSession !== 'function') return
    var session = sessionFor(context.origin)
    if (!session || session.token !== context.token || !session.account) return
    var account = Object.assign({}, session.account, { name: nameOf(profile, session.account.name) })
    global.RvBUtils.saveOfficialSession({ url: context.origin, token: context.token, account: account })
  }

  function saveProfile() {
    if (!state.context || !state.profile || state.refs.save.disabled) return Promise.resolve()
    var name = state.refs.nameInput.value.trim()
    if (!name) { setText(state.refs.editStatus, '请输入昵称'); return Promise.resolve() }
    var context = state.context; var epoch = state.epoch
    state.refs.save.disabled = true; setText(state.refs.editStatus, '正在保存…')
    return request(context, '/official/players/me', { body: { name: name, avatarCharacterId: state.pendingAvatarId || null } }).then(function (result) {
      if (epoch !== state.epoch || !currentContext(context)) return
      var profile = profileFrom(result); persistAccountName(profile, context); ensureCardCache(context); delete cardCache[state.accountId]; renderProfile(profile); setText(state.refs.editStatus, '资料已保存'); setStatus('')
    }).catch(function (error) { if (epoch === state.epoch) setText(state.refs.editStatus, error.message || '资料保存失败') }).finally(function () { if (epoch === state.epoch) state.refs.save.disabled = !state.catalog })
  }

  function replayAction(match, action, button, article, options) {
    options = options || {}
    var context = options.context || state.context
    var epoch = options.epoch === undefined ? state.epoch : options.epoch
    var owner = options.owner || state
    var isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : function () { return epoch === state.epoch && currentContext(context) }
    if (!match || !match.id || !context || !isCurrent()) return Promise.resolve()
    button.disabled = true; setText(article && article.querySelector ? article.querySelector('.rvb-match-actions') : null, '正在读取回放…')
    return request(context, '/official/matches/' + encodeURIComponent(match.id) + '/replay', {}, owner).then(function (result) {
      if (!isCurrent()) return
      var tools = global.RvBDeveloperTools
      if (!tools || typeof tools.assertTraceRecord !== 'function') throw new Error('回放验证工具不可用')
      var trace = tools.assertTraceRecord(result && result.trace ? result.trace : result)
      if (action === 'download') {
        if (typeof tools.downloadTrace !== 'function') throw new Error('回放下载工具不可用')
        tools.downloadTrace(trace); setText(article && article.querySelector ? article.querySelector('.rvb-match-actions') : null, '回放已下载')
      } else {
        if (typeof tools.readActiveBattle === 'function' && tools.readActiveBattle()) throw new Error('检测到进行中的对局，请先完成或离开当前对局')
        if (typeof tools.storeCompletedTrace !== 'function') throw new Error('回放存储工具不可用')
        return Promise.resolve(tools.storeCompletedTrace(trace)).then(function () {
          if (!isCurrent()) return
          global.location.href = 'replay.html'
        })
      }
    }).catch(function (error) { if (isCurrent()) setText(article && article.querySelector ? article.querySelector('.rvb-match-actions') : null, error.message || '回放不可用') }).finally(function () { if (isCurrent()) button.disabled = false })
  }

  function statCount(character, keys) { return valueAt(character, keys, 0) }
  function percent(value, total) { return total > 0 ? (value * 100 / total).toFixed(1) + '%' : '—' }
  function renderStats(container, payload) {
    clear(container)
    var matches = valueAt(payload, ['matches'], 0)
    var playerGames = valueAt(payload, ['playerGames'], 0)
    if (payload && payload.matches && typeof payload.matches === 'object') matches = valueAt(payload.matches, ['total', 'count', 'games'], matches)
    if (payload && payload.playerGames && typeof payload.playerGames === 'object') playerGames = valueAt(payload.playerGames, ['total', 'count', 'games', 'lineups'], playerGames)
    var identity = payload && payload.resourceIdentity && typeof payload.resourceIdentity === 'object' ? payload.resourceIdentity : {}
    var fingerprint = String(identity.authorityContentHash || identity.contentHash || identity.hash || '').trim().slice(0, 8)
    var resourceLabel = '当前资源包' + (fingerprint ? ' · 资源版本 ' + fingerprint : '')
    var note = addText(container, 'p', 'rvb-stats-definition', resourceLabel + ' · 已结算对局 ' + matches + ' 场 / ' + playerGames + ' 套参赛阵容；选择率 = 携带该角色的参赛阵容数 / 参赛阵容总数（本页分母：' + playerGames + ' 套参赛阵容）；胜率 = 获胜携带阵容数 / 携带阵容数；平局单列，并显示样本量。')
    note.dataset.playerGames = String(playerGames)
    var table = make('div', 'rvb-character-stats'); table.setAttribute('role', 'table')
    var header = make('div', 'rvb-character-stat rvb-character-stat--header')
    ;['角色', '携带 / 选择率', '胜', '负', '和', '胜率'].forEach(function (label) { addText(header, 'span', '', label) })
    table.appendChild(header)
    var characters = payload && Array.isArray(payload.characters) ? payload.characters : []
    if (!characters.length) addText(table, 'p', 'rvb-muted', '当前资源还没有已结算样本')
    characters.forEach(function (character) {
      var carried = statCount(character, ['carriedGames', 'lineups', 'appearances', 'games', 'played'])
      var wins = statCount(character, ['wins', 'carriedWins'])
      var draws = statCount(character, ['draws', 'carriedDraws'])
      var losses = statCount(character, ['losses', 'carriedLosses'])
      if (!losses && carried >= wins + draws) losses = carried - wins - draws
      var row = make('div', 'rvb-character-stat'); addText(row, 'span', 'rvb-character-stat-name', nameOf(character, '未命名角色')); addText(row, 'span', '', carried + ' / ' + percent(carried, playerGames)); addText(row, 'span', '', wins); addText(row, 'span', '', losses); addText(row, 'span', '', draws); addText(row, 'span', '', percent(wins, carried)); table.appendChild(row)
    })
    container.appendChild(table)
  }
  function loadCharacterStats(container) {
    if (!container) return Promise.resolve(false)
    var context
    try { context = readContext() } catch (error) { setText(container, error.message); return Promise.resolve(false) }
    var requestId = ++state.statsRequest
    container.setAttribute('aria-busy', 'true'); clear(container); addText(container, 'p', 'rvb-muted', '正在读取角色统计…')
    return request(context, '/official/character-stats', {}).then(function (payload) {
      if (requestId !== state.statsRequest || !currentContext(context)) return false
      renderStats(container, payload || {}); return true
    }).catch(function (error) { if (requestId === state.statsRequest) { clear(container); addText(container, 'p', 'rvb-profile-error', error.message || '角色统计读取失败') }; return false }).finally(function () { if (requestId === state.statsRequest) container.setAttribute('aria-busy', 'false') })
  }

  function invalidateStaleHistoryViews() {
    historyViews.forEach(function (view) {
      if (!view.context || currentContext(view.context)) return
      abortOwner(view)
      view.epoch += 1; view.context = null; view.cursor = null; view.matches = []; view.loaded = false; view.loading = false
      resetHistoryView(view)
      setText(view.status, '登录状态已更改，请重新打开战绩')
    })
  }

  function onStorage(event) {
    invalidateStaleHistoryViews()
    if (!state.dialog || !state.dialog.open) return
    if (!event || !event.key || event.key === 'rvb_official_url' || event.key.indexOf('rvb_official_session:') === 0) {
      if (!currentContext(state.context)) closeDialog()
    }
  }
  function onPresence(event) {
    var detail = event && event.detail
    invalidateStaleHistoryViews()
    if (!detail || !state.context) return
    if (detail.origin === state.context.origin && detail.token === state.context.token && detail.status === 'unauthorized') closeDialog()
  }

  global.RvBPlayerProfile = {
    open: open,
    close: closeDialog,
    decoratePlayer: decoratePlayer,
    bindAvatar: bindAvatar,
    renderIdentity: renderIdentity,
    loadHistoryInto: loadHistoryInto,
    loadCharacterStats: loadCharacterStats,
    localImage: localImage,
  }
  if (global.addEventListener) {
    global.addEventListener('storage', onStorage)
    global.addEventListener('rvb-official-presence', onPresence)
    global.addEventListener('pagehide', function () { closeDialog() }, { once: true })
  }
})(window)
