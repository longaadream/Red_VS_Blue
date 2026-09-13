/* Read-only local splash: no IPC, network, filesystem or game APIs. */
(() => {
  const started = performance.now()
  setInterval(() => {
    document.getElementById('elapsed').textContent = `已用时 ${Math.floor((performance.now() - started) / 1000)} 秒`
  }, 1000)
  window.renderStartupProgress = (completed, message, failed) => {
    document.getElementById('stage').textContent = message
    document.getElementById('progress').value = completed
    document.getElementById('count').textContent = `${completed} / 6 个阶段已完成`
    document.body.dataset.failed = String(failed === true)
    if (failed) document.getElementById('hint').textContent = '启动未能完成。请关闭窗口后重试；如果仍失败，请提供启动日志。'
  }
})()
