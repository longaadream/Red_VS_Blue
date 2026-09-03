(function (global) {
  'use strict'

  const STORAGE_KEY = 'rvb_tutorial_first_session_status'

  function saveStatus(storage, scenarioId, status, updatedAt) {
    if (!storage || (status !== 'completed' && status !== 'skipped')) return false
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({
        status: status,
        scenarioId: scenarioId,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
      }))
      return true
    } catch (_) { return false }
  }

  function readStatus(storage) {
    try {
      const saved = JSON.parse(storage && storage.getItem(STORAGE_KEY) || 'null')
      return saved && (saved.status === 'completed' || saved.status === 'skipped') ? saved : null
    } catch (_) { return null }
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text) node.textContent = text
    return node
  }

  function createRuntime(definition, hooks) {
    const controller = global.RvBTutorialController.create(definition)
    const root = createElement('aside', 'tutorial-dialog')
    root.id = 'tutorialDialog'
    root.setAttribute('aria-live', 'polite')
    root.innerHTML = [
      '<div class="tutorial-dialog__topline">',
      '  <span class="tutorial-dialog__session"></span>',
      '  <span class="tutorial-dialog__progress"></span>',
      '  <button type="button" class="tutorial-dialog__skip">跳过教学</button>',
      '</div>',
      '<div class="tutorial-dialog__scene"></div>',
      '<div class="tutorial-dialog__speaker"></div>',
      '<p class="tutorial-dialog__text"></p>',
      '<div class="tutorial-dialog__objective"><span>当前目标</span><strong></strong></div>',
      '<div class="tutorial-dialog__actions"></div>',
    ].join('')
    document.body.appendChild(root)

    const session = root.querySelector('.tutorial-dialog__session')
    const progress = root.querySelector('.tutorial-dialog__progress')
    const scene = root.querySelector('.tutorial-dialog__scene')
    const speaker = root.querySelector('.tutorial-dialog__speaker')
    const text = root.querySelector('.tutorial-dialog__text')
    const objective = root.querySelector('.tutorial-dialog__objective strong')
    const actions = root.querySelector('.tutorial-dialog__actions')
    const skip = root.querySelector('.tutorial-dialog__skip')
    let busy = false
    let disposed = false

    session.textContent = definition.sessionLabel + ' · ' + definition.englishTitle

    function persist(status) {
      saveStatus(global.localStorage, definition.id, status)
    }

    function applyCue(step) {
      if (!hooks || typeof hooks.setCue !== 'function') return
      if (!step || !step.cue) { hooks.setCue(null); return }
      const cue = global.RvBTutorialScenario.resolveCellCue(hooks.getState(), definition, step.cue)
      hooks.setCue(cue)
    }

    function button(label, modifier, onClick) {
      const node = createElement('button', 'tutorial-dialog__button ' + (modifier || ''), label)
      node.type = 'button'
      node.disabled = busy
      node.addEventListener('click', onClick)
      actions.appendChild(node)
    }

    function render() {
      if (disposed) return
      const snapshot = controller.snapshot()
      const step = snapshot.step
      if (!step || snapshot.status !== 'active') return
      root.hidden = false
      root.classList.toggle('is-busy', busy)
      progress.textContent = '场景 ' + step.scene + ' / 4'
      scene.textContent = step.sceneTitle
      speaker.textContent = step.speaker
      text.textContent = busy ? '对面正在掷骰子，先别抢。' : step.text
      objective.textContent = busy ? '等待 DM 结算对方行动' : step.objective
      actions.innerHTML = ''
      if (step.advance.type === 'continue') {
        button('继续', 'is-primary', function () { accept({ type: 'continue' }) })
      } else if (step.advance.type === 'complete') {
        button('结束教学', 'is-primary', function () { finish(false) })
        button('留在棋盘练练', '', function () { finish(true) })
      }
      if (step.advance.type === 'history-item' && hooks && typeof hooks.showActionHistory === 'function') {
        hooks.showActionHistory()
      }
      applyCue(step)
    }

    async function afterAdvance(result) {
      const id = result && result.completedStep && result.completedStep.id
      if (id && hooks && typeof hooks.onStepCompleted === 'function') {
        await hooks.onStepCompleted(id)
      }
      render()
      if (id === 'end-player-turn-one' || id === 'end-player-turn-two') {
        busy = true
        render()
        try {
          await hooks.runOpponentResponse(id === 'end-player-turn-one' ? 'shield-check' : 'cover-check')
        } finally {
          busy = false
          render()
        }
      }
    }

    function accept(event, state) {
      if (busy) return { accepted: false }
      const result = controller.accept(event, state || hooks.getState())
      if (result.accepted) void afterAdvance(result)
      return result
    }

    function finish(stay) {
      const result = controller.finish()
      if (!result.accepted) return
      persist('completed')
      hooks.setCue(null)
      root.hidden = true
      if (stay) {
        hooks.setMessage('教学完成。现在是自由练习时间，社长暂时闭麦。')
      } else {
        hooks.exitTutorial()
      }
    }

    skip.addEventListener('click', function () {
      controller.skip()
      persist('skipped')
      hooks.setCue(null)
      hooks.exitTutorial()
    })

    const historyDock = document.getElementById('actionHistoryDock')

    function onHistoryClick(event) {
      if (busy || controller.snapshot().step?.advance.type !== 'history-item') return
      const target = event.target && event.target.closest
        ? event.target.closest('[data-history-root-id], .action-history-entry, .action-history-item')
        : null
      if (!target) return
      const expectedLabel = controller.snapshot().step?.advance.labelIncludes
      const actualLabel = String(target.getAttribute('aria-label') || target.textContent || '')
      if (expectedLabel && !actualLabel.includes(expectedLabel)) {
        hooks.setMessage('这条不是 DM 指的记录，再找找“' + expectedLabel + '”。')
        return
      }
      accept({ type: 'history-item', label: actualLabel })
    }
    if (historyDock) historyDock.addEventListener('click', onHistoryClick)

    render()
    return Object.freeze({
      beforeAction: function (action, state) {
        if (busy) return { allowed: false, message: '对面正在结算，等这颗骰子停下来。' }
        return controller.beforeAction(action, state)
      },
      afterAcceptedAction: function (action, previousState) {
        return accept({ type: 'action', action: action }, previousState)
      },
      afterIntent: function (intent) { return accept({ type: 'intent', intent: intent }) },
      setBusy: function (next) { busy = !!next; render() },
      snapshot: controller.snapshot,
      dispose: function () {
        disposed = true
        if (historyDock) historyDock.removeEventListener('click', onHistoryClick)
        hooks.setCue(null)
        root.remove()
      },
    })
  }

  global.RvBTutorialRuntime = Object.freeze({
    create: createRuntime,
    storageKey: STORAGE_KEY,
    saveStatus: saveStatus,
    readStatus: readStatus,
  })
})(typeof window !== 'undefined' ? window : globalThis)
