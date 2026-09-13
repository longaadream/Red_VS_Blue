// Shipped with the desktop shell so older installed resource profiles also show
// readiness while the local authority starts behind their main menu.
export const LOCAL_STARTUP_STATUS_SCRIPT = `(() => {
  if (document.getElementById('rvb-local-startup-status')) return;
  const box = document.createElement('div');
  box.id = 'rvb-local-startup-status';
  box.setAttribute('role', 'status');
  box.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:10000;max-width:90vw;padding:10px 16px;border-radius:8px;background:#29251f;color:#f3e6cf;font:14px/1.5 sans-serif;text-align:center;box-shadow:0 2px 12px #0005';
  document.body.appendChild(box);
  async function refresh() {
    try {
      const mode = await window.electronAPI.getMode();
      if (mode.ready) {
        localStorage.setItem('rvb_local_server_url', mode.localUrl);
        const selectedMode = localStorage.getItem('rvb_lobby_server_mode');
        if ((!selectedMode || selectedMode === 'local') && window.RvBUtils && RvBUtils.saveServerConfig) {
          RvBUtils.saveServerConfig({ mode: 'local', url: mode.localUrl });
        }
        if (typeof updateFloatBar === 'function') updateFloatBar();
        if (typeof refreshUserUI === 'function') refreshUserUI();
        box.remove();
        return;
      }
      if (mode.localAuthorityRecovery.status === 'starting' || mode.localAuthorityRecovery.status === 'recovering') {
        box.textContent = '正在准备游戏，可以先浏览菜单…';
        setTimeout(refresh, 300);
        return;
      }
      box.textContent = '游戏准备失败，';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重试';
      retry.onclick = async () => {
        retry.disabled = true;
        box.textContent = '正在重新准备游戏…';
        try { await window.electronAPI.ensureLocalAuthority(); }
        finally { void refresh(); }
      };
      box.appendChild(retry);
    } catch {
      box.textContent = '暂时无法获取游戏准备状态，正在重试…';
      setTimeout(refresh, 1000);
    }
  }
  void refresh();
})()`
