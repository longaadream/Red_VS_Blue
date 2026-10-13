/* Workbench integration only. The native training view executes the same
 * battle page and authoritative engine as the game, never a renderer mock. */
(() => {
  'use strict'
  const api = window.editorAPI
  const host = document.getElementById('developer-training-host')
  if (!host || !window.TrainingPanel) return
  let targetSkillId = null
  let accepted = null
  const activePanel = () => document.getElementById('tab-training')?.classList.contains('active')
  const enter = () => document.querySelector('[data-tab="training"]')?.click()

  function currentDraftRequest() {
    window.__editorPersistActiveSession?.()
    if (!targetSkillId) {
      const selected = window.__editorGetActiveTrial?.()
      if (selected && !selected.ok) throw new Error(selected.error || '当前技能尚不能试用。')
      targetSkillId = selected?.request?.skillId || null
    }
    if (!targetSkillId) throw new Error('请先打开一个主动技能，再点击“试用技能”。被动规则可通过所属棋子一起验证。')
    const catalog = window.__editorGetContentCatalog?.() || {}
    const root = catalog.skills?.[targetSkillId]
    if (!root) throw new Error('找不到当前试用技能，请重新选择。')
    const cluster = window.ContentGraphCore.buildSkillCluster(catalog, { collection:'skills', id:targetSkillId })
    const documents = new Map([['skills:' + targetSkillId, { collection:'skills', document:root }]])
    for (const member of cluster.members?.all || []) {
      const { collection, id } = member.source || {}
      if (['skills','rules','pieces','cards'].includes(collection) && catalog[collection]?.[id]) documents.set(`${collection}:${id}`, { collection, document:catalog[collection][id] })
    }
    for (const session of window.__editorDraftSessions?.values() || []) {
      const relevant = documents.has(session.key)
      if (relevant && session.jsonError) throw new Error(`${session.draft?.name || '关联内容'}尚有格式错误，请修正后再试用。`)
      for (const [key, state] of Object.entries(session.editorState || {})) {
        if (state?.expressions?.length && (relevant || [...documents.keys()].some(documentKey => key.startsWith(documentKey + ':')))) throw new Error('还有未应用的参数输入，请先完成并应用；未完成的输入可以单独保存草稿。')
      }
    }
    return { skillId:targetSkillId, drafts:[...documents.values()] }
  }

  const panel = window.TrainingPanel.mount(host, {
    api,
    getDraftRequest: currentDraftRequest,
    getLaunchOptions: () => accepted || {},
    openAccepted: options => {
      if (!accepted?.taskId || !accepted?.acceptedHash) throw new Error('请从创作工作台选择一项任务，并打开它的已接受版本。')
      return api.workbenchTrainingEmbedded(accepted.taskId, accepted.acceptedHash, options)
    },
  })
  window.openDeveloperTraining = async request => {
    targetSkillId = request.skillId
    enter()
    return panel.open('draft')
  }
  window.openAcceptedDeveloperTraining = async options => {
    accepted = options
    enter()
    return panel.open('accepted')
  }
  window.__developerTrainingPanel = panel
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
    if (typeof panel.setVisible === 'function') void panel.setVisible(activePanel())
    else if (panel.getPreviewId()) void api.trainingPreviewSetVisible(panel.getPreviewId(), activePanel())
  }))
  window.addEventListener('beforeunload', () => panel.dispose())
})()
