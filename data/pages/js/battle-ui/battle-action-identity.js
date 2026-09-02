;(function (root) {
  'use strict'

  function isSkillAction(event) {
    return !!event && (event.kind === 'skill' || event.kind === 'chargeSkill')
  }

  function portraitUrl(portraitRef) {
    const ref = String(portraitRef || '').replace(/^images\//, '')
    if (!ref) return ''
    const fileName = /\.[a-z0-9]+$/i.test(ref)
      ? ref
      : ref.replace(/^(red|blue)-/, '') + '.jpg'
    return 'images/' + fileName
  }

  function pieceById(model, pieceId) {
    return ((model && model.pieces) || []).find(function (piece) {
      return String(piece.id || '') === String(pieceId || '')
    }) || null
  }

  function initialFor(name) {
    const normalized = String(name || '').trim()
    return normalized ? Array.from(normalized)[0] : '?'
  }

  function resolve(event, model) {
    const skillAction = isSkillAction(event)
    const sourcePiece = pieceById(model, event && event.sourcePieceId)
    const skillId = String(event && event.skillId || '')
    const skill = model && model.skillSummariesById && model.skillSummariesById[skillId]
    const sourceName = String(sourcePiece && sourcePiece.name || '未知棋子')
    return {
      isSkill: skillAction,
      skillName: skillAction ? String(event && event.label || skill && skill.name || skillId || '技能') : '',
      sourceName: sourceName,
      portraitSrc: portraitUrl(sourcePiece && sourcePiece.portraitId),
      portraitFallback: initialFor(sourceName),
      faction: String(sourcePiece && sourcePiece.faction || ''),
    }
  }

  root.BattleActionIdentity = {
    isSkillAction: isSkillAction,
    portraitUrl: portraitUrl,
    resolve: resolve,
  }
})(typeof window !== 'undefined' ? window : globalThis)
