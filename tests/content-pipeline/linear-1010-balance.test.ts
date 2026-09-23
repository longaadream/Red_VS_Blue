import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(process.cwd())
type TargetedSkillContent = {
  targeting: { steps: Array<{ range: number }> }
  description: string
}
type PieceContent = {
  name: string
  skills: Array<{ skillId: string }>
}
const readJson = <T extends Record<string, unknown> = Record<string, unknown>>(relative: string): T =>
  JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')) as T

describe('RED-211 documented balance changes', () => {
  it('keeps Ulquiorra ranges and damage wording aligned', () => {
    const cero = readJson<TargetedSkillContent>('data/skills/ulquiorra-cero.json')
    const black = readJson<TargetedSkillContent>('data/skills/ulquiorra-black-cero.json')
    expect(cero.targeting.steps[0].range).toBe(4)
    expect(cero.description).toContain('0.5倍伤害')
    expect(black.targeting.steps[0].range).toBe(2)
    expect(black.description).toContain('2倍伤害')
  })

  it('keeps the documented AP and roster changes', () => {
    const gaze = readJson('data/skills/blackwidow-deadly-gaze.json')
    const grimmjow = readJson<PieceContent>('data/pieces/dark-grimmjow.json')
    expect(gaze.actionPointCost).toBe(1)
    expect(grimmjow.name).toBe('格里姆乔')
    expect(grimmjow.skills.map((skill: { skillId: string }) => skill.skillId)).not.toContain('grimmjow-gran-rey-cero')
  })
})

describe('RED-213 documented balance changes', () => {
  it('keeps the approved skill costs, cooldowns, and Swift replacement aligned', () => {
    const waterDash = readJson('data/skills/alfonso-water-dash.json') as {
      actionPointCost: number
      chargeCost: number
    }
    const kick = readJson('data/skills/alfonso-kick.json') as { cooldownTurns: number }
    const speedShot = readJson('data/skills/max-speed-shot.json') as {
      actionPointCost: number
      cooldownTurns: number
      description: string
    }
    const fullSpeed = readJson('data/skills/max-full-speed.json') as {
      actionPointCost: number
      chargeCost: number
      cooldownTurns: number
      description: string
      keywords: string[]
      code: string
    }
    const deathBlossom = readJson('data/skills/death-blossom.json') as {
      actionPointCost: number
      chargeCost: number
    }

    expect(waterDash).toMatchObject({ actionPointCost: 2, chargeCost: 2 })
    expect(kick.cooldownTurns).toBe(1)
    expect(speedShot).toMatchObject({ actionPointCost: 1, cooldownTurns: 0 })
    expect(speedShot.description).toContain('每回合最多释放2次')
    expect(fullSpeed).toMatchObject({ actionPointCost: 0, chargeCost: 1, cooldownTurns: 1 })
    expect(fullSpeed.description).toContain('所有存活友方棋子获得迅捷')
    expect(fullSpeed.keywords).toContain('迅捷')
    expect(fullSpeed.code).toContain("stacking: 'independent'")
    expect(fullSpeed.code).toContain("type: 'deployment-first-move-free'")
    expect(deathBlossom).toMatchObject({ actionPointCost: 2, chargeCost: 1 })
  })
})
