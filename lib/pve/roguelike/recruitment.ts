import { applyInitialRules, buildInitialPiecesForPlayers } from '../../game/battle-setup'
import { getPieceById } from '../../game/piece-repository'
import { getSkillById } from '../../game/skill-repository'
import { assertContentAvailable, isContentAvailable } from '../../game/content-availability'
import { deriveStreamSeed, mulberry32 } from '../../game/rule-runtime'
import type { BattleState } from '../../game/turn'
import type { RoguelikeAdventureV1 } from '../contracts/roguelike-content-v1'

export function recruitmentOffers(content: RoguelikeAdventureV1): Record<string, string[]> {
  const config = content.recruitment
  if (!config) return {}
  return Object.fromEntries(content.sites.filter(site => site.kind === 'recruit').map(site => {
    const random = mulberry32(deriveStreamSeed(content.party.seed, `adventure-recruitment:${site.id}`))
    const pool = config.pieceIds.filter(id => {
      const piece = getPieceById(id)
      return piece && isContentAvailable(piece, 'pve')
    })
    for (let i = pool.length - 1; i > 0; i--) {
      const swap = Math.floor(random() * (i + 1)); [pool[i], pool[swap]] = [pool[swap], pool[i]]
    }
    return [site.id, pool.slice(0, config.candidates)]
  }))
}

export function buildAdventureRecruit(state: BattleState, templateId: string, instanceId: string, humanId: string, enemyId: string) {
  const template = getPieceById(templateId)
  if (!template) throw new Error('招募角色不存在')
  assertContentAvailable(template, 'pve')
  // Match-start owner effects and reserve setup scripts need their own encounter lifecycle.
  // This slice accepts ordinary piece/summon rules only; packs fail explicitly for the unsupported cases.
  if (template.playerRules?.length || template.progressiveDeployment) throw new Error('此角色暂不支持中途招募')
  for (const item of template.skills) {
    const skill = getSkillById(item.skillId)
    if (!skill) throw new Error('招募角色缺少技能')
    assertContentAvailable(skill, 'pve')
  }
  const piece = buildInitialPiecesForPlayers(state.map, [humanId, enemyId], [], [
    { playerId: humanId, faction: 'red', pieces: [template] },
    { playerId: enemyId, faction: 'blue', pieces: [] },
  ], () => 0, { progressiveDeployment: true, skipMissingPlayerDefaults: true })[0]
  applyInitialRules(piece, template)
  piece.instanceId = instanceId; piece.isCore = true
  // Native isolated actions hydrate executable rules from these canonical IDs on deployment.
  return JSON.parse(JSON.stringify(piece)) as typeof piece
}
