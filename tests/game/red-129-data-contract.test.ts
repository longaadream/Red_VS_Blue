/* eslint-disable @typescript-eslint/no-explicit-any -- RED-129 validates JSON-authored character contracts. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadAllSkillsById } from '@/lib/game/skills'

const DATA_ROOT = join(process.cwd(), 'data')

function loadJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(DATA_ROOT, ...segments), 'utf8')) as T
}

function loadSkill(id: string): any {
  return loadJson('skills', `${id}.json`)
}

describe('RED-129 complete data contract', () => {
  it('pins every approved AP, CP, cooldown, multiplier, and derived-card change', () => {
    const expectedSkills: Record<string, Record<string, unknown>> = {
      'nano-boost': { actionPointCost: 2, chargeCost: 2 },
      'shield-of-light': { actionPointCost: 2, cooldownTurns: 1 },
      'holy-light-descend': { actionPointCost: 3, chargeCost: 1 },
      'arthas-frostmourne': { actionPointCost: 1, powerMultiplier: 2 },
      'arthas-icebound-fortitude': { actionPointCost: 1 },
      'ichigo-black-getsuga-tensho': { powerMultiplier: 2 },
      'kenshin-amakakeru': { powerMultiplier: 2 },
      'naruto-shadow-clone': { cooldownTurns: 3 },
      ashbringer: { actionPointCost: 1 },
      'tirion-holy-recall': { actionPointCost: 1, cooldownTurns: 2 },
      'watcher-ultimate': { actionPointCost: 0 },
      'shadow-bolt': { chargeCost: 1 },
      'hashirama-edo-sage-buddha': { actionPointCost: 0, chargeCost: 1 },
      fireball: { actionPointCost: 1, cooldownTurns: 2 },
      blizzard: { actionPointCost: 0 },
      'kiljaedan-fel-fire': { powerMultiplier: 2 },
      'kiljaedan-soul-drain': { actionPointCost: 4 },
      'light-extraction': { cooldownTurns: 2 },
      'blackwidow-lethal-strike': { cooldownTurns: 1 },
      'blackwidow-lethal-toxin': { actionPointCost: 1 },
      'rocket-punch': { cooldownTurns: 1, powerMultiplier: 2 },
      earthshatter: { powerMultiplier: 2 },
      'itachi-totsuka-blade': { cooldownTurns: 2, chargeCost: 3, powerMultiplier: 2 },
      'obito-space-time': { actionPointCost: 5 },
      'rafaam-temporal-distortion': { actionPointCost: 1, cooldownTurns: 2 },
      'rafaam-curse-amplify': { actionPointCost: 0, chargeCost: 1 },
      'sasuke-kagutsuchi': { actionPointCost: 1 },
      'shishio-infinite-blade': { actionPointCost: 1 },
      'venom-symbiote-drag': { actionPointCost: 1 },
      'venom-claw-rend': { powerMultiplier: 2 },
      blink: { actionPointCost: 1, cooldownTurns: 0 },
      'turalyon-expedition-order': { actionPointCost: 1, cooldownTurns: 2 },
      'blessed-hammer': { actionPointCost: 1 },
      'velen-holy-prophecy': { cooldownTurns: 2 },
      'velen-fate-shelter': { cooldownTurns: 3 },
    }

    for (const [id, expected] of Object.entries(expectedSkills)) {
      expect(loadSkill(id), id).toMatchObject({ id, ...expected })
    }

    expect(loadJson<any>('cards', 'soul-fragment.json')).toMatchObject({
      id: 'soul-fragment',
      actionPointCost: 0,
    })
    expect(loadJson<any>('cards', 'hashirama-edo-nature-heal.json')).toMatchObject({
      id: 'hashirama-edo-nature-heal',
      actionPointCost: 1,
    })
  })

  it('pins the approved stats, renamed skills, targeting boundaries, and rewritten text', () => {
    expect(loadJson<any>('pieces', 'blue-kenshin.json').stats.defense).toBe(0)
    expect(loadJson<any>('pieces', 'red-doomsday-fist.json').stats.moveRange).toBe(4)
    expect(loadJson<any>('pieces', 'red-hidan.json').stats.moveRange).toBe(3)
    expect(loadJson<any>('pieces', 'red-rafaam.json').stats.attack).toBe(0)

    expect(loadSkill('itachi-amaterasu').name).toBe('天照之缚')
    expect(loadSkill('sasuke-amaterasu').name).toBe('天照之炎')
    expect(loadSkill('itachi-tsukuyomi').targeting.steps[0]).toMatchObject({
      type: 'piece',
      filter: 'enemy',
      range: 6,
    })
    expect(loadSkill('sasuke-chidori').targeting.steps[0]).toMatchObject({
      type: 'grid',
      range: 6,
      sameRowOrColumn: true,
      requireWalkable: true,
      requireUnoccupied: true,
    })
    expect(loadSkill('shadow-step').targeting.steps[0]).toMatchObject({
      type: 'grid',
      range: 7,
      requireWalkable: true,
      requireUnoccupied: true,
    })
    expect(loadSkill('blackwidow-lethal-toxin').targeting.steps[0]).toMatchObject({
      type: 'grid',
      range: 5,
      requireWalkable: true,
      requireUnoccupied: true,
    })
    expect(loadSkill('earthshatter').targeting.steps[0]).toMatchObject({
      type: 'grid',
      range: 99,
      requireWalkable: true,
      requireUnoccupied: true,
    })

    expect(loadSkill('nano-boost').description).toBe(
      '使10格内1个其他友军防御力+3、移速+1，且其造成的所有伤害+1。',
    )
    expect(loadSkill('holy-light-descend').description).toContain('治疗9点')
    expect(loadSkill('holy-light-descend').description).toContain('距离2、3格')
    expect(loadSkill('hellfire-shotgun').description).toContain('第1个目标')
    expect(loadSkill('kiljaedan-fel-fire').description).toContain('3x3范围内其他敌人')
    expect(loadSkill('minato-flying-raijin-passive').description).toContain('仅在水门自己的回合结束时')
    expect(loadSkill('minato-flying-raijin-passive').description).toContain('选择是否触发')
    expect(loadSkill('rafaam-temporal-distortion').description).toContain('对方下回合结束时归还')
    expect(loadSkill('rafaam-curse-amplify').description).toBe('复制对方手牌里所有的诅咒。')
    expect(loadSkill('sasuke-susanoo').description).toContain('防御力+1')
    expect(loadSkill('venom-corrosion').description).toBe('毒液每次更改敌方位置时，使其定身1回合。')
    expect(loadSkill('velen-fate-shelter').description).toContain('恢复8点生命并获得【圣盾】')
  })

  it('uses the approved replacement skill lists and removes deleted resources everywhere', () => {
    const tirion = loadJson<any>('pieces', 'blue-tirion-fordring.json')
    const tracer = loadJson<any>('pieces', 'tracer.json')
    const venom = loadJson<any>('pieces', 'red-venom.json')
    const rafaam = loadJson<any>('pieces', 'red-rafaam.json')
    const shishio = loadJson<any>('pieces', 'red-shishio.json')

    expect(tirion.skills.map((entry: any) => entry.skillId)).toEqual([
      'tirion-divine-glory',
      'ashbringer',
      'tirion-holy-recall',
    ])
    expect(tracer.skills.map((entry: any) => entry.skillId)).toEqual([
      'blink',
      'recall',
      'pulse-pistol',
    ])
    expect(venom.skills.map((entry: any) => entry.skillId)).toEqual([
      'venom-corrosion',
      'venom-host-transfer',
      'venom-symbiote-drag',
      'venom-claw-rend',
    ])
    expect(rafaam.skills.map((entry: any) => entry.skillId)).toEqual([
      'rafaam-temporal-distortion',
      'rafaam-curse-ward',
      'rafaam-curse-amplify',
    ])
    expect(loadJson<any>('pieces', 'blue-minato.json').rules).toEqual([
      'rule-minato-anchor-end-turn',
      'rule-minato-flying-raijin-trigger',
    ])
    expect(tirion.rules).toEqual([
      'rule-tirion-divine-shield-start',
      'rule-tirion-divine-glory',
    ])
    expect(rafaam.rules).toEqual(['rule-rafaam-curse-ward'])
    expect(shishio.rules).toContain('rule-shishio-infinite-blade-recast')

    const removedSkills = [
      'holy-blast',
      'sticky-bomb',
      'sticky-bomb-move',
      'sticky-bomb-explode',
      'shishio-infinite-blade-recast',
      'rafaam-temporal-distortion-enemy',
      'rafaam-temporal-distortion-self',
      'rafaam-temporal-distortion-trigger',
    ]
    const removedRules = [
      'rule-sticky-bomb-move',
      'rule-sticky-bomb-endturn',
      'rule-rafaam-temporal-distortion-enemy',
      'rule-rafaam-temporal-distortion-self',
    ]
    const skillManifest = loadJson<string[]>('skills', 'manifest.json')
    const ruleManifest = loadJson<string[]>('rules', 'manifest.json')
    const loadedSkills = loadAllSkillsById()

    for (const id of removedSkills) {
      expect(existsSync(join(DATA_ROOT, 'skills', `${id}.json`)), id).toBe(false)
      expect(skillManifest, id).not.toContain(id)
      expect(loadedSkills[id], id).toBeUndefined()
    }
    for (const id of removedRules) {
      expect(existsSync(join(DATA_ROOT, 'rules', `${id}.json`)), id).toBe(false)
      expect(ruleManifest, id).not.toContain(id)
    }

    for (const id of ['tirion-holy-recall', 'venom-corrosion']) {
      expect(skillManifest.filter(candidate => candidate === id), id).toHaveLength(1)
    }
    for (const id of [
      'rule-minato-anchor-end-turn',
      'rule-tirion-divine-glory',
      'rule-venom-corrosion-immobile',
    ]) {
      expect(ruleManifest.filter(candidate => candidate === id), id).toHaveLength(1)
    }
    expect(new Set(skillManifest).size).toBe(skillManifest.length)
    expect(new Set(ruleManifest).size).toBe(ruleManifest.length)
  })
})
