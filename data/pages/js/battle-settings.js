;(function(){
 'use strict'
 function mount(){
  const dialog=document.getElementById('battleSettings'),open=document.getElementById('battleSettingsButton')
  if(!dialog||!open)return
  const api=window.electronAPI,input=dialog.querySelector('[data-window-fullscreen]'),error=dialog.querySelector('[data-window-fullscreen-error]')
  const supported=api&&typeof api.getWindowFullscreen==='function'&&typeof api.setWindowFullscreen==='function'
  async function refreshFullscreen(){
   if(!supported)return
   try{input.checked=await api.getWindowFullscreen()}catch(reason){console.warn('读取窗口全屏状态失败',reason);error.textContent='无法读取全屏状态'}
  }
  if(supported){
   dialog.querySelector('[data-window-fullscreen-row]').hidden=false
   input.addEventListener('change',async function(){
    input.disabled=true;error.textContent=''
    try{input.checked=await api.setWindowFullscreen(input.checked)}catch(reason){console.warn('切换窗口全屏失败',reason);error.textContent='切换失败，请重试';await refreshFullscreen()}finally{input.disabled=false}
   })
   if(typeof api.onWindowFullscreenChanged==='function'){
    const unsubscribe=api.onWindowFullscreenChanged(value=>{input.checked=value})
    window.addEventListener('pagehide',()=>unsubscribe(),{once:true})
   }
  }
  open.addEventListener('click',function(){
   dialog.querySelector('[data-sound-volume]').value=Math.round(window.BattleAudio.volume()*100)
   dialog.querySelector('[data-sound-label]').textContent=window.BattleAudio.volume()?Math.round(window.BattleAudio.volume()*100)+'%':'静音'
   dialog.querySelector('[data-screen-shake]').checked=window.BattleImpact.enabled()
   const speed=document.querySelector('.battle-vignette-speed-control'),slot=dialog.querySelector('[data-speed-setting]')
   if(speed&&slot)slot.appendChild(speed)
   dialog.showModal()
   void refreshFullscreen()
  })
  dialog.querySelector('[data-close-settings]').addEventListener('click',()=>dialog.close())
  dialog.addEventListener('keydown',event=>event.stopPropagation())
  dialog.addEventListener('keyup',event=>event.stopPropagation())
  dialog.addEventListener('close',()=>open.focus())
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount()
})()
