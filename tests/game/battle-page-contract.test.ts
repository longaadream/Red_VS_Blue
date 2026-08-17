import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')

function readPage(name: string) {
  return readFileSync(resolve(pagesDir, name), 'utf8')
}

function readNamedFunction(html: string, name: string) {
  const marker = `function ${name}(`
  const start = html.indexOf(marker)
  if (start === -1) throw new Error(`Missing ${name} in battle.html`)

  const nextFunction = html.indexOf('\n    function ', start + marker.length)
  if (nextFunction === -1) throw new Error(`Could not isolate ${name} in battle.html`)

  return html.slice(start, nextFunction)
}

function extractInlineScripts(html: string) {
  const scripts: Array<{ source: string; htmlLine: number }> = []
  const pattern = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi

  for (const match of html.matchAll(pattern)) {
    const source = match[1]
    if (!source.trim()) continue

    const sourceOffset = (match.index ?? 0) + match[0].indexOf(source)
    const htmlLine = html.slice(0, sourceOffset).split('\n').length
    scripts.push({ source, htmlLine })
  }

  return scripts
}

function parseInlineScript(script: { source: string; htmlLine: number }, index: number) {
  const filename = `battle-inline-${index + 1}.js`

  try {
    new Script(script.source, { filename })
  } catch (error) {
    const stack = error instanceof Error ? error.stack ?? '' : ''
    const scriptLine = Number(stack.match(new RegExp(`${filename.replace('.', '\\.')}:(\\d+)`))?.[1] ?? 1)
    const htmlLine = script.htmlLine + scriptLine - 1
    throw new Error(`battle.html:${htmlLine} inline script ${index + 1} failed to parse: ${String(error)}`, {
      cause: error,
    })
  }
}

