import {readFileSync} from 'node:fs'
import {describe,it,expect,vi} from 'vitest'
const html=readFileSync('data/pages/battle.html','utf8')
function setup(){
  const source=html.slice(html.indexOf('let cardPressOrigin'),html.indexOf('// ── Card detail modal'))
  const show=vi.fn()
  const api=new Function('showCardDetail',`let pressTimer=null;${source};return {startCardPressTimer,moveCardPressTimer,clearPressTimer,consumeCardPressClick}`)(show)
  return {api,show}
}
describe('hand long press',()=>{
 it('opens after 500ms, tolerates slight motion and consumes the trailing click',()=>{
  vi.useFakeTimers();try {const {api,show}=setup();api.startCardPressTimer({touches:[{clientX:10,clientY:10}]},'i','c');api.moveCardPressTimer({touches:[{clientX:13,clientY:12}]});vi.advanceTimersByTime(500);expect(show).toHaveBeenCalledExactlyOnceWith('i','c');vi.advanceTimersByTime(5000);expect(api.consumeCardPressClick('i')).toBe(true);expect(api.consumeCardPressClick('i')).toBe(false)}finally{vi.useRealTimers()}
 })
 it('scrolling and cancelling never open a preview',()=>{
  vi.useFakeTimers();try {const {api,show}=setup();api.startCardPressTimer({touches:[{clientX:10,clientY:10}]},'i','c');api.moveCardPressTimer({touches:[{clientX:40,clientY:10}]});vi.advanceTimersByTime(600);expect(show).not.toHaveBeenCalled();api.startCardPressTimer({touches:[]},'i','c');api.clearPressTimer();vi.advanceTimersByTime(600);expect(show).not.toHaveBeenCalled()}finally{vi.useRealTimers()}
 })
})
