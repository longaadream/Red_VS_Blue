import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { aiEnvironmentV1, listLegalAIActions } from '@/lib/game/ai-environment'
import { toPublicBattleState } from '@/lib/game/deployment'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

type Attribute = { name: string; value: string }

class FakeElement {
  readonly attributes: Attribute[] = []
  hidden = false
  textContent = '旧标签'
  className = 'pi-identity core'
  title = '旧提示'

  setAttribute(name: string, value: string) {
    const existing = this.attributes.find(attribute => attribute.name === name)
    if (existing) existing.value = String(value)
    else this.attributes.push({ name, value: String(value) })
    if (name === 'class') this.className = String(value)
    if (name === 'title') this.title = String(value)
  }

  getAttribute(name: string) {
    return this.attributes.find(attribute => attribute.name === name)?.value ?? null
  }

  removeAttribute(name: string) {
    const index = this.attributes.findIndex(attribute => attribute.name === name)
    if (index >= 0) this.attributes.splice(index, 1)
    if (name === 'class') this.className = ''
    if (name === 'title') this.title = ''
  }
}

class FakeDocument {
  readonly badge = new FakeElement()

  getElementById(id: string) {
    return id === 'pieceInfoIdentity' ? this.badge : null
  }
}

type Piece = {
  instanceId: string
  templateId: string
  ownerPlayerId: string
  currentHp: number
  isCore: boolean
  masterPieceId?: string
}
type PublicSnapshot = { pieces: Piece[]; graveyard?: Piece[] }

function piece(overrides: Partial<Piece> = {}): Piece {
  return {
    instanceId: 'source',
    templateId: 'test-piece',
    ownerPlayerId: 'player-blue',
    currentHp: 10,
    isCore: true,
    ...overrides,
  }
}

function loadRenderer(document: FakeDocument, values: {
  G: { pieces: Piece[]; graveyard?: Piece[] }
  myPlayerId: string
  SPECTATE_MODE: boolean
}) {
  const context = createContext({
    document,
    G: values.G,
    myPlayerId: values.myPlayerId,
    SPECTATE_MODE: values.SPECTATE_MODE,
  })
  const page = readFileSync('data/pages/battle.html', 'utf8')
  const renderStart = page.indexOf('    function renderPieceIdentity(')
  const end = page.indexOf('    function renderPieceInfoRecord(', renderStart)
  const helperStart = page.indexOf('    function pieceIdentityDisguiseGroup(')
  if (renderStart < 0 || end < 0) throw new Error('RED-253 identity renderer is missing')
  const helper = helperStart >= 0
    ? page.slice(helperStart, renderStart)
    : 'function shouldHidePieceIdentityBadge() { return false }\n'
  new Script(helper + page.slice(renderStart, end), { filename: 'battle.html:red253-badge' }).runInContext(context)
  return {
    render: (target: Piece) => {
      context.piece = target
      return new Script('renderPieceIdentity(piece)', { filename: 'battle.html:red253-call' }).runInContext(context)
    },
    badge: document.badge,
  }
}

function expectHidden(badge: FakeElement) {
  expect(badge.hidden).toBe(true)
  expect(badge.textContent).toBe('')
  expect(badge.title).toBe('')
  expect(badge.getAttribute('aria-label')).toBe('')
  expect(badge.className).toBe('pi-identity')
}

