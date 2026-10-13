import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const page = readFileSync('electron-editor/ui/index.html', 'utf8')
const factory = page.slice(page.indexOf('const NEW_DOCUMENT_TEMPLATES ='), page.indexOf('const COLLECTIONS ='))
const core = readFileSync('electron-editor/ui/content-graph-core.js', 'utf8')

describe('new author documents', () => {
  it.each(['skills', 'cards', 'rules'])('starts %s with a valid empty author program', collection => {
    const context = vm.createContext({ console })
    vm.runInContext('window = globalThis', context)
    vm.runInContext(core, context)
    vm.runInContext(factory, context)
    const result = vm.runInContext(`(() => {
      const document = newDocumentData(${JSON.stringify(collection)}, 'new-example', '从空白开始');
      ContentGraphCore.assertContentGraphArtifact(document);
      return document;
    })()`, context)
    expect(result).not.toHaveProperty('summonCapability')
    expect(result.gameplayModules.entries[collection === 'rules' ? 'skillCode' : 'code'].compilerVersion).toBeTruthy()
  })

  it('reports a missing compiler instead of creating unowned executable code', () => {
    const context = vm.createContext({ window: {} })
    vm.runInContext(factory, context)
    expect(() => vm.runInContext("newDocumentData('skills', 'new-example', '从空白开始')", context)).toThrow('作者编译器尚未准备好')
  })
})
