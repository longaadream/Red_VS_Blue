import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function fixture() {
  const open = vi.fn()
  const selectPiece = vi.fn()
  const context = vm.createContext({ window: {}, pendingSkill: null, pendingCardAction: null, pendingActionFeedback: null,
    targetSubmissionPending: false, adventureBusy: false, pendingMove: true, validMoves: new Set(['6,5']),
    myPlayerId: 'human', G: { pieces: [{ instanceId: 'captain', ownerPlayerId: 'human', currentHp: 5, x: 5, y: 5 }] },
    adventureSnapshot: { world: { sites: [{ id: 'camp', x: 5, y: 5 }, { id: 'loot', x: 6, y: 5 }] } }, open, selectPiece })
  vm.runInContext(readFileSync('data/pages/js/adventure/world-ui.js', 'utf8'), context)
  vm.runInContext('openAdventureDialog = open', context)
  return { context, open, selectPiece, click: (x: number, y: number) => vm.runInContext(`adventureOpenCell(${x},${y})`, context) }
}
describe('adventure site click priority', () => {
  it('leaves occupied events to native selection so movement stays available', () => {
    const { click, open, selectPiece } = fixture()
    expect(click(5, 5)).toBe(false)
    expect(open).not.toHaveBeenCalled()
    expect(selectPiece).not.toHaveBeenCalled()
  })
  it('offers a separate nearby-site button without opening a modal during selection', () => {
    const { context, open, click } = fixture()
    const buttons: Array<{textContent?: string; onclick?: () => void}> = []
    const container = { hidden: true, replaceChildren: () => { buttons.length = 0 }, append: (button: typeof buttons[number]) => buttons.push(button) }
    context.document = { getElementById: () => container, createElement: () => ({}) }
    context.selectedPieceId = 'captain'; context.adventureStopped = false
    expect(click(5, 5)).toBe(false)
    vm.runInContext('refreshAdventureSiteActions()', context)
    expect(container.hidden).toBe(false)
    expect(buttons).toHaveLength(2)
    expect(open).not.toHaveBeenCalled()
    buttons[0].onclick!()
    expect(open).toHaveBeenCalledWith('site', 'camp')
    expect(click(6, 5)).toBe(false)
    context.pendingSkill = { skillId: 'targeted' }
    vm.runInContext('refreshAdventureSiteActions()', context)
    expect(container.hidden).toBe(true)
    expect(buttons).toHaveLength(0)
  })
  it('opens an empty facility when it is not a legal move target', () => {
    const { context, click, open } = fixture(); context.pendingMove = false
    expect(click(6, 5)).toBe(true)
    expect(open).toHaveBeenCalledWith('site', 'loot')
  })
  it('follows the captain after each committed action but leaves repeated renders and manual inspection alone', () => {
    const {context,selectPiece}=fixture(), focusCell=vi.fn(()=>true)
    context.window={BattleRenderer3D:{focusCell}}
    context.G.map={id:'act-map'}
    Object.assign(context.adventureSnapshot.world,{captainId:'captain',actNumber:1,seed:42})
    vm.runInContext('focusAdventureAct(); focusAdventureAct()',context)
    expect(focusCell).toHaveBeenCalledTimes(1)
    context.G.pieces[0].x=6
    vm.runInContext('focusAdventureAct()',context)
    expect(focusCell).toHaveBeenCalledTimes(1)
    context.adventureSnapshot.revision=1
    vm.runInContext('focusAdventureAct()',context)
    expect(focusCell).toHaveBeenLastCalledWith(6,5)
    expect(focusCell).toHaveBeenCalledTimes(2)
    context.adventureSnapshot.world.actNumber=2
    vm.runInContext('focusAdventureAct()',context)
    expect(focusCell).toHaveBeenLastCalledWith(6,5)
    expect(focusCell).toHaveBeenCalledTimes(3)
    vm.runInContext('selectAdventurePartyPiece(G.pieces[0])',context)
    expect(selectPiece).toHaveBeenCalledWith('captain')
    expect(focusCell).toHaveBeenCalledTimes(4)
  })
  it('returns deselection to the active battlefield, then the captain outside combat',()=>{
    const {context}=fixture(),focusCell=vi.fn(()=>true)
    Object.assign(context.window,{BattleRenderer3D:{focusCell}})
    context.G.map={id:'map'}
    Object.assign(context.adventureSnapshot.world,{captainId:'captain',active:'fight',zones:[{id:'fight',x:10,y:20,width:16,height:16}]})
    expect(context.window.focusAdventureContext()).toBe(true)
    expect(focusCell).toHaveBeenLastCalledWith(17.5,27.5)
    context.adventureSnapshot.world.active=undefined
    context.window.focusAdventureContext()
    expect(focusCell).toHaveBeenLastCalledWith(5,5)
  })
  it('preserves legal movement to an empty event cell', () => {
    const { click, open } = fixture()
    expect(click(6, 5)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
  it.each(['pendingSkill', 'pendingCardAction', 'pendingActionFeedback', 'targetSubmissionPending', 'adventureBusy'])(
    'does not intercept %s', flag => {
      const { context, click, open } = fixture(); context[flag] = true
      expect(click(5, 5)).toBe(false); expect(open).not.toHaveBeenCalled()
    })
  it.each(['pendingTargetSelection', 'pendingOptionSelection'])('preserves authoritative %s', flag => {
    const { context, click, open } = fixture(); context.G[flag] = { playerId: 'human' }
    expect(click(5, 5)).toBe(false); expect(open).not.toHaveBeenCalled()
  })
})


describe('adventure final reward presentation', () => {
  it.each([true,false])('waits for victory rewards but never delays defeat (won=%s)', won => {
    let pending=true
    const nodes = new Map<string, {textContent: string;style: Record<string,string>;querySelector: () => null}>()
    const context=vm.createContext({window:{},G:{terminalResult:{winnerPlayerId:won?'human':'enemy'}},myPlayerId:'human',recordSaved:false,
      clearTimeout:vi.fn(),adventureHasSupplyChoice:()=>pending,
      document:{getElementById:(id:string)=>{if(!nodes.has(id))nodes.set(id,{textContent:'',style:{},querySelector:()=>null});return nodes.get(id)}}})
    vm.runInContext(readFileSync('data/pages/js/adventure/battle-controller.js','utf8'),context)
    vm.runInContext('adventureSnapshot={world:{actNumber:1,actCount:1,coins:30}}; showAdventureResult()',context)
    expect(context.recordSaved).toBe(!won)
    expect(vm.runInContext('adventureStopped',context)).toBe(!won)
    if(won) {
      expect(nodes.has('resultOverlay')).toBe(false)
      pending=false;vm.runInContext('showAdventureResult()',context)
      expect(context.recordSaved).toBe(true)
      expect(vm.runInContext('adventureStopped',context)).toBe(true)
      expect(nodes.get('resultOverlay')?.style.display).toBe('flex')
      expect(nodes.get('resultSub')?.textContent).toContain('冒险完成')
    }
  })
})


describe('enemy skill intent labels',()=>{
  it('shows the authoritative skill sequence and distinguishes passive skills and allies',()=>{
    const {context}=fixture()
    context.skillDefOf=(id:string)=>({name:({'pve-sweep':'横扫','pve-hook':'肉钩'} as Record<string,string>)[id]})
    context.adventureSnapshot.aiPlayerId='enemy'
    const enemy={instanceId:'foe',ownerPlayerId:'enemy'}
    context.adventureSnapshot.world.plans=[{sourceId:'foe',kind:'move',action:{type:'move'}},{sourceId:'foe',kind:'attack',action:{skillId:'pve-sweep'}}]
    expect(context.window.adventureEnemyIntent(enemy)).toBe('下次行动：移动 → 横扫')
    expect(context.window.adventureSkillIntent(enemy,'pve-sweep',false)).toBe('即将使用')
    expect(context.window.adventureSkillIntent(enemy,'pve-hook',false)).toBe('本轮不使用')
    expect(context.window.adventureSkillIntent(enemy,'pve-overwatch',true)).toBe('条件触发')
    expect(context.window.adventureSkillIntent({instanceId:'ally',ownerPlayerId:'human'},'pve-sweep',false)).toBeNull()
    context.adventureSnapshot.world.plans=[{sourceId:'foe',kind:'attack',trackingTargetId:'captain',action:{skillId:'pve-hook'}}]
    expect(context.window.adventureEnemyIntent(enemy)).toBe('下次行动：肉钩（锁定）')
    context.adventureSnapshot.world.plans=[]
    expect(context.window.adventureEnemyIntent(enemy)).toBe('暂无行动预告')
    expect(context.window.adventureSkillIntent(enemy,'pve-hook',false)).toBe('未列入预告')
  })
})


describe('adventure card counters and casualty hints',()=>{
  it('renders current card power, passive counts and a conditional casualty hint',()=>{
    const {context}=fixture()
    context.adventureSnapshot.aiPlayerId='enemy'
    context.adventureSnapshot.world.counters={cards:{spark:{baseDamage:2,growth:6,damage:8}},passiveHits:{foe:3}}
    context.adventureSnapshot.world.forecast={complete:true,pieces:{captain:{hp:5,remainingHp:0,dies:true}}}
    const card={cardId:'spark',instanceId:'one'}
    const shown=context.window.adventureCardPresentation(card,{id:'spark',description:'原始描述'})
    expect(shown.presentation.badge).toBe('威力 8')
    expect(shown.presentation.description).toBe('原始描述')
    expect(context.window.adventureCardDetail('spark','原始描述')).toBe('威力 8（基础 2＋成长 6）\n\n原始描述')
    expect(card).toEqual({cardId:'spark',instanceId:'one'})
    expect(context.window.adventurePieceWarning({instanceId:'foe',ownerPlayerId:'enemy'})).toContain('3 次')
    expect(context.window.adventurePieceWarning({instanceId:'captain',ownerPlayerId:'human'})).toContain('预计阵亡')
  })
})


describe('adventure board warnings and reserve inspection', () => {
  it('only shows a board warning for a complete lethal forecast, and clears it as the forecast changes', () => {
    const { context } = fixture()
    context.adventureSnapshot.world.forecast = { complete: true, pieces: { captain: { dies: true } } }
    expect(vm.runInContext("window.adventureBoardWarning('captain')", context)).toBe('⚠ 预计阵亡')
    expect(vm.runInContext("window.adventureBoardWarning('other')", context)).toBe('')
    context.adventureSnapshot.world.forecast.complete = false
    expect(vm.runInContext("window.adventureBoardWarning('captain')", context)).toBe('')
    context.adventureSnapshot.world.forecast = { complete: true, pieces: {} }
    expect(vm.runInContext("window.adventureBoardWarning('captain')", context)).toBe('')
  })
  it('inspects a reserve portrait on right click without triggering deployment', () => {
    const { context } = fixture(), inspect = vi.fn(), deploy = vi.fn()
    context.showPieceInfo = inspect; context.deploy = deploy; context.PIECES_BY_ID = {}
    context.document = { createElement: () => ({ setAttribute: vi.fn(), append: vi.fn() }) }
    const portrait = vm.runInContext("adventurePortrait({instanceId:'reserve',name:'安娜',currentHp:10,maxHp:10}, deploy, '+')", context)
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    portrait.oncontextmenu(event)
    expect(inspect).toHaveBeenCalledWith('reserve')
    expect(deploy).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    portrait.onclick()
    expect(deploy).toHaveBeenCalledOnce()
  })
})
