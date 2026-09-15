import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import {expect, it} from 'vitest'

const source=readFileSync(new URL('../../lib/server/colyseus/create-colyseus-server.ts',import.meta.url),'utf8').replace(/\r/g, '')
const start=source.indexOf('beforeListen: async () => {')+'beforeListen: async () => {'.length
const body=source.slice(start,source.indexOf('\n    },\n    express:',start))
function harness(identity:()=>unknown){
  const context=vm.createContext({ready:false,healthError:undefined,Error,process:{connected:false},verificationProgress:{subscribe(){},unsubscribe(){}},repository:{},logger:{},adventureStore:undefined,preparePostgresAuthority:async()=>{},getServerGameProfileIdentityV1:identity})
  return {run:()=>vm.runInContext(transformSync('(async()=>{'+body+'})()', {loader:'ts'}).code,context),context}
}
it('refuses readiness when installed profile verification fails',async()=>{
  const h=harness(()=>{throw Error('invalid signed profile')})
  await expect(h.run()).rejects.toThrow('invalid signed profile')
  expect(h.context.ready).toBe(false)
  expect(h.context.healthError).toBe('invalid signed profile')
})
it('only becomes ready after identity verification completes',async()=>{
  let checked=false
  const h=harness(()=>{expect(h.context.ready).toBe(false);checked=true;return {}})
  await h.run()
  expect(checked).toBe(true)
  expect(h.context.ready).toBe(true)
})

