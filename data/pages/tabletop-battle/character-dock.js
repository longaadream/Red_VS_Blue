/* Native details + native commands, composed as a persistent non-modal character sheet. */
(function(){
 'use strict';
 const modal=document.getElementById('pieceInfoModal'),panel=document.getElementById('pieceKeywordPanel');
 const nativeRender=window.renderPieceInfoRecord,nativeContext=window.renderPieceContextMenu,nativeShow=window.showPieceInfo,nativeClose=window.closePieceInfo;
 let dismissed=null,lastSelected=null,keywordOpen=false,keywordName='',busy=false,casting=false,lastSignature='';
 const reopen=document.createElement('button');reopen.className='character-reopen';reopen.type='button';reopen.textContent='角色';reopen.hidden=true;reopen.title='展开选中角色';reopen.addEventListener('click',()=>{if(selectedPieceId){dismissed=null;window.showPieceInfo(selectedPieceId);}});document.body.append(reopen);
 const portrait=document.createElement('img');portrait.className='character-portrait';portrait.alt='';portrait.hidden=true;modal.querySelector('.pi-header').prepend(portrait);
 const keywordClose=document.createElement('button');keywordClose.className='character-keyword-close';keywordClose.type='button';keywordClose.setAttribute('aria-label','收起关键词说明');keywordClose.title='收起关键词说明';keywordClose.addEventListener('click',()=>setKeyword(false));
 function setKeyword(open){keywordOpen=open;panel.classList.toggle('is-keyword-open',open);panel.setAttribute('aria-hidden',String(!open));modal.querySelectorAll('.keyword-badge').forEach(button=>{const active=open&&button.dataset.keyword===keywordName;button.classList.toggle('active',active);button.setAttribute('aria-expanded',String(active));});}
 function refreshActions(piece){
  const records=pieceInfoDisplaySkills(piece),rows=[...document.querySelectorAll('#pieceInfoContent .pi-skill')];
  const owned=!!myPlayerId&&String(piece.ownerPlayerId||'').toLowerCase()===String(myPlayerId).toLowerCase();
  const targetBusy=!!(pendingSkill||pendingCardAction||targetSubmissionPending||pendingActionFeedback||casting||(G&&(G.pendingTargetSelection||G.pendingOptionSelection)));
  rows.slice(0,records.length).forEach((row,i)=>{
   const skill=records[i],id=skillIdOf(skill),definition=skillDefOf(id),passive=definition.type==='passive'||definition.kind==='passive';
   const meta=row.querySelector('.pi-skill-meta');if(meta)meta.textContent=meta.textContent.replace(/ 路 /g,' · ');
   if(!owned||passive||skill.derived){row.querySelectorAll('.character-cast,.character-cast-reason').forEach(element=>element.remove());row.classList.remove('cast-unavailable');return;}
   const available=resolveSkillAvailability(piece,skill);
   let button=row.querySelector('.character-cast');
   if(!button){button=document.createElement('button');button.type='button';button.className='character-cast';row.append(button);button.addEventListener('click',async(event)=>{
    event.stopPropagation();if(button.disabled||casting)return;
    // Re-resolve against the current visible owner and native availability at action time.
    const live=G&&G.pieces.find(p=>p.instanceId===piece.instanceId);
    if(!live||!resolveSkillAvailability(live,id).available)return;
    casting=true;button.disabled=true;setKeyword(false);
    try{selectedPieceId=live.instanceId;await dispatchBattleIntent({type:'select-skill',skillId:id});}
    finally{casting=false;lastSignature='';syncSelected(true);}
   });}
   button.setAttribute('aria-label','释放：'+(definition.name||id));button.title=targetBusy?'请先完成当前操作':available.unavailableReason||'释放 '+(definition.name||id);
   button.disabled=targetBusy||!available.available;button.textContent='释放';row.classList.toggle('cast-unavailable',!available.available);
   let reason=row.querySelector('.character-cast-reason');if(!reason){reason=document.createElement('div');reason.className='character-cast-reason';row.append(reason);}
   reason.textContent=available.unavailableReason||'';
  });
  modal.classList.toggle('is-selecting-target',!!(pendingSkill||pendingCardAction));
 }
 function enhance(piece){
  modal.setAttribute('aria-modal','false');modal.classList.add('character-dock');document.body.classList.add('character-dock-open');reopen.hidden=true;
  const source=PIECES_BY_ID[piece.templateId];portrait.hidden=!(source&&source.image);if(source&&source.image){portrait.src='images/'+source.image;portrait.alt=(piece.name||source.name||'角色')+'头像';}
  portrait.onerror=()=>{portrait.hidden=true;};
  const owner=String(piece.ownerPlayerId||'').toLowerCase()===String(myPlayerId||'').toLowerCase();modal.dataset.relation=owner?'ally':'enemy';
  panel.setAttribute('role','region');panel.setAttribute('aria-label','关键词说明');panel.append(keywordClose);
  modal.querySelectorAll('.keyword-badge[data-scope="piece"]').forEach(button=>{
   button.setAttribute('aria-controls','pieceKeywordPanel');
   button.onclick=event=>{event.stopPropagation();const same=keywordOpen&&keywordName===button.dataset.keyword;keywordName=button.dataset.keyword;activePieceKeyword=keywordName;
    if(!same){panel.innerHTML=renderKeywordPanel(currentPieceKeywords,keywordName,'');panel.append(keywordClose);const box=button.getBoundingClientRect();const top=Math.max(148,Math.min(box.top-15,window.innerHeight-410));panel.style.top=top+'px';}
    setKeyword(!same);
   };
  });
  setKeyword(keywordOpen);refreshActions(piece);
 }
 window.renderPieceInfoRecord=function(piece,preserveKeyword){
  if(currentPieceInfoSource==='deployment'){modal.classList.remove('character-dock');modal.setAttribute('aria-modal','true');document.body.classList.remove('character-dock-open');return nativeRender(piece,preserveKeyword);}
  const scroll=modal.querySelector('.pi-sheet').scrollTop;
  nativeRender(piece,true);enhance(piece);modal.querySelector('.pi-sheet').scrollTop=scroll;
 };
 window.showPieceInfo=function(id,preserveKeyword){
  const changed=currentPieceInfoId!==id;dismissed=null;if(changed||!preserveKeyword){keywordOpen=false;keywordName='';lastSignature='';}
  nativeShow(id,true);if(changed)modal.querySelector('.pi-sheet').scrollTop=0;
 };
 window.closePieceInfo=function(){
  dismissed=selectedPieceId;keywordOpen=false;keywordName='';document.body.classList.remove('character-dock-open');
  nativeClose.apply(this,arguments);reopen.hidden=!selectedPieceId;
 };
 function syncSelected(force){
  if(busy||currentPieceInfoSource==='deployment')return;
  if(selectedPieceId!==lastSelected){dismissed=null;keywordOpen=false;keywordName='';lastSignature='';lastSelected=selectedPieceId;modal.querySelector('.pi-sheet').scrollTop=0;}
  if(!selectedPieceId){reopen.hidden=true;return;}
  if(dismissed===selectedPieceId){reopen.hidden=false;return;}
  // While choosing targets, keep the caster sheet; target picking must not switch the viewed actor.
  const id=(pendingSkill||pendingCardAction)&&currentPieceInfoId?currentPieceInfoId:selectedPieceId;
  const piece=G&&G.pieces.find(p=>p.instanceId===id);if(!piece)return;
  const signature=JSON.stringify([id,pieceDispHp(piece),pieceDispStats(piece),pieceDispTags(piece),pieceInfoDisplaySkills(piece),G.turn,G.players.map(p=>[p.playerId,p.actionPoints,p.chargePoints]),!!pendingSkill,!!pendingCardAction,!!pendingActionFeedback,!!targetSubmissionPending]);
  if(!force&&signature===lastSignature)return;
  busy=true;try{lastSignature=signature;currentPieceInfoId=id;currentPieceInfoSource='board';window.renderPieceInfoRecord(piece,true);}finally{busy=false;}
 }
 window.renderPieceContextMenu=function(piece){const r=nativeContext(piece);syncSelected(false);return r;};
 // Status/resources/turn updates call the native render; this also keeps an open enemy sheet read-only.
 const nativeRenderPage=window.render;window.render=function(){const r=nativeRenderPage.apply(this,arguments);syncSelected(false);return r;};
 const nativeStatus=window.setStatusMsg;window.setStatusMsg=function(message){return nativeStatus.apply(this,[typeof message==='string'?message.replace('已选中棋子。点击菜单 i 或右键查看详细信息','已选中棋子，在左侧查看技能和状态'):message,...Array.prototype.slice.call(arguments,1)]);};
 // Non-modal sheet must not trap Tab. Escape gives target selection precedence over closing the sheet.
 document.removeEventListener('keydown',handlePieceInfoModalKeydown);
 document.addEventListener('keydown',event=>{
  if(currentPieceInfoSource==='deployment'){handlePieceInfoModalKeydown(event);return;}
  if(event.key!=='Escape'||event.defaultPrevented||pendingSkill||pendingCardAction)return;
  if(keywordOpen){event.preventDefault();setKeyword(false);}else if(document.body.classList.contains('character-dock-open')){event.preventDefault();window.closePieceInfo({restoreFocus:false});}
 });
 setKeyword(false);
})();
