;(function(root){
  'use strict'
  const KEY='rvb_screen_shake', listeners=new Set()
  let setting=null
  function enabled(){if(setting!==null)return setting;try{return root.localStorage.getItem(KEY)!=='off'}catch{return true}}
  function setEnabled(value){setting=!!value;try{root.localStorage.setItem(KEY,setting?'on':'off')}catch{/* Session preference still works. */}listeners.forEach(fn=>fn())}
  function create(target){
    const doc=root.document, reduced=root.matchMedia?root.matchMedia('(prefers-reduced-motion: reduce)'):null
    let animation=null, disposed=false, last=-Infinity
    function stop(){if(animation){animation.cancel();animation=null}}
    function preference(){if(!enabled() || (reduced && reduced.matches))stop()}
    function visibility(){if(doc.hidden)stop()}
    function key(event){if(event.code==='Space'||event.key==='Escape')stop()}
    if(doc){doc.addEventListener('visibilitychange',visibility);doc.addEventListener('pointerdown',stop,true);doc.addEventListener('contextmenu',stop,true);doc.addEventListener('keydown',key,true)}
    if(reduced && reduced.addEventListener)reduced.addEventListener('change',preference)
    listeners.add(preference)
    return {stop:stop, playEvents:function(events){
      if(disposed || !target || !target.animate || !enabled() || (doc && doc.hidden) || (reduced && reduced.matches) || !root.BattleAudio)return false
      const heavy=root.BattleAudio.cuesFor(events).some(cue=>cue.kind==='damage' && cue.tier===2)
      if(!heavy || Date.now()-last<240)return false
      last=Date.now();stop()
      // Independent translate leaves renderer zoom/transform intact. Input cancels it immediately.
      animation=target.animate([{translate:'0 0'},{translate:'-3px 1px'},{translate:'3px -1px'},{translate:'-2px 0'},{translate:'1px 0'},{translate:'0 0'}],{duration:180,easing:'ease-out'})
      return true
    },dispose:function(){
      disposed=true;stop();listeners.delete(preference)
      if(doc){doc.removeEventListener('visibilitychange',visibility);doc.removeEventListener('pointerdown',stop,true);doc.removeEventListener('contextmenu',stop,true);doc.removeEventListener('keydown',key,true)}
      if(reduced && reduced.removeEventListener)reduced.removeEventListener('change',preference)
    }}
  }
  root.BattleImpact={create:create,enabled:enabled,setEnabled:setEnabled}
  if(root.document)root.document.addEventListener('DOMContentLoaded',function(){
    const input=root.document.querySelector('[data-screen-shake]');if(!input)return
    input.checked=enabled();input.addEventListener('change',()=>setEnabled(input.checked))
  },{once:true})
})(typeof window!=='undefined'?window:globalThis)
