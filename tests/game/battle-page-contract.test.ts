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

function readNamedAsyncFunction(html: string, name: string) {
  const marker = `async function ${name}(`
  const start = html.indexOf(marker)
  if (start === -1) throw new Error(`Missing async ${name} in battle.html`)

  const candidates = [
    html.indexOf('\n    function ', start + marker.length),
    html.indexOf('\n    async function ', start + marker.length),
  ].filter(index => index !== -1)
  const nextFunction = Math.min(...candidates)
  if (!Number.isFinite(nextFunction)) throw new Error(`Could not isolate async ${name} in battle.html`)

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
  it('serves canonical battle-page images before legacy public QA assets', () => {
    const route = readFileSync(resolve(process.cwd(), 'app/qa/client/[...path]/route.ts'), 'utf8')
    const staticQaServer = readFileSync(resolve(process.cwd(), 'scripts/run-colyseus-pages-qa.mjs'), 'utf8')

    expect(route).toContain("[path.resolve(PAGE_ROOT, 'images'), PUBLIC_ROOT]")
    expect(route).toContain('for (const target of targets)')
    expect(route).toContain('Local QA serves battle-page images first, then legacy public images.')
    expect(staticQaServer).toContain("[safeResolve(resolve(pagesRoot, 'images'), relativePath), safeResolve(publicRoot, relativePath)]")
    expect(staticQaServer).toContain('resolveCandidates(pathname).find')
  })

  it('parses every inline script in the canonical battle page', () => {
    const scripts = extractInlineScripts(readPage('battle.html'))

    expect(scripts.length).toBeGreaterThan(0)
    for (const [index, script] of scripts.entries()) {
      expect(() => parseInlineScript(script, index)).not.toThrow()
    }
  })

  it('mounts the RED-167 vignette inside the shared battle presentation lifecycle', () => {
    const battlePage = readPage('battle.html')
    const vignetteSource = readFileSync(resolve(pagesDir, 'js/battle-ui/battle-action-vignette.js'), 'utf8')

    expect(battlePage).toContain('<script src="js/game-engine.js"></script>')
    expect(battlePage).not.toContain('<script src="js/battle-ui/battle-presentation-events.js"></script>')
    expect(battlePage).toContain('<script src="js/battle-ui/battle-action-identity.js"></script>')
    expect(battlePage).toContain('<script src="js/battle-ui/battle-action-vignette.js"></script>')
    expect(battlePage).toContain('battleActionVignette = BattleActionVignette.create({')
    expect(battlePage).toContain('vignetteUi: battleActionVignette')
    expect(battlePage).toContain("const RED167_QA_MODE = params.get('qa') === 'RED-167'")
    expect(battlePage).toContain('window.__RVB_RED167_REPLAY__ = playRed167QaSequence')
    expect(vignetteSource).toContain("speedControl.className = 'battle-vignette-speed-control'")
    expect(vignetteSource).toContain('speedControl.hidden = false')
    expect(vignetteSource).toContain('floatLayer.appendChild(speedControl)')
    expect(vignetteSource).not.toContain('data-vignette-control="speed"')
  })

  it('projects real training actions into the shared RED-167 presentation queue', () => {
    const battlePage = readPage('battle.html')
    const trainingAction = readNamedAsyncFunction(battlePage, 'trainingDoAction')
    const appendEvents = readNamedFunction(battlePage, 'appendTrainingPresentationEvents')
    const refreshEvents = readNamedFunction(battlePage, 'refreshTrainingPresentationEvents')
    const browserEntry = readFileSync(resolve(process.cwd(), 'lib/game/engine-browser-entry.ts'), 'utf8')
    const browserEngine = readFileSync(resolve(pagesDir, 'js/game-engine.js'), 'utf8')

    expect(trainingAction).toContain('appendTrainingPresentationEvents(Engine, action, oldG, newG)')
    expect(appendEvents).toContain('Engine.projectBattlePresentationEvents({')
    expect(appendEvents).toContain('actionId: action.clientActionId')
    expect(appendEvents).toContain('beforeState: beforeState')
    expect(appendEvents).toContain('afterState: afterState')
    expect(refreshEvents).toContain('Engine.projectBattlePresentationEventsForViewer(chain, myPlayerId)')
    expect(browserEntry).toContain('projectBattlePresentationEvents')
    expect(browserEntry).toContain('projectBattlePresentationEventsForViewer')
    expect(browserEngine).toContain('projectBattlePresentationEvents')
    expect(browserEngine).toContain('projectBattlePresentationEventsForViewer')
  })

  it('feeds the authoritative response timer into the shared battle clock view', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('let authoritativePendingTimer = null')
    expect(battlePage).toContain('authoritativePendingTimer = pendingTimer || null')
    expect(battlePage).toContain('pendingTimer: authoritativePendingTimer')
    expect(battlePage).toContain('msg.pendingTimer')
    expect(battlePage).toContain('id="turnClockFrozen"')
    expect(battlePage).toContain("frozenClock.textContent = '回合冻结 ' + view.frozenClockText")
    expect(battlePage).toContain("authoritativePendingTimer ? '响应 ' + view.clockText : view.clockText")
    expect(battlePage).toContain("clock.parentElement?.classList.toggle('pending-timer-active', !!authoritativePendingTimer)")
    expect(battlePage).toContain('.turn-summary-secondary.pending-timer-active')
    expect(battlePage).not.toContain('deploymentStatusTimer = setInterval')
    expect(battlePage).toContain('function scheduleDeadlineStatusRefresh()')
    expect(battlePage).toContain('deadlineStatusTimer = setTimeout')
  })

  it('renders the authoritative terminal result without judging or submitting gameOver locally', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('G.terminalResult')
    expect(battlePage).toContain('winnerPlayerId')
    expect(battlePage).not.toContain('function checkClientGameOver')
    expect(battlePage).not.toMatch(/\bG\.(?:gameOver|winner)\b/)
    expect(battlePage).not.toMatch(/RvBWs\.send\(\{\s*type:\s*['"]gameOver['"]/)
    expect(battlePage).not.toMatch(/msg\.type\s*===\s*['"]gameOver['"]/)
    expect(battlePage).not.toMatch(/RvBWs\.send\(\{\s*type:\s*['"]stateUpdate['"]/)
    expect(battlePage).not.toMatch(/wsMode === ['"]relay['"] && wsRole === ['"]host['"] && G/)
    expect(battlePage).toContain("if (wsMode === 'relay')")
    expect(battlePage).toContain('已忽略旧 Relay 客户端权威动作')
    expect(battlePage).toContain('已忽略非权威 Relay 恢复状态')
  })

  it('keeps one responsive HUD, opposite-edge piece dock, and unsectioned curved hand', () => {
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
    expect(contextCss).toMatch(/\.piece-context-menu\s*\{[\s\S]*?width:\s*min\(188px, calc\(100% - 16px\)\)/)
    expect(contextCss).toMatch(/\.piece-context-skills\s*\{[\s\S]*?flex-direction:\s*column[\s\S]*?overflow-y:\s*auto/)
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
    expect(battlePage).not.toContain('id="selectedStatusOverlay"')
    expect(battlePage).toContain('aria-label="查看棋子完整技能与状态"')
    expect(battlePage).toContain('onclick="switchPieceInfoToActionHistory()">行动记录</button>')
    expect(battlePage).toMatch(/function switchPieceInfoToActionHistory\(\)[\s\S]*?closePieceInfo\(\{ restoreFocus: false \}\)[\s\S]*?is-user-expanded[\s\S]*?button\.focus\(\)/)
    expect(battlePage).toContain('id="trainingToolsToggle"')
    expect(battlePage).toContain('aria-controls="trainingBar" aria-expanded="false"')
    expect(battlePage).toContain('id="trainingBar" class="training-popover" role="dialog" aria-hidden="true"')
    expect(contextCss).toMatch(/\.training-tools\s*\{[\s\S]*?position:\s*absolute/)
    expect(responsiveCss).toMatch(/\.hand-scroll\s*\{[\s\S]*?scrollbar-width:\s*none/)
    expect(contextCss).toMatch(/\.training-popover\s*\{[\s\S]*?transform-origin:\s*bottom left/)
    expect(battlePage).toMatch(/function setTrainingToolsOpen\(open[\s\S]*?aria-expanded[\s\S]*?aria-hidden/)
    expect(battlePage).toMatch(/const active = !targetSubmissionPending && !!\(pendingSkill \|\| pendingCardAction\)[\s\S]*?if \(active\) \{\s*closePieceContextMenu\(\)/)
    expect(battlePage).toMatch(/function setTrainingToolsOpen\(open[\s\S]*?if \(next\) closePieceContextMenu\(\)/)
    expect(battlePage).toMatch(/const draftAction[^\n]+\s*closePieceContextMenu\(\)/)
    expect(battlePage).toMatch(/BattleLegalActions\.probeSkillTarget\([\s\S]*?enterActionTargetMode\(draftAction, localTargetProbe\.preparation\)/)
    expect(battlePage).toMatch(/if \(localTargetProbe[\s\S]*?await doAction\(draftAction\)/)
    expect(battlePage).toMatch(/function closePieceInfo\(\)[\s\S]*?style\.display = 'none'[\s\S]*?renderPieceContextMenu\(selected \|\| null\)/)
    expect(battlePage).not.toMatch(/dispatchBattleIntent\(\{type:\\?'toggle-move\\?'\}\)/)
    expect(battlePage).not.toContain('class="piece-context-skill is-move"')
    expect(battlePage).toMatch(/const isTargeting = !!pendingSkill \|\| !!pendingCardAction/)
    expect(battlePage).toMatch(/function refreshBattleLegalActions\(\)[\s\S]*?queryMoveCells[\s\S]*?pendingMove = validMoves\.size > 0/)
    expect(battlePage).toMatch(/function selectPiece\(instanceId\)[\s\S]*?dismissedPieceContextId = null[\s\S]*?render\(\)/)
    expect(battlePage).toMatch(/function dismissPieceContextMenu\(\)[\s\S]*?dismissedPieceContextId = menu\.dataset\.pieceId[\s\S]*?closePieceContextMenu\(\)/)
    expect(battlePage).toMatch(/function positionPieceContextMenu\(\)[\s\S]*?layout\.placeEdgeDock[\s\S]*?menu\.dataset\.side = placement\.side/)
    expect(battlePage).toMatch(/function positionPieceContextMenu\(\)[\s\S]*?leftInset[\s\S]*?rightInset/)
    expect(battlePage).toContain('aria-label="收起技能栏"')
    expect(battlePage).toMatch(/document\.addEventListener\('pointerdown',[\s\S]*?#pieceContextMenu[\s\S]*?dismissPieceContextMenu\(\)/)
    expect(battlePage).toMatch(/document\.addEventListener\('wheel',[\s\S]*?#boardStage3d[\s\S]*?dismissPieceContextMenu\(\)/)
    expect(battlePage).toContain('const disabled = !availability.available')
    expect(battlePage).toMatch(/function resolveSkillAvailability\(piece, skillOrId\)[\s\S]*?actionLow[\s\S]*?chargeLow/)
    expect(responsiveCss).not.toContain('@media (max-width: 760px)')
    expect(responsiveCss).toContain('touch-action: pan-x')
    expect(mobileCss).toContain('@media (max-width: 760px)')
    expect(contextCss).toMatch(/orientation: landscape[\s\S]*?\.training-popover \.tb-btn[\s\S]*?min-height:\s*44px/)
    expect(mobileCss).toMatch(/\.board-view-button\s*\{[\s\S]*?min-height:\s*42px/)
    expect(mobileCss).toMatch(/\.piece-context-skill\s*\{[\s\S]*?min-height:\s*44px/)
    expect(contextCss).toMatch(/orientation:\s*landscape[\s\S]*?\.piece-context-menu\s*\{[\s\S]*?width:\s*148px/)
    expect(mobileCss).toMatch(/\.training-setup-sheet\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 16px\)/)
    expect(mobileCss).toMatch(/\.training-setup-grid\s*\{[\s\S]*?overflow-y:\s*auto/)
  })

  it('reopens the selected piece skill panel after a committed move', () => {
    const battlePage = readPage('battle.html')
    const moveStart = battlePage.indexOf('function moveSelectedPieceToCell(pieceId, x, y)')
    const moveEnd = battlePage.indexOf('function onCellClick(x, y)', moveStart)
    const moveHandler = battlePage.slice(moveStart, moveEnd)

    expect(moveHandler).toMatch(/dismissedPieceContextId = null[\s\S]*?doAction\(\{ type: 'move'/)
    expect(battlePage).toMatch(/function restoreSelectedPieceMenu\(options\)[\s\S]*?input\.reopen[\s\S]*?dismissedPieceContextId = null/)
    expect(battlePage).toMatch(/restoreSelectedPieceMenu\(\{ reopen: action\.type === 'move' \}\)/)
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

    expect(lobby).toContain("window.location.href = 'battle.html?mode=' + mode")
    expect(lobby).toContain("function goToTraining() { return goToLocalPractice('training') }")
    expect(lobby).toContain("function goToTutorial() { return goToLocalPractice('tutorial') }")
    expect(lobby).not.toMatch(/location\.href\s*=\s*['"]training\.html/)
  })

  it('keeps the tutorial opening review visible before reserve deployment begins', () => {
    const battlePage = readPage('battle.html')
    const tutorialRuntime = readFileSync(resolve(pagesDir, 'js/tutorial/tutorial-runtime.js'), 'utf8')
    const opening = battlePage.match(/async function runTutorialOpening\(\) \{([\s\S]*?)\n    \}/)?.[1] || ''

    expect(opening).not.toContain('openPlayerDeployment')
    expect(battlePage).toContain("if (stepId === 'review-defense')")
    expect(battlePage).toContain('RvBTutorialScenario.openPlayerDeployment(G, tutorialDefinition)')
    expect(tutorialRuntime).toContain("step.advance.type === 'history-item'")
    expect(tutorialRuntime).toContain('hooks.showActionHistory()')
    expect(tutorialRuntime).toContain("const historyDock = document.getElementById('actionHistoryDock')")
    expect(tutorialRuntime).toContain("historyDock.addEventListener('click', onHistoryClick, true)")
    expect(tutorialRuntime).toContain("'[data-history-root-id][aria-pressed=\"true\"]'")
    expect(tutorialRuntime).toContain('acceptHistoryTarget(clickedTarget || selectedTarget)')
  })

  it('leaves time to read the opponent action before advancing the tutorial turn', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('const TUTORIAL_OPPONENT_WINDUP_MS = 650')
    expect(battlePage).toContain('const TUTORIAL_OPPONENT_RESULT_DWELL_MS = 1400')
    expect(battlePage).toContain('await tutorialPause(TUTORIAL_OPPONENT_WINDUP_MS)')
    expect(battlePage).toContain('await tutorialPause(TUTORIAL_OPPONENT_RESULT_DWELL_MS)')
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
    expect(battlePage).toContain('RvBWs.request(method, data || {}, timeoutMs || 3500)')
    expect(battlePage).toContain('RvBWs.requestAt(getServerUrl(), method, data || {}, timeoutMs || 3500)')
    expect(battlePage).toContain("fetchServerJson('catalog.pieces')")
    expect(battlePage).toContain("fetchServerJson('catalog.skills')")
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

  it('uses the current hand-instance AP cost for card click validation', () => {
    const battlePage = readPage('battle.html')
    const submittedActions: unknown[] = []
    const statusMessages: string[] = []
    const context = createContext({
      G: {
        turn: { currentPlayerId: 'player-red' },
        players: [{
          playerId: 'player-red',
          actionPoints: 1,
          hand: [{ cardId: 'holy-charge', instanceId: 'discounted-charge', actionPointCost: 1 }],
        }],
        customCards: {},
      },
      myPlayerId: 'player-red',
      cardsById: { 'holy-charge': { id: 'holy-charge', type: 'active', actionPointCost: 2 } },
      pendingCardAction: { cardInstanceId: 'discounted-charge', cardId: 'holy-charge' },
      pendingSkill: null,
      pendingMove: false,
      selectedPieceId: null,
      isPendingHandSelection: () => false,
      setStatusMsg: (message: string) => statusMessages.push(message),
      setMoveButtonClass: () => undefined,
      renderPieceContextMenu: () => undefined,
      renderHand: () => undefined,
      doAction: (action: unknown) => submittedActions.push(action),
    })
    new Script(readNamedFunction(battlePage, 'onCardClick')).runInContext(context)

    new Script("onCardClick('discounted-charge', 'holy-charge')").runInContext(context)

    expect(JSON.parse(JSON.stringify(submittedActions))).toEqual([{
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'discounted-charge',
    }])
    expect(statusMessages).not.toContain('行动点不足（需要 2，剩余 1）')
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

  it('submits LAN and Relay actions without executing a local authority preview', async () => {
    const battlePage = readPage('battle.html')
    const sentMessages: unknown[] = []
    let actionSequence = 0
    const context = createContext({
      withClientActionId: (action: Record<string, unknown>) => ({ ...action, clientActionId: `client-${++actionSequence}` }),
      TRAINING_MODE: false,
      trainingDoAction: () => {
        throw new Error('training path should not run')
      },
      getServerUrl: () => 'http://127.0.0.1:3000',
      G: { pieces: [] },
      document: { getElementById: () => ({ disabled: false }) },
      setMoveButtonDisabled: () => undefined,
      addLog: () => undefined,
      clearTargetInteraction: () => undefined,
      setStatusMsg: () => undefined,
      renderActionBar: () => undefined,
      rejectPendingActionFeedback: () => undefined,
      roomId: 'room-red109',
      latestAuthorityVersion: 7,
      latestAuthorityStateHash: 'hash-7',
      wsMode: 'lan',
      wsRole: 'guest',
      wsConnected: true,
      relaySeq: 0,
      RvBWs: {
        isConnected: () => true,
        send: (message: unknown) => sentMessages.push(message),
      },
      createBattleActionAuth: async () => ({ signature: 'signed' }),
      myPlayerId: 'player-red',
      pendingSkill: null,
      pendingCardAction: null,
      selectedPieceId: null,
      restoreSelectedPieceMenu: () => undefined,
      GameEngine: {
        safeCloneBattleState: () => {
          throw new Error('local authority preview must not run')
        },
      },
      runDeterministicAuthorityAction: () => {
        throw new Error('local authority preview must not run')
      },
    })
new Script([
      readNamedFunction(battlePage, 'battleAuthorityCommandMessage'),
      readNamedAsyncFunction(battlePage, 'doAction'),
    ].join('\n')).runInContext(context)

    await new Script("doAction({ type: 'deploymentLock', playerId: 'player-red' })").runInContext(context)
    await new Script("doAction({ type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId: 'shot' })").runInContext(context)
    await new Script("doAction({ type: 'move', playerId: 'player-red', pieceId: 'caster', toX: 2, toY: 3 })").runInContext(context)
    context.wsMode = 'relay'
    context.wsRole = 'guest'
    await new Script("doAction({ type: 'playCard', playerId: 'player-red', cardInstanceId: 'choice-card' })").runInContext(context)

    const messages = JSON.parse(JSON.stringify(sentMessages)) as Array<Record<string, unknown>>
    expect(messages).toHaveLength(4)
    for (const [index, message] of messages.entries()) {
      expect(message).toMatchObject({
        type: 'action',
        protocolVersion: 3,
        authorityBuildId: 'rvb-authority-v3-chunked-sha256-1',
        roomId: 'room-red109',
        clientActionId: `client-${index + 1}`,
        expectedAuthorityVersion: 7,
        playerId: 'player-red',
        auth: { signature: 'signed' },
      })
      expect(message.command).toEqual(message.action)
    }
    expect(messages[0].command).toMatchObject({ type: 'deploymentLock', clientActionId: 'client-1' })
    expect(messages[1].command).toMatchObject({ type: 'useBasicSkill', clientActionId: 'client-2' })
    expect(messages[2].command).toMatchObject({ type: 'move', clientActionId: 'client-3' })
    expect(messages[3]).toMatchObject({ seq: 1, prevStateHash: 'hash-7' })
    expect(messages[3].command).toMatchObject({ type: 'playCard', clientActionId: 'client-4' })
  })

  it('does not stamp or submit an action while the authoritative conflict resync gate is active', async () => {
    const battlePage = readPage('battle.html')
    const statusMessages: string[] = []
    let stamped = false
    let sent = false
    const context = createContext({
      RvBWs: {
        isAuthoritySyncing: () => true,
        send: () => { sent = true },
      },
      withClientActionId: () => {
        stamped = true
        return { type: 'move', clientActionId: 'should-not-exist' }
      },
      setStatusMsg: (message: string) => statusMessages.push(message),
    })
    new Script(readNamedAsyncFunction(battlePage, 'doAction')).runInContext(context)

    await new Script("doAction({ type: 'move', playerId: 'player-red', pieceId: 'caster', toX: 2, toY: 3 })").runInContext(context)

    expect(stamped).toBe(false)
    expect(sent).toBe(false)
    expect(statusMessages.at(-1)).toBe('正在同步服务端状态，请等待完成后重新操作')
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
    expect(battlePage).toContain("clearTargetInteraction('turn-changed', { deferRender: input.deferRender === true })")
    expect(battlePage).toContain("clearTargetInteraction('selected-piece-unavailable', { deferRender: input.deferRender === true })")
    expect(battlePage).toContain("clearTargetInteraction('server-rejected')")
    expect(battlePage).toContain('function reconcileBattleInteractionState(previousState, nextState, options)')
    expect(battlePage).toContain('selectionId: pbc.selectionId')
    expect(battlePage).toContain('stateRevision: pbc.stateRevision')
    expect(battlePage).toContain("canCancel: pbc.canCancel !== false")
    expect(battlePage).toMatch(/const rejectedPending = [\s\S]*?targetSubmissionPending = null[\s\S]*?请重新选择/)
    expect(battlePage).toMatch(/if \(rejectedPending\)[\s\S]*?rejectPendingActionFeedback\([\s\S]*?preserveTargetInteraction: true/)
    expect(battlePage.match(/_pendingChoiceShown = null/g)?.length || 0).toBeGreaterThanOrEqual(3)
    expect(battlePage).toMatch(/pendingSelection && pendingSelection\.canCancel === false[\s\S]*?return/)
    expect(battlePage).toContain('id="optionPickerCancel"')
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

  it('renders registered status SVGs in piece detail without undefined optional metadata', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain(
      "const iconPath = t.iconPath || t.assetPath || meta.assetPath || 'images/effect-icons/fallback.svg'",
    )
    expect(battlePage).toContain('class="pi-status-icon-image" src="${escHtml(iconPath)}"')
    expect(battlePage).toContain("const description = t.description || meta.description || ''")
    expect(battlePage).toContain("description ? `<span class=\"pi-status-desc\">${escHtml(description)}</span>` : ''")
    expect(battlePage).not.toContain('escHtml(t.icon || meta.glyph)')
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
    expect(battlePage).toContain('@media (orientation: portrait)')
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
    expect(battlePage).toContain('id="deploymentStatus"')
    expect(battlePage).toContain('RvBDeploymentStatus.create')
    expect(battlePage).not.toContain('点击“确认部署”后不可更改')
    expect(battlePage).toContain('var relayActionAuth = await createBattleActionAuth(action)')
    expect(battlePage).toContain('RvBWs.send(battleAuthorityCommandMessage(action, relayActionAuth')
    expect(battlePage).toContain('已忽略旧 Relay 客户端权威动作')
    expect(battlePage).not.toContain('relayAuthorityState')
    expect(battlePage).not.toContain('runRelayAuthorityAction')
    expect(battlePage).not.toContain('publishRelayAuthorityResult')
    expect(battlePage).not.toContain("RvBWs.send({ type: 'stateUpdate'")
    expect(browserEngine).toContain('toPublicBattleState')
  })

  it('submits RED-138 deployment only from authoritative projected cells', () => {
    const battlePage = readPage('battle.html')
    const submittedActions: unknown[] = []
    const statusMessages: string[] = []
    const context = createContext({
      G: {
        pieces: [],
        deployment: {
          mode: 'progressive-reserve-v1',
          status: 'awaiting-reserve-deploy',
          revision: 17,
          activePlayerId: 'player-red',
          legalPositions: [{ x: 2, y: 3 }],
        },
      },
      myPlayerId: 'player-red',
      SPECTATE_MODE: false,
      targetSubmissionPending: false,
      pendingActionFeedback: null,
      localDeploymentChoiceId: 'tyrande-1',
      pendingOptionSelectionForOther: () => false,
      doAction: (action: unknown) => submittedActions.push(action),
      setStatusMsg: (message: string) => statusMessages.push(message),
    })
    new Script(readNamedFunction(battlePage, 'onCellClick')).runInContext(context)

    new Script('onCellClick(1, 1)').runInContext(context)
    expect(submittedActions).toEqual([])
    expect(statusMessages.at(-1)).toBe('请选择权威高亮的部署格')

    new Script('onCellClick(2, 3)').runInContext(context)
    expect(JSON.parse(JSON.stringify(submittedActions.at(-1)))).toEqual({
      type: 'deployReservePiece',
      playerId: 'player-red',
      expectedDeploymentRevision: 17,
      pieceId: 'tyrande-1',
      toX: 2,
      toY: 3,
    })

  })

  it('keeps progressive reserve deployment non-modal and returns directly to normal tagged movement', () => {
    const battlePage = readPage('battle.html')
    const reserveSelection = readNamedFunction(battlePage, 'selectReserveDeploymentPiece')
    const authorityCells = readNamedFunction(battlePage, 'authorityCellSet')

    expect(battlePage).toContain('id="deploymentChoices"')
    expect(battlePage).toContain('role="radiogroup"')
    expect(battlePage).not.toContain('id="deploymentSkip"')
    expect(battlePage).not.toContain("type: 'deploymentSkipFreeMove'")
    expect(battlePage).not.toContain("type: 'deploymentFreeMove'")
    expect(battlePage).not.toContain("'awaiting-free-move'")
    expect(battlePage.match(/expectedDeploymentRevision: deployment\.revision/g)).toHaveLength(2)
    expect(battlePage).toMatch(
      /function selectReserveDeploymentPiece\(pieceId\)[\s\S]*?!legalPositions\.length[\s\S]*?type: 'deployReservePiece'[\s\S]*?pieceId: pieceId/,
    )
    expect(reserveSelection).not.toContain('Math.random')
    expect(authorityCells).not.toMatch(/manhattan/i)
    expect(battlePage).toContain("pieceHasVisibleStatusTag(_selPiece, 'deployment-first-move-free')")
    expect(battlePage).toContain('本回合首移 0 AP')
  })

  it('keeps deployment candidate nodes stable while only the countdown refreshes', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain("let deploymentChoicesRenderKey = ''")
    expect(battlePage).toContain('if (nextChoicesKey !== deploymentChoicesRenderKey)')
    expect(battlePage).toContain('deploymentChoicesRenderKey = nextChoicesKey')
    expect(battlePage).toContain('renderTurnTimerStatus()')
  })

  it('shows authoritative reserve-candidate stats and opens read-only accessible details', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('function showDeploymentPieceInfo(pieceId, trigger, preserveKeyword)')
    expect(battlePage).toContain('function resolveDeploymentOfferPiece(pieceId)')
    expect(battlePage).toContain("G.pieceStatsByTemplateId[offer.templateId]")
    expect(battlePage).toContain('HP / 攻击 / 防御 / 移动')
    expect(battlePage).toContain('属性与技能')
    expect(battlePage).toContain('aria-label="查看候选棋子的属性与技能"')
    expect(battlePage).toContain('aria-labelledby="pieceInfoName"')
    expect(battlePage).toContain('aria-label="关闭棋子详情"')
    expect(battlePage).toContain('function handlePieceInfoModalKeydown(event)')
    expect(battlePage).toMatch(/handlePieceInfoModalKeydown[\s\S]*?event\.key === 'Escape'/)
    expect(battlePage).toMatch(/handlePieceInfoModalKeydown[\s\S]*?event\.key !== 'Tab'/)

    const inspectSource = readNamedFunction(battlePage, 'showDeploymentPieceInfo')
    expect(inspectSource).not.toContain('localDeploymentChoiceId =')
    expect(inspectSource).not.toContain('doAction(')
    expect(inspectSource).not.toContain('expectedDeploymentRevision')
    expect(battlePage).toMatch(
      /function reconcileDeploymentPieceInfo[\s\S]*?deployment\.revision !== currentPieceInfoDeploymentRevision[\s\S]*?closePieceInfo/,
    )
  })
})
