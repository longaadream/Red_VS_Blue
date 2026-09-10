import { z } from 'zod'
import { ContentIdV1Schema, SemVerV1Schema } from '@/lib/content-pipeline/contracts/primitives-v1'
import { PackPayloadPathV1Schema } from '@/lib/content-pipeline/contracts/pack-v1'

const id = ContentIdV1Schema
const text = z.string().min(1)
const uint = z.number().int().nonnegative()
const position = z.object({ x: uint, y: uint }).strict()
const ids = z.array(id).min(1).refine(items => new Set(items).size === items.length, 'Duplicate ID')
const zone = z.object({ id, name: text, x: uint, y: uint, width: uint.positive(), height: uint.positive(),
  enemyIds: ids, coreIds: ids, reward: uint }).strict()
const enemy = z.object({ id, templateId: id, zone: id, tier: z.enum(['minion','elite','boss']),
  role: text, ip: text, core: z.boolean(), x: uint, y: uint }).strict()
const site = z.object({ id, name: text, x: uint, y: uint, kind: z.enum(['camp','loot','encounter','recruit']), detail: text }).strict()

export const RoguelikeAdventureV1Schema = z.object({
  schemaVersion: z.literal('rvb-pve-roguelike-adventure/v1'), id, version: SemVerV1Schema, name: text,
  map: z.object({ id, name: text, layout: z.array(z.string().regex(/^[.#CO]+$/)).min(1).max(256) }).strict(),
  party: z.object({ humanId: id, enemyId: id, seed: uint.max(0xffffffff), pieceIds: ids }).strict(),
  generation: z.object({ algorithm: z.literal('landmark-routes-v1'), placementShift: uint.max(8),
    sceneryDensity: z.number().min(0).max(.3), mirror: z.boolean() }).strict().optional(),
  recruitment: z.object({ pieceIds: ids, candidates: uint.positive().max(6), cost: uint,
    dismissCost: uint.positive() }).strict().optional(),
  zones: z.array(zone).min(1), sites: z.array(site), startingPositions: z.record(id, position),
  enemyLineup: z.array(enemy).min(1),
  resources: z.object({ pieceIds: ids, skillIds: ids,
    buildsPath: z.literal('data/pve/roguelike/builds.json'), suppliesPath: z.literal('data/pve/roguelike/supplies.json').optional(), images: z.array(PackPayloadPathV1Schema).min(1) }).strict(),
}).strict().superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
  const width = value.map.layout[0].length, height = value.map.layout.length
  if (width > 256 || value.map.layout.some(row => row.length !== width)) invalid('Map must be rectangular and at most 256 cells wide')
  const inside = (p: {x:number;y:number}) => p.x < width && p.y < height
  const walkable = (p: {x:number;y:number}) => inside(p) && value.map.layout[p.y][p.x] === '.'
  for (const list of [value.zones, value.sites, value.enemyLineup]) {
    if (new Set(list.map(item => item.id)).size !== list.length) invalid('Duplicate world ID')
  }
  if (value.party.humanId === value.party.enemyId) invalid('Player IDs must differ')
  for (const area of value.zones) {
    if (!inside({x:area.x+area.width-1,y:area.y+area.height-1})) invalid('Zone outside map')
    const members = value.enemyLineup.filter(piece => piece.zone === area.id)
    if (members.length !== area.enemyIds.length || members.some(piece => !area.enemyIds.includes(piece.id))) invalid('Zone enemy membership mismatch')
    if (members.filter(piece => piece.core).length !== area.coreIds.length || members.filter(piece => piece.core).some(piece => !area.coreIds.includes(piece.id))) invalid('Zone core membership mismatch')
  }
  for (const [index, piece] of value.enemyLineup.entries()) {
    const area = value.zones.find(item => item.id === piece.zone)
    if (piece.id !== `${value.party.enemyId}-${index+1}`) invalid('Enemy instance IDs must match roster order')
    if (!area || piece.x < area.x || piece.y < area.y || piece.x >= area.x+area.width || piece.y >= area.y+area.height) invalid('Enemy outside its zone')
    if (!value.resources.pieceIds.includes(piece.templateId)) invalid('Unregistered enemy template')
    const initial = value.startingPositions[piece.id]
    if (!initial || initial.x !== piece.x || initial.y !== piece.y) invalid('Enemy starting position mismatch')
  }
  const expected = [...value.party.pieceIds.map((_,i)=>`${value.party.humanId}-${i+1}`), ...value.enemyLineup.map(piece=>piece.id)]
  if (Object.keys(value.startingPositions).length !== expected.length || expected.some(key=>!value.startingPositions[key])) invalid('Starting roster mismatch')
  const positions = Object.values(value.startingPositions)
  if (positions.some(p=>!walkable(p)) || new Set(positions.map(p=>`${p.x},${p.y}`)).size !== positions.length) invalid('Invalid or overlapping initial positions')
  for (const item of value.sites) if (!walkable(item) || item.kind === 'encounter' && !value.zones.some(area=>area.id===item.id)) invalid('Invalid site')
  if (new Set(value.sites.map(item => `${item.x},${item.y}`)).size !== value.sites.length) invalid('Overlapping sites')
  if (value.sites.some(item => item.kind === 'recruit') && !value.recruitment) invalid('Missing recruitment configuration')
  if (value.recruitment && value.recruitment.candidates > value.recruitment.pieceIds.length) invalid('Not enough recruitment candidates')
  if (value.generation && value.sites.filter(item => item.kind === 'camp').length !== 1) invalid('Generated adventure requires one starting camp')
})

const teamMember = z.object({pieceId:id,name:text,image:text,role:text,description:text}).strict()
const pair = z.object({fixed:id,scaling:id,label:text,max:uint.positive(),initial:uint,steady:uint,base:uint,
  gain:z.number().nonnegative(),unit:text,note:text,step:uint.positive().optional(),gate:z.boolean().optional()}).strict()
export const RoguelikeBuildsV1Schema = z.object({
  schemaVersion:z.literal('rvb-pve-roguelike-builds/v1'),id,version:SemVerV1Schema,
  families:z.array(z.object({id,name:text,tag:text,color:z.string().regex(/^#[0-9a-fA-F]{6}$/),icon:text,summary:text,
    team:z.array(teamMember).min(1),loop:z.array(text),pair,cardIds:ids,example:text,links:z.array(text),questions:z.array(text)}).strict()).min(1),
}).strict().superRefine((value,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:z.ZodIssueCode.custom,message})
  if(new Set(value.families.map(f=>f.id)).size!==value.families.length)fail('Duplicate family')
  for(const family of value.families) {
    if(!family.cardIds.includes(family.pair.fixed)||!family.cardIds.includes(family.pair.scaling)||family.pair.fixed===family.pair.scaling)fail('Invalid comparison card reference')
    if(family.pair.initial>family.pair.max)fail('Initial comparison value exceeds display range')
  }
})

export type RoguelikeAdventureV1 = z.infer<typeof RoguelikeAdventureV1Schema>
export type RoguelikeBuildsV1 = z.infer<typeof RoguelikeBuildsV1Schema>
export const RoguelikeSuppliesV1Schema = z.object({
  schemaVersion: z.literal('rvb-pve-roguelike-supplies/v1'), id, version: SemVerV1Schema,
  relics: z.array(z.object({ id, name: text, description: text, icon: text, familyId: id,
    grants: z.array(z.object({ cardId: id, count: uint.positive().max(10) }).strict()).min(1),
  }).strict()).min(1),
  initialRelicIds: z.array(id), rewardRelicIds: z.array(id), rewardCardIds: ids, rewardCopies: uint.positive().max(10),
}).strict().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
  const relicIds = value.relics.map(relic => relic.id)
  for (const list of [relicIds, value.initialRelicIds, value.rewardRelicIds]) if (new Set(list).size !== list.length) fail('Duplicate relic')
  if ([...value.initialRelicIds, ...value.rewardRelicIds].some(id => !relicIds.includes(id))) fail('Missing relic')
  for (const relic of value.relics) if (new Set(relic.grants.map(grant => grant.cardId)).size !== relic.grants.length) fail('Duplicate grant')
})
export type RoguelikeSuppliesV1 = z.infer<typeof RoguelikeSuppliesV1Schema>
export function parseRoguelikeDocumentV1(value: unknown): RoguelikeAdventureV1 | RoguelikeBuildsV1 | RoguelikeSuppliesV1 | undefined {
  const schema=(value as {schemaVersion?:unknown}|null)?.schemaVersion
  if(schema==='rvb-pve-roguelike-adventure/v1') return RoguelikeAdventureV1Schema.parse(value)
  if(schema==='rvb-pve-roguelike-builds/v1') return RoguelikeBuildsV1Schema.parse(value)
  if(schema==='rvb-pve-roguelike-supplies/v1') return RoguelikeSuppliesV1Schema.parse(value)
  return undefined
}
