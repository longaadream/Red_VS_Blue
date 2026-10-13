import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

it('can load the shared runtime in a browser without shared-memory support', () => {
  const renameSync=vi.fn()
  const code=ts.transpileModule(readFileSync('lib/content-pipeline/runtime/profile-rename.ts','utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText
  const exports:Record<string,unknown>={}
  const context=vm.createContext({exports,SharedArrayBuffer:undefined,Atomics:undefined,
    require:(id:string)=>{if(id!=='node:fs')throw new Error(id);return {renameSync,existsSync:()=>false}}})
  expect(()=>new vm.Script(code).runInContext(context)).not.toThrow()
  expect(exports.renameProfileDirectoryWithWindowsRetryV1).toBeTypeOf('function')
  expect(renameSync).not.toHaveBeenCalled()
})
