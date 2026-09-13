import type { BattleState } from './turn'
import { areMatchAllies } from './match-teams'

export const SKILL_PRESENTATION_VERSION = 1
export type PresentationAudience = 'public' | 'owner' | 'allies' | 'enemies' | 'spectators'
export type DisplayField = 'name' | 'templateId' | 'health' | 'attack' | 'defense' | 'moveRange' | 'skills' | 'statuses'
export type PresentationLifetime = 'while-alive' | 'battle'
export interface PresentationOptions {
  id: string
  audience: PresentationAudience
  lifetime?: PresentationLifetime
  expiresTurn?: number
}
export interface DisplayBinding extends PresentationOptions {
  targetId: string
  sourceId: string
  fields: DisplayField[]
  mode: 'live' | 'snapshot'
  onSourceMissing: 'snapshot' | 'self' | 'remove'
}
export interface PresentationIndicator extends PresentationOptions {
  targetId: string
  label: string
  value: number
  max?: number
  source?: { pieceId: string; field: 'currentHp' | 'maxHp' | 'attack' | 'defense' | 'moveRange' }
}
export interface PresentationMarker extends PresentationOptions { cells: { x: number; y: number }[]; label: string; icon: string }
export interface PresentationCue extends PresentationOptions { kind: 'float' | 'flash' | 'sound'; targetId: string; text: string; sound?: 'notice' | 'success' | 'warning' }
type Display = { name?: string; templateId?: string; currentHp?: number; maxHp?: number; attack?: number; defense?: number; moveRange?: number; skills?: unknown[]; statusTags?: unknown[] }
type RecordBase = { key: string; serial: number; stream: string; ownerPlayerId: string; holderId?: string }
type PresentationRecord = RecordBase & (
  { kind: 'binding'; spec: DisplayBinding; snapshot: Display } |
  { kind: 'indicator'; spec: PresentationIndicator } |
  { kind: 'marker'; spec: PresentationMarker } |
  { kind: 'cue'; spec: PresentationCue; cell: { x: number; y: number } }
)
interface Store { version: 1; sequences: Record<string,number>; records: PresentationRecord[] }
const fields: DisplayField[] = ['name','templateId','health','attack','defense','moveRange','skills','statuses']
const audiences: PresentationAudience[] = ['public','owner','allies','enemies','spectators']
const invalid = (message: string): never => { throw new Error('skill presentation: ' + message) }
const text = (value: unknown, max = 120): string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value) ? value : invalid('invalid text')
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9 ? value : invalid('invalid number')
function copy<T>(value: T): T {
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): void => {
    if (depth > 20) invalid('JSON depth exceeded')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number') { number(item); return }
    if (!item || typeof item !== 'object' || seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) invalid('plain JSON required')
    seen.add(item as object)
    if (Object.getOwnPropertySymbols(item as object).length) invalid('symbol forbidden')
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue
      if (!('value' in descriptor) || ['__proto__','constructor','prototype'].includes(key)) invalid('unsafe JSON property')
      visit(descriptor.value, depth + 1)
    }
    seen.delete(item as object)
  }
  visit(value, 0)
  const encoded = JSON.stringify(value)
  if (encoded.length > 32768) invalid('record too large')
  return JSON.parse(encoded) as T
}
function store(battle: BattleState): Store {
  const value = battle.extensions?.skillPresentation as Store | undefined
  if (!value) return { version: 1, sequences: {}, records: [] }
  if (value.version !== 1 || !value.sequences || Object.values(value.sequences).some(v=>!Number.isSafeInteger(v)||v<0) || !Array.isArray(value.records) || value.records.length > 512) invalid('unsupported state')
  return value
}
function alive(battle: BattleState, id: string) { return battle.pieces.find(p => p.instanceId === id && p.currentHp > 0) }
function visible(battle: BattleState, audience: PresentationAudience, owner: string, viewer?: string): boolean {
  const player = battle.players.find(p => p.playerId.toLowerCase() === String(viewer ?? '').trim().toLowerCase())
  switch (audience) {
    case 'public': return true
    case 'owner': return !!player && player.playerId.toLowerCase() === owner.toLowerCase()
    case 'allies': return !!player && areMatchAllies(battle, owner, player.playerId)
    case 'enemies': return !!player && !areMatchAllies(battle, owner, player.playerId)
    case 'spectators': return !player
    default: return false
  }
}
function active(battle: BattleState, record: PresentationRecord): boolean {
  return (record.spec.expiresTurn === undefined || battle.turn.turnNumber < record.spec.expiresTurn)
    && (record.spec.lifetime !== 'while-alive' || !!record.holderId && !!alive(battle, record.holderId))
}
function readDisplay(piece: BattleState['pieces'][number], selected: DisplayField[]): Display {
  const result: Display = {}
  for (const field of selected) {
    if (field === 'health') { result.currentHp = piece.currentHp; result.maxHp = piece.maxHp }
    else if (field === 'statuses') result.statusTags = (piece.statusTags || []).filter(tag => tag.visible !== false).map(tag => Object.fromEntries(
      ['type','name','currentDuration','remainingDuration','currentUses','remainingUses','intensity','stacks'].filter(k => Object.hasOwn(tag,k) && tag[k as keyof typeof tag] !== undefined).map(k => [k, tag[k as keyof typeof tag]]),
    ))
    else if (field === 'skills') result.skills = (piece.skills || []).map(skill => ({ skillId: skill.skillId, ...(skill.currentCooldown===undefined?{}:{currentCooldown:skill.currentCooldown}) }))
    else if (field === 'name' || field === 'templateId') result[field] = String(piece[field] || '')
    else result[field] = Number(piece[field] || 0)
  }
  return copy(result)
}
/** Trusted author API: only presentation state is changed; never HP, skills or occupancy. */
export function createSkillPresentation(battle: BattleState, ownerPlayerId: string, namespace: string, holderId?: string) {
  text(namespace)
  if (!battle.players.some(p => p.playerId === ownerPlayerId)) invalid('owner missing')
  const key = (id: string) => JSON.stringify([ownerPlayerId, holderId ?? '', namespace, text(id)])
  function base<T extends PresentationOptions>(input: T, allowed: string[]): T {
    const spec = copy(input)
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) invalid('object required')
    for (const k of Object.keys(spec)) if (!['id','audience','lifetime','expiresTurn',...allowed].includes(k)) invalid('unknown field ' + k)
    text(spec.id)
    if (!audiences.includes(spec.audience)) invalid('audience required')
    spec.lifetime ??= holderId ? 'while-alive' : 'battle'
    if (!['while-alive','battle'].includes(spec.lifetime) || spec.lifetime === 'while-alive' && !holderId) invalid('invalid lifetime')
    if (spec.expiresTurn !== undefined && (!Number.isSafeInteger(spec.expiresTurn) || spec.expiresTurn < battle.turn.turnNumber)) invalid('invalid expiry')
    return spec
  }
  function put(entry: Omit<PresentationRecord, keyof RecordBase>, id: string, once = false): string {
    const current = store(battle), recordKey = key(id)
    // Each visibility/owner domain is independent: invisible writes cannot advance public IDs.
    const stream = battle.players.findIndex(p=>p.playerId===ownerPlayerId) + '-' + entry.spec.audience
    const previous = current.records.find(r => r.key === recordKey)
    if (once && previous) return 'p-' + previous.stream + '-' + previous.serial
    let retained = current.records.filter(r => r.key !== recordKey && active(battle, r))
    if (once) {
      const oldCues=retained.filter(r=>r.kind==='cue' && r.stream===stream)
      const discard=new Set(oldCues.slice(0,Math.max(0,oldCues.length-95)).map(r=>r.key))
      retained=retained.filter(r=>!discard.has(r.key))
    }
    const sequence=current.sequences[stream] || 0
    if (retained.length >= 512 || sequence >= Number.MAX_SAFE_INTEGER) invalid('state budget exceeded')
    const serial = previous?.stream===stream ? previous.serial : sequence + 1
    const record = { ...entry, key: recordKey, serial, stream, ownerPlayerId, ...(holderId ? {holderId} : {}) } as PresentationRecord
    battle.extensions ??= {}
    battle.extensions.skillPresentation = { version: 1, sequences: {...current.sequences,[stream]:Math.max(sequence,serial)}, records: [...retained, record] }
    return 'p-' + stream + '-' + serial
  }
  return {
    bind(input: DisplayBinding) {
      const spec = base(input, ['targetId','sourceId','fields','mode','onSourceMissing'])
      const target = alive(battle,text(spec.targetId)), source = alive(battle,text(spec.sourceId))
      if (!target || !source) invalid('binding source or target missing')
      if (!Array.isArray(spec.fields) || !spec.fields.length || new Set(spec.fields).size !== spec.fields.length || spec.fields.some(f => !fields.includes(f))) invalid('invalid display fields')
      if (!['live','snapshot'].includes(spec.mode) || !['snapshot','self','remove'].includes(spec.onSourceMissing)) invalid('invalid binding mode')
      return put({ kind: 'binding', spec, snapshot: readDisplay(source!, spec.fields) } as Omit<PresentationRecord, keyof RecordBase>, spec.id)
    },
    indicator(input: PresentationIndicator) {
      const spec = base(input, ['targetId','label','value','max','source'])
      if (!alive(battle,text(spec.targetId))) invalid('indicator target missing')
      text(spec.label); number(spec.value)
      if (spec.max !== undefined && number(spec.max) <= 0) invalid('positive maximum required')
      if (spec.source) {
        if (Object.keys(spec.source).some(k => !['pieceId','field'].includes(k)) || !alive(battle,text(spec.source.pieceId)) || !['currentHp','maxHp','attack','defense','moveRange'].includes(spec.source.field)) invalid('invalid indicator source')
      }
      return put({kind:'indicator',spec},spec.id)
    },
    mark(input: PresentationMarker) {
      const spec = base(input, ['cells','label','icon'])
      text(spec.label); if (!['◆','⚡','✦'].includes(spec.icon)) invalid('unsupported marker icon')
      if (!Array.isArray(spec.cells) || !spec.cells.length || spec.cells.length > 64) invalid('invalid marker cells')
      for (const cell of spec.cells) if (!cell || Object.keys(cell).some(k=>!['x','y'].includes(k)) || !Number.isInteger(cell.x) || !Number.isInteger(cell.y) || !battle.map.tiles.some(t=>t.x===cell.x&&t.y===cell.y)) invalid('invalid marker cell')
      if (new Set(spec.cells.map(c=>`${c.x},${c.y}`)).size !== spec.cells.length) invalid('duplicate cells')
      return put({kind:'marker',spec},spec.id)
    },
    emit(input: PresentationCue) {
      const spec = base(input, ['kind','targetId','text','sound'])
      const target = alive(battle,text(spec.targetId))
      if (!['float','flash','sound'].includes(spec.kind) || !target || target.x === null || target.y === null) invalid('invalid cue')
      if (spec.sound !== undefined && !['notice','success','warning'].includes(spec.sound)) invalid('invalid sound preset')
      text(spec.text)
      return put({kind:'cue',spec,cell:{x:target!.x!,y:target!.y!}} as Omit<PresentationRecord,keyof RecordBase>,spec.id,true)
    },
    remove(id: string) {
      const current = store(battle), records = current.records.filter(r=>r.key!==key(id))
      if (records.length === current.records.length) return false
      battle.extensions!.skillPresentation = {...current,records}; return true
    },
    cleanup() {
      if (battle.extensions?.skillPresentation) { const current=store(battle); battle.extensions.skillPresentation={...current,records:current.records.filter(r=>active(battle,r))} }
    },
  }
}

