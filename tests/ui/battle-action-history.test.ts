import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')

type RootGroup = {
  rootEventId: string
  root: { eventId: string }
  children: Array<{ eventId: string }>
}

type ActionHistoryUi = {
  mount: (options: Record<string, unknown>) => void
  update: (model: Record<string, unknown>) => void
  getRoots: () => RootGroup[]
  getActiveRootId: () => string | null
}

type BrowserModule = {
  mergeRoots: (previous: RootGroup[], events: Array<Record<string, unknown>>, limit: number) => RootGroup[]
  visibleRoots: (roots: RootGroup[], limit: number) => RootGroup[]
  groupEvents: (events: Array<Record<string, unknown>>) => RootGroup[]
  highlightCells: (group: RootGroup, model: Record<string, unknown>) => Array<Record<string, unknown>>
  collapseReasons: (state: Record<string, unknown>) => string[]
  create: (options: Record<string, unknown>) => ActionHistoryUi
}

type LocalEvent = {
  preventDefault?: () => void
  stopPropagation: () => void
  target?: {
    closest: (selector: string) => { dataset: { historyRootId: string } } | null
  }
}

type HighlightElement = {
  className: string
  innerHTML: string
  setAttribute: ReturnType<typeof vi.fn>
  remove: () => void
}

function loadActionHistory() {
  const window: Record<string, unknown> = {}
  const context = createContext({ window, globalThis: window, console, setTimeout, clearTimeout })
  const iconsSource = readFileSync(resolve(pagesDir, 'js/battle-ui/battle-effect-icons.js'), 'utf8')
  const historySource = readFileSync(resolve(pagesDir, 'js/battle-ui/battle-action-history.js'), 'utf8')
  new Script(iconsSource, { filename: 'battle-effect-icons.js' }).runInContext(context)
  new Script(historySource, { filename: 'battle-action-history.js' }).runInContext(context)
  return {
    history: window.BattleActionHistory as BrowserModule,
    icons: window.BattleEffectIcons as BrowserModule,
  }
}

function rootEvent(index: number, overrides: Record<string, unknown> = {}) {
  return {
    eventId: `action-${index}:0`,
    rootEventId: `action-${index}:0`,
    parentEventId: null,
    actionId: `action-${index}`,
    sequence: 0,
    kind: 'skill',
    iconId: 'action-skill',
    actorPlayerId: 'red',
    sourcePieceId: 'source',
    targetPieceIds: ['target'],
    priority: 100,
    skippable: true,
    ...overrides,
  }
}

