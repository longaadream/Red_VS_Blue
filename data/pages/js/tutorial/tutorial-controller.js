(function (global) {
  'use strict'

  function normalize(value) { return String(value || '').trim().toLowerCase() }
  function sameCell(left, right) {
    return !!left && !!right && Number(left.x) === Number(right.x) && Number(left.y) === Number(right.y)
  }

  function pieceForAction(state, action) {
    const all = (state && state.pieces || []).concat(
      Object.values(state && state.deployment && state.deployment.reserves || {}).flat(),
    )
    return all.find(function (piece) { return piece.instanceId === action.pieceId }) || null
  }

  function cardForAction(state, action) {
    const player = (state && state.players || []).find(function (candidate) {
      return normalize(candidate.playerId) === normalize(action.playerId)
    })
    return (player && player.hand || []).find(function (card) { return card.instanceId === action.cardInstanceId }) || null
  }

  function actionMatches(expected, action, state) {
    if (!expected || expected.type !== 'action' || !action || action.type !== expected.actionType) return false
    const source = pieceForAction(state, action)
    if (expected.templateId && normalize(source && source.templateId) !== normalize(expected.templateId)) return false
    if (expected.skillId && normalize(action.skillId) !== normalize(expected.skillId)) return false
    if (expected.cardId) {
      const card = cardForAction(state, action)
      if (normalize(card && (card.cardId || card.templateId || card.id)) !== normalize(expected.cardId)) return false
    }
    if (expected.to && !sameCell(expected.to, { x: action.toX, y: action.toY })) return false
    if (expected.targetTemplateId && action.targetPieceId) {
      const target = (state.pieces || []).find(function (piece) { return piece.instanceId === action.targetPieceId })
      if (normalize(target && target.templateId) !== normalize(expected.targetTemplateId)) return false
    }
    return true
  }

  function eventMatches(expected, event, state) {
    if (!expected || !event) return false
    if (expected.type === 'action') return event.type === 'action' && actionMatches(expected, event.action, state)
    if (expected.type === 'continue') return event.type === 'continue'
    if (expected.type === 'history-item') return event.type === 'history-item'
    if (expected.type === 'intent') {
      return event.type === 'intent'
        && event.intent && event.intent.type === expected.intentType
        && sameCell(expected.cell, event.intent)
    }
    return false
  }

  function createController(definition) {
    if (!definition || !Array.isArray(definition.steps) || !definition.steps.length) {
      throw new Error('[tutorial] a non-empty step list is required')
    }
    let index = 0
    let status = 'active'
    const events = []

    function currentStep() { return definition.steps[index] || null }
    function snapshot() {
      return {
        scenarioId: definition.id,
        status: status,
        index: index,
        total: definition.steps.length,
        step: currentStep(),
        events: events.slice(),
      }
    }
    function advance(event) {
      const completed = currentStep()
      events.push({ stepId: completed && completed.id, eventType: event.type, at: Date.now() })
      if (index < definition.steps.length - 1) index += 1
      return { accepted: true, completedStep: completed, snapshot: snapshot() }
    }

    return Object.freeze({
      snapshot: snapshot,
      beforeAction: function (action, state) {
        if (status !== 'active') return { allowed: true }
        const step = currentStep()
        const allowed = actionMatches(step && step.advance, action, state)
        return allowed
          ? { allowed: true }
          : { allowed: false, message: '这步先按 DM 的标记来，别急着把剧本撕了。' }
      },
      accept: function (event, state) {
        if (status !== 'active') return { accepted: false, snapshot: snapshot() }
        const step = currentStep()
        if (!eventMatches(step && step.advance, event, state)) return { accepted: false, snapshot: snapshot() }
        return advance(event)
      },
      finish: function () {
        const step = currentStep()
        if (!step || !step.advance || step.advance.type !== 'complete') return { accepted: false, snapshot: snapshot() }
        status = 'completed'
        events.push({ stepId: step.id, eventType: 'complete', at: Date.now() })
        return { accepted: true, completedStep: step, snapshot: snapshot() }
      },
      skip: function () {
        status = 'skipped'
        events.push({ stepId: currentStep() && currentStep().id, eventType: 'skip', at: Date.now() })
        return snapshot()
      },
    })
  }

  global.RvBTutorialController = Object.freeze({
    create: createController,
    actionMatches: actionMatches,
    eventMatches: eventMatches,
  })
})(typeof window !== 'undefined' ? window : globalThis)
