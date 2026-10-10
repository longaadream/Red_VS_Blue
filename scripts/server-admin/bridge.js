(() => {
  const opsLink = document.getElementById('ops-link')
  const token = location.hash.slice(1) || sessionStorage.getItem('rvb-admin-session') || ''
  if (token) sessionStorage.setItem('rvb-admin-session', token)
  if (!opsLink) return
  opsLink.hidden = false
  opsLink.textContent = '服务器运维与连接'
  // In the unified panel this is a normal view button. Keep an href fallback
  // for older panel assets that still render an anchor.
  if (opsLink.tagName === 'A') opsLink.href = '/ops' + (token ? '#' + token : '')
  else opsLink.dataset.view = 'remote-ops'
  const asideLabel = document.querySelector('aside small')
  if (asideLabel) asideLabel.textContent = '本机运营 · 已统一'
  const footerLabel = document.querySelector('footer span')
  if (footerLabel) footerLabel.textContent = '本机指挥台 · 运维入口共享当前会话'
})()
