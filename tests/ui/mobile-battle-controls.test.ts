import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

class Element {
  id = ''; type = ''; textContent = ''; hidden = false; disabled = false; inert = false
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  children: Element[] = []
  events: Record<string, () => void> = {}
  classes = new Set<string>()
  classList = { contains: (s: string) => this.classes.has(s), toggle: (s: string, on: boolean) => on ? this.classes.add(s) : this.classes.delete(s) }
  append(e: Element) { this.children.push(e) }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  getAttribute(k: string) { return this.attrs[k] }
  querySelectorAll() { return this.children }
  addEventListener(k: string, fn: () => void) { this.events[k] = fn }
  click() { if (!this.disabled) this.events.click?.() }
}
function harness() {
  const hand = new Element(), menu = new Element(), body = new Element(), layout = new Element()
  const card = new Element(); card.dataset.instanceId = 'c1'; card.setAttribute('aria-disabled', 'false'); hand.append(card)
  const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  const nativeCard = vi.fn(), show = vi.fn(), close = vi.fn()
  const context = {
    matchMedia: () => media, document: { body, createElement: () => new Element(), getElementById: (id: string) => id === 'handCards' ? hand : menu, querySelector: () => layout },
    G: { players: [{playerId:'me', hand:[{instanceId:'c1'}]}], pieces:[{instanceId:'p1'}], pendingOptionSelection: null as null | {hand: boolean} },
    myPlayerId:'me', selectedPieceId: null as string | null, dismissedPieceContextId: null,
    pendingSkill: null as string | null, pendingMove:false, pendingCardAction:null, targetSubmissionPending:false, pendingActionFeedback:false,
    isPendingHandSelection: (p: null | {hand: boolean}) => !!p?.hand,
    pendingTargetSelectionForMe: () => false, pendingOptionSelectionForMe: () => !!context.G.pendingOptionSelection,
    onCardClick: nativeCard, showCardDetail: show, closeCardDetail: close, closePieceInfo: vi.fn(),
    renderHand: vi.fn(), renderActionBar:vi.fn(), showPieceInfo:vi.fn(), setTileStatusExpanded:vi.fn(), renderPieceContextMenu: vi.fn(), dismissPieceContextMenu: vi.fn(), render: vi.fn(), addEventListener: vi.fn(),
  }
  const live = Object.assign(context, {window:context})
  runInNewContext(readFileSync(resolve('data/pages/js/battle-ui/mobile-battle-controls.js'), 'utf8'), live)
  return {context, live, media, hand, body, layout, nativeCard, show, close, toggle:body.children.find(e=>e.id==='mobileHandToggle')!, dock:body.children.find(e=>e.id==='mobileDockToggle')!, play:layout.children.at(-1)!}
}
describe('mobile battle focus controls', () => {
  it('explicitly folds the whole dock without losing selection; rendering does not reopen it', () => {
    const h=harness(); h.live.selectedPieceId='p1'; h.context.render()
    expect(h.body.classes.has('mobile-dock-collapsed')).toBe(false)
    h.dock.click(); h.context.render()
    expect(h.live.selectedPieceId).toBe('p1')
    expect(h.body.classes.has('mobile-dock-collapsed')).toBe(true)
    h.dock.click()
    expect(h.body.classes.has('mobile-dock-collapsed')).toBe(false)
  })
  it('forced hand selection overrides an explicitly folded dock', () => {
    const h=harness(); h.live.selectedPieceId='p1'; h.context.render(); h.dock.click()
    h.context.G.pendingOptionSelection={hand:true}; h.context.render()
    expect(h.body.classes.has('mobile-dock-collapsed')).toBe(false)
    expect(h.dock.disabled).toBe(true); expect(h.hand.inert).toBe(false)
  })
  it('collapses tile details on entering movement, but allows reopening while inspecting', () => {
    const h=harness(); h.live.pendingMove=true; h.context.renderActionBar()
    expect(h.context.setTileStatusExpanded).toHaveBeenCalledExactlyOnceWith(false)
    h.context.setTileStatusExpanded.mockClear(); h.context.renderActionBar()
    expect(h.context.setTileStatusExpanded).not.toHaveBeenCalled()
  })
  it('collapses tile details on skill targeting and explicit character inspection', () => {
    const h=harness(); h.live.pendingSkill='s1'; h.context.renderActionBar()
    expect(h.context.setTileStatusExpanded).toHaveBeenCalledWith(false)
    h.context.setTileStatusExpanded.mockClear(); h.context.showPieceInfo('p1')
    expect(h.context.setTileStatusExpanded).toHaveBeenCalledExactlyOnceWith(false)
  })
  it('starts folded; tapping a card previews without issuing a play command', () => {
    const h = harness(); expect(h.hand.inert).toBe(true)
    h.toggle.click(); expect(h.hand.inert).toBe(false)
    h.context.onCardClick('c1', 'card'); expect(h.show).toHaveBeenCalledWith('c1', 'card'); expect(h.nativeCard).not.toHaveBeenCalled()
    h.play.click(); expect(h.nativeCard).toHaveBeenCalledExactlyOnceWith('c1', 'card', true)
    h.play.click(); expect(h.nativeCard).toHaveBeenCalledTimes(1)
  })
  it('forces hand choices open and routes them through the existing selection handler', () => {
    const h = harness(); h.context.G.pendingOptionSelection = {hand:true}; h.context.renderHand()
    expect(h.hand.inert).toBe(false); expect(h.toggle.disabled).toBe(true)
    h.context.onCardClick('c1', 'card'); expect(h.nativeCard).toHaveBeenCalledWith('c1', 'card'); expect(h.show).not.toHaveBeenCalled()
  })
  it('folds the hand when choosing a skill target', () => {
    const h = harness(); h.toggle.click(); h.live.pendingSkill = 'skill'; h.context.render()
    expect(h.hand.inert).toBe(true)
  })
  it('preserves desktop card clicks and hand access', () => {
    const h = harness(); h.media.matches = false; h.context.render()
    expect(h.hand.inert).toBe(false)
    h.context.onCardClick('c1', 'card'); expect(h.nativeCard).toHaveBeenCalledWith('c1', 'card'); expect(h.show).not.toHaveBeenCalled()
  })
  it('closes a preview when a required hand choice arrives', () => {
    const h = harness(); h.context.onCardClick('c1','card'); h.context.G.pendingOptionSelection = {hand:true}; h.context.render()
    expect(h.close).toHaveBeenCalledOnce(); expect(h.hand.inert).toBe(false); expect(h.play.hidden).toBe(true)
  })
  it('closes a preview when target selection starts', () => {
    const h = harness(); h.context.onCardClick('c1','card'); h.live.pendingSkill = 's1'; h.context.render()
    expect(h.close).toHaveBeenCalledOnce(); expect(h.hand.inert).toBe(true); expect(h.play.hidden).toBe(true)
  })
  it('allows reading a candidate after a required choice has opened', () => {
    const h = harness(); h.context.G.pendingOptionSelection = {hand:true}; h.context.renderHand()
    h.context.showCardDetail('c1','card'); h.context.render()
    expect(h.show).toHaveBeenCalledOnce(); expect(h.close).not.toHaveBeenCalled(); expect(h.play.hidden).toBe(true)
  })
})
