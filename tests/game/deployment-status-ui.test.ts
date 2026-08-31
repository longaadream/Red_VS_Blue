import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

type DeploymentStatusApi = {
  create(input: {
    deployment?: {
      mode?: string
      status?: string
      activePlayerId?: string
      offerPieces?: Array<{ instanceId: string; templateId: string; name: string }>
      legalPositions?: Array<{ x: number; y: number }>
      reserveCounts?: Record<string, number>
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
    mode?: string
    phase?: string
    ownsStep?: boolean
    showCandidates?: boolean
    reserveCount?: number
    offerPieces?: Array<{ instanceId: string; templateId: string; name: string }>
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

describe('RED-138 progressive reserve deployment view', () => {
  const progressiveDeployment = {
    mode: 'progressive-reserve-v1',
    status: 'awaiting-reserve-deploy',
    activePlayerId: 'Alice',
    offerPieces: [
      { instanceId: 'tyrande-1', templateId: 'tyrande', name: '泰兰德' },
      { instanceId: 'tirion-1', templateId: 'tirion', name: '提里奥' },
    ],
    legalPositions: [{ x: 2, y: 3 }],
    reserveCounts: { Alice: 7, Bob: 8 },
  }

  it('exposes owner-only candidates and the authoritative reserve count without calculating cells', () => {
    const api = loadDeploymentStatusApi()

    expect(api.create({
      deployment: progressiveDeployment,
      playerId: 'alice',
      selectedPieceName: '泰兰德',
    })).toMatchObject({
      visible: true,
      mode: 'progressive-reserve-v1',
      phase: 'awaiting-reserve-deploy',
      ownsStep: true,
      showCandidates: true,
      reserveCount: 7,
      stateText: '已选择 泰兰德 · 请选择高亮落点',
      offerPieces: progressiveDeployment.offerPieces,
    })

    expect(api.create({ deployment: progressiveDeployment, playerId: 'bob' })).toMatchObject({
      visible: true,
      ownsStep: false,
      showCandidates: false,
      stateText: '等待对方完成部署',
      offerPieces: [],
    })
  })

  it('explains deterministic fallback and hides once authority leaves reserve placement', () => {
    const api = loadDeploymentStatusApi()
    const fallback = { ...progressiveDeployment, legalPositions: [] }

    expect(api.create({ deployment: fallback, playerId: 'alice' })).toMatchObject({
      stateText: '选择一名预备棋子 · 将由规则随机落位',
      showCandidates: true,
    })
    expect(api.create({
      deployment: { ...progressiveDeployment, status: 'turn-ready' },
      playerId: 'alice',
    })).toMatchObject({ visible: false })
  })
})
