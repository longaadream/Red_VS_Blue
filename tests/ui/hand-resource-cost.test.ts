import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8')
const script = page.slice(page.indexOf('    function refreshHandResourceCost()'), page.indexOf('    function refreshLessonVisualCue()'))

describe('hand resource cost preview', () => {
  it('shows authoritative skill costs and clears cancelled or non-skill choices', () => {
    const label = { hidden: true, textContent: '' }
    const cost = vi.fn(() => ({ actionCost: 2, chargeCost: 1 }))
    const context = {
      document: { getElementById: () => label },
      G: { pieces: [{ instanceId: 'caster' }] }, selectedPieceId: 'caster',
      pendingSkill: { skillId: 'skill' } as Record<string, unknown> | null,
      resolveSkillAvailability: cost,
    }
    runInNewContext(script + '\nrefreshHandResourceCost()', context)
    expect(label.hidden).toBe(false)
    expect(label.textContent).toBe('本次消耗：行动 2 · 充能 1')
    context.pendingSkill = null
    runInNewContext('refreshHandResourceCost()', context)
    expect(label.hidden).toBe(true)
    context.pendingSkill = { turnTargetActionType: 'choose' }
    runInNewContext('refreshHandResourceCost()', context)
    expect(label.hidden).toBe(true)
    expect(cost).toHaveBeenCalledOnce()
  })
})