function createRealNarutoFixture() {
  const naruto = Object.assign(makePiece({
    instanceId: 'naruto',
    templateId: 'blue-naruto',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 1,
    y: 1,
    currentHp: 67,
    maxHp: 123,
    attack: 11,
    moveRange: 5,
  }), { name: '鸣人', isCore: true })
  naruto.skills = [{ skillId: 'naruto-shadow-clone', currentCooldown: 0, usesRemaining: -1 }]
  const state = makeState({
    pieces: [naruto],
    currentPlayerId: 'player-blue',
    width: 6,
    height: 5,
  })
  state.players.find(player => player.playerId === 'player-blue')!.actionPoints = 10
  state.skillsById['naruto-shadow-clone'] = JSON.parse(
    readFileSync(resolve(process.cwd(), 'data/skills/naruto-shadow-clone.json'), 'utf8'),
  )
  const action = listLegalAIActions(state, 'player-blue').find(candidate => (
    candidate.kind === 'basic-skill'
    && candidate.action.type === 'useBasicSkill'
    && candidate.action.skillId === 'naruto-shadow-clone'
    && candidate.action.selectedOption === 'summon'
    && candidate.action.targetX === 2
    && candidate.action.targetY === 1
  ))
  if (!action) throw new Error('RED-253 Naruto summon fixture action is missing')
  const result = aiEnvironmentV1.simulate(state, action, { rootSeed: 0x8b0253 })
  if (!result.accepted) throw new Error('RED-253 Naruto summon fixture was rejected')
  return { state: result.state, sourceId: naruto.instanceId }
}

function roundTripPublicProjection(state: BattleState): PublicSnapshot {
  return JSON.parse(JSON.stringify(toPublicBattleState(state, 'red253-spectator'))) as PublicSnapshot
}

