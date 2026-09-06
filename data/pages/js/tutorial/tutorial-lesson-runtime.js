(function (global) {
  'use strict'
  function create(lesson, hooks) {
    const root = document.createElement('aside')
    root.className = 'tutorial-dialog'
    root.id = 'tutorialLessonDialog'
    root.setAttribute('aria-label', '社长的教学提示')
    const title = document.createElement('h2')
    title.className = 'tutorial-dialog__scene'
    title.textContent = '第 ' + lesson.number + ' 局 · ' + lesson.title
    const text = document.createElement('p')
    text.className = 'tutorial-dialog__text'
    text.setAttribute('aria-live', 'polite')
    const objective = document.createElement('p')
    objective.className = 'tutorial-dialog__objective'
    const actions = document.createElement('div')
    actions.className = 'tutorial-dialog__actions'
    root.append(title, text, objective, actions)
    document.body.appendChild(root)
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
      const piece = step === 'select' || step === 'shield' || step === 'heal' ? openingPiece(false) : step === 'attack' ? openingPiece(true) : null
      const cell = step === 'move' || step === 'terrain' ? opening.moveTo : piece
      hooks.setCue(cell ? { cells: [{ x: cell.x, y: cell.y }] } : null)
      render()
    }
    function begin() {
      started = true
      if (opening && ['deployment', 'charge', 'full-match'].includes(opening.kind)) {
        teach('deploy', '对手先行动，轮到你时会出现增援候选。先点击候选棋子查看属性，选定一枚，再点击棋盘上的高亮格部署。部署不花行动点；这一步由你亲手完成。', '轮到你后，选择增援并点击高亮落点')
      } else if (opening && opening.kind === 'protection') {
        teach('heal', '先看乌瑟尔的生命，他已经受伤。点击安度因，选择“圣光闪耀”，再点击乌瑟尔。我们先亲手治疗一次，看看生命如何变化。', '安度因 → 圣光闪耀 → 乌瑟尔')
      } else if (opening && opening.kind === 'terrain') {
        teach('terrain', '先点击亮起的掩体格。掩体可以站人，但会阻挡弹射物；墙和洞穴不能站人。接下来我们亲手移动到掩体，再尝试进攻。', '点击亮起的掩体格')
      } else if (opening) teach('select', '先点击亮起的乌瑟尔。选中棋子后，可以看到他的生命和可用技能。这里只是查看，还不会消耗行动点。', '第一步：点击乌瑟尔')
      else { message = '接下来由你指挥，需要时点“给点思路”。'; hooks.setCue(null) }
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
        teach('collect', '核心阵亡后留下了亮起的结晶。选一枚能走过去的己方棋子，普通移动到结晶格拾取。距离不够时先靠近，或结束回合等下一轮；不要忘了保护自己的核心。', '选择己方棋子，普通移动到结晶格')
        hooks.setCue({ cells: crystals })
      } else if (openingStep === 'collect' && !crystals.length && action.playerId !== lesson.player.playerId) {
        teach('fight-crystal', '刚才的结晶已被对手拿走。继续移动和攻击，下一枚结晶出现后，我们再练习拾取。', '继续作战，观察下一枚结晶')
      }
      if (action.playerId !== lesson.player.playerId) return
      if (openingStep === 'deploy' && action.type === 'deployReservePiece') {
        deployedPieceId = action.pieceId
        teach('deploy-result', '增援已经上场。看上方行动点，部署没有消耗它。接下来选中刚上场的棋子，我们练习它本回合的免费首移。', '先看部署结果，再学习移动')
      } else if (openingStep === 'move-new' && action.type === 'move') {
        const previous = before.players.find(function (p) { return p.playerId === lesson.player.playerId })
        teach('new-move-result', '这次移动实际消耗 ' + (previous.actionPoints - own.actionPoints) + ' 点行动点。刚部署的棋子仅本回合第一次普通移动免费；其他移动要看实际费用。现在来看手牌。', '观察行动点的变化')
      } else if (openingStep === 'card' && action.type === 'playCard') {
        teach('card-result', '手牌已经打出并结算。看它是否离开手牌区，再看行动点和效果变化。卡牌费用和效果以卡面及实际结算为准。', '查看手牌和资源变化')
      } else if (openingStep === 'heal' && action.type === 'useBasicSkill' && action.skillId === 'light-of-the-light') {
        const old = before.pieces.find(function (p) { return p.instanceId === piece.instanceId })
        if (piece.currentHp > old.currentHp) teach('heal-result', '乌瑟尔实际恢复了 ' + (piece.currentHp - old.currentHp) + ' 点生命。治疗补回损失的生命；接下来再给他加一层保护。', '观察生命变化，再学习圣盾')
      } else if (openingStep === 'shield' && action.type === 'useBasicSkill' && action.skillId === 'shield-of-light') {
        teach('shield-result', '圣光盾已经结算。查看乌瑟尔身上的圣盾状态：它可以抵挡一次伤害。对自己施放会返还 1 点行动点，但使用前仍需先付 2 点。', '查看圣盾状态与行动点')
      } else if (openingStep === 'collect' && action.type === 'move' && ((before.extensions || {}).tileEffects || []).some(function (t) { return t.tileType === 'charge-crystal' && t.x === action.toX && t.y === action.toY }) && own.chargePoints > before.players.find(function (p) { return p.playerId === lesson.player.playerId }).chargePoints) {
        teach('collect-result', '结晶已经拾取，队伍充能增加了。现在我们用一次充能技能，亲眼看看 AP、CP 和效果的变化。', '观察队伍充能点')
      } else if (openingStep === 'charge' && action.type === 'useChargeSkill') {
        teach('charge-result', '充能技能已经结算。看队伍剩余 CP、行动点和技能冷却，再决定下一轮怎样继续。', '观察充能技能的实际效果')
      } else if (openingStep === 'practice-skill' && ['useBasicSkill', 'useChargeSkill'].includes(action.type)) {
        teach('attack-result', '技能已成功结算。看目标生命或状态的变化，再看剩余行动点。完整对战也按这样逐项判断。', '查看本次技能结果')
      } else if (openingStep === 'move' && action.type === 'move' && piece && piece.x === opening.moveTo.x && piece.y === opening.moveTo.y) {
        const previous = before.players.find(function (p) { return p.playerId === lesson.player.playerId })
        teach('move-result', '乌瑟尔已经走到这里。这次移动消耗了 ' + (previous.actionPoints - own.actionPoints) + ' 点行动点，现在剩下 ' + own.actionPoints + ' 点。移动后，还可以继续使用技能。', '观察上方行动点，再学习攻击')
      } else if (openingStep === 'attack' && action.type === 'useBasicSkill' && action.skillId === opening.skillId) {
        const target = openingPiece(true)
        const previous = before.pieces.find(function (p) { return p.templateId === opening.targetTemplateId && p.ownerPlayerId !== lesson.player.playerId })
        const damage = previous ? previous.currentHp - (target ? target.currentHp : 0) : 0
        if (damage > 0) teach('attack-result', '命中了！' + previous.name + '实际减少了 ' + damage + ' 点生命。你还剩 ' + own.actionPoints + ' 点行动点。使用技能后也要看冷却，不能只看剩余行动点。', '观察敌人生命和技能状态')
      } else if (openingStep === 'end-turn' && action.type === 'endTurn') {
        teach('watch', '现在轮到对手。注意他移动了谁、用了什么技能，以及你的棋子生命有没有变化。', '观察对手行动，等待回合交还')
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
    function lessonButton(step, label, next) {
      if (openingStep === step) addButton(label, function () { if (openingStep === step) next() }, true)
    }
    function teachMove() {
      teach('move', opening.kind === 'terrain' ? '选中乌瑟尔，再点击亮起的掩体格。掩体是可以站人的，我们用实际移动验证一次。' : '选中乌瑟尔，再点击亮起的目标格，向敌人靠近。也可以拖动棋子到那个格子。', '将乌瑟尔移到亮起的目标格')
    }
    function teachEndTurn() {
      teach('end-turn', '这一轮操作已经完成。点击右下角“结束回合”，把行动机会交给对手。有剩余行动点也可以结束，不要求全部用完。', '点击右下角“结束回合”')
    }
    function render() {
      if (disposed) return
      const terminal = hooks.getState().terminalResult
      root.classList.toggle('is-busy', busy)
      text.textContent = failure || message
      objective.textContent = terminal ? '本局已结束' : failure ? '练习中断，可重开或返回课程' : !started ? '跟随本局引导，亲手学习操作' : busy ? '对手正在行动，观察棋盘与行动记录' : teaching() ? openingObjective : '继续实战：查看局面，再安排你的行动'
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
        if (terminal && lesson.number < global.RvBTutorialLessons.all.length) addButton('下一局', function () { dispose(); hooks.next() })
      } else if (!started) {
        addButton(opening ? '开始学习' : '开始本局', begin, true)
      } else if (teaching()) {
        lessonButton('deploy-result', '学习本回合首移', function () {
          teach('move-new', '选中刚部署的棋子，再点击它周围的可移动高亮格，或拖动过去。它本回合第一次普通移动免费。如果这个落点没有可走的格子，可以先选先锋练习移动，留意费用区别。', '选中棋子，再点击可移动格')
          const piece = hooks.getState().pieces.find(function (p) { return p.instanceId === deployedPieceId })
          if (piece) hooks.setCue({ cells: [{ x: piece.x, y: piece.y }] })
        })
        lessonButton('new-move-result', '学习使用手牌', function () {
          teach('card', '看看下方手牌。点一次“幸运币”查看效果，再点同一张把它打出。卡牌会提供一次效果；我们先用这张熟悉操作。', '点击幸运币查看，再点击打出')
        })
        lessonButton('card-result', opening.kind === 'charge' ? '学习争夺结晶' : opening.kind === 'full-match' ? '学习安排技能' : '学习结束回合', function () {
          if (opening.kind === 'charge') teach('fight-crystal', '先选己方棋子，移动靠近敌人，再使用伤害技能。行动点不够就结束回合继续。核心阵亡会留下结晶，出现时我会指给你看。', '移动、使用技能作战，观察核心阵亡后的地面')
          else if (opening.kind === 'full-match') teach('practice-skill', '选中一枚己方棋子，查看技能费用，再点一个可用技能和合法目标。距离不够可以先移动，行动点不够就结束回合；轮到你时记得先部署增援。我们先完成一次技能结算。', '选棋子 → 查看技能 → 使用技能与合法目标')
          else teachEndTurn()
        })
        lessonButton('heal-result', '学习圣光盾', function () {
          teach('shield', '现在点击乌瑟尔，选择“圣光盾”，再点击乌瑟尔自己。先看技能需要 2 点行动点，再进行施放。', '乌瑟尔 → 圣光盾 → 乌瑟尔自己')
        })
        lessonButton('shield-result', '学习移动与反击', teachMove)
        lessonButton('collect-result', '学习充能技能', function () {
          teach('charge', '选中一枚己方棋子，查看带充能费用的技能。AP、CP 和冷却都满足后，点击技能并选择它要求的目标。乌瑟尔的“赐福”也是充能技能；资源不够时继续部署和作战，下一回合再试。', '查看费用，亲手使用一次充能技能')
        })
        lessonButton('charge-result', '学习结束回合', teachEndTurn)
        if (openingStep === 'move-result') addButton('学习使用技能', function () {
          const target = openingPiece(true)
          if (openingStep !== 'move-result') return
          teach('attack', '现在点击乌瑟尔技能栏里的“祝福之锤”，再点击亮起的' + target.name + '。这个技能花 1 点行动点，只能攻击两格内的敌人。', '点击祝福之锤，再点击' + target.name)
          if (hooks.revealPieceSkills) hooks.revealPieceSkills(openingPiece(false).instanceId)
        }, true)
        lessonButton('attack-result', '学习结束回合', teachEndTurn)
        if (openingStep === 'review') addButton('继续本局练习', function () {
          if (openingStep !== 'review') return
          openingStep = 'free'; message = '接下来继续练习刚才的操作。我会继续提醒新情况，也可以点“给点思路”重看本局要点。先查看核心生命，再选择棋子和行动，直到本局分出胜负。'; hooks.setCue(null); render()
        }, true)
      } else {
        addButton('给点思路', function () { message = lesson.help; render() })
      }
      addButton('返回课程', leave)
    }
    function observe(action, before) {
      observeOpening(action, before)
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
      message = (terminal.winnerPlayerId ? won ? '你赢下了本局。' : '这局失败了，可以回看行动记录再试一次。' : '本局平局。') + '原因：' + (reasons[terminal.reason] || terminal.reason) + '。没有做过的技巧可以以后再练。'
      hooks.setCue(null)
      render()
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
            if (owner !== lesson.player.playerId) await new Promise(function (resolve) { global.setTimeout(resolve, 500) })
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
            observe(action, before)
          }
          if (!applied) throw new Error('人机计划已失效，请重新开始本局')
        }
        throw new Error('人机行动超过本次安全上限')
      } catch (error) {
        failure = '练习暂时中断：' + (error && error.message || String(error))
      } finally {
        busy = false
        if (!disposed && !failure && openingStep === 'watch' && !hooks.getState().terminalResult) {
          teach('review', '又轮到你了。行动点会在自己的新回合开始时补充，行动记录能查看刚才发生了什么。接下来继续练习本局刚学过的操作，我会继续提醒需要注意的变化。', '观察新回合，再继续练习')
        }
        if (!disposed) { hooks.render(); showResult(); render() }
      }
    }
    function dispose() { disposed = true; hooks.setCue(null); root.remove() }
    render()
    hooks.setCue(lesson.cue || null)
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
