import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const rootDir = process.cwd()
const pagesDir = resolve(rootDir, 'data/pages')

function loadBrowserModule(relativePath: string, exportName: string, window: Record<string, unknown> = {}) {
  const context = createContext({ window, globalThis: window, console })
  const source = readFileSync(resolve(pagesDir, relativePath), 'utf8')
  new Script(source, { filename: relativePath }).runInContext(context)
  // Browser modules intentionally expose untyped JS APIs to this contract test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return window[exportName] as Record<string, any>
}

function jsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) return jsonFiles(fullPath)
    return extname(entry.name) === '.json' ? [fullPath] : []
  })
}

function discoverLiteralStatusTypes(): string[] {
  const patterns = [
    /add(?:Player)?StatusEffectById\([\s\S]{0,1400}?\btype\s*:\s*['"]([^'"]+)['"]/g,
    /statusTags\.push\(\s*\{[\s\S]{0,1400}?\btype\s*:\s*['"]([^'"]+)['"]/g,
    /statusTags\s*:\s*\[\s*\{[\s\S]{0,1400}?\btype\s*:\s*['"]([^'"]+)['"]/g,
  ]
  const types = new Set<string>()
  for (const file of jsonFiles(resolve(rootDir, 'data'))) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of source.matchAll(pattern)) types.add(match[1])
    }
  }
  return [...types].sort()
}

function discoverLiteralTileEffectTypes(): string[] {
  const pattern = /\btileType\s*:\s*['"]([^'"]+)['"]/g
  const types = new Set<string>()
  for (const file of jsonFiles(resolve(rootDir, 'data'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(pattern)) types.add(match[1])
  }
  return [...types].sort()
}

describe('RED-165 battle effect icon registry', () => {
  it('classifies every current literal status type instead of silently showing new bookkeeping tags', () => {
    const icons = loadBrowserModule('js/battle-ui/battle-effect-icons.js', 'BattleEffectIcons')
    const discovered = discoverLiteralStatusTypes()
    discovered.push('deployment-first-move-free')
    discovered.sort()

    expect(discovered.length).toBeGreaterThan(35)
    expect(Object.keys(icons.statusRegistry).sort()).toEqual(expect.arrayContaining(discovered))
    for (const type of discovered) {
      const meta = icons.resolveStatusType(type)
      expect(['board', 'hidden'], type).toContain(meta.visibility)
      expect(meta.iconId, type).toBeTruthy()
      expect(meta.assetPath, type).toMatch(/^images\/(?:effect-icons|tile-effects)\/[a-z0-9-]+\.svg$/)
      expect(meta.assetPath, type).not.toMatch(/[\u{1F000}-\u{1FAFF}\uFE0F]/u)
    }
    const registryEntries = Object.values(icons.statusRegistry) as Array<{ visibility: string; label?: string }>
    const playerFacing = registryEntries.filter((meta) => meta.visibility !== 'hidden')
    expect(playerFacing.length).toBeGreaterThan(30)
    expect(playerFacing.every((meta) => meta.visibility === 'board')).toBe(true)
    expect(playerFacing.every((meta) => typeof meta.label === 'string' && meta.label.trim().length > 0)).toBe(true)
  })

  it('keeps named mechanics distinct, shares semantic fallbacks, and hard-hides bookkeeping', () => {
    const icons = loadBrowserModule('js/battle-ui/battle-effect-icons.js', 'BattleEffectIcons')

    expect(icons.resolveStatusType('amaterasu-burn')).toMatchObject({
      iconId: 'amaterasu',
      category: 'damage-over-time',
      visibility: 'board',
    })
    expect(icons.resolveStatusType('divine-shield')).toMatchObject({
      iconId: 'divine-shield',
      category: 'shield',
      visibility: 'board',
    })
    expect(icons.resolveStatusType('freeze')).toMatchObject({ iconId: 'freeze', visibility: 'board' })
    expect(icons.resolveStatusType('imprisoned')).toMatchObject({
      iconId: 'imprisoned', assetPath: 'images/effect-icons/imprisoned.svg', label: '禁锢', visibility: 'board',
    })
    expect(icons.resolveStatusType('resurreccion')).toMatchObject({
      iconId: 'resurreccion', assetPath: 'images/effect-icons/resurreccion.svg', label: '归刃', visibility: 'board',
    })
    expect(icons.resolveStatusType('damage-buff')).toMatchObject({
      iconId: 'empowered', assetPath: 'images/effect-icons/empowered.svg', label: '强化', visibility: 'board',
    })
    expect(icons.resolveStatusType('damage-multiplier')).toMatchObject({
      iconId: 'damage-multiplier', assetPath: 'images/effect-icons/damage-multiplier.svg', label: '飞天御剑流', visibility: 'board',
    })
    expect(icons.resolveStatusType('icebound-fortitude')).toMatchObject({
      category: 'shield', label: '寒冰坚忍', visibility: 'board',
    })
    expect(icons.resolveStatusType('calm-shield')).toMatchObject({
      category: 'shield', label: '平静护盾', visibility: 'board',
    })
    expect(icons.resolveStatusType('aizen-kyoka-active').visibility).toBe('hidden')
    expect(icons.resolveStatusType('aizen-kyoka-secret').visibility).toBe('hidden')
    expect(icons.resolveStatusType('chidori-immobile').iconId)
      .toBe(icons.resolveStatusType('venom-corrosion-immobile').iconId)
    expect(icons.resolveStatusType('shishio-cooldown-fired').visibility).toBe('hidden')
    expect(icons.resolveStatusType('shishio-dmg-counter').visibility).toBe('hidden')
    expect(icons.resolveStatusType('hidan-undying-used').visibility).toBe('hidden')
    expect(icons.resolveStatusType('curse-ward-used').visibility).toBe('hidden')
  })

  it('gives every current literal tile effect a player-facing name', () => {
    const icons = loadBrowserModule('js/battle-ui/battle-effect-icons.js', 'BattleEffectIcons')
    const tileEffectTypes = discoverLiteralTileEffectTypes()

    expect(tileEffectTypes.length).toBeGreaterThanOrEqual(6)
    for (const type of tileEffectTypes) {
      expect(icons.statusRegistry[type], type).toBeTruthy()
      expect(icons.resolveStatusType(type).label, type).toEqual(expect.any(String))
      expect(icons.resolveStatusType(type).label.trim(), type).not.toBe('')
    }
  })

  it('lets authoritative visible false win and gives unknown player-visible statuses a real fallback icon', () => {
    const icons = loadBrowserModule('js/battle-ui/battle-effect-icons.js', 'BattleEffectIcons')

    expect(icons.resolveStatus({ type: 'divine-shield', visible: false }).visibility).toBe('hidden')
    expect(icons.resolveStatus({ type: 'future-visible-effect' })).toMatchObject({
      iconId: 'fallback',
      category: 'unknown',
      visibility: 'board',
      assetPath: 'images/effect-icons/fallback.svg',
    })
    expect(icons.badge({ stacks: 3, currentDuration: 2, currentUses: 1, intensity: 8 })).toEqual({
      stacks: 3,
      duration: 2,
      uses: 1,
      intensity: 8,
    })
  })

  it('resolves every presentation-event action icon without emoji or an empty asset', () => {
    const icons = loadBrowserModule('js/battle-ui/battle-effect-icons.js', 'BattleEffectIcons')
    const actionIconIds = [
      'action-move', 'action-deploy', 'action-skill', 'action-charge-skill', 'action-card',
      'action-end-turn', 'action-automatic', 'action-choice', 'action-passive', 'action-block',
      'action-damage', 'action-heal', 'action-force-move', 'action-spawn', 'action-death',
      'action-eliminated', 'action-action-points', 'action-charge-points', 'action-card-gain',
      'action-card-discard', 'action-card-change', 'action-tile-change', 'action-tile-effect-add',
      'action-tile-effect-remove', 'action-stat-change', 'action-redirect', 'status-add',
      'status-remove', 'result-hidden',
    ]
    for (const iconId of actionIconIds) {
      expect(icons.resolveAction(iconId)).toMatchObject({ iconId })
      expect(icons.resolveAction(iconId).assetPath).toMatch(/^images\/effect-icons\/[a-z0-9-]+\.svg$/)
      expect(icons.resolveAction(iconId).assetPath).not.toMatch(/[\u{1F000}-\u{1FAFF}\uFE0F]/u)
    }
    expect(icons.resolveAction('future-action').iconId).toBe('fallback')
  })

  it('keeps every registered icon path backed by a shipped SVG asset', () => {
    const icons = loadBrowserModule('js/battle-ui/battle-effect-icons.js', 'BattleEffectIcons')
    const entries = [
      ...Object.values(icons.statusRegistry),
      ...Object.values(icons.actionRegistry),
      icons.resolveStatusType('future-status'),
    ] as Array<{ assetPath: string }>
    for (const entry of entries) {
      expect(entry.assetPath, entry.assetPath).toMatch(/^images\//)
      const relative = entry.assetPath.replace(/^images\//, '')
      expect(
        existsSync(resolve(rootDir, 'public', relative)) || existsSync(resolve(pagesDir, 'images', relative)),
        entry.assetPath,
      ).toBe(true)
    }
  })

  it('projects only player-facing statuses into the view model with icon metadata', () => {
    const window: Record<string, unknown> = {}
    loadBrowserModule('js/battle-ui/battle-effect-icons.js', 'BattleEffectIcons', window)
    const viewModel = loadBrowserModule('js/battle-ui/battle-view-model.js', 'BattleViewModel', window)
    const model = viewModel.create({
      viewerId: 'red',
      selectedPieceId: 'piece-red',
      presentationEvents: [{
        eventId: 'action-1:0', rootEventId: 'action-1:0', actionId: 'action-1', sequence: 0,
        kind: 'skill', iconId: 'action-skill', actorPlayerId: 'red', sourcePieceId: 'piece-red',
        presentation: {
          cue: 'projectile', selectedCell: { x: 0, y: 0 }, pathCells: [{ x: 0, y: 0 }],
          endPoint: { x: 0, y: 0 }, endReason: 'hit',
          collisions: [{ kind: 'piece', x: 0, y: 0, pieceId: 'piece-red', blocking: true }],
          areaCells: [{ x: 0, y: 0 }], ignored: 'not-public',
        },
        priority: 100, skippable: true, message: '客户端不消费这段日志文字',
      }],
      snapshot: {
        map: { id: 'm', width: 1, height: 1, tiles: [] },
        pieces: [{
          instanceId: 'piece-red', templateId: 'red', ownerPlayerId: 'red', faction: 'red',
          x: 0, y: 0, currentHp: 10, maxHp: 10,
          statusTags: [
            { id: 'shield', type: 'divine-shield', name: '圣盾' },
            { id: 'counter', type: 'shishio-dmg-counter', name: '内部计数' },
            { id: 'future', type: 'future-visible-effect', name: '未来效果' },
          ],
        }],
        players: [{ playerId: 'red', name: 'Red', actionPoints: 1, chargePoints: 0 }],
        turn: { currentPlayerId: 'red', turnNumber: 1, phase: 'action' },
      },
    })

    expect(model.selection.piece.statuses.map((status: { id: string }) => status.id)).toEqual(['shield', 'future'])
    expect(model.selection.piece.statuses[0]).toMatchObject({
      type: 'divine-shield',
      iconId: 'divine-shield',
      iconPath: 'images/effect-icons/divine-shield.svg',
      visibility: 'board',
    })
    expect(model.selection.piece.statuses[1]).toMatchObject({ iconId: 'fallback' })
    expect(model.presentationEvents).toEqual([expect.objectContaining({
      eventId: 'action-1:0', kind: 'skill', iconId: 'action-skill', sourcePieceId: 'piece-red',
      presentation: {
        cue: 'projectile', selectedCell: { x: 0, y: 0 }, pathCells: [{ x: 0, y: 0 }],
        endPoint: { x: 0, y: 0 }, endReason: 'hit',
        collisions: [{ kind: 'piece', x: 0, y: 0, pieceId: 'piece-red', blocking: true }],
        areaCells: [{ x: 0, y: 0 }],
      },
    })])
    expect(model.presentationEvents[0]).not.toHaveProperty('message')
  })
})
