/* eslint-disable @typescript-eslint/no-explicit-any -- CLI JSON assertions. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createOfflineDemonGoalFixture } from '@/lib/ai-bot/offline-goal-fixture'

const script = resolve(process.cwd(), 'scripts/ai/run-goal-search.mjs')

function runCli(...args: string[]) {
  const output = execFileSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  })
  return JSON.parse(output) as Record<string, any>
}

describe('offline goal search CLI', () => {
  it('prints help without requiring credentials or a Cloud environment', () => {
    const output = execFileSync(process.execPath, [script, '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    expect(output).toContain('--smoke')
    expect(output).toContain('--input <path>')
  })

  it('runs the deterministic real five-card smoke and emits a safe JSON route', () => {
    const first = runCli('--smoke', '--seed', '9109817', '--max-time-ms', '10000')
    const second = runCli('--smoke', '--seed', '9109817', '--max-time-ms', '10000')

    expect(first.status).toBe('found')
    expect(first.mode).toBe('smoke')
    expect(first.route).toHaveLength(5)
    expect(first.route.map((entry: any) => entry.action.type)).toEqual(Array(5).fill('playCard'))
    expect(first.route.at(-1).action.extraTargets).toEqual([{ x: 1, y: 0 }])
    expect(first.fixture.expectedActionPointCost).toBe(9)
    expect(first.route).toEqual(second.route)
    expect(first.error).toBeUndefined()
    expect(JSON.stringify(first)).not.toMatch(/password|token|secret|authorization/i)
  })

  it('accepts a complete offline BattleState JSON input', async () => {
    const fixture = await createOfflineDemonGoalFixture({ rootSeed: 9109817 })
    const directory = mkdtempSync(join(tmpdir(), 'rvb-goal-cli-test-'))
    const input = join(directory, 'battle-state.json')
    try {
      writeFileSync(input, `${JSON.stringify(fixture.state)}\n`)
      const output = runCli(
        '--input', input,
        '--player', fixture.playerId,
        '--seed', String(fixture.rootSeed),
        '--goal', fixture.goalTemplateId,
        '--max-depth', '5',
        '--max-time-ms', '10000',
      )
      expect(output.status).toBe('found')
      expect(output.mode).toBe('input')
      expect(output.route).toHaveLength(5)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
