;(function(root){
 'use strict'
 const doc=root.document
 let audio=null
 function prepare(){if(!audio&&root.BattleAudio)audio=root.BattleAudio.create()}
 function click(event){
  const button=event.target.closest&&event.target.closest('button, [role="button"], input[type="button"], input[type="submit"], a[href]')
  if(!event.isTrusted||!button||button.matches(':disabled')||button.closest('[aria-disabled="true"], [inert], [data-no-click-sound], [data-kind]'))return
  prepare()
  if(audio){audio.unlock();audio.play('click')}
 }
 if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',prepare,{once:true});else prepare()
 doc.addEventListener('click',click,true)
 root.addEventListener('pagehide',function(){if(audio)audio.dispose();audio=null})
 root.addEventListener('pageshow',prepare)
})(window)
