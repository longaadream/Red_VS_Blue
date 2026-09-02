import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

import { POST as postDebugBattle } from '@/app/api/debug/battle/route'
import { GET as getQaClientResource } from '@/app/qa/client/[...path]/route'
import {
  isRed43LocalDevelopmentHostHeader,
  isRed43LocalDevelopmentHostname,
} from '@/app/qa/same-alignment/access'
import {
  RED43_SCENARIOS,
  collectRed43TargetEvidence,
  prepareRed43State,
  type Red43ScenarioId,
} from '@/app/qa/same-alignment/server'
import { hashStable } from '@/lib/game/battle-runner'
import { createDebugDuel } from '@/lib/game/debug-battle'

describe('RED-43 same-alignment UI acceptance contract', () => {
  it.each([
    ['light-light', 'enemy'],
    ['dark-dark', 'ally'],
  ] as const)('derives the %s target set from the authoritative runner by ownerPlayerId', async (scenarioId, expectedFilter) => {
    const scenario = RED43_SCENARIOS[scenarioId as Red43ScenarioId]
    const duel = await createDebugDuel({
      seed: scenario.seed,
      first: { playerId: 'alice', seat: 'red', alignment: scenario.alignment, templateIds: scenario.roster },
      second: { playerId: 'bob', seat: 'blue', alignment: scenario.alignment, templateIds: scenario.roster },
      piecesPerPlayer: scenario.roster.length,
    })
    const state = prepareRed43State(duel.state, 'alice', scenario)
    const beforeHash = hashStable(state)
    const evidence = collectRed43TargetEvidence(state, 'alice', scenario)
    const acceptedOwners = new Set(evidence.acceptedTargetPieceIds.map(instanceId =>
      state.pieces.find(piece => piece.instanceId === instanceId)?.ownerPlayerId,
    ))

    expect(evidence.expectedFilter).toBe(expectedFilter)
    expect(state.pendingTargetSelection).toBeUndefined()
    expect(state.pendingOptionSelection).toBeUndefined()
    expect(
      evidence.acceptedTargetPieceIds,
      JSON.stringify([...new Set(Object.values(evidence.rejectionReasons))]),
    ).toHaveLength(8)
    expect(evidence.rejectedTargetPieceIds).toHaveLength(8)
    expect(acceptedOwners).toEqual(new Set([expectedFilter === 'ally' ? 'alice' : 'bob']))
    expect(hashStable(state)).toBe(beforeHash)
  })

  it('serves the canonical battle page and its data only through the loopback QA route', async () => {
    const battleResponse = await getQaClientResource(
      new NextRequest('http://127.0.0.1:3000/qa/client/battle.html'),
      { params: Promise.resolve({ path: ['battle.html'] }) },
    )
    const dataResponse = await getQaClientResource(
      new NextRequest('http://localhost:3000/qa/client/data/pieces/manifest.json'),
      { params: Promise.resolve({ path: ['data', 'pieces', 'manifest.json'] }) },
    )
    const imageResponse = await getQaClientResource(
      new NextRequest('http://localhost:3000/qa/client/images/kenshin.jpg'),
      { params: Promise.resolve({ path: ['images', 'kenshin.jpg'] }) },
    )
    const tileEffectResponse = await getQaClientResource(
      new NextRequest('http://localhost:3000/qa/client/images/tile-effects/amaterasu.svg'),
      { params: Promise.resolve({ path: ['images', 'tile-effects', 'amaterasu.svg'] }) },
    )
    const effectIconResponse = await getQaClientResource(
      new NextRequest('http://localhost:3000/qa/client/images/effect-icons/divine-shield.svg'),
      { params: Promise.resolve({ path: ['images', 'effect-icons', 'divine-shield.svg'] }) },
    )
    const traversalResponse = await getQaClientResource(
      new NextRequest('http://localhost:3000/qa/client/package.json'),
      { params: Promise.resolve({ path: ['..', 'package.json'] }) },
    )
    const nonLoopbackResponse = await getQaClientResource(
      new NextRequest('http://qa.example.com/qa/client/battle.html'),
      { params: Promise.resolve({ path: ['battle.html'] }) },
    )

    expect(battleResponse.status).toBe(200)
    expect(battleResponse.headers.get('content-type')).toContain('text/html')
    expect(await battleResponse.text()).toContain('<title>对战 - RED vs BLUE</title>')
    expect(dataResponse.status).toBe(200)
    expect(await dataResponse.json()).toContain('ana')
    expect(imageResponse.status).toBe(200)
    expect(imageResponse.headers.get('content-type')).toBe('image/jpeg')
    expect(tileEffectResponse.status).toBe(200)
    expect(tileEffectResponse.headers.get('content-type')).toBe('image/svg+xml')
    expect(await tileEffectResponse.text()).toBe(
      readFileSync(resolve(process.cwd(), 'public/tile-effects/amaterasu.svg'), 'utf8'),
    )
    expect(effectIconResponse.status).toBe(200)
    expect(effectIconResponse.headers.get('content-type')).toBe('image/svg+xml')
    expect(await effectIconResponse.text()).toBe(
      readFileSync(resolve(process.cwd(), 'public/effect-icons/divine-shield.svg'), 'utf8'),
    )
    expect(traversalResponse.status).toBe(404)
    expect(nonLoopbackResponse.status).toBe(404)
  })

  it('rejects the RED-43 launcher and room API outside loopback development', async () => {
    const requestBody = JSON.stringify({ mode: 'create-ui-acceptance-room', scenario: 'light-light' })
    const nonLoopbackResponse = await postDebugBattle(new NextRequest('http://qa.example.com/api/debug/battle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    }))

    expect(nonLoopbackResponse.status).toBe(404)
    expect(isRed43LocalDevelopmentHostname('qa.example.com')).toBe(false)
    expect(isRed43LocalDevelopmentHostHeader('qa.example.com:3000')).toBe(false)

    try {
      vi.stubEnv('NODE_ENV', 'production')
      const productionResponse = await postDebugBattle(new NextRequest('http://127.0.0.1:3000/api/debug/battle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      }))

      expect(productionResponse.status).toBe(404)
      expect(isRed43LocalDevelopmentHostname('127.0.0.1')).toBe(false)
      expect(isRed43LocalDevelopmentHostHeader('localhost:3000')).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('exposes visible ownership and target evidence without replacing the battle UI', () => {
    const battleHtml = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    const launcherPage = readFileSync(resolve(process.cwd(), 'app/qa/same-alignment/page.tsx'), 'utf8')
    const launcher = readFileSync(resolve(process.cwd(), 'app/qa/same-alignment/client.tsx'), 'utf8')

    expect(battleHtml).toContain('id="red43QaPanel"')
    expect(battleHtml).toContain('data-owner-player-id=')
    expect(battleHtml).toContain('window.__RVB_RED43__')
    expect(battleHtml).toContain('UI / 规则')
    expect(battleHtml).not.toContain('getSkillHint()')
    expect(battleHtml.indexOf('await RvBUtils.restoreServerFromParams(params)'))
      .toBeLessThan(battleHtml.indexOf("if (!getServerUrl()) { showMsg('未连接服务器'"))
    expect(launcher).toContain("mode: 'create-ui-acceptance-room'")
    expect(launcher).toContain("id: 'light-light'")
    expect(launcher).toContain("id: 'dark-dark'")
    expect(launcher).toContain('Alice playerId')
    expect(launcher).toContain('Bob playerId')
    expect(launcherPage).toContain('isRed43LocalDevelopmentHostHeader')
  })
})
