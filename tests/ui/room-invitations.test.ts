import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { expect, it, vi } from 'vitest'

const source = readFileSync('data/pages/js/room-invitations.js', 'utf8')
function setup(intent: unknown, destination = {hostId:'abc123',roomId:'room-1'}) {
  let value = JSON.stringify(intent)
  let accountId = 'alice'
  const fetch = vi.fn(async () => ({ok:true,json:async()=>destination}))
  const window = {RvBRoomInvitations: undefined as undefined | {takeIntent:()=>Promise<{origin:string;hostId:string;roomId:string}>}, RvBUtils:{
    normalizeOfficialOrigin:(raw:string)=>raw,
    readOfficialSession:()=>({token:'session-token',account:{id:accountId}}),
  }}
  new Script(source).runInContext(createContext({window,fetch,URL,URLSearchParams,AbortSignal,
    localStorage:{getItem:()=> 'https://server.test'}, sessionStorage:{getItem:()=>value,removeItem:()=>{value=''}},
    location:{pathname:'/official.html'},document:{querySelector:()=>null},
  }))
  return {api:window.RvBRoomInvitations!,fetch,changeAccount:()=>{accountId='bob'}}
}
it('consumes an explicit acceptance intent through the authenticated same-server API',async()=>{
  const {api,fetch} = setup({id:'invite-1',origin:'https://server.test',accountId:'alice'})
  expect(await api.takeIntent()).toEqual({origin:'https://server.test',hostId:'abc123',roomId:'room-1'})
  expect(fetch).toHaveBeenCalledWith('https://server.test/official/community/invitations/invite-1/accept',expect.objectContaining({method:'POST',headers:expect.objectContaining({Authorization:'Bearer session-token'})}))
  await expect(api.takeIntent()).rejects.toThrow('邀请已失效')
})
it('rejects account/server changes and malformed destination without navigating',async()=>{
  for (const intent of [{id:'i',origin:'https://evil.test',accountId:'alice'},{id:'i',origin:'https://server.test',accountId:'bob'}]) {
    const {api,fetch}=setup(intent)
    await expect(api.takeIntent()).rejects.toThrow('邀请账号已变化')
    expect(fetch).not.toHaveBeenCalled()
  }
  const {api}=setup({id:'i',origin:'https://server.test',accountId:'alice'},{hostId:'https://evil.test',roomId:'r'})
  await expect(api.takeIntent()).rejects.toThrow('目的地无效')
})
it('discards an acceptance response if the signed-in account changes while awaiting it',async()=>{
  const test=setup({id:'i',origin:'https://server.test',accountId:'alice'})
  test.fetch.mockImplementation(async()=>{test.changeAccount();return {ok:true,json:async()=>({hostId:'abc123',roomId:'r'})}})
  await expect(test.api.takeIntent()).rejects.toThrow('登录账号已变化')
})