describe('RED-166 icon action history', () => {
  it('groups children under their root and ignores duplicate snapshot events', () => {
    const { history } = loadActionHistory()
    const root = rootEvent(1)
    const child = {
      ...rootEvent(1),
      eventId: 'action-1:1',
      parentEventId: 'action-1:0',
      sequence: 1,
      kind: 'damage',
      iconId: 'action-damage',
      result: { amount: 4 },
    }

    const once = history.mergeRoots([], [child, root], 20)
    const duplicate = history.mergeRoots(once, [root, child], 20)

    expect(duplicate).toHaveLength(1)
    expect(duplicate[0].root.eventId).toBe('action-1:0')
    expect(duplicate[0].children.map((event: { eventId: string }) => event.eventId)).toEqual(['action-1:1'])
  })

  it('keeps bounded data and renders only the latest five roots in stable newest-first order', () => {
    const { history } = loadActionHistory()
    let roots: RootGroup[] = []
    for (let index = 1; index <= 25; index += 1) {
      roots = history.mergeRoots(roots, [rootEvent(index)], 20)
    }

    expect(roots).toHaveLength(20)
    expect((roots[0] as { rootEventId: string }).rootEventId).toBe('action-6:0')
    expect(history.visibleRoots(roots, 5).map((group: { rootEventId: string }) => group.rootEventId))
      .toEqual(['action-25:0', 'action-24:0', 'action-23:0', 'action-22:0', 'action-21:0'])
    expect(history.groupEvents([])).toEqual([])

    const oneSnapshot = Array.from({ length: 20 }, (_, index) => rootEvent(index))
    expect(history.visibleRoots(history.mergeRoots([], oneSnapshot, 20), 5)
      .map((group: { rootEventId: string }) => group.rootEventId))
      .toEqual(['action-19:0', 'action-18:0', 'action-17:0', 'action-16:0', 'action-15:0'])
  })

  it('derives static source, target, and move path cells without mutating the model', () => {
    const { history } = loadActionHistory()
    const model = {
      pieces: [
        { id: 'source', x: 4, y: 4 },
        { id: 'target', x: 3, y: 2 },
      ],
    }
    const snapshot = JSON.stringify(model)
    const skillGroup = history.groupEvents([rootEvent(1, { result: null, targetCell: null })])[0]
    const moveGroup = history.groupEvents([rootEvent(2, {
      kind: 'move',
      iconId: 'action-move',
      targetPieceIds: [],
      targetCell: { x: 2, y: 1 },
      result: { fromX: 0, fromY: 0, toX: 2, toY: 1 },
    })])[0]

    expect(history.highlightCells(skillGroup, model)).toEqual([
      expect.objectContaining({ x: 4, y: 4, role: 'source' }),
      expect.objectContaining({ x: 3, y: 2, role: 'target' }),
    ])
    expect(history.highlightCells(moveGroup, model)).toEqual([
      { x: 0, y: 0, role: 'source' },
      { x: 2, y: 1, role: 'target' },
    ])
    expect(JSON.stringify(model)).toBe(snapshot)
  })

  it('collapses for target mode, narrow landscape, same-side UI, status summaries, and dialogs', () => {
    const { history } = loadActionHistory()

    expect(history.collapseReasons({ width: 1280, height: 720 })).toEqual([])
    expect(history.collapseReasons({ width: 844, height: 390 })).toEqual([
      'narrow', 'compact-landscape',
    ])
    expect(history.collapseReasons({
      width: 1280,
      height: 720,
      interactionMode: 'target',
      sameSidePopover: true,
      statusOverlay: true,
      dialog: true,
    })).toEqual(['target-mode', 'same-side-popover', 'status-overlay', 'dialog'])
  })

  it('renders unknown icons through the fallback and consumes pointer/click activation locally', () => {
    const { history, icons } = loadActionHistory()
    const listeners = new Map<string, (event: LocalEvent) => void>()
    const classNames = new Set<string>()
    const list = { innerHTML: '' }
    const collapsedButton = { setAttribute: vi.fn() }
    const dock = {
      hidden: true,
      dataset: {} as Record<string, string>,
      innerHTML: '',
      classList: {
        toggle: (name: string, value: boolean) => value ? classNames.add(name) : classNames.delete(name),
      },
      querySelector: (selector: string) => selector === '.action-history-list' ? list : collapsedButton,
      addEventListener: (type: string, listener: (event: LocalEvent) => void) => listeners.set(type, listener),
      removeEventListener: vi.fn(),
      contains: () => false,
    }
    let highlight: HighlightElement | null = null
    const floatLayer = {
      querySelector: () => highlight,
      appendChild: (element: HighlightElement) => { highlight = element },
    }
    const document = {
      getElementById: (id: string) => id === 'actionHistoryDock' ? dock : null,
      createElement: () => ({
        className: '',
        innerHTML: '',
        setAttribute: vi.fn(),
        remove: () => { highlight = null },
      }),
    }
    const window = {
      innerWidth: 1280,
      innerHeight: 720,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
    }
    const ui = history.create({
      document,
      window,
      icons,
      setTimeout: () => 1,
      clearTimeout: vi.fn(),
    })
    const model = {
      pieces: [{ id: 'source', x: 0, y: 0 }, { id: 'target', x: 1, y: 0 }],
      players: [{ id: 'red', faction: 'red' }],
      selection: { mode: 'inspect' },
      presentationEvents: [rootEvent(1, { kind: 'future', iconId: 'future-action' })],
    }
    const before = JSON.stringify(model)

    ui.mount({ element: dock, floatLayer, projectCell: (x: number, y: number) => ({ left: x * 40, top: y * 40 }) })
    ui.update(model)
    ui.update(model)

    expect(ui.getRoots()).toHaveLength(1)
    expect(list.innerHTML).toContain('images/effect-icons/fallback.svg')
    expect(list.innerHTML).toContain('aria-label="未知动作，点击高亮来源与目标"')
    expect(list.innerHTML.match(/data-history-root-id=/g)).toHaveLength(1)
    expect(JSON.stringify(model)).toBe(before)

    const pointerEvent = { stopPropagation: vi.fn() }
    listeners.get('pointerdown')?.(pointerEvent)
    expect(pointerEvent.stopPropagation).toHaveBeenCalledOnce()
    const wheelEvent = { stopPropagation: vi.fn() }
    listeners.get('wheel')?.(wheelEvent)
    expect(wheelEvent.stopPropagation).toHaveBeenCalledOnce()

    const actionButton = { dataset: { historyRootId: 'action-1:0' } }
    const hoverEvent = {
      target: {
        closest: (selector: string) => selector === '[data-history-root-id]' ? actionButton : null,
      },
    }
    listeners.get('pointerover')?.(hoverEvent as never)
    expect(ui.getActiveRootId()).toBe('action-1:0')
    listeners.get('pointerout')?.({ relatedTarget: null } as never)
    expect(ui.getActiveRootId()).toBeNull()

    const clickEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      target: {
        closest: (selector: string) => selector === '[data-history-root-id]' ? actionButton : null,
      },
    }
    listeners.get('click')?.(clickEvent)

    expect(clickEvent.preventDefault).toHaveBeenCalledOnce()
    expect(clickEvent.stopPropagation).toHaveBeenCalledOnce()
    expect(ui.getActiveRootId()).toBe('action-1:0')
    expect((highlight as HighlightElement | null)?.innerHTML).toContain('action-history-path')

    const expandEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      target: {
        closest: (selector: string) => selector === '.action-history-collapsed-button' ? collapsedButton : null,
      },
    }
    ui.update({
      ...model,
      presentationEvents: Array.from({ length: 7 }, (_, index) => rootEvent(index + 1)),
    })
    expect(list.innerHTML.match(/data-history-root-id=/g)).toHaveLength(5)
    listeners.get('click')?.(expandEvent as never)
    expect(classNames.has('is-user-expanded')).toBe(true)
    expect(list.innerHTML.match(/data-history-root-id=/g)).toHaveLength(7)
    expect(collapsedButton.setAttribute).toHaveBeenCalledWith('aria-label', '收起动作历史')

    ui.update({ ...model, selection: { mode: 'target' } })
    expect(classNames.has('is-collapsed')).toBe(true)
    expect(classNames.has('is-user-expanded')).toBe(false)
    ui.update(model)
    expect(classNames.has('is-collapsed')).toBe(false)
    expect(classNames.has('is-user-expanded')).toBe(true)

    listeners.get('pointerout')?.({ relatedTarget: null } as never)
    expect(ui.getActiveRootId()).toBe('action-1:0')
    listeners.get('click')?.(clickEvent)
    expect(ui.getActiveRootId()).toBeNull()
    expect(highlight).toBeNull()
  })

  it('renders the authoritative skill name as text without a skill icon', () => {
    const source = readFileSync(resolve(pagesDir, 'js/battle-ui/battle-action-history.js'), 'utf8')
    expect(source).toContain("event.label || event.skillId || '技能'")
    expect(source).toContain('action-history-predicate is-skill-release')
    expect(source).toContain('action-history-skill-name')
    expect(source).toMatch(/isSkillRelease[\s\S]*?rootMark = isSkillRelease[\s\S]*?action-history-skill-name/)
  })

  it('uses the mounted battlefield renderer projection for history highlights', () => {
    const window: Record<string, unknown> = {}
    const context = createContext({ window, globalThis: window, console })
    new Script(
      readFileSync(resolve(pagesDir, 'js/battle-ui/battle-presentation.js'), 'utf8'),
      { filename: 'battle-presentation.js' },
    ).runInContext(context)
    const renderer = {
      init: vi.fn(),
      projectCell: vi.fn((x: number, y: number, elevation: number) => ({ left: x * 17, top: y * 13 - elevation })),
      dispose: vi.fn(),
    }
    const historyUi = { mount: vi.fn(), dispose: vi.fn() }
    const presentation = (window.BattlePresentation as {
      create: (options: Record<string, unknown>) => {
        mount: (options: Record<string, unknown>) => void
        dispose: () => void
      }
    }).create({ renderer, domUi: { dispose: vi.fn() }, historyUi })
    const floatLayer = {}
    const historyDock = {}

    presentation.mount({ boardContainer: {}, floatLayer, historyDock })
    const mounted = historyUi.mount.mock.calls[0]?.[0] as {
      element: unknown
      floatLayer: unknown
      projectCell: (x: number, y: number, elevation: number) => unknown
    }
    expect(mounted.element).toBe(historyDock)
    expect(mounted.floatLayer).toBe(floatLayer)
    expect(mounted.projectCell(4, 3, 0.86)).toEqual({ left: 68, top: 38.14 })
    expect(renderer.projectCell).toHaveBeenCalledWith(4, 3, 0.86)
    presentation.dispose()
  })

  it('expands the new action history and gates the old text log behind an explicit debug flag', () => {
    const page = readFileSync(resolve(pagesDir, 'battle.html'), 'utf8')
    const css = readFileSync(resolve(pagesDir, 'css/battle-context-ui.css'), 'utf8')

    expect(page).toContain('id="actionHistoryDock"')
    expect(page).toContain('BattleActionHistory.create')
    expect(page).not.toContain('onOpenLog: openLog')
    expect(page).toContain("params.get('qa') === 'RED-166'")
    expect(page).toContain('red166QaPresentationEvents(snapshot)')
    expect(page).toContain('id="btnDebugBattleLog" hidden')
    expect(page).toContain("params.get('debugBattleLog') === '1'")
    expect(page).toContain('if (!DEBUG_BATTLE_LOG) return')
    expect(page).toContain('id="opponentHandStack"')
    expect(page).toContain('Math.min(10, Math.max(0, Math.trunc(opponentHandCount)))')
    expect(page).toContain('19 / (visibleCardBacks - 1)')
    expect(page).toContain('class="opponent-hand-count" aria-hidden="true">\' + visibleCardBacks')
    expect(css).toMatch(/\.action-history-dock\s*\{[\s\S]*?width:\s*52px/)
    expect(css).toMatch(/\.action-history-collapsed-button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/)
    expect(css).toContain('.action-history-dock.is-user-expanded')
    expect(css).toMatch(/\.action-history-dock\.is-user-expanded\s*\{[\s\S]*?max-height:[^;]+- 72px\)/)
    expect(css).toMatch(/\.action-history-dock\.is-user-expanded \.action-history-list\s*\{[\s\S]*?max-height:[^;]+- 142px\)/)
    expect(css).toMatch(/\.action-history-dock\.is-user-expanded \.action-history-list\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain/)
    expect(css).toContain('.action-history-sentence')
    expect(css).toContain('.opponent-hand-stack')
    expect(css).toContain('.opponent-hand-count')
    expect(css).toMatch(/\.action-history-highlight\s*\{[\s\S]*?pointer-events:\s*none/)
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.action-history-point\s*\{\s*animation:\s*none/)
  })

  it('ships distinct predicate assets for damage, AP/CP and all three hand mutations', () => {
    const icons = readFileSync(resolve(pagesDir, 'js/battle-ui/battle-effect-icons.js'), 'utf8')
    for (const asset of [
      'verb-damage.svg', 'verb-action-points.svg', 'verb-charge-points.svg',
      'verb-card-gain.svg', 'verb-card-discard.svg', 'verb-card-change.svg', 'complement-hidden.svg',
    ]) {
      expect(icons).toContain(asset)
      expect(readFileSync(resolve(pagesDir, 'images/effect-icons', asset), 'utf8')).toContain('<svg')
    }
  })
})
