;(function(){
 'use strict'
 function mount(){
  const dialog=document.getElementById('battleSettings'),open=document.getElementById('battleSettingsButton')
  if(!dialog||!open)return
  open.addEventListener('click',function(){
   dialog.querySelector('[data-sound-volume]').value=Math.round(window.BattleAudio.volume()*100)
   dialog.querySelector('[data-sound-label]').textContent=window.BattleAudio.volume()?Math.round(window.BattleAudio.volume()*100)+'%':'静音'
   dialog.querySelector('[data-screen-shake]').checked=window.BattleImpact.enabled()
   dialog.showModal()
  })
  dialog.querySelector('[data-close-settings]').addEventListener('click',()=>dialog.close())
  dialog.addEventListener('keydown',event=>event.stopPropagation())
  dialog.addEventListener('keyup',event=>event.stopPropagation())
  dialog.addEventListener('close',()=>open.focus())
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount()
})()
