const token = location.hash.slice(1) || sessionStorage.getItem('rvb-admin-session') || ''
if (token) sessionStorage.setItem('rvb-admin-session', token)
history.replaceState(null, '', location.pathname)
const fields = ['host', 'port', 'user', 'key', 'service', 'database', 'directory', 'release', 'panelPort', 'panelToken']
document.getElementById('panel-link').href = '/#' + token
const output = document.getElementById('output')
document.querySelectorAll('[data-action]').forEach(button => {
  button.onclick = async () => {
    const input = Object.fromEntries(fields.map(name => [name, document.getElementById(name).value.trim()]))
    input.action = button.dataset.action
    input.maintenance = document.getElementById('maintenance').checked
    if (input.action === 'activate' && !confirm(`将停止 ${input.service} 并切换到 ${input.release}。确认执行？`)) return
    document.querySelectorAll('button').forEach(el => { el.disabled = true })
    document.getElementById('state').textContent = '正在执行…'
    output.textContent = `${new Date().toLocaleTimeString()} · ${button.textContent}\n正在连接服务器…`
    try {
      const response = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(input) })
      const text = await response.text()
      let result
      try { result = JSON.parse(text) } catch { throw Error(text || '请求被拒绝，请从启动命令输出的完整链接重新打开') }
      if (!response.ok) throw Error(result.error)
      output.textContent = result.output
      if (input.action === 'connect-panel') document.getElementById('panelToken').value = ''
      document.getElementById('state').textContent = '操作完成'
    } catch (error) {
      output.textContent = error.message
      document.getElementById('state').textContent = '未完成'
    } finally { document.querySelectorAll('button').forEach(el => { el.disabled = false }) }
  }
})
