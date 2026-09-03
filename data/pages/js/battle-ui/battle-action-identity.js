;(function (root) {
  'use strict'

  const reportedMissingSkills = new Set()

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

  function skillDisplayName(event, skill) {
    const skillId = String(event && event.skillId || '')
    const registeredName = String(skill && skill.name || '').trim()
    if (registeredName && registeredName !== skillId) return registeredName

    const eventLabel = String(event && event.label || '').trim()
    if (eventLabel && eventLabel !== skillId) return eventLabel

    const reportKey = String(event && event.eventId || '') + ':' + skillId
    if (!reportedMissingSkills.has(reportKey)) {
      reportedMissingSkills.add(reportKey)
      if (typeof console !== 'undefined' && console.error) {
        console.error('[battle-action-identity] missing skill display metadata', {
          eventId: String(event && event.eventId || ''),
          skillId: skillId,
        })
      }
    }
    return '未知技能'
  }

  function resolve(event, model) {
    const skillAction = isSkillAction(event)
    const sourcePiece = pieceById(model, event && event.sourcePieceId)
    const skillId = String(event && event.skillId || '')
    const skill = model && model.skillSummariesById && model.skillSummariesById[skillId]
    const sourceName = String(sourcePiece && sourcePiece.name || '未知棋子')
    return {
      isSkill: skillAction,
      skillName: skillAction ? skillDisplayName(event, skill) : '',
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
