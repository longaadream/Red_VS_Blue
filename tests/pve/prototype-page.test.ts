import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const pageSource = readFileSync(
  path.join(process.cwd(), 'data', 'pages', 'pve.html'),
  'utf8',
)
const apiSource = readFileSync(
  path.join(process.cwd(), 'data', 'pages', 'js', 'pve-api.js'),
  'utf8',
)
const browserSource = pageSource + '\n' + apiSource

describe('RED-117 server-authoritative Prototype page', () => {
  it('uses only the PVE server API instead of reading content files', () => {
    expect(apiSource).toContain("const API_ROOT = '/api/pve'")
    expect(apiSource).toContain("requestJson('/runs'")
    expect(apiSource).toContain("'/runs/' + encodeURIComponent(id)")
    expect(apiSource).toContain("'/commands'")

    expect(browserSource).not.toMatch(/data\/pve/i)
    expect(browserSource).not.toContain('fetchPackJson')
    expect(browserSource).not.toContain('loadManifest')
    expect(browserSource).not.toContain('loadMany')
    expect(pageSource).not.toContain('pack-fetch.js')
  })

  it('does not create a rule seed, terminal result, or browser-owned Run', () => {
    expect(browserSource).not.toContain('Date.now')
    expect(browserSource).not.toContain('Math.random')
    expect(browserSource).not.toContain('createRunState')
    expect(browserSource).not.toContain('rootSeed')
    expect(browserSource).not.toContain('terminalResult')
    expect(browserSource).not.toMatch(/\bwinner\b/)

    expect(apiSource).toContain('window.crypto.randomUUID()')
    expect(apiSource).toContain("schemaVersion: 'rvb-pve-command/v1'")
    expect(apiSource).toContain('runId,')
    expect(apiSource).toContain('expectedRevision: view.revision')
  })

  it('stores only the last Run ID and leaves the legacy Run untouched', () => {
    expect(apiSource.match(/localStorage\.setItem\(/g)).toHaveLength(1)
    expect(apiSource).toContain(
      'localStorage.setItem(LAST_RUN_STORAGE_KEY, value)',
    )
    expect(apiSource).toContain(
      'localStorage.getItem(LEGACY_RUN_STORAGE_KEY)',
    )
    expect(browserSource).not.toContain('localStorage.removeItem')
    expect(pageSource).not.toContain('localStorage.')
    expect(pageSource).toContain('不会迁移、读取或删除它')
  })

  it('recovers by URL and renders every server-provided legal command generically', () => {
    expect(pageSource).toContain("searchParams.get('runId')")
    expect(pageSource).toContain("searchParams.set('runId', runId)")
    expect(pageSource).toContain('Array.isArray(view.legalCommands)')
    expect(pageSource).toContain('commands.forEach(function (command)')
    expect(pageSource).toContain('RvBPve.submitLegalCommand(pageState.view, command)')

    expect(pageSource).not.toMatch(/switch\s*\(\s*node/)
    expect(pageSource).not.toMatch(/node\.type\s*===/)
    expect(apiSource).toContain('const parameters = legalCommand.parameters')
    expect(apiSource).toContain("typeof payload.message === 'string'")
    expect(apiSource).toContain("typeof payload.code === 'string'")
  })
})
