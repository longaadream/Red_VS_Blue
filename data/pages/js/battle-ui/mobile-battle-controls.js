/* Mobile presentation only. Commands and availability remain in battle.html. */
(function () {
  'use strict';
  const media = matchMedia('(orientation: landscape) and (max-height: 600px)');
  const hand = document.getElementById('handCards');
  const menu = document.getElementById('pieceContextMenu');
  const toggle = document.createElement('button');
  toggle.id = 'mobileHandToggle'; toggle.type = 'button';
  toggle.setAttribute('aria-controls', 'handCards');
  document.body.append(toggle);
  const skills = document.createElement('button');
  skills.id = 'mobileSkillsToggle'; skills.type = 'button'; skills.textContent = '技能';
  skills.setAttribute('aria-controls', 'pieceContextMenu');
  document.body.append(skills);
  const dock = document.createElement('button');
  dock.id = 'mobileDockToggle'; dock.type = 'button';
  dock.setAttribute('aria-controls', 'handCards pieceContextMenu');
  document.body.append(dock);
  const play = document.createElement('button');
  play.id = 'mobileCardPlay'; play.type = 'button'; play.textContent = '使用卡牌';
  document.querySelector('#cardDetailModal .cd-layout').append(play);
  let handOpen = false, lastSelected = null, preview = null, lastForced = false, lastTargeting = false, lastMoving = false;
  let dockCollapsed = false;
  const nativeCardClick = window.onCardClick;
  const nativeShowCard = window.showCardDetail, nativeCloseCard = window.closeCardDetail;
  const forcedHand = () => !!G && isPendingHandSelection(G.pendingOptionSelection);
  function targeting() {
    return !!(pendingSkill || pendingCardAction || targetSubmissionPending || pendingActionFeedback ||
      pendingTargetSelectionForMe() || (pendingOptionSelectionForMe() && !forcedHand()));
  }
  function sync() {
    const mobile = media.matches;
    if (selectedPieceId !== lastSelected) { handOpen = false; dockCollapsed = false; lastSelected = selectedPieceId; }
    if (targeting()) handOpen = false;
    const forced = forcedHand(), collapsed = mobile && dockCollapsed && !forced;
    const expanded = mobile && (forced || (handOpen && !collapsed));
    const target = targeting();
    const enteredSelection = (target && !lastTargeting) || (forced && !lastForced);
    if (mobile && (enteredSelection || (pendingMove && !lastMoving) || expanded)) setTileStatusExpanded(false);
    lastMoving = !!pendingMove;
    lastTargeting = target; lastForced = forced;
    if (mobile && preview && enteredSelection) {
      // Clear first: native close/render hooks may synchronously re-enter sync.
      preview = null; nativeCloseCard();
    }
    document.body.classList.toggle('mobile-hand-expanded', expanded);
    document.body.classList.toggle('mobile-hand-required', mobile && forced);
    document.body.classList.toggle('mobile-dock-collapsed', collapsed);
    menu.inert = collapsed;
    dock.hidden = !mobile;
    dock.disabled = forced;
    dock.textContent = collapsed ? '手牌 / 技能' : '收起';
    dock.setAttribute('aria-label', collapsed ? '展开手牌和技能区' : '收起手牌和技能区');
    dock.setAttribute('aria-expanded', String(mobile && !collapsed));
    hand.inert = mobile && !expanded;
    toggle.hidden = !mobile || collapsed;
    toggle.disabled = forced;
    toggle.textContent = (expanded ? '收起手牌' : '手牌') + ' ' + hand.querySelectorAll('.card-item').length;
    toggle.setAttribute('aria-expanded', String(expanded));
    skills.hidden = !mobile || collapsed || !selectedPieceId || targeting() || menu.classList.contains('is-open') || expanded;
    if (preview) {
      const player = G && G.players.find(p => String(p.playerId).toLowerCase() === myPlayerId);
      const inHand = player && player.hand.some(c => c.instanceId === preview.instanceId);
      play.hidden = !mobile || !inHand || forced;
      // The hand's native render already presents authoritative interaction state.
      const card = [...hand.querySelectorAll('.card-item')].find(el => el.dataset.instanceId === preview.instanceId);
      play.disabled = !card || card.getAttribute('aria-disabled') === 'true' || targeting();
    } else play.hidden = true;
  }
  toggle.addEventListener('click', () => { handOpen = !handOpen; window.closePieceInfo({restoreFocus:false}); sync(); });
  dock.addEventListener('click', () => {
    dockCollapsed = !dockCollapsed;
    if (dockCollapsed) { handOpen = false; window.closePieceInfo({restoreFocus:false}); window.closeCardDetail(); }
    else { dismissedPieceContextId = null; renderPieceContextMenu(G && G.pieces.find(p => p.instanceId === selectedPieceId)); }
    sync();
  });
  const nativeDismiss = window.dismissPieceContextMenu;
  window.dismissPieceContextMenu = function () {
    if (!media.matches) return nativeDismiss.apply(this, arguments);
    dockCollapsed = true; handOpen = false; sync();
  };
  skills.addEventListener('click', () => {
    dismissedPieceContextId = null;
    renderPieceContextMenu(G && G.pieces.find(p => p.instanceId === selectedPieceId));
    sync();
  });
  window.showCardDetail = function (instanceId, cardId) {
    if (media.matches) setTileStatusExpanded(false);
    preview = {instanceId, cardId};
    const result = nativeShowCard.apply(this, arguments); sync(); return result;
  };
  window.closeCardDetail = function () {
    preview = null; const result = nativeCloseCard.apply(this, arguments); sync(); return result;
  };
  window.onCardClick = function (instanceId, cardId) {
    if (!media.matches || forcedHand()) return nativeCardClick.apply(this, arguments);
    window.showCardDetail(instanceId, cardId);
  };
  play.addEventListener('click', () => {
    if (!preview || play.disabled) return;
    const card = preview;
    play.disabled = true; window.closeCardDetail(); handOpen = false;
    nativeCardClick(card.instanceId, card.cardId, true);
    sync();
  });
  const nativeShowPiece = window.showPieceInfo;
  window.showPieceInfo = function () {
    if (media.matches) setTileStatusExpanded(false);
    return nativeShowPiece.apply(this, arguments);
  };
  for (const name of ['renderHand', 'renderActionBar', 'renderPieceContextMenu', 'dismissPieceContextMenu', 'render']) {
    const native = window[name];
    window[name] = function () { const result = native.apply(this, arguments); sync(); return result; };
  }
  const changed = () => { handOpen = false; window.closePieceInfo({restoreFocus:false}); window.closeCardDetail(); sync(); };
  media.addEventListener('change', changed);
  window.addEventListener('pagehide', () => media.removeEventListener('change', changed), {once:true});
  sync();
})();
