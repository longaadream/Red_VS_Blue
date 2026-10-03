/* Native details + native commands, composed as a persistent non-modal character sheet. */
(function(){
 'use strict';
 const modal=document.getElementById('pieceInfoModal'),panel=document.getElementById('pieceKeywordPanel');
 const nativeRender=window.renderPieceInfoRecord,nativeDeploymentError=window.renderDeploymentPieceInfoError,nativeContext=window.renderPieceContextMenu,nativeShow=window.showPieceInfo,nativeClose=window.closePieceInfo;
 let dismissed=null,lastSelected=null,keywordOpen=false,keywordName='',busy=false,casting=false,lastSignature='';
 const reopen=document.createElement('button');reopen.className='character-reopen';reopen.type='button';reopen.textContent='角色';reopen.hidden=true;reopen.title='展开选中角色';reopen.addEventListener('click',()=>{if(selectedPieceId){dismissed=null;window.showPieceInfo(selectedPieceId);}});document.body.append(reopen);
 const portrait=document.createElement('img');portrait.className='character-portrait';portrait.alt='';portrait.hidden=true;modal.querySelector('.pi-header').prepend(portrait);
 const keywordClose=document.createElement('button');keywordClose.className='character-keyword-close';keywordClose.type='button';keywordClose.setAttribute('aria-label','收起关键词说明');keywordClose.title='收起关键词说明';keywordClose.addEventListener('click',()=>setKeyword(false));
 function setKeyword(open){keywordOpen=open;panel.classList.toggle('is-keyword-open',open);panel.setAttribute('aria-hidden',String(!open));modal.querySelectorAll('.keyword-badge').forEach(button=>{const active=open&&button.dataset.keyword===keywordName;button.classList.toggle('active',active);button.setAttribute('aria-expanded',String(active));});}
 function targetSkillId(){
  const local=pendingSkill&&(pendingSkill.skillId||(pendingSkill.baseAction&&pendingSkill.baseAction.skillId));
  if(local)return String(local);
  const draft=targetSubmissionPending&&targetSubmissionPending.draft&&targetSubmissionPending.draft.skill;
  return draft&&draft.skillId?String(draft.skillId):'';
 }
 function targetCancelAllowed(){
  if(!targetSkillId()||targetSubmissionPending)return false;
  const selection=G&&(G.pendingTargetSelection||G.pendingOptionSelection);
  return !(selection&&selection.canCancel===false);
 }
 function setCancelMeta(meta,cancelMode,stateLabel){
  if(!meta)return;
  if(cancelMode||stateLabel){
   if(meta.dataset.cancelOriginalHtml===undefined)meta.dataset.cancelOriginalHtml=meta.innerHTML;
   meta.textContent=cancelMode?'再次点击取消':stateLabel;meta.classList.toggle('character-cast-cancel-label',cancelMode);meta.classList.toggle('character-cast-cancel-disabled-label',!cancelMode);
  }else if(meta.dataset.cancelOriginalHtml!==undefined){
   meta.innerHTML=meta.dataset.cancelOriginalHtml;delete meta.dataset.cancelOriginalHtml;meta.classList.remove('character-cast-cancel-label');meta.classList.remove('character-cast-cancel-disabled-label');
  }
 }
  function skillCardClickTargetAllowed(target){
   if(!target||typeof target.closest!=='function')return true;
   return !target.closest('.character-cast,.keyword-badge,.pi-keywords,#targetSelectionControls,.character-cast-reason,button,a,input,select,textarea,[contenteditable="true"],[role="button"]');
  }
  function bindSkillCardActivation(row){
   if(!row||!row.dataset||row.dataset.skillCardClickBound==='true')return;
   row.dataset.skillCardClickBound='true';
   let pointerId=null,startX=0,startY=0;
   row.addEventListener('pointerdown',event=>{
    if(event.button!==undefined&&event.button!==0)return;
    if(event.isPrimary===false)return;
    pointerId=event.pointerId;startX=event.clientX||0;startY=event.clientY||0;delete row.dataset.skillCardPointerMoved;
   });
   row.addEventListener('pointermove',event=>{
    if(pointerId===null||event.pointerId!==pointerId)return;
    if(Math.abs((event.clientX||0)-startX)>8||Math.abs((event.clientY||0)-startY)>8)row.dataset.skillCardPointerMoved='true';
   });
   row.addEventListener('pointerup',event=>{
    if(pointerId===null||event.pointerId!==pointerId)return;
    pointerId=null;
   });
   row.addEventListener('pointercancel',event=>{
    if(pointerId===null||event.pointerId!==pointerId)return;
    pointerId=null;
    // A cancelled pointer must not synthesize a card activation. Keep the
    // marker until the click path consumes it or a new pointer starts.
    row.dataset.skillCardPointerMoved='true';
   });
   row.addEventListener('click',event=>{
    if(event.defaultPrevented||(event.button!==undefined&&event.button!==0)||!skillCardClickTargetAllowed(event.target))return;
    if(row.dataset.skillCardPointerMoved==='true'){delete row.dataset.skillCardPointerMoved;return;}
    const selection=window.getSelection&&window.getSelection();
    if(selection&&String(selection).trim())return;
    const button=row.querySelector('.character-cast');
    if(!button||button.disabled||typeof button.click!=='function')return;
    button.click();
   });
  }
 function refreshActions(piece){
  const records=pieceInfoDisplaySkills(piece),rows=[...document.querySelectorAll('#pieceInfoContent .pi-skill')];
  const owned=!!myPlayerId&&String(piece.ownerPlayerId||'').toLowerCase()===String(myPlayerId).toLowerCase();
  const authoritativeSelection=G&&(G.pendingTargetSelection||G.pendingOptionSelection);
  const selectionLocked=!!(authoritativeSelection&&authoritativeSelection.canCancel===false);
  const waitingForOther=typeof waitingForOtherPending==='function'&&waitingForOtherPending();
  // A local target draft is cancelable and must leave the other skill headers
  // interactive so a new preview can replace it. Submission and authoritative
  // non-cancelable selections still lock the dock.
  const targetBusy=!!(pendingCardAction||targetSubmissionPending||pendingActionFeedback||casting||selectionLocked||waitingForOther);
  const targetingSkillId=targetSkillId();
  const cancelAllowed=targetCancelAllowed();
  rows.slice(0,records.length).forEach((row,i)=>{
   const skill=records[i],id=skillIdOf(skill),definition=skillDefOf(id),passive=definition.type==='passive'||definition.kind==='passive';
   const isTargeting=!!targetingSkillId&&String(id)===targetingSkillId;
   row.classList.toggle('is-targeting-skill',isTargeting);
   row.setAttribute('aria-current',isTargeting?'true':'false');
   const meta=row.querySelector('.pi-skill-meta');if(meta)meta.textContent=meta.textContent.replace(/ 路 /g,' · ');
   if(!owned||passive||skill.derived){row.querySelectorAll('.character-cast,.character-cast-reason').forEach(element=>element.remove());row.classList.remove('cast-unavailable');return;}
   const available=resolveSkillAvailability(piece,skill);
   let button=row.querySelector('.character-cast');
   if(!button){button=document.createElement('button');button.type='button';button.className='character-cast';row.append(button);button.addEventListener('click',async(event)=>{
    event.stopPropagation();if(button.disabled||casting)return;
    const hoverPreview=typeof pendingSkill!=='undefined'&&pendingSkill&&pendingSkill.previewOnly===true&&pendingSkill.previewOrigin==='hover'&&String(pendingSkill.skillId||'')===String(id);
    if(button.dataset.targetMode==='cancel'&&!hoverPreview){
     casting=true;button.disabled=true;setKeyword(false);
     try{selectedPieceId=piece.instanceId;await dispatchBattleIntent({type:'cancel-target'});}
     finally{casting=false;syncSelected(false);}
     return;
    }
    // Re-resolve against the current visible owner and native availability at action time.
    const live=G&&G.pieces.find(p=>p.instanceId===piece.instanceId);
    if(!live||!resolveSkillAvailability(live,id).available)return;
    casting=true;button.disabled=true;setKeyword(false);
    try{selectedPieceId=live.instanceId;await dispatchBattleIntent({type:'select-skill',skillId:id});}
    finally{casting=false;syncSelected(false);}
   });}
   if(!row.dataset.skillPreviewHoverBound){
    row.dataset.skillPreviewHoverBound='true';
    row.addEventListener('pointerenter',event=>{
     const pointerType=event&&event.pointerType;
     if(pointerType&&pointerType!=='mouse')return;
     const target=event&&event.target;
     if(target&&typeof target.closest==='function'&&target.closest('.keyword-badge,.pi-keywords'))return;
     const current=row.querySelector('.character-cast');
     if(!current||current.disabled||typeof window.previewSkillCard!=='function')return;
     window.previewSkillCard(current.dataset.skillId||id);
    });
    row.addEventListener('pointerleave',event=>{
     if(event&&event.pointerType&&event.pointerType!=='mouse')return;
     if(event&&event.relatedTarget&&row.contains(event.relatedTarget))return;
     const current=row.querySelector('.character-cast');
     if(current&&typeof window.endSkillCardPreview==='function')window.endSkillCardPreview(current.dataset.skillId||id);
    });
   }
   // The existing skill header is the action surface. Moving it into the
   // same real button keeps the title, type and cost readable while leaving
   // the description and keyword badges outside the release target.
   const header=row.querySelector('.pi-skill-header');
   const skillMeta=row.querySelector('.pi-skill-meta');
   if(header&&header.parentElement!==button)button.append(header);
   if(skillMeta&&skillMeta.parentElement!==button)button.append(skillMeta);
   const description=row.querySelector('.pi-skill-desc');
   if(button.parentElement!==row)row.append(button);
   const targetControls=row.querySelector('#targetSelectionControls');
   const controlsBetween=!!(targetControls&&targetControls.parentElement===row&&button.nextElementSibling===targetControls&&targetControls.nextElementSibling===description);
   if(description&&button.nextElementSibling!==description&&!controlsBetween)row.insertBefore(button,description);
    bindSkillCardActivation(row);
   button.dataset.skillId=id;
   const hoverPreview=!!(isTargeting&&typeof pendingSkill!=='undefined'&&pendingSkill&&pendingSkill.previewOnly===true&&pendingSkill.previewOrigin==='hover'&&String(pendingSkill.skillId||'')===String(id));
   const cancelMode=isTargeting&&cancelAllowed&&!hoverPreview;
   const cancelStateLabel=isTargeting&&!hoverPreview?(targetSubmissionPending?'等待确认…':!cancelAllowed?'当前选择不可取消':''):'';
   if(isTargeting&&!hoverPreview)button.dataset.targetMode=cancelMode?'cancel':'cancel-disabled';else delete button.dataset.targetMode;
   button.classList.toggle('is-cancel-mode',cancelMode);button.classList.toggle('is-cancel-disabled',isTargeting&&!cancelMode&&!hoverPreview);
   setCancelMeta(skillMeta,cancelMode,cancelStateLabel);
   button.classList.toggle('tutorial-skill-hint',document.body.dataset.tutorialSkill===id);
   if(document.body.dataset.tutorialSkill===id&&!button.dataset.tutorialRevealed){
    button.dataset.tutorialRevealed='true';
    requestAnimationFrame(()=>{if(button.isConnected&&document.body.dataset.tutorialSkill===id)button.scrollIntoView({block:'nearest',inline:'nearest'});});
   }
   const skillName=definition.name||id;
   button.setAttribute('aria-label',cancelMode?'取消：'+skillName:hoverPreview?'预演：'+skillName:'释放：'+skillName);
   button.title=cancelMode?'再次点击取消':hoverPreview?'当前为预演；点击或拖动释放':targetSubmissionPending&&isTargeting?'等待权威确认':isTargeting&&!cancelAllowed?'当前规则选择不可取消':targetBusy?'请先完成当前操作':available.unavailableReason||'释放 '+skillName;
   button.disabled=cancelMode?false:hoverPreview?false:isTargeting||targetBusy||!available.available;row.classList.toggle('cast-unavailable',!available.available&&!cancelMode&&!hoverPreview);
   let reason=row.querySelector('.character-cast-reason');if(!reason){reason=document.createElement('div');reason.className='character-cast-reason';row.append(reason);}
   reason.textContent=cancelMode?'':available.unavailableReason||'';
  });
  modal.classList.toggle('is-selecting-target',!!((pendingSkill&&!pendingSkill.previewOnly)||pendingCardAction||targetSubmissionPending));
 }
 window.refreshTargetSkillButtonState=function(){
  if(currentPieceInfoSource!=='board'||!currentPieceInfoId)return;
  const piece=G&&G.pieces&&G.pieces.find(p=>p.instanceId===currentPieceInfoId);
  if(piece)refreshActions(piece);
 };
 function refreshPortrait(piece){
  const source=PIECES_BY_ID[piece.templateId];
  portrait.hidden=true;portrait.removeAttribute('src');portrait.alt='';
  if(source&&source.image){portrait.src='images/'+source.image;portrait.alt=(piece.name||source.name||'角色')+'头像';portrait.hidden=false;}
  portrait.onerror=()=>{portrait.hidden=true;};
 }
 function prepareDeployment(piece){
  modal.classList.remove('character-dock');modal.setAttribute('aria-modal','true');document.body.classList.remove('character-dock-open');
  reopen.hidden=true;setKeyword(false);refreshPortrait(piece);
 }
 function preserveTargetControlsBeforeRender(){
  const controls=document.getElementById('targetSelectionControls');
  if(!controls||!controls.parentElement||controls.parentElement===document.body)return;
  // nativeRender replaces #pieceInfoContent.innerHTML. Move the shared
  // controls out first so the current target session keeps its DOM node and
  // renderTargetOverlay can mount it into the refreshed skill row afterward.
  document.body.appendChild(controls);
 }
 function enhance(piece){
  modal.setAttribute('aria-modal','false');modal.classList.add('character-dock');document.body.classList.add('character-dock-open');reopen.hidden=true;
  refreshPortrait(piece);
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
  if(currentPieceInfoSource==='deployment'){prepareDeployment(piece);return nativeRender(piece,preserveKeyword);}
  const scroll=modal.querySelector('.pi-sheet').scrollTop;
  preserveTargetControlsBeforeRender();
  nativeRender(piece,true);enhance(piece);modal.querySelector('.pi-sheet').scrollTop=scroll;
  if((pendingSkill||pendingCardAction||targetSubmissionPending)&&typeof renderTargetOverlay==='function')renderTargetOverlay();
 };
 window.renderDeploymentPieceInfoError=function(piece){prepareDeployment(piece);return nativeDeploymentError(piece);};
 window.showPieceInfo=function(id,preserveKeyword){
  const changed=currentPieceInfoId!==id;dismissed=null;if(changed||!preserveKeyword){keywordOpen=false;keywordName='';lastSignature='';}
  nativeShow(id,true);if(changed)modal.querySelector('.pi-sheet').scrollTop=0;
 };
 window.closePieceInfo=function(){
  if(currentPieceInfoSource==='board'&&(pendingSkill||pendingCardAction||targetSubmissionPending)){
   setStatusMsg('请先完成或取消当前目标选择');
   return false;
  }
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
  // Local selection/cancellation changes button state, not the character
  // sheet's content. Replacing a hovered row would immediately re-arm the
  // cancelled skill through pointerenter on its replacement.
  const signature=JSON.stringify([id,pieceDispHp(piece),pieceDispStats(piece),pieceDispTags(piece),pieceInfoDisplaySkills(piece),G.turn,G.players.map(p=>[p.playerId,p.actionPoints,p.chargePoints])]);
  if(!force&&signature===lastSignature){refreshActions(piece);return;}
  busy=true;try{lastSignature=signature;currentPieceInfoId=id;currentPieceInfoSource='board';window.renderPieceInfoRecord(piece,true);}finally{busy=false;}
  // A skill can enter targeting from the compact board menu before the
  // reading sheet existed. Re-run the shared renderer after opening it so
  // the existing target footer moves into this sheet in the same turn.
  if(pendingSkill||pendingCardAction||targetSubmissionPending){
   if(typeof renderTargetOverlay==='function')renderTargetOverlay();
  }
 }
 window.renderPieceContextMenu=function(piece){const r=nativeContext(piece);syncSelected(false);return r;};
 // Status/resources/turn updates call the native render; this also keeps an open enemy sheet read-only.
 const nativeRenderPage=window.render;window.render=function(){const r=nativeRenderPage.apply(this,arguments);syncSelected(false);return r;};
 const nativeStatus=window.setStatusMsg;window.setStatusMsg=function(message){return nativeStatus.apply(this,[typeof message==='string'?message.replace('已选中棋子。点击菜单 i 或右键查看详细信息','已选中棋子，在左侧查看技能和状态'):message,...Array.prototype.slice.call(arguments,1)]);};
 // Non-modal sheet must not trap Tab. Escape gives target selection precedence over closing the sheet.
 document.removeEventListener('keydown',handlePieceInfoModalKeydown);
 document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||event.defaultPrevented||currentPieceInfoSource==='deployment')return;
  if(!(pendingSkill||pendingCardAction||targetSubmissionPending))return;
  event.preventDefault();dispatchBattleIntent({type:'cancel-target'});
 },true);
 document.addEventListener('keydown',event=>{
  if(currentPieceInfoSource==='deployment'){handlePieceInfoModalKeydown(event);return;}
  if(event.key==='Escape'&&!event.defaultPrevented&&(pendingSkill||pendingCardAction||targetSubmissionPending)){
   event.preventDefault();dispatchBattleIntent({type:'cancel-target'});return;
  }
  if(event.key!=='Escape'||event.defaultPrevented||pendingSkill||pendingCardAction||targetSubmissionPending)return;
  if(keywordOpen){event.preventDefault();setKeyword(false);}else if(document.body.classList.contains('character-dock-open')){event.preventDefault();window.closePieceInfo({restoreFocus:false});}
 });
 setKeyword(false);
})();