describe('RED-253 core badge privacy', () => {
  it('masks an active clone group for an enemy while preserving raw owner labels', () => {
    const source = piece({ instanceId: 'blue-source' })
    const clone = piece({ instanceId: 'blue-clone', isCore: false, masterPieceId: source.instanceId, currentHp: 1 })
    const enemy = loadRenderer(new FakeDocument(), {
      G: { pieces: [source, clone] }, myPlayerId: 'player-red', SPECTATE_MODE: false,
    })

    enemy.render(source)
    expectHidden(enemy.badge)
    enemy.render(clone)
    expectHidden(enemy.badge)
    expect(source.isCore).toBe(true)
    expect(clone.isCore).toBe(false)

    const ownerDocument = new FakeDocument()
    const owner = loadRenderer(ownerDocument, {
      G: { pieces: [source, clone] }, myPlayerId: 'PLAYER-BLUE', SPECTATE_MODE: false,
    })
    owner.render(source)
    expect(ownerDocument.badge.hidden).toBe(false)
    expect(ownerDocument.badge.textContent).toBe('核心棋子')
    owner.render(clone)
    expect(ownerDocument.badge.hidden).toBe(false)
    expect(ownerDocument.badge.textContent).toBe('非核心棋子')
  })

  it('masks a graveyard source while its clone is alive, but restores a live source after clone death', () => {
    const source = piece({ instanceId: 'fallen-source', currentHp: 0 })
    const clone = piece({ instanceId: 'live-clone', isCore: false, masterPieceId: source.instanceId, currentHp: 1 })
    const document = new FakeDocument()
    const renderer = loadRenderer(document, {
      G: { pieces: [clone], graveyard: [source] }, myPlayerId: 'player-red', SPECTATE_MODE: false,
    })

    renderer.render(source)
    expectHidden(document.badge)

    const liveSource = piece({ instanceId: 'live-source' })
    const deadClone = piece({ instanceId: 'dead-clone', isCore: false, masterPieceId: liveSource.instanceId, currentHp: 0 })
    const restored = loadRenderer(document, {
      G: { pieces: [liveSource], graveyard: [deadClone] }, myPlayerId: 'player-red', SPECTATE_MODE: false,
    })
    restored.render(liveSource)
    expect(document.badge.hidden).toBe(false)
    expect(document.badge.textContent).toBe('核心棋子')
  })

  it('keeps a missing-source clone masked and clears stale DOM fields when switching back to an ordinary piece', () => {
    const clone = piece({ instanceId: 'snapshot-clone', isCore: false, masterPieceId: 'missing-source', currentHp: 1 })
    const ordinary = piece({ instanceId: 'ordinary', isCore: false })
    const document = new FakeDocument()
    const renderer = loadRenderer(document, {
      G: { pieces: [clone] }, myPlayerId: 'player-red', SPECTATE_MODE: false,
    })

    renderer.render(clone)
    expectHidden(document.badge)
    renderer.render(ordinary)
    expect(document.badge.hidden).toBe(false)
    expect(document.badge.textContent).toBe('非核心棋子')
    expect(document.badge.className).toBe('pi-identity non-core')
    expect(document.badge.title).toContain('非核心棋子')
    expect(document.badge.getAttribute('aria-label')).toContain('非核心棋子')
    renderer.render(clone)
    expectHidden(document.badge)
    renderer.render(ordinary)
    expect(document.badge.hidden).toBe(false)
  })

  it('keeps raw and projected spectator views from exposing identity through the badge', () => {
    const source = piece({ instanceId: 'spectator-source' })
    const clone = piece({ instanceId: 'spectator-clone', isCore: false, masterPieceId: source.instanceId, currentHp: 1 })
    const document = new FakeDocument()
    const renderer = loadRenderer(document, {
      G: { pieces: [source, clone] }, myPlayerId: 'player-blue', SPECTATE_MODE: true,
    })
    renderer.render(source)
    expectHidden(document.badge)
    renderer.render(clone)
    expectHidden(document.badge)

    const projectedSource = piece({ instanceId: 'projected-source' })
    const projectedClone = piece({ instanceId: 'projected-clone', isCore: false })
    const projectedDocument = new FakeDocument()
    const projected = loadRenderer(projectedDocument, {
      G: { pieces: [projectedSource, projectedClone] }, myPlayerId: 'player-blue', SPECTATE_MODE: true,
    })
    projected.render(projectedSource)
    expectHidden(projectedDocument.badge)
    projected.render(projectedClone)
    expectHidden(projectedDocument.badge)
  })

  it('masks real spectator JSON after source death and source omission', () => {
    const fixture = createRealNarutoFixture()
    const deadSourceState = structuredClone(fixture.state)
    const deadSource = deadSourceState.pieces.find(target => target.instanceId === fixture.sourceId)
    if (!deadSource) throw new Error('RED-253 Naruto fixture source disappeared before dead-source projection')
    deadSourceState.pieces = deadSourceState.pieces.filter(target => target.instanceId !== fixture.sourceId)
    deadSourceState.graveyard = [...(deadSourceState.graveyard ?? []), { ...deadSource, currentHp: 0 }]
    const missingSourceState = structuredClone(fixture.state)
    missingSourceState.pieces = missingSourceState.pieces.filter(target => target.instanceId !== fixture.sourceId)

    const liveSnapshot = roundTripPublicProjection(fixture.state)
    const deadSourceSnapshot = roundTripPublicProjection(deadSourceState)
    const missingSourceSnapshot = roundTripPublicProjection(missingSourceState)
    expect(liveSnapshot.pieces.every(target => target.isCore === true)).toBe(true)
    expect(deadSourceSnapshot.pieces.some(target => target.isCore === false)).toBe(true)
    expect(missingSourceSnapshot.pieces.every(target => target.isCore === false)).toBe(true)

    for (const snapshot of [liveSnapshot, deadSourceSnapshot, missingSourceSnapshot]) {
      const document = new FakeDocument()
      const renderer = loadRenderer(document, {
        G: { pieces: snapshot.pieces, graveyard: snapshot.graveyard },
        myPlayerId: 'player-blue',
        SPECTATE_MODE: true,
      })
      for (const target of [...snapshot.pieces, ...(snapshot.graveyard ?? [])]) {
        renderer.render(target)
        expectHidden(document.badge)
      }
    }
  })

  it('does not infer disguise from names, template-like ids, or an ordinary non-core piece', () => {
    const ordinary = piece({ instanceId: 'naruto-clone-looking-id', templateId: 'blue-summon', isCore: false })
    const ordinaryCore = piece({ instanceId: 'ordinary-core', isCore: true })
    const document = new FakeDocument()
    const renderer = loadRenderer(document, {
      G: { pieces: [ordinary, ordinaryCore] }, myPlayerId: 'player-red', SPECTATE_MODE: false,
    })
    renderer.render(ordinary)
    expect(document.badge.hidden).toBe(false)
    expect(document.badge.textContent).toBe('非核心棋子')
    renderer.render(ordinaryCore)
    expect(document.badge.hidden).toBe(false)
    expect(document.badge.textContent).toBe('核心棋子')
  })
})
