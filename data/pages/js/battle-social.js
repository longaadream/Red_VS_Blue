;(function(){
 'use strict'
 const presets={hello:'大家好', 'good-luck':'祝你好运', 'nice-move':'这步漂亮', 'well-played':'打得不错',thanks:'谢谢',sorry:'抱歉',gg:'精彩的对局'}
 const stamps={'thumbs-up':'赞',heart:'♥',clap:'喝彩',laugh:'哈',warning:'!',skull:'☠',star:'★'}
 function mount(options){
  const root=document.createElement('aside');root.className='battle-social';root.setAttribute('aria-label','桌边便笺')
  root.innerHTML='<button type="button" class="social-toggle" aria-expanded="false">便笺</button><section class="social-panel" hidden><ol class="social-notes" aria-live="polite"></ol><div class="social-presets"></div><form><label>写一张便笺<textarea rows="2" maxlength="120" placeholder="最多60字，Enter发送"></textarea></label><button type="submit">发送</button></form><p class="social-status" role="status"></p></section>'
  document.body.appendChild(root)
  const panel=root.querySelector('section'),toggle=root.querySelector('.social-toggle'),input=root.querySelector('textarea'),form=root.querySelector('form'),status=root.querySelector('.social-status'),notes=root.querySelector('ol'),choices=root.querySelector('.social-presets')
  let connected=false,ready=false,composing=false,pending=null,cooldownUntil=0,helloTimeout=null,ackTimeout=null,sequence=0,disposed=false,lastCooldown=false
  const seen=new Set(),toast=document.createElement('div');toast.className='social-arrival-note';toast.hidden=true;root.appendChild(toast)
  let toastTimeout=null,muted=false
  const mute=document.createElement('button');mute.type='button';mute.className='social-mute';mute.textContent='静音提示';mute.setAttribute('aria-pressed','false');panel.appendChild(mute)
  mute.addEventListener('click',()=>{muted=!muted;mute.textContent=muted?'恢复提示':'静音提示';mute.setAttribute('aria-pressed',String(muted));if(muted)toast.hidden=true})
  const session=String(Date.now())+'-'+Math.random().toString(36).slice(2)
  function refresh(){
   const remaining=Math.max(0,cooldownUntil-Date.now())
   root.querySelectorAll('form button,.social-presets button').forEach(button=>{button.disabled=!connected||!ready||!!options.spectating||!!pending||remaining>0})
   input.disabled=!!options.spectating
   if(remaining>0)status.textContent='稍等 '+(remaining/1000).toFixed(1)+' 秒'
   else if(options.spectating)status.textContent='观战中：可以阅读便笺'
   else if(lastCooldown)status.textContent='可以递交下一张便笺'
   lastCooldown=remaining>0
  }
  function send(kind,payload){
   if(!connected||!ready||options.spectating||pending||Date.now()<cooldownUntil)return false
   if(kind==='text'){
    payload=payload.trim()
    const count=typeof Intl.Segmenter==='function'?Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(payload)).length:Array.from(payload).length
    if(!payload||count>60||payload.split('\n').length>2||new TextEncoder().encode(payload).length>256){status.textContent='请输入最多60字、两行以内的便笺';return false}
   }
   const requestId=session+'-'+(++sequence)
   if(!options.send({type:'socialSend',requestId,kind,payload})){status.textContent='连接已断开，便笺未发送';return false}
   pending={requestId,kind,payload};status.textContent='正在递交便笺…';refresh()
   ackTimeout=setTimeout(()=>{pending=null;status.textContent='没有收到确认，请检查连接后再试';refresh()},5000)
   return true
  }
  toggle.addEventListener('click',()=>{panel.hidden=!panel.hidden;toggle.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden&&!options.spectating)input.focus()})
  root.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'&&!event.isComposing&&!composing){panel.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus()}});root.addEventListener('keyup',event=>event.stopPropagation())
  input.addEventListener('compositionstart',()=>{composing=true});input.addEventListener('compositionend',()=>{composing=false})
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!composing){event.preventDefault();send('text',input.value)}})
  form.addEventListener('submit',event=>{event.preventDefault();if(!composing)send('text',input.value)})
  function setConnected(value){
   connected=!!value;ready=false;clearTimeout(helloTimeout);clearTimeout(ackTimeout);pending=null
   status.textContent=connected?'正在连接桌边便笺…':'连接断开，草稿已保留';choices.replaceChildren();refresh()
   if(connected){options.send({type:'socialHello',requestId:session+'-hello-'+(++sequence)});helloTimeout=setTimeout(()=>{if(!ready){status.textContent='当前服务器暂不支持便笺';refresh()}},3000)}
  }
  function receive(message){
   if(disposed)return
   if(message.type==='socialReady'&&connected){
    clearTimeout(helloTimeout);ready=message.supported===true&&message.protocolVersion===1
    status.textContent=ready?'每3秒可递交一张便笺':'当前服务器暂不支持便笺'
    choices.replaceChildren()
    if(ready) [['preset',message.presetIds||[],presets],['stamp',message.stampIds||[],stamps]].forEach(([kind,ids,labels])=>ids.forEach(id=>{if(!labels[id])return;const button=document.createElement('button');button.type='button';button.textContent=labels[id];button.addEventListener('click',()=>send(kind,id));choices.appendChild(button)}))
    refresh()
   }else if(message.type==='socialAck'&&pending&&message.requestId===pending.requestId){
    clearTimeout(ackTimeout)
    if(message.ok){cooldownUntil=Date.now()+3000;if(pending.kind==='text'&&input.value.trim()===pending.payload)input.value='';status.textContent='便笺已递交'}
    else{cooldownUntil=Date.now()+Math.max(0,Number(message.retryAfterMs)||0);status.textContent=message.code==='SOCIAL_COOLDOWN'?'递交太快，请稍等':'便笺未发送，请检查内容或连接'}
    pending=null;refresh()
   }else if(message.type==='socialEvent'){
    if(message.messageId){if(seen.has(message.messageId))return;seen.add(message.messageId);if(seen.size>200)seen.delete(seen.values().next().value)}
    const li=document.createElement('li'),name=document.createElement('strong'),text=document.createElement('span')
    name.textContent=message.displayName||'玩家';text.textContent=message.kind==='preset'?(presets[message.payload]||'便笺'):message.kind==='stamp'?(stamps[message.payload]||'印章'):String(message.payload||'')
    li.append(name,text);notes.appendChild(li);while(notes.children.length>50)notes.firstElementChild.remove();notes.scrollTop=notes.scrollHeight
    if(!muted){toast.textContent=name.textContent+'：'+text.textContent;toast.hidden=false;clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>{toast.hidden=true},5000)
     toggle.classList.add('has-note');setTimeout(()=>{if(!disposed)toggle.classList.remove('has-note')},2000)}
   }
  }
  const tick=setInterval(refresh,100)
  return {setConnected,receive,dispose(){disposed=true;clearInterval(tick);clearTimeout(helloTimeout);clearTimeout(ackTimeout);clearTimeout(toastTimeout);root.remove()}}
 }
 window.BattleSocial={mount}
})()
