import { describe, expect, it } from 'vitest'

import {
  syncLinearTrainingEvidence,
  type LinearGitHubSyncAdapter,
} from '@/lib/game/ai-linear-github'

function adapter(overrides: Partial<LinearGitHubSyncAdapter> = {}) {
  const calls: string[] = []
  const value: LinearGitHubSyncAdapter = {
    currentBranch: () => 'codex/RED-110-linear-greedy-training',
    writeEvidence: () => { calls.push('write') },
    stage: () => { calls.push('stage') },
    hasStagedChanges: () => true,
    commit: () => { calls.push('commit') },
    push: () => { calls.push('push') },
    now: () => '2026-08-27T00:00:00.000Z',
    ...overrides,
  }
  return { value, calls }
}

const input = {
  requiredBranch: 'codex/RED-110-linear-greedy-training',
  taskId: 'RED-110',
  evidencePath: 'docs/qa/evidence/linear-ai/latest.json',
  evidence: { completedGeneration: 1 },
  commitMessage: 'ai(train): archive generation 1',
}

describe('linear training GitHub sync adapter', () => {
  it('writes, stages, commits, and pushes only on the exact task branch', () => {
    const fixture = adapter()
    expect(syncLinearTrainingEvidence(fixture.value, input)).toMatchObject({
      status: 'synced', branch: input.requiredBranch, evidencePath: input.evidencePath,
    })
    expect(fixture.calls).toEqual(['write', 'stage', 'commit', 'push'])
    for (const branch of ['main', 'codex/RED-999-other', 'feature/RED-110-wrong']) {
      const rejected = adapter({ currentBranch: () => branch })
      expect(() => syncLinearTrainingEvidence(rejected.value, input)).toThrowError(/requires task branch/)
      expect(rejected.calls).toEqual([])
    }
  })

  it('keeps local evidence when push fails and succeeds on a later retry', () => {
    const failed = adapter({ push: () => { throw new Error('offline') } })
    expect(() => syncLinearTrainingEvidence(failed.value, input)).toThrowError(/offline/)
    expect(failed.calls).toEqual(['write', 'stage', 'commit'])
    const retried = adapter({ hasStagedChanges: () => false })
    expect(syncLinearTrainingEvidence(retried.value, input).status).toBe('synced')
    expect(retried.calls).toEqual(['write', 'stage', 'push'])
  })
})
