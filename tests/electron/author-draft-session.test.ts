import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const page = readFileSync('electron-editor/ui/index.html', 'utf8')
const persistence = page.slice(page.indexOf('async function persistAuthorDrafts()'), page.indexOf('async function clearPersistedAuthorDraft('))

describe('author draft renderer persistence', () => {
  it('keeps the written revision after a delayed save and session remount without marking newer edits saved', async () => {
    let finish!: (value: { revision: string }) => void
    const api = { saveAuthorDraft: vi.fn(() => new Promise(resolve => { finish = resolve })) }
    const old = { key:'skills:one', saved:{ name:'old' }, draft:{ name:'edited' }, serialized:'edited', revision:'base', draftRevision:null }
    const sessions = new Map<string, Record<string, unknown>>([[old.key, old]])
    const body = { dataset:{} as Record<string, string> }
    const context = vm.createContext({ api, DRAFT_SESSIONS:sessions, document:{body}, workspaceSaving:false, authorDraftSaving:false,
      persistActiveEditorSession:vi.fn(), sessionIsDirty:()=>true, sessionFingerprint:(value:typeof old)=>value.serialized,
      saveDraftButton:{disabled:false}, syncStudioHeader:vi.fn(), toast:vi.fn(), clone:structuredClone })
    new vm.Script(persistence).runInContext(context)
    const first = vm.runInContext('persistAuthorDrafts()', context)
    expect(body.dataset.saving).toBe('true')
    expect(context.authorDraftSaving).toBe(true)
    const current = {...old, serialized:'newer edit'}
    sessions.set(old.key, current)
    await vm.runInContext('persistAuthorDrafts()', context)
    expect(api.saveAuthorDraft).toHaveBeenCalledTimes(1)
    finish({revision:'written'})
    await first
    expect(current).toMatchObject({serialized:'newer edit',draftRevision:'written',persistedFingerprint:'edited'})
    expect(body.dataset.saving).toBeUndefined()
    expect(context.workspaceSaving).toBe(false)
    expect(context.authorDraftSaving).toBe(false)
  })
  it('releases the saving gate after an IPC failure', async () => {
    const toast=vi.fn(),body={dataset:{}}
    const session={key:'skills:one',saved:{},draft:{},serialized:'{}'}
    const context=vm.createContext({api:{saveAuthorDraft:vi.fn(async()=>{throw new Error('保存冲突')})},
      DRAFT_SESSIONS:new Map([[session.key,session]]),document:{body},workspaceSaving:false,authorDraftSaving:false,
      persistActiveEditorSession:vi.fn(),sessionIsDirty:()=>true,sessionFingerprint:()=>'',saveDraftButton:{disabled:false},
      syncStudioHeader:vi.fn(),toast,clone:structuredClone})
    new vm.Script(persistence).runInContext(context)
    await vm.runInContext('persistAuthorDrafts()',context)
    expect(context.workspaceSaving).toBe(false)
    expect(context.authorDraftSaving).toBe(false)
    expect(toast).toHaveBeenCalledWith('草稿保存失败：保存冲突','error')
  })
})
