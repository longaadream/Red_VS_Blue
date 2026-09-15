(function (global) {
  'use strict'
  function create(lesson, hooks) {
    const root = document.createElement('aside')
    root.className = 'tutorial-dialog'
    root.id = 'tutorialLessonDialog'
    root.setAttribute('aria-label', '社长的教学提示')
    root.setAttribute('tabindex', '0')
    const title = document.createElement('h2')
    title.className = 'tutorial-dialog__scene'
    title.textContent = '第 ' + lesson.number + ' 局 · ' + lesson.title
    const header = document.createElement('div')
    header.className = 'tutorial-dialog__header'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'tutorial-dialog__toggle'
    toggle.textContent = '说明'
    toggle.setAttribute('aria-expanded', 'false')
    toggle.setAttribute('aria-label', '展开教程说明')
    let collapsed = true
    toggle.addEventListener('click', function () {
      collapsed = !collapsed
      root.classList.toggle('is-collapsed', collapsed)
      toggle.textContent = collapsed ? '说明' : '收起'
      toggle.setAttribute('aria-expanded', String(!collapsed))
      toggle.setAttribute('aria-label', collapsed ? '展开教程提示' : '收起教程提示')
      root.scrollTop = 0
    })
    header.append(title, toggle)
    const text = document.createElement('p')
    text.className = 'tutorial-dialog__text'
    text.setAttribute('aria-live', 'polite')
    const objective = document.createElement('p')
    objective.className = 'tutorial-dialog__objective'
    const actions = document.createElement('div')
    actions.className = 'tutorial-dialog__actions'
    root.append(header, text, objective, actions)
    document.body.appendChild(root)
    const bubble = document.createElement('div')
    bubble.id = 'tutorialActionBubble'
    bubble.setAttribute('role', 'status')
    document.body.appendChild(bubble)
    const seen = new Set()
    const history = []
    const review = document.createElement('details')
    const reviewLabel = document.createElement('summary')
    reviewLabel.textContent = '本局提示回看'
    const reviewItems = document.createElement('ol')
    review.append(reviewLabel, reviewItems)
    root.appendChild(review)
    let started = false
    let busy = false
    let opponentNote = ''
    let teachingCue = null
    function setTeachingCue(cue) { teachingCue = cue; hooks.setCue(cue) }
    let disposed = false
    let failure = ''
    let message = lesson.intro
    let terminalShown = false
    const opening = lesson.guidedOpening
    let openingStep = opening ? 'welcome' : 'free'
    let openingObjective = ''
    let deployedPieceId = null
    function teaching() { return !!opening && openingStep !== 'free' }
    function openingPiece(enemy) {
      return (hooks.getState().pieces || []).find(function (piece) {
        return piece.templateId === (enemy ? opening.targetTemplateId : opening.templateId)
          && (enemy ? piece.ownerPlayerId !== lesson.player.playerId : piece.ownerPlayerId === lesson.player.playerId)
      })
    }
    function teach(step, copy, goal) {
      openingStep = step; message = copy; openingObjective = goal
      history.push({ key: 'opening-' + step, text: copy })
      const own = openingPiece(false)
      const source = step === 'heal' || step === 'charge' ? (hooks.getState().pieces || []).find(function (p) { return p.templateId === (step === 'heal' ? 'anduin' : 'uther') && p.ownerPlayerId === lesson.player.playerId }) : own
      const target = step === 'attack' ? openingPiece(true) : own
      const skillId = step === 'charge' ? 'divine-blessing' : step === 'heal' ? 'light-of-the-light' : step === 'shield' ? 'shield-of-light' : step === 'attack' ? opening.skillId : null
      const cue = { step: step, cells: [], skillId: skillId }
      if (step === 'charge' && source) cue.cells = [{ x: source.x, y: source.y }]
      if (step === 'move' || step === 'terrain') cue.cells = [opening.moveTo]
      else if (['select', 'heal', 'shield', 'attack'].includes(step) && target) cue.cells = [{ x: target.x, y: target.y }]
      if (step === 'move' && own) cue.path = [{ x: own.x, y: own.y }, opening.moveTo]
      if (skillId && source && target) cue.path = [{ x: source.x, y: source.y }, { x: target.x, y: target.y }]
      setTeachingCue(cue)
      if (skillId && source && hooks.revealPieceSkills) hooks.revealPieceSkills(source.instanceId)
      render()
    }
    function begin() {
      started = true
      if (opening && ['deployment', 'charge', 'full-match'].includes(opening.kind)) {
        teach('deploy', '部署免费。落点须距场上所有棋子超过 5 格（横纵步数相加），只能选择高亮空格。', '选择增援 → 点击高亮落点')
      } else if (opening && opening.kind === 'protection') {
        teach('heal', '先补回生命，再用圣盾挡住下一次伤害。', '① 圣光闪耀 → ② 圣光盾')
      } else if (opening && opening.kind === 'terrain') {
        teach('terrain', '点击掩体查看地形。掩体可站立，阻挡弹射物。', '点击亮起的掩体格')
      } else if (opening) teach('select', '点击乌瑟尔，查看生命与技能。', '第一步：点击乌瑟尔')
      else { message = '接下来由你指挥，需要时点“给点思路”。'; setTeachingCue(null) }
      void pump()
    }
    function openingAllows(action) {
      if (!teaching()) return true
      const piece = openingPiece(false)
      const target = openingPiece(true)
      if (!action || action.playerId !== lesson.player.playerId) return false
      if (['pendingOptionSelect', 'pendingTargetSelect', 'cancelPendingSelection'].includes(action.type)) return true
      if (openingStep === 'deploy') return action.type === 'deployReservePiece'
      if (openingStep === 'move-new') return action.type === 'move'
      if (openingStep === 'card') return action.type === 'playCard'
      if (['fight-crystal', 'collect', 'charge', 'practice-skill'].includes(openingStep)) return true
      if (openingStep === 'heal' || openingStep === 'shield') {
        const source = openingStep === 'heal' ? (hooks.getState().pieces || []).find(function (p) { return p.ownerPlayerId === lesson.player.playerId && p.templateId === 'anduin' }) : piece
        return action.type === 'useBasicSkill' && source && action.pieceId === source.instanceId
          && action.skillId === (openingStep === 'heal' ? 'light-of-the-light' : 'shield-of-light')
          && (!action.targetPieceId || piece && action.targetPieceId === piece.instanceId)
      }
      if (openingStep === 'move') return action.type === 'move' && piece && action.pieceId === piece.instanceId
        && action.toX === opening.moveTo.x && action.toY === opening.moveTo.y
      if (openingStep === 'attack') return action.type === 'useBasicSkill' && piece && action.pieceId === piece.instanceId
        && action.skillId === opening.skillId && (!action.targetPieceId || target && action.targetPieceId === target.instanceId)
      return openingStep === 'end-turn' && action.type === 'endTurn'
    }
    function observeOpening(action, before) {
      if (!teaching() || hooks.getState().terminalResult) return
      const state = hooks.getState()
      const piece = openingPiece(false)
      const own = state.players.find(function (p) { return p.playerId === lesson.player.playerId })
      const crystals = ((state.extensions || {}).tileEffects || []).filter(function (t) { return t.tileType === 'charge-crystal' })
      if (openingStep === 'fight-crystal' && crystals.length) {
        teach('collect', '移动到结晶格，拾取队伍充能。', '选择己方棋子，普通移动到结晶格')
        setTeachingCue({ cells: crystals })
      } else if (openingStep === 'collect' && !crystals.length && action.playerId !== lesson.player.playerId) {
        teach('fight-crystal', '结晶已被对手拿走，继续作战。', '继续作战，观察下一枚结晶')
      }
      if (action.playerId !== lesson.player.playerId) return
      if (openingStep === 'deploy' && action.type === 'deployReservePiece') {
        deployedPieceId = action.pieceId
        teach('deploy-result', '增援已上场，本回合首次普通移动免费。', '先看部署结果，再学习移动')
      } else if (openingStep === 'move-new' && action.type === 'move') {
        const previous = before.players.find(function (p) { return p.playerId === lesson.player.playerId })
        teach('new-move-result', '这次移动实际消耗 ' + (previous.actionPoints - own.actionPoints) + ' 点行动点。接下来学习手牌。', '观察行动点的变化')
      } else if (openingStep === 'card' && action.type === 'playCard') {
        teach('card-result', '卡牌已结算，查看效果与剩余行动点。', '查看手牌和资源变化')
      } else if (openingStep === 'heal' && action.type === 'useBasicSkill' && action.skillId === 'light-of-the-light') {
        const old = before.pieces.find(function (p) { return p.instanceId === piece.instanceId })
        if (piece.currentHp > old.currentHp) teach('heal-result', '乌瑟尔实际恢复了 ' + (piece.currentHp - old.currentHp) + ' 点生命。接下来学习圣盾。', '观察生命变化，再学习圣盾')
      } else if (openingStep === 'shield' && action.type === 'useBasicSkill' && action.skillId === 'shield-of-light') {
        teach('shield-result', '圣盾抵挡一次伤害。圣光盾消耗 2 行动点，对自己施放返还 1 点。', '查看圣盾状态与行动点')
      } else if (openingStep === 'collect' && action.type === 'move' && ((before.extensions || {}).tileEffects || []).some(function (t) { return t.tileType === 'charge-crystal' && t.x === action.toX && t.y === action.toY }) && own.chargePoints > before.players.find(function (p) { return p.playerId === lesson.player.playerId }).chargePoints) {
        teach('collect-result', '已拾取结晶，队伍充能增加。', '观察队伍充能点')
      } else if (openingStep === 'charge' && action.type === 'useChargeSkill') {
        teach('charge-result', '充能技能已结算，查看剩余资源与冷却。', '观察充能技能的实际效果')
      } else if (openingStep === 'practice-skill' && ['useBasicSkill', 'useChargeSkill'].includes(action.type)) {
        teach('attack-result', '技能已结算，查看目标生命、状态和剩余行动点。', '查看本次技能结果')
      } else if (openingStep === 'move' && action.type === 'move' && piece && piece.x === opening.moveTo.x && piece.y === opening.moveTo.y) {
        const previous = before.players.find(function (p) { return p.playerId === lesson.player.playerId })
        teach('move-result', '乌瑟尔已经走到这里。这次移动消耗了 ' + (previous.actionPoints - own.actionPoints) + ' 点行动点，现在剩下 ' + own.actionPoints + ' 点。', '查看行动点变化')
      } else if (openingStep === 'attack' && action.type === 'useBasicSkill' && action.skillId === opening.skillId) {
        const target = openingPiece(true)
        const previous = before.pieces.find(function (p) { return p.templateId === opening.targetTemplateId && p.ownerPlayerId !== lesson.player.playerId })
        const damage = previous ? previous.currentHp - (target ? target.currentHp : 0) : 0
        if (damage > 0) teach('attack-result', '命中了！' + previous.name + '实际减少了 ' + damage + ' 点生命。你还剩 ' + own.actionPoints + ' 点行动点。', '观察敌人生命和技能状态')
      } else if (openingStep === 'end-turn' && action.type === 'endTurn') {
        teach('watch', '观察对手的移动与攻击。', '观察对手行动，等待回合交还')
      }
    }

    function addButton(label, fn, primary) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tutorial-dialog__button' + (primary ? ' is-primary' : '')
      button.textContent = label
      button.addEventListener('click', fn)
      actions.appendChild(button)
    }
    function leave() { dispose(); hooks.exit() }
    function advanceOpeningResult() {
      if (!teaching() || disposed || failure || hooks.getState().terminalResult || hooks.getState().pendingTargetSelection || hooks.getState().pendingOptionSelection) return
      const completedStep = openingStep
      function nextWhen(step, next) {
        if (completedStep === step) next()
      }
      nextWhen('deploy-result', function () {
        teach('move-new', '选中新棋子，移动到高亮格。本回合首次普通移动免费。', '选中棋子，再点击可移动格')
        const piece = hooks.getState().pieces.find(function (p) { return p.instanceId === deployedPieceId })
        if (piece) setTeachingCue({ step: 'move-new', pieceId: piece.instanceId, cells: [{ x: piece.x, y: piece.y }] })
      })
      nextWhen('new-move-result', function () {
        teach('card', '点击“幸运币”查看，再点一次打出。', '点击幸运币查看，再点击打出')
      })
      nextWhen('card-result', function () {
        if (opening.kind === 'charge') teach('fight-crystal', '击败敌方核心，争夺留下的结晶。', '移动、使用技能作战，观察核心阵亡后的地面')
        else if (opening.kind === 'full-match') teach('practice-skill', '选中棋子，使用技能攻击合法目标。', '选棋子 → 查看技能 → 使用技能与合法目标')
        else teachEndTurn()
      })
      nextWhen('heal-result', function () {
        teach('shield', '生命补好了，用乌瑟尔的“圣光盾”保护自己。', '✓ 圣光闪耀 → ② 圣光盾')
      })
      nextWhen('shield-result', teachMove)
      nextWhen('collect-result', function () {
        teach('charge', '点击乌瑟尔的“赐福”，强化所有友军的下次伤害。场上圣盾越多，强化越高。', '乌瑟尔 → 赐福；行动点、充能点都要够')
      })
      nextWhen('charge-result', teachEndTurn)
      nextWhen('move-result', function () {
        const target = openingPiece(true)
        if (openingStep !== 'move-result') return
        teach('attack', '使用“祝福之锤”攻击' + target.name + '：消耗 1 行动点，范围 2 格。', '点击祝福之锤，再点击' + target.name)
      })
      nextWhen('attack-result', teachEndTurn)
    }
    function teachMove() {
      teach('move', opening.kind === 'terrain' ? '选中乌瑟尔，移动到亮起的掩体格。' : '选中乌瑟尔，点击或拖动到亮起的目标格。', '将乌瑟尔移到亮起的目标格')
    }
    function teachEndTurn() {
      teach('end-turn', '行动点从 1 点起，每次自己的新回合上限 +1，最多 10 点，并补满；剩余点数不累积。', '点击右下角“结束回合”，观察下回合行动点')
    }
    function render() {
      if (disposed) return
      const terminal = hooks.getState().terminalResult
      root.classList.toggle('is-busy', busy)
      root.classList.toggle('is-guiding', started && !terminal && !failure)
      root.classList.toggle('is-review', openingStep === 'review')
      root.classList.toggle('is-collapsed', started && collapsed && !terminal && !failure)
      text.textContent = failure || opponentNote || message
      const prompts = {
        deploy: '增援要离所有棋子超过 5 格，包括友军。横着、竖着各算一步；第 6 格才可部署。',
        'move-new': '先点新部署的棋子，再点可移动格；本回合首次移动免费。',
        card: '点幸运币查看，再点一次打出。',
        heal: '点“圣光闪耀”，再点受伤的乌瑟尔。',
        shield: '点“圣光盾”，给乌瑟尔自己加盾。',
        charge: '点乌瑟尔的“赐福”。它消耗行动点和充能点，强化全体友军。',
        'end-turn': '行动点从 1 点起。每次自己的新回合上限 +1，并补满；最多 10 点。',
        review: '行动点已补满。点上方“继续本局练习”，轮到你指挥了。',
        select: '点亮起的棋子，查看它的技能。',
        move: '点亮起的落点，也可以把棋子拖过去。',
        attack: '点箭头标出的技能，再点亮起的敌人。',
        collect: '走到结晶上，就能拾取充能点。',
        'fight-crystal': '击败敌方核心，地上会留下充能结晶。',
      }
      bubble.hidden = !started || busy || !!terminal || !!failure || !prompts[openingStep]
      bubble.textContent = prompts[openingStep] || ''
      bubble.setAttribute('data-step', openingStep)
      objective.textContent = terminal ? '本局已结束' : failure ? '练习中断，可重开或返回课程' : !started ? '点击开始学习' : busy ? '等待对手行动' : teaching() ? openingObjective : '消灭敌方场上核心'
      actions.replaceChildren()
      reviewItems.replaceChildren()
      history.filter(function (notice) { return notice.key !== 'ai-rejected' }).forEach(function (notice) {
        const item = document.createElement('li')
        item.textContent = notice.text
        reviewItems.appendChild(item)
      })
      review.hidden = !reviewItems.children.length
      if (terminal || failure) {
        addButton('再试一次', function () { dispose(); hooks.restart() }, true)
        const nextLesson = global.RvBTutorialLessons.all[lesson.number]
        if (terminal && nextLesson && nextLesson.enabled !== false) addButton('下一局', function () { dispose(); hooks.next() })
      } else if (!started) {
        addButton(opening ? '开始学习' : '开始本局', begin, true)
      } else if (teaching()) {
        if (openingStep === 'review') addButton('继续本局练习', function () {
          if (openingStep !== 'review') return
          openingStep = 'free'; message = '继续作战，消灭敌方场上核心。'; setTeachingCue(null); render()
        }, true)
      } else {
        addButton('给点思路', function () { message = lesson.help; render() })
      }
      addButton('返回课程', leave)
      if (hooks.positionGuide) hooks.positionGuide()
    }
    function observe(action, before) {
      observeOpening(action, before)
      advanceOpeningResult()
      const previousPlayer = before.players && before.players.find(function (p) { return p.playerId === lesson.player.playerId })
      const currentPlayer = hooks.getState().players && hooks.getState().players.find(function (p) { return p.playerId === lesson.player.playerId })
      if (previousPlayer && currentPlayer && currentPlayer.maxActionPoints > previousPlayer.maxActionPoints && hooks.showResourceGrowth) {
        hooks.showResourceGrowth(previousPlayer.maxActionPoints, currentPlayer.maxActionPoints)
      }
      const notices = global.RvBTutorialLessons.observe(lesson, before, hooks.getState(), action, seen)
      notices.forEach(function (notice) { history.push(notice) })
      if (!teaching() && notices.length) message = notices[0].text
      render()
    }
    function showResult() {
      const terminal = hooks.getState().terminalResult
      if (!terminal || disposed || terminalShown) return
      terminalShown = true
      const won = terminal.winnerPlayerId === lesson.player.playerId
      const reasons = { 'core-eliminated': '一方场上核心全灭', 'mutual-core-elimination': '双方场上核心同时全灭', 'round-limit': '达到轮次上限', surrender: '投降', 'timeout-surrender': '超时投降' }
      message = (terminal.winnerPlayerId ? won ? '你赢下了本局。' : '本局失败。' : '本局平局。') + '原因：' + (reasons[terminal.reason] || terminal.reason) + '。'
      setTeachingCue(null)
      render()
    }
    function pause(ms) {
      return new Promise(function (resolve) { global.setTimeout(resolve, ms) })
    }
    function describeOpponentAction(action, state) {
      const pieces = state.pieces || []
      const source = pieces.find(function (p) { return p.instanceId === action.pieceId })
      const target = pieces.find(function (p) { return p.instanceId === action.targetPieceId })
      const name = source ? source.name : '对手'
      const skill = (state.skillsById || {})[action.skillId]
      if (action.type === 'move') return name + '移动到 (' + action.toX + ', ' + action.toY + ')'
      if (action.type === 'deployReservePiece') return '对手部署' + (source ? source.name : '增援')
      if (action.type === 'endTurn') return '对手结束回合'
      if (action.type === 'beginPhase') return '回合开始，结算效果'
      if (action.type === 'playCard') return '对手使用手牌'
      if (action.skillId) return name + '使用' + (skill && skill.name || '技能') + (target ? ' → ' + target.name : '')
      return name + '完成选择'
    }
    function opponentCue(action, state) {
      const cells = (state.pieces || []).filter(function (p) {
        return p.instanceId === action.pieceId || p.instanceId === action.targetPieceId
      }).filter(function (p) { return Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 })
        .map(function (p) { return { x: p.x, y: p.y } })
      const x = action.toX ?? action.targetX, y = action.toY ?? action.targetY
      if (Number.isFinite(x) && Number.isFinite(y)) cells.push({ x: x, y: y })
      return cells.length ? { cells: cells } : null
    }
    function describeResult(before, after) {
      const changes = []
      ;(before.pieces || []).forEach(function (piece) {
        const next = (after.pieces || []).find(function (p) { return p.instanceId === piece.instanceId })
        if (!next && piece.currentHp > 0) { changes.push(piece.name + '离场'); return }
        const delta = next && next.currentHp - piece.currentHp
        if (delta) changes.push(piece.name + (delta < 0 ? '受到 ' + -delta + ' 点伤害' : '回复 ' + delta + ' 点生命'))
      })
      return changes.length ? '。' + changes.slice(0, 3).join('；') + (changes.length > 3 ? '等' : '') : ''
    }
    async function pump() {
      if (busy || disposed || !started || failure) return
      busy = true; render()
      try {
        const engine = await hooks.engine()
        // Bound malfunctioning policies; interruption must never turn into a fabricated loss.
        for (let count = 0; count < 200; count++) {
          if (disposed) return
          const state = hooks.getState()
          if (state.terminalResult) { showResult(); return }
          const owner = engine.getCurrentInputOwnerPlayerId(state)
          const awaitingChoice = !!state.pendingOptionSelection || !!state.pendingTargetSelection || state.deployment && state.deployment.status === 'awaiting-reserve-deploy'
          if (owner === lesson.player.playerId && (state.turn.phase === 'action' || awaitingChoice)) return
          const plan = engine.planBotActions(state, owner)
          if (!plan || !plan.actions.length) throw new Error('当前局面没有可执行的人机行动')
          let applied = false
          for (const draft of plan.actions) {
            if (disposed || hooks.getState().terminalResult || engine.getCurrentInputOwnerPlayerId(hooks.getState()) !== owner) break
            const action = engine.prepareLegalBotAction(hooks.getState(), draft, owner)
            if (!action) continue
            const opponentAction = owner !== lesson.player.playerId
            const phaseOnly = action.type === 'beginPhase'
            const description = describeOpponentAction(action, hooks.getState())
            if (opponentAction) {
              opponentNote = '看这里：' + description
              hooks.setCue(opponentCue(action, hooks.getState()))
              render()
              await pause(phaseOnly ? 350 : 1000)
            }
            if (disposed) return
            const before = hooks.getState()
            try {
              await hooks.commit(action)
            } catch (error) {
              if (!error || error.name !== 'BattleRuleError') throw error
              // A rejected draft leaves the authority unchanged. Continue the validated
              // batch (which contains endTurn), recording the cause for AI diagnostics.
              history.push({ key: 'ai-rejected', text: error.message, turn: before.turn.turnNumber, action: action })
              continue
            }
            if (disposed) return
            applied = true
            if (opponentAction) {
              opponentNote = description + describeResult(before, hooks.getState())
              render()
              // Keep this result visible before another action or turn replaces it.
              await pause(phaseOnly ? 700 : 2000)
              if (disposed) return
              opponentNote = ''
              hooks.setCue(teachingCue)
            }
            observe(action, before)
          }
          if (!applied) throw new Error('人机计划已失效，请重新开始本局')
        }
        throw new Error('人机行动超过本次安全上限')
      } catch (error) {
        failure = '练习暂时中断：' + (error && error.message || String(error))
      } finally {
        busy = false
        opponentNote = ''
        if (!disposed && !failure && openingStep === 'watch' && !hooks.getState().terminalResult) {
          teach('review', '又轮到你了，行动点已补充。继续用刚学会的操作作战。', '观察新回合，再继续练习')
        }
        if (!disposed) { hooks.setCue(teachingCue); hooks.render(); showResult(); render() }
      }
    }
    function dispose() { disposed = true; setTeachingCue(null); root.remove(); bubble.remove() }
    render()
    setTeachingCue(lesson.cue || null)
    return Object.freeze({
      beforeAction: function (action) {
        if (!started || busy || disposed || failure || hooks.getState().terminalResult) return { allowed: false, message: failure || (!started ? '先点击开始学习。' : '等待当前行动结算。') }
        if (!openingAllows(action)) return { allowed: false, message: openingObjective || '先跟随引导完成这一项操作。' }
        return { allowed: true }
      },
      afterAcceptedAction: async function (action, before) { observe(action, before); showResult(); await pump() },
      afterIntent: function (intent) {
        if (!started || busy || disposed || hooks.getState().terminalResult) return
        if (openingStep === 'terrain' && intent.type === 'activate-cell' && intent.x === opening.moveTo.x && intent.y === opening.moveTo.y) {
          teach('select', '这格是掩体，可以站人。接下来点击乌瑟尔，再把他移到刚才的掩体格。技能能否穿过地形，要看技能类型与合法目标。', '点击乌瑟尔')
          return
        }
        if (openingStep !== 'select') return
        const piece = openingPiece(false)
        if (piece && hooks.getSelectedPieceId && hooks.getSelectedPieceId() === piece.instanceId) {
          teachMove()
        }
      }, showResult: showResult, dispose: dispose,
      snapshot: function () { return { lessonId: lesson.id, started: started, busy: busy, failure: failure, openingStep: openingStep, notices: history.slice() } },
    })
  }
  global.RvBTutorialLessonRuntime = Object.freeze({ create: create })
})(typeof window !== 'undefined' ? window : globalThis)