/** Replace private definitions with resolved display values before any client receives a snapshot. */
export function projectSkillPresentation(state: BattleState, projected: BattleState, viewer?: string): void {
  if (!state.extensions?.skillPresentation) return
  const value = store(state)
  const bindings: { id: string; targetId: string; display: Display }[] = []
  const indicators: {id: string; targetId: string; label: string; value: number; max?: number}[] = []
  const markers: {id: string; x: number; y: number; label: string; icon: string}[] = []
  const cues: {id: string; kind: string; targetId: string; x: number; y: number; text: string; sound?: string}[] = []
  for (const r of value.records) {
    if (!active(state,r) || !visible(state,r.spec.audience,r.ownerPlayerId,viewer)) continue
    const id = 'p-' + r.stream + '-' + r.serial
    if (r.kind === 'binding') {
      const target=alive(state,r.spec.targetId), source=alive(state,r.spec.sourceId)
      if (!target) continue
      const display = r.spec.mode === 'snapshot' ? r.snapshot : source ? readDisplay(source,r.spec.fields)
        : r.spec.onSourceMissing === 'snapshot' ? r.snapshot : r.spec.onSourceMissing === 'self' ? readDisplay(target,r.spec.fields) : null
      if (display) bindings.push({id,targetId:target.instanceId,display:copy(display)})
    } else if (r.kind === 'indicator') {
      if (!alive(state,r.spec.targetId)) continue
      const source=r.spec.source && alive(state,r.spec.source.pieceId)
      indicators.push({id,targetId:r.spec.targetId,label:r.spec.label,value:source && r.spec.source ? number(source[r.spec.source.field]) : r.spec.value,...(r.spec.max===undefined?{}:{max:r.spec.max})})
    } else if (r.kind === 'marker') r.spec.cells.forEach((cell,i)=>markers.push({id:id+'-'+i,...cell,label:r.spec.label,icon:r.spec.icon}))
    else if (r.kind === 'cue') {
      cues.push({id,kind:r.spec.kind,targetId:r.spec.targetId,...r.cell,text:r.spec.text,...(r.spec.sound?{sound:r.spec.sound}:{})})
    }
  }
  projected.extensions ??= {}
  // No owner/source references, snapshots, author keys or private sequence counters cross this boundary.
  projected.extensions.skillPresentation = {version:1,bindings,indicators,markers,cues}
}
