(function () {
  'use strict'

  const state = { client: null, snapshot: null, frame: null, frameToken: 0, pendingView: 0 }
  const byId = id => document.getElementById(id)
  const text = (element, value) => { if (element) element.textContent = value == null ? '' : String(value) }
  const typeLabels = { battle: '战斗', boss: '首领', event: '事件', shop: '商店' }
  const progress = { timer: 0, entryUntil: 0, pointerInside: false, keyboardInside: false, key: null }

  function setProgressOpen(open) {
    byId('progressOverlay').classList.toggle('is-open', open)
    byId('progressPanel').inert = !open
    byId('progressPanel').setAttribute('aria-hidden', String(!open))
    byId('progressToggle').setAttribute('aria-expanded', String(open))
    byId('progressToggle').setAttribute('aria-label', open ? '收起路线进度' : '展开路线进度')
  }

  function scheduleProgressClose(delay) {
    clearTimeout(progress.timer)
    progress.timer = setTimeout(() => {
      if (!progress.pointerInside && !progress.keyboardInside) setProgressOpen(false)
    }, Math.max(delay, progress.entryUntil - Date.now()))
  }

  function updateProgressEntry(route) {
    if (route.phase === 'battle') {
      clearTimeout(progress.timer)
      progress.key = null
      progress.entryUntil = 0
      progress.pointerInside = false
      progress.keyboardInside = false
      setProgressOpen(false)
      return
    }
    const key = [route.seed, route.chapterIndex, route.nodeIndex, route.phase].join(':')
    if (progress.key === key) return
    progress.key = key
    progress.entryUntil = Date.now() + 5000
    setProgressOpen(true)
    scheduleProgressClose(5000)
  }

  function setStatus(message, error) {
    const status = byId('routeStatus')
    text(status, message)
    if (status) status.dataset.error = error ? '1' : ''
  }

  function resourceFile(directory, id) {
    return state.client?.files?.['data/' + directory + '/' + id + '.json'] || null
  }


  function renderProgress(route) {
    const root = byId('routeProgress')
    root.replaceChildren()
    if (!route) return
    const currentChapter = route.chapterIndex || 0
    const nodes = route.nodes || []
    nodes.forEach((node, index) => {
      const item = document.createElement('div')
      const isCurrent = index === route.nodeIndex
      const isDone = index < route.nodeIndex || (route.phase === 'result' && index === route.nodeIndex && route.lastResult?.outcome === 'victory')
      item.className = 'progress-node' + (isCurrent ? ' current' : '') + (isDone ? ' done' : '')
      item.setAttribute('role', 'listitem')
      item.title = node.name || node.id || ('节点 ' + (index + 1))
      item.textContent = String(index + 1)
      const small = document.createElement('small')
      small.textContent = typeLabels[node.type] || node.type || '节点'
      item.appendChild(small)
      root.appendChild(item)
    })
    text(byId('chapterLabel'), (route.chapterName || ('第 ' + (currentChapter + 1) + ' 章')) + ' · ' + (currentChapter + 1) + '/' + (route.chapterCount || 3))
  }

  function pieceTemplate(piece) {
    return piece?.templateId ? resourceFile('pieces', piece.templateId) : null
  }

  function openDetail(title, body, skills) {
    const root = byId('detailContent')
    root.replaceChildren()
    const heading = document.createElement('h3'); heading.textContent = title; root.appendChild(heading)
    const copy = document.createElement('p'); copy.textContent = body || '暂无详细说明。'; root.appendChild(copy)
    if (Array.isArray(skills) && skills.length) {
      const list = document.createElement('div')
      skills.forEach(skill => {
        const item = document.createElement('p')
        const name = document.createElement('strong')
        name.textContent = skill.name || skill.id || '技能'
        item.append(name, document.createTextNode('：' + (skill.description || '暂无描述')))
        list.appendChild(item)
      })
      root.appendChild(list)
    }
    const dialog = byId('detailDialog')
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
  }

  function renderParty(route) {
    const root = byId('partyCards')
    root.replaceChildren()
    const party = Array.isArray(route?.party) ? route.party : []
    text(byId('partyCount'), party.length + ' 人')
    party.forEach(piece => {
      const template = pieceTemplate(piece) || {}
      const card = document.createElement('article'); card.className = 'party-card'
      const avatar = document.createElement('div'); avatar.className = 'party-avatar'
      const image = template.image || template.imagePath || piece.image
      if (image) {
        const img = document.createElement('img')
        img.src = image.startsWith('/') || image.startsWith('.') || image.includes('/') ? image : 'images/adventure/' + image
        img.alt = ''
        img.onerror = () => { avatar.textContent = (piece.name || template.name || '?').slice(0, 1) }
        avatar.appendChild(img)
      } else avatar.textContent = (piece.name || template.name || '?').slice(0, 1)
      const copy = document.createElement('div')
      const name = document.createElement('div'); name.className = 'party-name'; name.textContent = piece.name || template.name || piece.templateId || '队员'
      const hp = document.createElement('div'); hp.className = 'party-meta'
      hp.textContent = '生命 ' + (piece.currentHp ?? '—') + '/' + (piece.maxHp ?? '—')
      const stats = document.createElement('div'); stats.className = 'party-meta'
      stats.textContent = '攻击 ' + (piece.attack ?? template.attack ?? '—') + ' · 防御 ' + (piece.defense ?? template.defense ?? '—') + ' · 移动 ' + (piece.moveRange ?? template.moveRange ?? template.movement ?? '—')
      copy.append(name, hp, stats)
      const details = document.createElement('button'); details.className = 'detail-link'; details.type = 'button'; details.textContent = '资料'
      const skills = (piece.skills || template.skills || []).map(skill => {
        const id = typeof skill === 'string' ? skill : skill?.skillId || skill?.id
        const def = id ? resourceFile('skills', id) : null
        return { id, name: def?.name || id, description: def?.description || '' }
      })
      details.addEventListener('click', () => openDetail(name.textContent, '生命 ' + (piece.currentHp ?? '—') + '/' + (piece.maxHp ?? '—') + ' · 攻击 ' + (piece.attack ?? template.attack ?? '—') + ' · 防御 ' + (piece.defense ?? template.defense ?? '—') + ' · 移动 ' + (piece.moveRange ?? template.moveRange ?? template.movement ?? '—') + '\n\n' + (template.description || '查看角色的当前资料与技能。'), skills))
      card.append(avatar, copy, details)
      root.appendChild(card)
    })
    if (!party.length) {
      const empty = document.createElement('p'); empty.className = 'party-meta'; empty.textContent = '队伍资料将在路线开始后显示。'; root.appendChild(empty)
    }
  }

  function renderBackpack(route, growth) {
    const cards = Array.isArray(route?.cards) ? route.cards : []
    const relics = Array.isArray(route?.relics) ? route.relics : []
    text(byId('coinsValue'), route?.coins ?? '—')
    text(byId('backpackSummary'), '卡牌 ' + cards.length + ' · 遗物 ' + relics.length)
    const root = byId('backpackDetails'); root.replaceChildren()
    cards.forEach(card => {
      const definition = resourceFile('cards', card.cardId || card.id) || {}
      const item = document.createElement('div'); item.className = 'backpack-item'
      const name = document.createElement('strong'); name.textContent = definition.name || card.name || card.cardId || '卡牌'
      const desc = document.createElement('p'); desc.textContent = definition.description || card.description || '暂无描述。'
      item.append(name, desc)
      const carriedGrowth = growth?.[card.cardId || card.id]
      if (Number.isFinite(carriedGrowth) && carriedGrowth !== 0) {
        const note = document.createElement('p')
        note.textContent = '本次冒险同名牌成长：' + (carriedGrowth > 0 ? '+' : '') + carriedGrowth
        item.appendChild(note)
      }
      root.appendChild(item)
    })
    relics.forEach(relic => {
      const item = document.createElement('div'); item.className = 'backpack-item'
      const name = document.createElement('strong'); name.textContent = relic.name || relic.id || '遗物'
      const desc = document.createElement('p'); desc.textContent = relic.description || '暂无描述。'
      item.append(name, desc); root.appendChild(item)
    })
    if (!cards.length && !relics.length) {
      const empty = document.createElement('p'); empty.className = 'party-meta'; empty.textContent = '背包暂时为空。'; root.appendChild(empty)
    }
  }

  function actionButton(label, handler, secondary) {
    const button = document.createElement('button')
    button.type = 'button'; button.className = secondary ? 'secondary-button' : 'primary-button'; button.textContent = label
    button.addEventListener('click', handler)
    return button
  }

  async function routeRequest(type, payload) {
    if (!state.client) return
    setStatus('正在更新路线…')
    try {
      const result = await state.client.request(type, payload)
      render(result)
    } catch (error) {
      setStatus(error.message || '路线操作失败', true)
    }
  }

  function renderNode(route, revision) {
    const node = route?.nodes?.[route.nodeIndex]
    const type = node?.type || 'event'
    text(byId('nodeBadge'), '节点 ' + ((route?.nodeIndex ?? 0) + 1))
    text(byId('nodeType'), typeLabels[type] || type)
    text(byId('nodeTitle'), node?.name || '固定路线')
    let description = '继续前进。'
    if (route?.phase === 'won') {
      text(byId('nodeType'), '通关')
      text(byId('nodeTitle'), '三幕路线已完成')
      description = '你已击败全部章节首领。可以用当前种子再来一局。'
    } else if (route?.phase === 'battle') description = '战斗正在进行，使用原生战斗界面完成这一关。'
    else if (route?.phase === 'result') description = route.lastResult?.outcome === 'victory' ? '战斗胜利，处理完本节点后继续。' : '本节点未能取胜，路线不能继续。'
    else if (type === 'event') description = '事件内容仍在整理，本版本提供继续占位。'
    else if (type === 'shop') description = '商店内容仍在整理，本版本提供继续占位。'
    text(byId('nodeDescription'), description)
    const actions = byId('nodeAction'); actions.replaceChildren()
    if (route?.phase === 'between' && (type === 'battle' || type === 'boss')) {
      actions.appendChild(actionButton('进入战斗', () => routeRequest('enter', { revision })))
    } else if (route?.phase === 'between') {
      actions.appendChild(actionButton('继续', () => routeRequest('continue', { revision })))
    } else if (route?.phase === 'result' && route.lastResult?.outcome === 'victory') {
      actions.appendChild(actionButton('继续路线', () => routeRequest('continue', { revision })))
    } else if (route?.phase === 'result' || route?.phase === 'lost' || route?.phase === 'won') {
      const title = route.phase === 'won' ? '再来一局' : '重新开始'
      actions.appendChild(actionButton(title, () => {
        const seed = route.seed
        routeRequest('restart', { seed })
      }))
    }
  }

  function scheduleView(phase) {
    const token = ++state.frameToken
    clearTimeout(state.pendingView)
    state.pendingView = setTimeout(() => {
      if (token !== state.frameToken) return
      const battle = phase === 'battle'
      byId('routeShell').hidden = battle
      byId('battleView').hidden = !battle
      if (battle) {
        if (!state.frame) {
          state.frame = byId('battleFrame')
          state.frame.src = 'battle.html?mode=adventure&fixedRoute=1'
        }
      } else if (state.frame) {
        state.frame.src = 'about:blank'
        state.frame = null
      }
      if (state.snapshot?.route) updateProgressEntry(state.snapshot.route)
    }, 40)
  }

  function render(snapshot) {
    if (!snapshot || !snapshot.route) return
    state.snapshot = snapshot
    const route = snapshot.route
    renderProgress(route); renderParty(route)
    renderBackpack(route, snapshot.world?.cardProgress?.players?.[snapshot.humanPlayerId]?.growth)
    renderNode(route, snapshot.revision)
    scheduleView(route.phase)
    if (route.phase === 'battle') setStatus('战斗中：请在原生战斗界面完成行动。')
    else if (route.phase === 'won') setStatus('三幕路线已完成。')
    else if (route.phase === 'lost') setStatus('路线结束，可以使用当前种子重新开始。')
    else setStatus(route.lastResult?.outcome === 'defeat' || route.lastResult?.outcome === 'draw' ? '本节点未胜，不能推进路线。' : '请选择当前节点。')
  }

  function installHost() {
    window.RvBPveRouteHost = {
      createBattleClient() {
        if (!state.client) throw new Error('固定路线 Worker 尚未准备好')
        let detached = false
        return {
          files: state.client.files,
          request(type, payload = {}) {
            if (detached) return Promise.reject(new Error('战斗客户端已退出'))
            const forwardedType = type === 'start' ? 'snapshot' : type
            return state.client.request(forwardedType, forwardedType === 'snapshot' ? {} : payload)
          },
          dispose() { detached = true },
        }
      },
    }
  }

  async function start() {
    byId('retryButton').hidden = true
    byId('loadingPanel').hidden = false
    byId('loadingPanel').querySelector('.spinner').hidden = false
    text(byId('loadingMessage'), '正在加载资源与路线引擎…')
    try {
      state.client = await window.RvBPveRouteClient.create()
      state.client.onSnapshot(render)
      installHost()
      const query = new URLSearchParams(location.search)
      const seedText = query.get('seed')
      const seed = seedText !== null && /^\d+$/.test(seedText) ? Number(seedText) : undefined
      const snapshot = await state.client.request('start', seed === undefined ? {} : { seed })
      byId('loadingPanel').hidden = true
      render(snapshot)
    } catch (error) {
      byId('loadingPanel').hidden = false
      byId('loadingPanel').querySelector('.spinner').hidden = true
      text(byId('loadingMessage'), error.message || '固定路线初始化失败。')
      byId('retryButton').hidden = false
      byId('retryButton').onclick = () => { state.client?.dispose(); state.client = null; start() }
      setStatus(error.message || '固定路线初始化失败', true)
    }
  }

  const progressOverlay = byId('progressOverlay')
  progressOverlay.addEventListener('pointerenter', () => {
    progress.pointerInside = true
    clearTimeout(progress.timer)
    setProgressOpen(true)
  })
  progressOverlay.addEventListener('pointerleave', () => {
    progress.pointerInside = false
    scheduleProgressClose(1000)
  })
  progressOverlay.addEventListener('focusin', event => {
    if (!event.target.matches(':focus-visible')) return
    progress.keyboardInside = true
    clearTimeout(progress.timer)
    setProgressOpen(true)
  })
  progressOverlay.addEventListener('focusout', event => {
    if (progressOverlay.contains(event.relatedTarget)) return
    progress.keyboardInside = false
    scheduleProgressClose(1000)
  })
  byId('progressToggle').addEventListener('click', () => {
    const open = !progressOverlay.classList.contains('is-open')
    clearTimeout(progress.timer)
    progress.entryUntil = 0
    setProgressOpen(open)
    if (open && !progress.pointerInside && !progress.keyboardInside) scheduleProgressClose(5000)
  })
  byId('backpackButton').addEventListener('click', () => {
    const details = byId('backpackDetails')
    const open = details.hidden
    details.hidden = !open
    byId('backpackButton').setAttribute('aria-expanded', String(open))
    text(byId('backpackButton'), open ? '关闭' : '打开')
  })
  byId('detailDialog').addEventListener('click', event => {
    if (event.target === byId('detailDialog')) byId('detailDialog').close()
  })
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && byId('detailDialog').open) byId('detailDialog').close()
  })
  start()
})()
