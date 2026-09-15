import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {it,expect,vi} from 'vitest'

interface TestNode {children:TestNode[];style:Record<string,string>;hidden:boolean;value?:string;append(...items:TestNode[]):void;replaceChildren():void;setAttribute():void}
function node():TestNode {return {children:[],style:{},hidden:true,append(...items:TestNode[]){this.children.push(...items)},replaceChildren(){this.children=[]},setAttribute(){}}}
function setup(search:string){
  const ips=vi.fn(async()=>['127.0.0.1','192.168.5.8','192.168.5.8','169.254.1.1'])
  const window={RvBHost:{getLanIps:ips},RvBLanAddress:{show:async(_box:TestNode,_explicit?:string)=>{void _box;void _explicit}}}
  runInNewContext(readFileSync('data/pages/js/lan-address.js','utf8'),{window,URL,URLSearchParams,location:{search},document:{createElement:node,addEventListener:()=>{}},navigator:{}})
  return {window,ips}
}
it('shows real LAN IP and host port, excluding loopback and duplicate addresses',async()=>{
  const {window}=setup('?serverUrl=http://127.0.0.1:2567&lobbyContext=lan'),box=node()
  await window.RvBLanAddress.show(box)
  expect(box.children).toHaveLength(2)
  expect(box.children[1].children[0].value).toBe('http://192.168.5.8:2567')
})
it('does not show LAN addresses in a public room hosted locally',async()=>{
  const {window,ips}=setup('?serverUrl=http://127.0.0.1:2567&lobbyContext=public'),box=node()
  await window.RvBLanAddress.show(box)
  expect(box.hidden).toBe(true);expect(ips).not.toHaveBeenCalled()
})
it('preserves a direct peer address without replacing it by this devices IP',async()=>{
  const {window,ips}=setup('?lobbyContext=lan'),box=node()
  await window.RvBLanAddress.show(box,'http://192.168.5.7:2567')
  expect(box.children[1].children[0].value).toBe('http://192.168.5.7:2567')
  expect(ips).not.toHaveBeenCalled()
})