describe('battle page route contract', () => {
  it('parses every inline script in the canonical battle page', () => {
    const scripts = extractInlineScripts(readPage('battle.html'))

    expect(scripts.length).toBeGreaterThan(0)
    for (const [index, script] of scripts.entries()) {
      expect(() => parseInlineScript(script, index)).not.toThrow()
    }
  })

  it('keeps one responsive HUD, board-anchored piece menu, and unsectioned curved hand', () => {
    const battlePage = readPage('battle.html')
    const responsiveCss = readFileSync(resolve(pagesDir, 'css/battle-responsive.css'), 'utf8')
    const contextCss = readFileSync(resolve(pagesDir, 'css/battle-context-ui.css'), 'utf8')
    const mobileCss = readFileSync(resolve(pagesDir, 'css/battle-responsive-mobile.css'), 'utf8')

    expect(battlePage).toContain('<link rel="stylesheet" href="css/battle-responsive.css" />')
    expect(battlePage).toContain('<link rel="stylesheet" href="css/battle-context-ui.css" />')
    expect(battlePage).toContain('<script src="js/battle-ui/battle-context-layout.js"></script>')
    expect(battlePage).toContain('<link rel="stylesheet" href="css/battle-responsive-mobile.css" />')
    expect(battlePage).toContain('id="btnResetBoardView"')
    expect(battlePage).toContain('id="pieceContextMenu"')
    expect(battlePage).toContain('id="pieceContextSkills"')
    expect(battlePage).not.toContain('id="btnToggleBattleDetail"')
    expect(battlePage).not.toContain('id="battleDetailRail"')
    expect(battlePage).not.toContain('skillBar')
    expect(battlePage).not.toContain('.board-side-rail')
    expect(battlePage).not.toContain('.selected-status-card')
    expect(responsiveCss).not.toContain('.board-side-rail')
    expect(battlePage).toContain('class="hand-scroll" id="handCards" data-battle-ui-region="hand" role="region" aria-label="手牌列表" tabindex="0"')
    expect(battlePage).not.toContain('arcHandContainer')
    expect(battlePage).toContain('--hand-arc-angle:')
    expect(contextCss).toContain('.piece-context-menu')
    expect(contextCss).toMatch(/\.piece-context-menu\s*\{[\s\S]*?max-width:\s*min\(520px, calc\(100% - 16px\)\)/)
    expect(contextCss).toMatch(/\.piece-context-skills\s*\{[\s\S]*?max-width:\s*100%[\s\S]*?overflow-x:\s*auto/)
    expect(contextCss).toContain('var(--hand-arc-angle')
    expect(battlePage).not.toContain('class="hand-panel"')
    expect(battlePage).not.toContain('class="hand-label"')
    expect(battlePage).not.toContain('id="handCount"')
    expect(battlePage).not.toContain('id="handTarget"')
    expect(battlePage).not.toContain('id="handBody"')
    expect(battlePage).not.toContain('暂无手牌')
    expect(responsiveCss).not.toContain('.hand-panel')
    expect(contextCss).not.toContain('.hand-panel')
    expect(contextCss).not.toContain('.hand-label')
    expect(contextCss).toMatch(/\.hand-scroll\s*\{[\s\S]*?background:\s*transparent/)
    expect(battlePage).toContain('id="selectedStatusOverlay"')
    expect(contextCss).toMatch(/\.selected-status-overlay\s*\{[\s\S]*?position:\s*absolute[\s\S]*?border:\s*0[\s\S]*?pointer-events:\s*none/)
    expect(contextCss).toMatch(/\.selected-status-overlay\[hidden\]\s*\{\s*display:\s*none/)
    expect(battlePage).toContain('id="trainingToolsToggle"')
    expect(battlePage).toContain('aria-controls="trainingBar" aria-expanded="false"')
    expect(battlePage).toContain('id="trainingBar" class="training-popover" role="dialog" aria-hidden="true"')
    expect(contextCss).toMatch(/\.training-tools\s*\{[\s\S]*?position:\s*absolute/)
    expect(responsiveCss).toMatch(/\.hand-scroll\s*\{[\s\S]*?scrollbar-width:\s*none/)
    expect(contextCss).toMatch(/\.training-popover\s*\{[\s\S]*?transform-origin:\s*bottom left/)
    expect(battlePage).toMatch(/function setTrainingToolsOpen\(open[\s\S]*?aria-expanded[\s\S]*?aria-hidden/)
    expect(battlePage).toMatch(/const active = !!\(pendingSkill \|\| pendingCardAction \|\| targetSubmissionPending\)[\s\S]*?if \(active\) \{\s*closePieceContextMenu\(\)/)
    expect(battlePage).toMatch(/function setTrainingToolsOpen\(open[\s\S]*?if \(next\) closePieceContextMenu\(\)/)
    expect(battlePage).toMatch(/const draftAction[^\n]+\s*closePieceContextMenu\(\)\s*await doAction\(draftAction\)/)
    expect(battlePage).toMatch(/function closePieceInfo\(\)[\s\S]*?style\.display = 'none'[\s\S]*?renderPieceContextMenu\(selected \|\| null\)/)
    expect(battlePage).toMatch(/dispatchBattleIntent\(\{type:\\?'toggle-move\\?'\}\)/)
    expect(battlePage).toMatch(/const isTargeting = !!pendingMove \|\| !!pendingSkill/)
    expect(battlePage).toMatch(/function selectPiece\(instanceId\)[\s\S]*?pendingMove = false[\s\S]*?renderPieceContextMenu\(sp\)/)
    expect(battlePage).toMatch(/function toggleMove\(\)[\s\S]*?renderPieceContextMenu\(pendingMove \? null : sp\)/)
    expect(battlePage).toContain('const disabled = !availability.available')
    expect(battlePage).toMatch(/function resolveSkillAvailability\(piece, skillOrId\)[\s\S]*?actionLow[\s\S]*?chargeLow/)
    expect(responsiveCss).not.toContain('@media (max-width: 760px)')
    expect(responsiveCss).toContain('touch-action: pan-x')
    expect(mobileCss).toContain('@media (max-width: 760px)')
    expect(contextCss).toMatch(/orientation: landscape[\s\S]*?\.training-popover \.tb-btn[\s\S]*?min-height:\s*44px/)
    expect(mobileCss).toMatch(/\.board-view-button\s*\{[\s\S]*?min-height:\s*42px/)
    expect(mobileCss).toMatch(/\.piece-context-skill\s*\{[\s\S]*?min-height:\s*44px/)
    expect(mobileCss).toMatch(/\.training-setup-sheet\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 16px\)/)
    expect(mobileCss).toMatch(/\.training-setup-grid\s*\{[\s\S]*?overflow-y:\s*auto/)
  })

  it('keeps the board dominant in low-height landscape battle layouts', () => {
    const responsiveCss = readFileSync(resolve(pagesDir, 'css/battle-responsive.css'), 'utf8')
    const contextCss = readFileSync(resolve(pagesDir, 'css/battle-context-ui.css'), 'utf8')
    const mobileCss = readFileSync(resolve(pagesDir, 'css/battle-responsive-mobile.css'), 'utf8')

    expect(responsiveCss).toContain('--battle-hand-height: 142px')
    expect(responsiveCss).toMatch(/@media \(max-width: 1024px\)[\s\S]*?--battle-hand-height:\s*134px/)
    expect(contextCss).toMatch(/orientation:\s*landscape[\s\S]*?--battle-hud-offset:\s*44px[\s\S]*?--battle-hand-height:\s*112px/)
    expect(contextCss).toMatch(/orientation:\s*landscape[\s\S]*?\.card-item\s*\{[\s\S]*?width:\s*76px[\s\S]*?height:\s*90px/)
    expect(contextCss).toMatch(/orientation:\s*landscape[\s\S]*?\.turn-summary-secondary\s*\{\s*display:\s*none/)
    expect(contextCss).toMatch(/\.topbar #resApDisplay,[\s\S]*?\.topbar \.hud-hand\s*\{\s*display:\s*none/)
    expect(contextCss).toMatch(/#statusMsg\s*\{[\s\S]*?bottom:\s*calc\(var\(--battle-hand-height\) \+ 8px\)/)
    expect(mobileCss).toMatch(/@media \(max-width: 760px\)[\s\S]*?--battle-hand-height:\s*112px/)
  })

  it('floats the hand over a full-viewport battlefield without a build watermark', () => {
    const battlePage = readPage('battle.html')
    const responsiveCss = readFileSync(resolve(pagesDir, 'css/battle-responsive.css'), 'utf8')

    expect(battlePage).not.toContain('UI 20260517')
    expect(responsiveCss).toMatch(/\.main-panel\s*\{[\s\S]*?padding-top:\s*0/)
    expect(responsiveCss).toMatch(/\.board-wrap\s*\{[\s\S]*?position:\s*absolute\s*!important;[\s\S]*?inset:\s*0/)
    expect(responsiveCss).toMatch(/\.hand-scroll\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0;[\s\S]*?pointer-events:\s*none/)
    expect(responsiveCss).toMatch(/\.card-item\s*\{[\s\S]*?pointer-events:\s*auto/)
  })

  it('keeps mobile battle controls clear of the floating hand', () => {
    const mobileCss = readFileSync(resolve(pagesDir, 'css/battle-responsive-mobile.css'), 'utf8')

    expect(mobileCss).toMatch(/\.battle-turn-control\s*\{[\s\S]*?bottom:\s*calc\(var\(--battle-hand-height\) \+ 10px\)/)
    expect(mobileCss).toMatch(/\.training-tools\s*\{[\s\S]*?bottom:\s*calc\(var\(--battle-hand-height\) \+ 10px\)/)
  })

  it('routes the lobby training entry to battle.html training mode', () => {
    const lobby = readPage('index.html')

    expect(lobby).toContain("window.location.href = 'battle.html?mode=training'")
    expect(lobby).not.toMatch(/location\.href\s*=\s*['"]training\.html/)
  })

  it('keeps training.html as a compatibility redirect without battle interactions', () => {
    const legacyTrainingPage = readPage('training.html')
    const battlePage = readPage('battle.html')
    const sharedInteractionMarkers = [
      'function renderBoard',
      'function onCellClick',
      'function renderActionBar',
      'function computeValidSkillTargets',
      'async function doAction',
    ]

    expect(legacyTrainingPage).toContain('battle.html')
    expect(legacyTrainingPage).toContain("params.set('mode', 'training')")
    expect(legacyTrainingPage).toContain('window.location.search')
    expect(legacyTrainingPage).toContain('window.location.replace')
    expect(legacyTrainingPage).not.toMatch(
      /applyBattleAction|GameEngine|function\s+(?:renderBoard|onCellClick|toggleMove|doAction)\b/,
    )
    for (const marker of sharedInteractionMarkers) {
      expect(battlePage).toContain(marker)
      expect(legacyTrainingPage).not.toContain(marker)
    }
  })

  it('turns missing battle parameters into a terminal error instead of an endless spinner', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toMatch(/if \(!roomId \|\| !myPlayerId\) \{ showMsg\([^\n]+, 'err'\); return \}/)
    expect(battlePage).toContain("spinner.style.display = type === 'err' ? 'none' : ''")
  })

  it('recovers training data from the connected server and rejects empty starting rosters', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('async function loadServerBattleDataFallback()')
    expect(battlePage).toContain('RvBUtils.serverFetch(path, { timeoutMs: timeoutMs || 3500 })')
    expect(battlePage).toMatch(
      /if \(!Object\.keys\(PIECES_BY_ID\)\.length\) \{\s*try \{\s*await loadServerBattleDataFallback\(\)/,
    )
    expect(battlePage).toContain('return { ok: recoveredFromServer || errors.length === 0, errors }')
    expect(battlePage).toMatch(
      /if \(!firstPieces\.length \|\| !secondPieces\.length\) \{\s*throw new Error\('训练棋子资源未加载/,
    )
  })

  it('lists placeable templates for both runtime battle factions', () => {
    const battlePage = readPage('battle.html')
    const owner = { value: 'training-red' }
    const select = { innerHTML: '' }
    const context = createContext({
      PIECES_BY_ID: {
        ana: { id: 'ana', name: 'Ana', faction: 'good' },
        reaper: { id: 'reaper', name: 'Reaper', faction: 'evil' },
        neutral: { id: 'neutral', name: 'Neutral', faction: 'neutral' },
        mercenary: { id: 'mercenary', name: 'Mercenary' },
      },
      trainingSetupConfig: null,
      getTrainingPlayerFaction: (playerId: string) => playerId === 'training-red' ? 'red' : 'blue',
      document: {
        getElementById: (id: string) => {
          if (id === 'placeOwner') return owner
          if (id === 'placeTemplate') return select
          return null
        },
      },
    })
    new Script([
      readNamedFunction(battlePage, 'getTemplateFactionForBattleFaction'),
      readNamedFunction(battlePage, 'refreshPlaceTemplates'),
    ].join('\n')).runInContext(context)

    new Script('refreshPlaceTemplates()').runInContext(context)
    expect(select.innerHTML).toContain('value="reaper"')
    expect(select.innerHTML).not.toContain('value="ana"')
    expect(select.innerHTML).toContain('value="neutral"')
    expect(select.innerHTML).toContain('value="mercenary"')

    owner.value = 'training-blue'
    new Script('refreshPlaceTemplates()').runInContext(context)
    expect(select.innerHTML).toContain('value="ana"')
    expect(select.innerHTML).not.toContain('value="reaper"')
    expect(select.innerHTML).toContain('value="neutral"')
    expect(select.innerHTML).toContain('value="mercenary"')
  })

  it('places the selected template for the selected training owner', () => {
    const battlePage = readPage('battle.html')
    const patches: unknown[] = []
    const context = createContext({
      G: {
        turn: { currentPlayerId: 'training-red' },
        pieces: [],
      },
      myPlayerId: 'training-red',
      TRAINING_MODE: true,
      targetSubmissionPending: false,
      placingMode: true,
      pendingOptionSelectionForOther: () => false,
      document: {
        getElementById: (id: string) => {
          if (id === 'placeTemplate') return { value: 'ana' }
          if (id === 'placeOwner') return { value: 'training-blue' }
          return null
        },
      },
      currentBattleViewModel: {
        legal: { placementCells: [{ x: 2, y: 3 }] },
      },
      sendPatch: (body: unknown) => {
        patches.push(body)
        return Promise.resolve(true)
      },
      addLog: () => undefined,
      PIECES_BY_ID: { ana: { id: 'ana', name: 'Ana' } },
    })
    new Script(readNamedFunction(battlePage, 'onCellClick')).runInContext(context)

    expect(() => new Script('onCellClick(2, 3)').runInContext(context)).not.toThrow()
    expect(JSON.parse(JSON.stringify(patches))).toEqual([
      { type: 'addPiece', ownerPlayerId: 'training-blue', templateId: 'ana', x: 2, y: 3 },
    ])
  })

  it('does not submit a typeless battle action when a card preview is cancelled on the board', () => {
    const battlePage = readPage('battle.html')
    const submittedActions: unknown[] = []
    const statusMessages: string[] = []
    const context = createContext({
      G: {
        turn: { currentPlayerId: 'player-red' },
        pieces: [],
      },
      myPlayerId: 'player-red',
      targetSubmissionPending: false,
      TRAINING_MODE: false,
      placingMode: false,
      pendingCardAction: { cardInstanceId: 'demon-summon-1-instance', cardId: 'demon-summon-1' },
      pendingSkill: null,
      pendingMove: false,
      selectedPieceId: null,
      pendingOptionSelectionForOther: () => false,
      submitTargetAction: (action: unknown) => submittedActions.push(action),
      setStatusMsg: (message: string) => statusMessages.push(message),
      currentTargetSourceName: () => '恶魔召唤（1）',
      renderHand: () => undefined,
      renderTargetOverlay: () => undefined,
      document: {
        getElementById: () => ({ style: { display: '' } }),
      },
    })
    new Script(readNamedFunction(battlePage, 'onCellClick')).runInContext(context)

    new Script('onCellClick(4, 3)').runInContext(context)

    expect(JSON.parse(JSON.stringify(submittedActions))).toEqual([])
    expect(new Script('pendingCardAction').runInContext(context)).toBeNull()
    expect(statusMessages).toContain('已取消卡牌预览')

    context.G.pieces = [{ instanceId: 'ally-piece', x: 1, y: 1, currentHp: 10 }]
    context.pendingCardAction = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'demon-summon-1-instance',
      cardId: 'demon-summon-1',
      preparation: { targetType: 'piece', filter: 'ally', candidates: [{ type: 'piece', pieceId: 'ally-piece' }] },
    }
    new Script('onCellClick(4, 3)').runInContext(context)

    expect(JSON.parse(JSON.stringify(submittedActions))).toEqual([])
    expect(new Script('pendingCardAction.type').runInContext(context)).toBe('playCard')
    expect(statusMessages.at(-1)).toBe('目标不在权威候选集合内')
  })

  it('fails closed before transport when a target action has no type', () => {
    const battlePage = readPage('battle.html')
    const sentActions: unknown[] = []
    const statusMessages: string[] = []
    const logs: string[] = []
    const context = createContext({
      targetSubmissionPending: null,
      red50Evidence: { targetCommands: [], rejections: [] },
      addLog: (message: string) => logs.push(message),
      setStatusMsg: (message: string) => statusMessages.push(message),
      doAction: (action: unknown) => sentActions.push(action),
    })
    new Script(readNamedFunction(battlePage, 'submitTargetAction')).runInContext(context)

    const accepted = new Script("submitTargetAction({}, '恶魔召唤（1）')").runInContext(context)

    expect(accepted).toBe(false)
    expect(sentActions).toEqual([])
    expect(JSON.parse(JSON.stringify(context.red50Evidence.rejections))).toMatchObject([
      { code: 'CLIENT_ACTION_TYPE_MISSING', message: '目标动作缺少有效类型，未发送' },
    ])
    expect(statusMessages.at(-1)).toBe('目标动作缺少有效类型，未发送')
    expect(logs.at(-1)).toContain('目标动作缺少有效类型')
  })

  it('keeps target submission single-flight and clears transient targeting on every authoritative exit', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('function submitTargetAction(action, label)')
    expect(battlePage).toMatch(
      /function submitTargetAction\(action, label\) \{\s*if \(targetSubmissionPending\)/,
    )
    expect(battlePage).toContain('目标指令已提交，正在等待权威确认')
    expect(battlePage).toContain("clearTargetInteraction('user-cancelled')")
    expect(battlePage).toContain("clearTargetInteraction('piece-switched')")
    expect(battlePage).toContain("clearTargetInteraction('turn-changed')")
    expect(battlePage).toContain("clearTargetInteraction('selected-piece-unavailable')")
    expect(battlePage).toContain("clearTargetInteraction('server-rejected')")
    expect(battlePage).toContain('function reconcileBattleInteractionState(previousState, nextState)')
  })

  it('keeps the nearby piece menu action-only while preserving the existing right-click piece detail', () => {
    const battlePage = readPage('battle.html')
    const domUi = readPage('js/battle-ui/battle-dom-ui.js')

    expect(domUi).not.toContain('selectedPieceStatus')
    expect(domUi).not.toContain('selected-detail-portrait')
    expect(domUi).not.toContain('selected-detail-stats')
    expect(domUi).not.toContain('selected-skill-list')
    expect(domUi).not.toContain('data-skill-id')
    expect(battlePage).toContain('function resolveSkillAvailability(piece, skillOrId)')
    expect(battlePage).toMatch(
      /function selectSkillCard[\s\S]*?resolveSkillAvailability\(sp, skId\)/,
    )
    expect(battlePage).toMatch(
      /function renderPieceContextMenu\(piece\)[\s\S]*?resolveSkillAvailability\(piece, sk\)/,
    )
    expect(battlePage).not.toContain('detailPiece.skills')
    expect(battlePage).toContain('oncontextmenu="event.preventDefault();dispatchBattleIntent({type:\'inspect-piece\'')
    expect(battlePage).toContain('aria-label="查看棋子完整技能与状态"')
    expect(battlePage).toContain('function showPieceInfo(instanceId, preserveKeyword)')
    expect(battlePage).toContain('statsHtml + tagsHtml')
    expect(battlePage).toContain('\`<div class="pi-section-label">技能</div>\` + skillsHtml')
  })

  it('exposes accessible target feedback and a mobile target mode that removes obstructing detail UI', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('<div id="statusMsg" role="status" aria-live="polite">')
    expect(battlePage).toContain('<div id="targetOverlay" role="status" aria-live="polite">')
    expect(battlePage).toContain('border: 0; border-radius: 0; background: transparent;')
    expect(battlePage).toContain('id="targetSourceName"')
    expect(battlePage).toContain('id="targetCancelButton"')
    expect(battlePage).toMatch(/function renderTargetOverlay\(\)[\s\S]*?closePieceContextMenu\(\)/)
    expect(battlePage).toContain('body.target-mode-active #trainingTools')
    expect(battlePage).toContain('@media (prefers-reduced-motion: reduce)')
    expect(battlePage).toContain('button:focus-visible')
  })

  it('keeps authoritative skill availability feedback in the nearby piece menu', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('class="piece-context-skills"')
    expect(battlePage).toContain('const availability = resolveSkillAvailability(piece, sk)')
    expect(battlePage).toContain('const disabled = !availability.available')
    expect(battlePage).toContain("titleParts.push('不可用：' + availability.unavailableReason)")
    expect(battlePage).not.toContain('skillBar')
    for (const reason of ['冷却中', '可用次数已耗尽', '行动点不足', '充能点不足']) {
      expect(battlePage).toContain(reason)
    }
  })

  it('requires landscape play on phones and reserves usable space at both mobile acceptance sizes', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('id="orientationGuard"')
    expect(battlePage).toContain('请旋转设备')
    expect(battlePage).toContain('@media (orientation: portrait) and (max-width: 760px)')
    expect(battlePage).toContain('@media (orientation: landscape) and (max-width: 1000px) and (max-height: 500px)')
    expect(battlePage).toContain('--mobile-landscape-min: 844px')
    expect(battlePage).toContain('--mobile-landscape-recommended: 932px')
    expect(battlePage).toContain('body.target-mode-active #trainingTools')
    expect(battlePage).toContain('body.target-mode-active #statusMsg')
  })

  it('exposes deployment selection and irreversible confirmation while keeping relay choices private', () => {
    const battlePage = readPage('battle.html')
    const browserEngine = readPage('js/game-engine.js')

    expect(battlePage).toContain("G.deployment.status === 'awaiting-locks'")
    expect(battlePage).toMatch(
      /function selectPiece\(instanceId\)[\s\S]*?type: 'deploymentChoice'[\s\S]*?pieceId: localDeploymentChoiceId/,
    )
    expect(battlePage).toMatch(
      /async function doTurnControl\(\)[\s\S]*?type: 'deploymentLock'[\s\S]*?playerId: myPlayerId/,
    )
    expect(battlePage).toContain("btnEnd.textContent = locked ? '部署已锁定' : '确认部署'")
    expect(battlePage).toContain('点击“确认部署”后不可更改')
    expect(battlePage).toContain('function publicRelayBattleState(state)')
    expect(battlePage).toContain('GameEngine.toPublicBattleState(state)')
    expect(battlePage).toContain('const publicState = publicRelayBattleState(relayAuthorityState)')
    expect(battlePage).toContain('authorityVersion: relaySeq')
    expect(battlePage).toContain("type: 'deploymentTimeout'")
    expect(battlePage).toContain("clientActionId: 'relay-deployment-timeout-'")
    expect(battlePage).not.toContain("RvBWs.send({ type: 'stateUpdate', seq: relaySeq, state: newG")
    expect(browserEngine).toContain('toPublicBattleState')
  })
})
