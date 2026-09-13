/* Publishing UI uses the narrow preload API; no tokens enter content projects. */
window.openPublicationSettings = async function (api) {
  const settings = await api.publicationSettings()
  const dialog = document.createElement('dialog')
  dialog.className = 'wb-modal'
  dialog.innerHTML = `<h2>首次发布设置</h2><p class="wb-copy">设置保存在编辑器本机。上传凭据由系统加密，不写进给 AI 的内容目录。</p><form class="wb-form"><label>GitHub 仓库<input name="repository" required placeholder="所有者/仓库名"/></label><label>上传凭据<input name="token" type="password" autocomplete="off" maxlength="4096"/></label><p class="wb-copy" data-token-note></p><p class="wb-copy">凭据需要目标仓库的 Contents 写权限。不要粘贴到 AI 对话中。</p><div><button class="btn btn-ghost" type="button" data-key>选择已有官方签名密钥</button><p class="wb-path" data-key-path></p></div><div class="wb-status" role="alert"></div><div class="wb-actions"><button class="btn btn-primary">保存设置</button><button class="btn btn-ghost" type="button" data-close>取消</button></div></form>`
  dialog.querySelector('[name="repository"]').value = settings.repository
  dialog.querySelector('[name="token"]').required = !settings.hasToken
  dialog.querySelector('[data-token-note]').textContent = settings.hasToken ? '凭据已保存；留空继续使用原凭据。' : '尚未配置上传凭据。'
  dialog.querySelector('[data-key-path]').textContent = settings.keyFile || '尚未选择'
  const createKey = document.createElement('button')
  createKey.type = 'button'; createKey.className = 'btn btn-ghost'; createKey.textContent = '生成本机签名身份'
  dialog.querySelector('[data-key]').after(createKey)
  document.body.append(dialog)
  let useSelectedKey = false
  createKey.onclick = async () => {
    try {
      const identity = await api.publicationCreateKey()
      useSelectedKey = true
      dialog.querySelector('[data-key-path]').textContent = identity.filename
      dialog.querySelector('[role="alert"]').textContent = `签名身份已准备。首次使用须将公钥 ID 配入客户端并升级一次：${identity.keyId}。以后沿用同一身份发布。`
    } catch (error) { dialog.querySelector('[role="alert"]').textContent = error.message }
  }
  dialog.querySelector('[data-key]').onclick = async () => {
    try { const filename = await api.publicationChooseKey(); if (filename) { useSelectedKey = true; dialog.querySelector('[data-key-path]').textContent = filename } }
    catch (error) { dialog.querySelector('[role="alert"]').textContent = error.message }
  }
  dialog.querySelector('[data-close]').onclick = () => dialog.close()
  dialog.onclose = () => { dialog.querySelector('[name="token"]').value = ''; dialog.remove() }
  dialog.querySelector('form').onsubmit = async event => {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(event.currentTarget))
    dialog.querySelectorAll('button').forEach(button => { button.disabled = true })
    try { await api.publicationSaveSettings({ ...data, useSelectedKey }); dialog.close() }
    catch (error) { dialog.querySelector('[role="alert"]').textContent = error.message; dialog.querySelectorAll('button').forEach(button => { button.disabled = false }) }
  }
  dialog.showModal()
}

window.openContentPublication = async function (api, input) {
  const settings = await api.publicationSettings()
  if (!settings.repository || !settings.hasToken || !settings.keyFile) { await window.openPublicationSettings(api); return }
  const dialog = document.createElement('dialog')
  dialog.className = 'wb-modal'
  dialog.innerHTML = `<h2>发布测试更新</h2><p class="wb-copy" data-target></p><div class="wb-note">自动生成完整资源包；本机保有上一发布记录时，一并生成适用补丁。已安装新版客户端的玩家会自动检查官方仓库，在主菜单应用资源更新；旧客户端需先升级一次。补丁基准不匹配时下载完整资源包。</div><p class="wb-copy" data-notes></p><div class="wb-release-result" role="status"></div><div class="wb-actions"><button class="btn btn-primary" data-confirm>发布测试更新</button><button class="btn btn-ghost" data-close>取消</button></div>`
  dialog.querySelector('[data-target]').textContent = `目标：${settings.repository} · 测试渠道。${input.pendingCount} 个未接受的文件不会被打包。`
  dialog.querySelector('[data-notes]').textContent = input.notes
  document.body.append(dialog)
  dialog.querySelector('[data-close]').onclick = () => dialog.close()
  const unsubscribe = api.onPublicationProgress(value => { if (value.taskId === input.id && dialog.open) dialog.querySelector('[role="status"]').textContent = value.stage })
  dialog.onclose = () => { unsubscribe(); dialog.remove() }
  dialog.querySelector('[data-confirm]').onclick = async () => {
    dialog.querySelectorAll('button').forEach(button => { button.disabled = true })
    dialog.oncancel = event => event.preventDefault()
    const resultElement = dialog.querySelector('[role="status"]')
    try {
      resultElement.textContent = '检查内容…'
      const result = await api.workbenchPublish(input.id, input.acceptedHash, input.notes)
      resultElement.textContent = `发布成功\n版本：${result.version}\n${result.url}\n新版客户端会检查官方仓库的资源更新；也可分享链接供手动下载。`
      const copy = document.createElement('button')
      copy.className = 'btn btn-primary'; copy.textContent = '复制下载链接'
      copy.onclick = async () => { try { await api.copyText(result.url) } catch (error) { resultElement.textContent = error.message } }
      dialog.querySelector('.wb-actions').prepend(copy)
    } catch (error) {
      resultElement.textContent = error.message
      dialog.querySelector('[data-confirm]').disabled = false
      dialog.querySelector('[data-confirm]').textContent = '核对并重试'
    } finally {
      dialog.oncancel = null
      dialog.querySelector('[data-close]').disabled = false
      dialog.querySelector('[data-close]').textContent = '关闭'
    }
  }
  dialog.showModal()
}
