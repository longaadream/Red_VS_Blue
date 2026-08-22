import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')
const readPage = (name: string) => readFileSync(resolve(pagesDir, name), 'utf8')
const readScript = (name: string) => readFileSync(resolve(pagesDir, 'js/developer-tools', name), 'utf8')

describe('read-only Trace replay viewer', () => {
  it('reuses the battle presentation boundary and exposes timeline inspection controls', () => {
    const page = readPage('replay.html')

    expect(page).toContain('battle-view-model.js')
    expect(page).toContain('battle-renderer-3d.js')
    expect(page).toContain('replay-viewer.js')
    expect(page).toContain('replayTimeline')
    expect(page).toContain('replayPlayButton')
    expect(page).toContain('replayPreviousButton')
    expect(page).toContain('replayNextButton')
    expect(page).toContain('replaySpeed')
    expect(page).toContain('replayPerspective')
    expect(page).toContain('replayPieceDetails')
    expect(page).toContain('replayEventList')
    expect(page).toContain('replayDiffList')
    expect(page).toContain('replayRandomStreams')
  })

  it('loads only the local validated trace and has no room mutation or network path', () => {
    const page = readPage('replay.html')
    const script = readScript('replay-viewer.js')
    const combined = page + '\n' + script

    expect(script).toContain('readStoredTrace')
    expect(script).toContain('assertTraceRecord')
    expect(script).toContain('BattleViewModel.create')
    expect(script).toContain('BattleRenderer3D.update')
    expect(script).toContain("intent.type === 'activate-cell'")
    expect(script).toContain('textContent')
    expect(combined).not.toContain('RvBWs')
    expect(combined).not.toContain('WebSocket')
    expect(combined).not.toContain('serverFetch')
    expect(combined).not.toContain("fetch(")
    expect(combined).not.toContain("type: 'action'")
    expect(combined).not.toContain('runBattleAction')
    expect(combined).not.toContain('/api/rooms/')
    expect(combined).not.toContain('innerHTML')
  })
})
