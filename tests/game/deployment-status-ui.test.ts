import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

type DeploymentStatusApi = {
  create(input: {
    deployment?: {
      status?: string
      deadlineAt?: number
      locks?: Record<string, { locked?: boolean }>
    }
    playerId?: string
    selectedPieceName?: string
    spectating?: boolean
    now?: number
  }): {
    visible: boolean
    clockText: string
    remainingSeconds: number
    stateText: string
    urgent: boolean
  }
}

function loadDeploymentStatusApi(): DeploymentStatusApi {
  const source = readFileSync(
    resolve(process.cwd(), 'data/pages/js/battle-ui/deployment-status.js'),
    'utf8',
  )
  const browserWindow: Record<string, unknown> = {}
  const context = createContext({ window: browserWindow })
  new Script(source, { filename: 'deployment-status.js' }).runInContext(context)
  return browserWindow.RvBDeploymentStatus as DeploymentStatusApi
}

function awaitingDeployment(deadlineAt = 46_000) {
  return {
    status: 'awaiting-locks',
    deadlineAt,
    locks: {
      alice: { locked: false },
      bob: { locked: false },
    },
  }
}

describe('RED-31 deployment countdown view', () => {
  it('shows the authoritative 45-second deadline and counts down without changing rules state', () => {
    const api = loadDeploymentStatusApi()
    const deployment = awaitingDeployment()

    expect(api.create({ deployment, playerId: 'alice', now: 1_000 })).toMatchObject({
      visible: true,
      clockText: '00:45',
      remainingSeconds: 45,
      urgent: false,
    })
    expect(api.create({ deployment, playerId: 'alice', now: 36_001 })).toMatchObject({
      visible: true,
      clockText: '00:10',
      remainingSeconds: 10,
      urgent: true,
    })
    expect(deployment).toEqual(awaitingDeployment())
  })

  it('shows single-player lock state and hides after authoritative completion', () => {
    const api = loadDeploymentStatusApi()
    const deployment = awaitingDeployment()
    deployment.locks.alice.locked = true

    expect(api.create({ deployment, playerId: 'alice', now: 2_000 })).toMatchObject({
      visible: true,
      stateText: '已锁定 · 等待对方',
    })
    expect(api.create({ deployment, playerId: 'bob', now: 2_000 })).toMatchObject({
      visible: true,
      stateText: '对方已锁定 · 请确认部署',
    })
    expect(api.create({
      deployment: { ...deployment, status: 'complete' },
      playerId: 'alice',
      now: 2_000,
    })).toMatchObject({ visible: false })
  })

  it('surfaces the local reroll selection in the formal deployment panel', () => {
    const api = loadDeploymentStatusApi()

    expect(api.create({
      deployment: awaitingDeployment(),
      playerId: 'alice',
      selectedPieceName: '观者',
      now: 1_000,
    })).toMatchObject({
      stateText: '已选择重投：观者',
    })
  })
})
