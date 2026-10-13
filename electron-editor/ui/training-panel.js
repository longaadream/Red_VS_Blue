/* 内容工作台中的嵌入式训练营宿主。
 *
 * The native WebContentsView is positioned over [data-training-canvas]. All
 * game state remains inside battle.html; this panel only sends preview
 * lifecycle commands and displays the read-only trace returned by main.
 */
(() => {
  'use strict'

  const asObject = value => value && typeof value === 'object' ? value : {}
  const errorMessage = error => String(error?.message || error || '未知错误')
    .replace(/^Error invoking remote method '[^']+': Error: /, '')

  function mount(root, options = {}) {
    if (!root) throw new Error('训练营面板缺少挂载节点')
    const api = options.api || window.editorAPI || {}
    let previewId = null
    let previewKind = ''
    let snapshot = null
    let busy = false
    let disposed = false
    let desiredVisible = false
    let operationGeneration = 0
    const previousRuns = []
    let removeUpdateListener = null
    let status = ''
    let statusKind = ''
    let controlSide = 'training-red'

    root.innerHTML = `
      <section class="training-panel" aria-label="训练营试玩">
        <header class="training-panel__header">
          <div>
            <div class="training-panel__eyebrow">训练营预览</div>
            <h2>训练营试玩</h2>
            <p>在编辑器里运行真实规则。应用新的技能草稿后，可从同一初始场景重新开始。</p>
          </div>
          <span class="training-panel__status" data-training-status>未打开</span>
        </header>
        <div class="training-panel__body">
          <div class="training-panel__controls">
            <label>初始行动方
              <select data-training-side>
                <option value="training-red">红方</option>
                <option value="training-blue">蓝方</option>
              </select>
            </label>
            <div class="training-panel__buttons">
              <button type="button" class="training-button training-button--primary" data-training-open>打开已接受版本</button>
              <button type="button" class="training-button" data-training-draft>打开当前草稿</button>
              <button type="button" class="training-button" data-training-retry disabled>应用并重试</button>
              <button type="button" class="training-button" data-training-close disabled>关闭试玩</button>
            </div>
            <div class="training-panel__message" data-training-message role="status" aria-live="polite"></div>
          </div>
          <div class="training-panel__stage" data-training-stage>
            <div class="training-panel__canvas" data-training-canvas>
              <span>打开试玩后，战场会显示在此处。</span>
            </div>
            <aside class="training-panel__trace" aria-label="训练状态">
              <div class="training-panel__trace-title">状态与日志</div>
              <dl>
                <div><dt>版本</dt><dd data-training-hash>—</dd></div>
                <div><dt>随机种子</dt><dd data-training-seed>—</dd></div>
                <div><dt>动作数</dt><dd data-training-action-count>0</dd></div>
                <div><dt>初始状态</dt><dd data-training-initial-hash>—</dd></div>
                <div><dt>当前状态</dt><dd data-training-state-hash>—</dd></div>
              </dl>
              <pre data-training-log>尚无权威动作记录。</pre>
              <div data-training-history></div>
            </aside>
          </div>
        </div>
      </section>`

    const canvas = root.querySelector('[data-training-canvas]')
    const statusNode = root.querySelector('[data-training-status]')
    const messageNode = root.querySelector('[data-training-message]')
    const sideNode = root.querySelector('[data-training-side]')
    const openNode = root.querySelector('[data-training-open]')
    const draftButton = root.querySelector('[data-training-draft]')
    const retryNode = root.querySelector('[data-training-retry]')
    const closeNode = root.querySelector('[data-training-close]')
    const hashNode = root.querySelector('[data-training-hash]')
    const seedNode = root.querySelector('[data-training-seed]')
    const countNode = root.querySelector('[data-training-action-count]')
    const initialHashNode = root.querySelector('[data-training-initial-hash]')
    const stateHashNode = root.querySelector('[data-training-state-hash]')
    const logNode = root.querySelector('[data-training-log]')

    const call = async (name, ...args) => {
      if (typeof options[name] === 'function') return options[name](...args)
      if (typeof api[name] === 'function') return api[name](...args)
      const apiName = {
        openAccepted: 'workbenchTrainingEmbedded',
        openDraft: 'skillTrialEmbedded',
        retry: 'trainingPreviewRetry',
        setBounds: 'trainingPreviewSetBounds',
        setVisible: 'trainingPreviewSetVisible',
        inspect: 'trainingPreviewInspect',
        close: 'trainingPreviewClose',
      }[name]
      if (apiName && typeof api[apiName] === 'function') return api[apiName](...args)
      throw new Error('训练营尚未连接到编辑器，请重新打开工作台。')
    }

    const renderStatus = () => {
      statusNode.textContent = previewId ? (previewKind === 'draft' ? '草稿试玩中' : '已接受版本试玩中') : '未打开'
      statusNode.classList.toggle('is-active', Boolean(previewId))
      statusNode.classList.toggle('is-error', statusKind === 'error')
      messageNode.textContent = status
      messageNode.className = `training-panel__message${statusKind ? ` is-${statusKind}` : ''}`
      retryNode.disabled = busy || !previewId
      closeNode.disabled = busy || !previewId
      openNode.disabled = busy
      draftButton.disabled = busy
      sideNode.disabled = busy || Boolean(previewId)
    }

    const setStatus = (message, kind = '') => {
      status = message || ''
      statusKind = kind
      renderStatus()
    }

    const getLaunchOptions = async () => {
      const supplied = typeof options.getLaunchOptions === 'function'
        ? asObject(await options.getLaunchOptions())
        : {}
      const setupConfig = Object.assign({}, asObject(supplied.setupConfig), { firstPlayerId: controlSide })
      return Object.assign({}, supplied, { setupConfig })
    }

    const getDraftRequest = async () => {
      if (typeof options.getDraftRequest !== 'function') throw new Error('当前技能草稿接口尚未接入')
      const request = await options.getDraftRequest()
      if (!request || typeof request !== 'object') throw new Error('当前技能草稿不可用')
      return request
    }

    const inspect = async () => {
      if (disposed || !previewId) return
      const generation = operationGeneration
      try {
        const value = await call('inspect', previewId)
        if (!value || disposed || generation !== operationGeneration || previewId !== value.previewId) return
        snapshot = value
        hashNode.textContent = String(value.contentHash || '—').slice(0, 16)
        seedNode.textContent = value.rootSeed == null ? '—' : String(value.rootSeed)
        countNode.textContent = String(value.actionCount ?? (Array.isArray(value.actionLog) ? value.actionLog.length : 0))
        initialHashNode.textContent = String(value.initialStateHash || '—').slice(0, 16)
        stateHashNode.textContent = String(value.stateHash || '—').slice(0, 16)
        const actionLabels = {
          initializeBattle: '初始化战场', beginPhase: '开始阶段', endTurn: '结束回合', move: '移动',
          attack: '攻击', useSkill: '使用技能', playCard: '使用卡牌',
          useBasicSkill: '使用基础技能', useUltimateSkill: '使用终极技能',
          useActiveSkill: '使用主动技能', useCard: '使用手牌',
          deployReservePiece: '部署棋子', pendingTargetSelect: '选择目标',
          pendingOptionSelect: '确认选项', pendingHandCardSelect: '选择手牌',
          confirmPendingTarget: '确认目标', chooseOption: '选择选项', pass: '跳过',
        }
        const playerLabels = { 'training-red': '红方', 'training-blue': '蓝方', system: '系统' }
        const shortHash = hash => String(hash || '—').slice(0, 12)
        const actionLine = entry => {
          const type = entry?.command?.type || entry?.action?.type || entry?.type || '动作'
          const player = playerLabels[entry?.playerId] || '未知执行者'
          const seed = entry?.rootSeed == null ? '—' : entry.rootSeed
          return `动作 ${entry?.index == null ? '—' : entry.index} · ${actionLabels[type] || '未知动作'} · ${player} · 种子 ${seed} · ${shortHash(entry?.preStateHash)} → ${shortHash(entry?.postStateHash)}`
        }
        const setupLine = entry => {
          const labels = { updateResources: '调整资源', removePiece: '移除棋子', resetCooldowns: '重置冷却', addPiece: '添加棋子' }
          const input = entry?.input || {}
          const player = playerLabels[input.playerId] || '指定方'
          const detail = entry?.type === 'updateResources'
            ? `${player}行动点 ${input.actionPoints == null ? '—' : input.actionPoints}、充能点 ${input.chargePoints == null ? '—' : input.chargePoints}`
            : entry?.type === 'addPiece' ? '添加棋子到指定格' : ''
          return `${entry?.initial === false ? '本次临时调整' : '初始场景'} · ${labels[entry?.type] || '场景设置'}${detail ? `（${detail}）` : ''} · ${shortHash(entry?.beforeHash)} → ${shortHash(entry?.afterHash)}`
        }
        const lines = (Array.isArray(value.actionLog) ? value.actionLog.slice(-8).map(actionLine) : [])
          .concat(Array.isArray(value.setupLog) ? value.setupLog.slice(-4).map(setupLine) : [])
        logNode.textContent = lines.length ? lines.join('\n') : '尚无权威动作记录。'
      } catch (error) {
        setStatus(errorMessage(error), 'error')
      }
    }

    const observeCanvas = async () => {
      if (!previewId || disposed || !canvas) return
      const rect = canvas.getBoundingClientRect()
      const bounds = {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      }
      await call('setBounds', previewId, bounds).catch(error => setStatus(errorMessage(error), 'error'))
    }

    const openPreview = async kind => {
      if (busy || disposed) throw new Error('训练营正在处理上一项操作，请稍后重试。')
      const generation = ++operationGeneration
      busy = true
      renderStatus()
      try {
        const previousId = previewId
        const launchOptions = await getLaunchOptions()
        const result = kind === 'draft'
          ? await call('openDraft', await getDraftRequest(), launchOptions)
          : await call('openAccepted', launchOptions)
        if (!result?.previewId) throw new Error('训练营没有成功创建试玩。')
        if (disposed || generation !== operationGeneration) { await call('close', result.previewId); throw new Error('本次打开已取消。') }
        previewId = result.previewId
        previewKind = kind
        snapshot = result || null
        if (previousId) await call('close', previousId)
        await observeCanvas()
        await call('setVisible', previewId, desiredVisible)
        setStatus('已打开真实规则训练场')
        observeCanvas()
        void inspect()
        return result
      } catch (error) {
        setStatus(errorMessage(error), 'error')
        throw error
      } finally {
        busy = false
        renderStatus()
      }
    }

    const retryPreview = async () => {
      if (!previewId || busy || disposed) return
      const generation = ++operationGeneration
      busy = true
      renderStatus()
      try {
        const request = previewKind === 'draft' ? await getDraftRequest() : null
        const previous = { snapshot, log:logNode.textContent }
        const result = await call('retry', previewId, request)
        if (disposed || generation !== operationGeneration) { if (result?.previewId) await call('close', result.previewId); return }
        if (result?.previewId) previewId = result.previewId
        previousRuns.push(previous)
        const history = root.querySelector('[data-training-history]')
        const entry = document.createElement('details'), title = document.createElement('summary'), log = document.createElement('pre')
        title.textContent = `上次试玩 ${previousRuns.length} · ${previous.snapshot?.actionCount || 0} 个动作`
        log.textContent = previous.log
        entry.append(title, log); history.prepend(entry)
        snapshot = result || snapshot
        await observeCanvas()
        await call('setVisible', previewId, desiredVisible)
        setStatus('已应用新快照，并从相同初始场景重试')
        observeCanvas()
        void inspect()
        return result
      } catch (error) {
        setStatus(errorMessage(error), 'error')
      } finally {
        busy = false
        renderStatus()
      }
    }

    const closePreview = async () => {
      operationGeneration += 1
      if (!previewId) return
      busy = true
      renderStatus()
      const id = previewId
      try {
        await call('close', id)
        previewId = null
        previewKind = ''
        snapshot = null
        setStatus('试玩已关闭')
        hashNode.textContent = '—'; seedNode.textContent = '—'; countNode.textContent = '0'
        initialHashNode.textContent = '—'; stateHashNode.textContent = '—'; logNode.textContent = '尚无权威动作记录。'
      } catch (error) {
        setStatus(errorMessage(error), 'error')
      } finally {
        busy = false
        renderStatus()
      }
    }

    sideNode.addEventListener('change', () => {
      controlSide = sideNode.value === 'training-blue' ? 'training-blue' : 'training-red'
      if (typeof options.onControlSideChange === 'function') options.onControlSideChange(controlSide)
    })
    openNode.addEventListener('click', () => { void openPreview('accepted').catch(() => { /* shown in the panel */ }) })
    draftButton.addEventListener('click', () => { void openPreview('draft').catch(() => { /* shown in the panel */ }) })
    retryNode.addEventListener('click', () => { void retryPreview() })
    closeNode.addEventListener('click', () => { void closePreview() })
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(observeCanvas)
      observer.observe(canvas)
      options._trainingPanelObserver = observer
    } else window.addEventListener('resize', observeCanvas)
    const updated = options.onUpdated || api.onTrainingPreviewUpdated
    if (typeof updated === 'function') {
      removeUpdateListener = updated(value => {
        if (!disposed && previewId && (!value || value.previewId === previewId)) void inspect()
      })
    }
    renderStatus()

    return {
      open: openPreview,
      retry: retryPreview,
      close: closePreview,
      setVisible: async visible => {
        desiredVisible = visible === true
        if (!previewId) return false
        await call('setVisible', previewId, desiredVisible)
        if (visible === true) observeCanvas()
        return true
      },
      inspect,
      getPreviewId: () => previewId,
      getPreviousRuns: () => previousRuns.slice(),
      dispose: () => {
        disposed = true
        operationGeneration += 1
        if (removeUpdateListener) removeUpdateListener()
        if (options._trainingPanelObserver) options._trainingPanelObserver.disconnect()
        else window.removeEventListener('resize', observeCanvas)
        if (previewId) void call('close', previewId).catch(() => {})
      },
    }
  }

  window.TrainingPanel = Object.freeze({ mount })
})()
