import { afterEach, expect, it, vi } from 'vitest'
import os from 'node:os'
import dgram from 'node:dgram'
import { startLanBroadcast } from '../../mobile-server/lan-broadcast'

vi.mock('../../electron-client/host-discovery',()=>({
  hostDiscoveryFromEnvironment:()=>({schemaVersion:1,serverId:'android-host',serverName:'手机'}),
  ipv4Broadcast:()=> '192.168.5.255',
}))
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers()})
it('advertises the native host identity and port repeatedly, then stops',()=>{
  vi.useFakeTimers()
  vi.spyOn(os,'networkInterfaces').mockReturnValue({wifi:[{family:'IPv4',internal:false,address:'192.168.5.8',netmask:'255.255.255.0',cidr:'192.168.5.8/24',mac:''}]})
  const sent:unknown[][]=[]
  const socket={on:vi.fn(),close:vi.fn(),setBroadcast:vi.fn(),bind:(_port:number,_address:string,ready:()=>void)=>ready(),send:(data:Buffer,port:number,address:string,done:(error?:Error)=>void)=>{sent.push([JSON.parse(data.toString()),port,address]);done()}}
  vi.spyOn(dgram,'createSocket').mockReturnValue(socket as unknown as dgram.Socket)
  const stop=startLanBroadcast(2567)
  expect(sent[0]).toEqual([{magic:'RVB_DISCOVER',schemaVersion:1,serverId:'android-host',serverName:'手机',name:'手机',ip:'192.168.5.8',ips:['192.168.5.8'],port:2567},7877,'192.168.5.255'])
  vi.advanceTimersByTime(2000);expect(sent).toHaveLength(2)
  stop();vi.advanceTimersByTime(4000);expect(sent).toHaveLength(2)
})
it('survives interface enumeration failure and retries next cycle',()=>{
  vi.useFakeTimers()
  const interfaces=vi.spyOn(os,'networkInterfaces').mockImplementationOnce(()=>{throw Error('interface unavailable')}).mockReturnValue({})
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{})
  const stop=startLanBroadcast(2567)
  expect(warning).toHaveBeenCalled()
  vi.advanceTimersByTime(2000);expect(interfaces).toHaveBeenCalledTimes(2)
  stop()
})
