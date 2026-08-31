import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..', '..')

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8')
}

describe('RED-118 packaged Editor content pipeline boundary', () => {
  it('exposes one typed content operation and removes arbitrary build process IPC', () => {
    const main = source('electron-editor/main.ts')
    const preload = source('electron-editor/preload.ts')

    expect(main).toContain("handleTrusted('content-operation'")
    expect(main).toContain('normalizeEditorContentOperationRequestV1')
    expect(main).toContain('content-pipeline-worker.cjs')
    expect(main).toContain('utilityProcess.fork')
    expect(main).toContain('EditorContentOperationQueueV1')
    expect(main).toContain('contentOperationQueue.enqueue')
    expect(main).not.toContain("handleTrusted('run-build'")
    expect(main).not.toMatch(/spawn\(['\"]node['\"]/)
    expect(preload).toContain("ipcRenderer.invoke('content-operation'")
    expect(preload).not.toContain("ipcRenderer.invoke('run-build'")
  })

  it('builds the self-contained worker before Editor development and packaging', () => {
    const packageJson = JSON.parse(source('package.json')) as {
      scripts: Record<string, string>
    }

    expect(packageJson.scripts['build:content-pipeline:editor-bundle'])
      .toContain('rvb.mjs bundle-editor-worker')
    expect(packageJson.scripts['dev:electron:editor'])
      .toContain('build:content-pipeline:editor-bundle')
    expect(packageJson.scripts['build:electron:editor'])
      .toContain('build:content-pipeline:editor-bundle')
  })

  it('uses a writable authoring workspace and shows canonical identity and refusal fields', () => {
    const main = source('electron-editor/main.ts')
    const ui = source('electron-editor/ui/index.html')

    expect(main).toContain("path.join(app.getPath('userData'), 'content-authoring')")
    expect(main).toContain('ensureAuthoringWorkspace')
    expect(ui).toContain('packageHash')
    expect(ui).toContain('resolvedProfileHash')
    expect(ui).toContain('authorityContentHash')
    expect(ui).toContain('engineAbi')
    expect(ui).toContain('contentAbi')
    expect(ui).toContain('publisherKeyId')
    expect(ui).toContain('capabilities')
    expect(ui).toContain('refusal')
    expect(ui).toContain('refusalPath')
    expect(ui).toContain('refusalContent')
  })

  it('exposes visible controls and pending feedback for the complete operation chain', () => {
    const ui = source('electron-editor/ui/index.html')

    for (const operation of ['build', 'sign', 'validate', 'resolve', 'smoke']) {
      expect(ui).toContain(`data-pipeline-operation="${operation}"`)
      expect(ui).toContain(`data-operation-form="${operation}"`)
      expect(ui).toContain(`data-run-operation="${operation}"`)
    }
    expect(ui).toContain('aria-live="polite"')
    expect(ui).toContain('badge-pending')
    expect(ui).toContain('处理中')
    expect(ui).toContain('terminalOutcome')
    expect(ui).toContain('finalRunHash')
  })
})
