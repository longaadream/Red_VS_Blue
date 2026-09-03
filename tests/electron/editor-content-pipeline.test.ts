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

  it('keeps common build fields visible while progressive-disclosing advanced and patch settings', () => {
    const ui = source('electron-editor/ui/index.html')

    expect(ui).toContain('<summary>高级设置</summary>')
    expect(ui).toContain('<summary>工作区与审计信息</summary>')
    expect(ui).toContain('data-patch-settings hidden')
    expect(ui).toContain("patchSettings.hidden = buildMode.value !== 'patch'")
    expect(ui).toContain('id="build-source"')
    expect(ui).toContain('id="build-package-id"')
    expect(ui).toContain('id="build-version"')
  })
})

describe('RED-178 JSON-first content editor', () => {
  it('edits every content collection through fields, code, and complete JSON where applicable', () => {
    const ui = source('electron-editor/ui/index.html')

    for (const collection of ['pieces', 'skills', 'cards', 'rules']) {
      expect(ui).toContain(`${collection}: {`)
      expect(ui).toContain(`initializeCollection(subdir)`)
    }
    expect(ui).toContain('data-editor-pane="fields"')
    expect(ui).toContain("...(executableFields.length ? ['code'] : [])")
    expect(ui).toContain('data-editor-mode="${mode}"')
    expect(ui).toContain("json:'完整 JSON'")
    expect(ui).not.toContain('建议直接打开 JSON 文件进行编辑')
  })

  it('rejects malformed JSON before write and preserves unknown fields during common-field edits', () => {
    const ui = source('electron-editor/ui/index.html')

    expect(ui).toContain('const value = JSON.parse(text)')
    expect(ui).toContain("throw new Error('顶层必须是 JSON 对象。')")
    expect(ui).toContain("saveButton.disabled = Boolean(result.error)")
    expect(ui).toContain('if (parsed.error) return')
    expect(ui).toContain('await api.writeFile(subdir, item.filename, parsed.value)')
    expect(ui).toContain('let draft = clone(data)')
    expect(ui).toContain('setPath(draft, input.dataset.fieldPath, value)')
  })

  it('keeps format, restore, save, and external-open actions distinct with dirty feedback', () => {
    const ui = source('electron-editor/ui/index.html')

    expect(ui).toContain('data-format-json')
    expect(ui).toContain('data-reset-document')
    expect(ui).toContain('data-save-json')
    expect(ui).toContain('data-open-external')
    expect(ui).toContain("setStatus(result.error ? 'JSON 有错误'")
    expect(ui).toContain("'未保存'")
  })

  it('creates complete JSON templates and registers new IDs through the trusted main process', () => {
    const main = source('electron-editor/main.ts')
    const preload = source('electron-editor/preload.ts')
    const ui = source('electron-editor/ui/index.html')

    expect(ui).toContain('NEW_DOCUMENT_TEMPLATES')
    expect(ui).toContain('data-new-document="pieces"')
    expect(ui).toContain('data-new-document="skills"')
    expect(ui).toContain('data-new-document="cards"')
    expect(ui).toContain('data-new-document="rules"')
    expect(ui).toContain('await api.createFile(subdir, item.id, parsed.value)')
    expect(ui).toContain('data-editor-mode="json"')
    expect(preload).toContain("ipcRenderer.invoke('create-file'")
    expect(main).toContain("handleTrusted('create-file'")
    expect(main).toContain("safePath(subdir, 'manifest.json', 'write')")
    expect(main).toContain("flag: 'wx'")
    expect(main).toContain('fs.writeFileSync(manifestFile, JSON.stringify(nextManifest')
  })
})
