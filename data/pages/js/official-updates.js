(function () {
  'use strict';
  const api = window.electronAPI;
  const android = !api?.getOfficialUpdateStatus && window.Capacitor?.isNativePlatform?.() === true;
  if (!api?.getOfficialUpdateStatus && !android) return;
  const host = document.querySelector('.header');
  if (!host) return;
  const style = document.createElement('style');
  style.textContent = `
    .official-update-actions { margin-left:auto; display:flex; align-items:center; gap:10px; }
    .official-update-entry { position:relative; display:grid; place-items:center; flex:0 0 36px; width:36px; height:36px; min-width:36px; min-height:36px; margin:0; padding:0; border:1px solid #877150; border-radius:10px; background:#c5b08b; color:#382c23; cursor:pointer; }
    .official-update-entry:hover { background:#dfcba7; }
    .official-update-entry svg { width:18px; height:18px; }
    .official-update-entry[data-notice=true]::after { content:''; position:absolute; top:3px; right:3px; width:6px; height:6px; border-radius:50%; background:#41775a; }
    .official-update-entry:focus-visible, .official-update-panel button:focus-visible { outline:2px solid #386d85; outline-offset:3px; }
    dialog.official-update-panel { position:fixed; inset:0; margin:auto; box-sizing:border-box; width:min(460px,calc(100vw - 32px)); max-width:calc(100vw - 32px); max-height:calc(100svh - 32px); overflow:auto; padding:22px; border:2px solid #766044; border-radius:14px; background:#efe0be; color:#382c23; box-shadow:0 18px 60px #0006; font:14px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .official-update-panel::backdrop { background:#17120e80; }
    .official-update-panel h2 { margin:0 0 4px; font-size:21px; color:inherit; }
    .official-update-panel h3 { margin:0 0 6px; font-size:14px; color:inherit; }
    .official-update-panel p { margin:0; overflow-wrap:anywhere; }
    .official-update-panel [data-current] { color:#70604b; font-size:12px; }
    .official-update-section { margin:16px 0; padding:12px 14px; border:1px solid #c6b492; border-radius:9px; background:#f8edda; }
    .official-update-section p { min-height:24px; }
    .official-update-panel label { display:flex; align-items:center; gap:8px; }
    .official-update-panel input { accent-color:#577059; }
    .official-update-panel select { min-height:36px; padding:6px; background:#f8edda; color:#382c23; border:1px solid #877150; border-radius:6px; font:inherit; }
    .official-update-panel select:focus-visible { outline:2px solid #386d85; outline-offset:3px; }
    .official-update-panel .official-update-note { margin-top:8px; font-size:12px; color:#70604b; }
    .official-update-panel [data-error] { color:#9b342d; margin-top:8px; }
    .official-update-footer { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; margin-top:18px; }
    .official-update-panel button { width:auto; min-height:36px; padding:6px 14px; border:1px solid #877150; border-radius:8px; background:#e0cfac; color:#382c23; font:inherit; cursor:pointer; }
    .official-update-panel button[data-check] { background:#4b6354; border-color:#4b6354; color:#fff7e7; }
    .official-update-panel button:hover { filter:brightness(1.07); }
    .official-update-panel button:disabled { opacity:.6; cursor:wait; }
    .official-update-panel button[hidden] { display:none; }
    @media(max-width:480px) { .official-update-actions { gap:6px; } dialog.official-update-panel { padding:18px; } }
  `;
  document.head.appendChild(style);
  const actions = document.createElement('div');
  actions.className = 'official-update-actions';
  const identity = host.querySelector('#userPill');
  if (identity) actions.appendChild(identity);
  host.appendChild(actions);
  const button = document.createElement('button');
  button.className = 'official-update-entry';
  button.type = 'button';
  button.title = '官方更新';
  button.setAttribute('aria-label', '官方更新');
  if (!android) button.setAttribute('aria-haspopup', 'dialog');
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/></svg>';
  actions.appendChild(button);
  if (android) {
    button.onclick = () => {
      sessionStorage.setItem('rvb_maintenance_section', 'updates');
      if (typeof window.loadPage === 'function') window.loadPage('android-maintenance.html');
      else window.location.href = 'android-maintenance.html';
    };
    return;
  }
  const panel = document.createElement('dialog');
  panel.className = 'official-update-panel';
  panel.setAttribute('aria-labelledby', 'official-update-title');
  panel.innerHTML = '<h2 id="official-update-title">官方更新</h2><p data-current></p><section class="official-update-section"><h3>资源包 · 测试频道</h3><p data-resource role="status"></p></section><section class="official-update-section"><h3>客户端 · 稳定频道</h3><p data-client role="status"></p></section><section class="official-update-section"><h3>本机游戏服务</h3><p data-local role="status">正在准备游戏…</p><button type="button" data-local-retry hidden>重新准备游戏</button></section><label><input type="checkbox" data-automatic> 后台自动检查并下载</label><p class="official-update-note">启动时检查更新，完成后进入游戏。客户端更新需重启安装。</p><p data-error role="alert"></p><div class="official-update-footer"><button type="button" data-recovery>资源管理</button><button type="button" data-check>立即检查</button><button type="button" data-install hidden>重启并安装</button><button type="button" data-close disabled>进入游戏</button></div>';
  document.body.appendChild(panel);
  const sourceLabel = document.createElement('label');
  sourceLabel.innerHTML = '下载源 <select data-source aria-label="更新下载源"><option value="github">GitHub 官方源</option><option value="cos">COS 香港源</option></select>';
  panel.insertBefore(sourceLabel, panel.querySelector('.official-update-section'));
  const sourceNote = document.createElement('p');
  sourceNote.className = 'official-update-note';
  sourceNote.textContent = '客户端和资源包共用所选源。更新中或客户端已下载时暂不能切换；下载失败可切换后重试。';
  sourceLabel.after(sourceNote);
  const find = selector => panel.querySelector(selector);
  let startupPending = true;
  let disposed = false;
  let localTimer;
  async function refreshLocal() {
    if (disposed || !api.getMode) return;
    try {
      const mode = await api.getMode();
      if (disposed) return;
      const busy = ['starting', 'recovering'].includes(mode.localAuthorityRecovery?.status);
      find('[data-local]').textContent = mode.ready ? '游戏已就绪' : busy ? '正在准备游戏…' : (mode.localAuthorityNotice || '游戏准备失败，请重试');
      find('[data-local-retry]').hidden = mode.ready || busy;
      render(await api.getOfficialUpdateStatus());
    } catch {
      if (!disposed) {
        find('[data-local]').textContent = '无法获取游戏状态，请重试';
        find('[data-local-retry]').hidden = false;
      }
    } finally {
      if (!disposed) localTimer = setTimeout(refreshLocal, 1500);
    }
  }
  function render(status) {
    startupPending = status.startupPending === true;
    if (startupPending && !panel.open) panel.showModal();
    if (disposed) return;
    find('[data-check]').textContent = status.resource.phase === 'error' || status.client.phase === 'error' ? '重试更新检查' : '检查更新';
    find('[data-close]').disabled = startupPending && !status.canEnter;
    find('[data-close]').textContent = startupPending
      ? status.canEnter && (status.resource.phase === 'error' || status.client.phase === 'error') ? '离线进入' : '进入游戏'
      : '关闭';
    find('[data-current]').textContent = '当前客户端 ' + status.clientVersion;
    find('[data-resource]').textContent = status.resource.message + (status.resource.version ? ' · ' + status.resource.version : '');
    find('[data-client]').textContent = status.client.message + (status.client.version ? ' · ' + status.client.version : '') + (status.client.percent !== undefined ? ' · ' + status.client.percent + '%' : '');
    find('[data-automatic]').checked = status.automatic;
    find('[data-source]').value = status.source || 'github';
    find('[data-source]').disabled = Boolean(status.sourceLocked);
    find('[data-install]').hidden = status.client.phase !== 'downloaded';
    const label = status.client.phase === 'downloaded' ? '更新已就绪' : status.resource.phase === 'applying' ? '正在更新资源…' : '官方更新';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.dataset.notice = String(status.client.phase === 'downloaded' || status.resource.phase === 'applying');
  }
  async function action(operation) {
    find('[data-error]').textContent = '';
    try { await operation(); render(await api.getOfficialUpdateStatus()); }
    catch (error) { find('[data-error]').textContent = error.message || '更新暂时不可用，请稍后重试'; }
  }
  button.onclick = () => { panel.showModal(); void action(() => Promise.resolve()); };
  panel.addEventListener('cancel', event => { if (startupPending) event.preventDefault(); });
  find('[data-close]').onclick = () => action(async () => {
    if (startupPending) render(await api.enterAfterUpdateCheck());
    panel.close();
  });
  find('[data-check]').onclick = () => action(async () => {
    find('[data-check]').disabled = true;
    try { await api.checkOfficialUpdates(); } finally { find('[data-check]').disabled = false; }
  });
  find('[data-local-retry]').onclick = () => action(async () => {
    const retry = find('[data-local-retry]');
    retry.disabled = true;
    find('[data-local]').textContent = '正在重新准备游戏…';
    try {
      const result = await api.ensureLocalAuthority();
      if (!result.ok) throw new Error(result.error || '游戏准备失败，请重试');
    } finally { retry.disabled = false; }
  });
  find('[data-recovery]').onclick = () => { window.location.href = 'pack.html'; };
  find('[data-install]').onclick = () => action(() => api.installClientUpdate());
  find('[data-automatic]').onchange = event => action(() => api.setAutomaticUpdates(event.target.checked));
  find('[data-source]').onchange = event => action(async () => {
    try { await api.setOfficialUpdateSource(event.target.value); }
    finally { render(await api.getOfficialUpdateStatus()); }
  });
  const unsubscribe = api.onOfficialUpdateStatus(render);
  window.addEventListener('pagehide', () => { disposed = true; clearTimeout(localTimer); unsubscribe(); }, { once: true });
  void refreshLocal();
  panel.showModal();
  void action(async () => {
    const status = await api.getOfficialUpdateStatus();
    render(status);
    if (status.startupPending) await api.checkOfficialUpdates();
    else panel.close();
  });
})();
