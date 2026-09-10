import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
afterEach(()=>vi.useRealTimers())
it('binds selection long-press once across rerenders, cancels taps, and consumes the long-press click',()=>{
  vi.useFakeTimers()
  const handlers=new Map<string,Array<(event:unknown)=>void>>()
  const grid={addEventListener(type:string,listener:(event:unknown)=>void){handlers.set(type,[...(handlers.get(type)||[]),listener])}}
  const show=vi.fn(),sandbox={document:{getElementById:()=>grid},setTimeout,clearTimeout,showPieceDetail:show,bind:()=>{}}
  const html=readFileSync('data/pages/piece-selection.html','utf8').replace(/\r\n/g,'\n')
  const start=html.indexOf('    // Long-press\n'),end=html.indexOf('    // Piece detail popup',start)
  expect(start).toBeGreaterThan(0)
  new Script(html.slice(start,end)+';globalThis.bind=setupLongPress').runInContext(createContext(sandbox))
  sandbox.bind();sandbox.bind();sandbox.bind()
  expect(handlers.get('touchstart')).toHaveLength(1)
  const fire=(type:string,event:unknown={})=>handlers.get(type)!.forEach(fn=>fn(event))
  const touch={target:{closest:()=>({dataset:{pid:'anduin'}})}}
  for(let i=0;i<8;i++){fire('touchstart',touch);vi.advanceTimersByTime(80);fire('touchend');sandbox.bind()}
  vi.advanceTimersByTime(1000);expect(show).not.toHaveBeenCalled()
  fire('touchstart',touch);vi.advanceTimersByTime(600);expect(show).toHaveBeenCalledExactlyOnceWith('anduin')
  fire('touchend');const click={preventDefault:vi.fn(),stopImmediatePropagation:vi.fn()};fire('click',click);expect(click.preventDefault).toHaveBeenCalledOnce()
  fire('touchstart',touch);fire('touchcancel');vi.advanceTimersByTime(1000);expect(show).toHaveBeenCalledOnce()
})
