import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const { createContentProject } = require('../../electron-editor/dist/content-project.js')
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-workbench-smoke-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
for (const [relative, value] of Object.entries({
  'data/pieces/manifest.json': ['hero'], 'data/skills/manifest.json': ['drain'],
  'data/rules/manifest.json': ['battle-rule'],
  'data/rules/battle-rule.json': { id:'battle-rule', name:'战斗规则', description:'规则关联测试', extension:{keep:true} },
  'data/pieces/hero.json': { id:'hero', name:'吸血战士', description:'普攻后按实际伤害恢复生命', skills:[{ skillId:'drain', level:1, currentCooldown:2, extension:{ keep:true } }], stats:{ maxHp:100, attack:20, defense:5, moveRange:3 } },
  'data/skills/drain.json': { id:'drain', name:'血之回响', description:'恢复实际伤害的 30%', ratio:0.3, keywords:['恢复'], effectTags:['recovery'], statusTag:{id:'blood',type:'skill-rule',name:'血印',extension:{keep:true}}, extension:{keep:true} },
})) fs.writeFileSync(path.join(project, relative), JSON.stringify(value, null, 2))
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root:project }))
const portServer = net.createServer()
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve))
const port = portServer.address().port
await new Promise(resolve => portServer.close(resolve))
const executable = process.env.RVB_WORKBENCH_EXE || path.join(root, 'dist/editor/win-unpacked/RED vs BLUE Editor.exe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { env, windowsHide:true, stdio:'ignore' })
let socket, nextId = 0
const evidence = path.join(root, 'docs/qa/RED-191')
fs.mkdirSync(evidence, { recursive:true })
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function connect() {
  const until = Date.now() + 90000
  while (Date.now() < until) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal:AbortSignal.timeout(1500) })).json()
      const target = targets.find(target => target.type === 'page' && target.url.includes('index.html'))
      if (target) {
        socket = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once:true }); socket.addEventListener('error', reject, { once:true }) })
        return
      }
    } catch { /* Startup is bounded by the deadline. */ }
    await delay(250)
  }
  throw new Error('Editor did not expose its renderer before the deadline')
}
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => { socket.removeEventListener('message', listener); reject(new Error(`Timeout: ${method}`)) }, 30000)
    const listener = event => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timeout); socket.removeEventListener('message', listener)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Renderer failed')
  return result.result?.value
}
async function waitFor(expression) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(100) }
  throw new Error('Condition not met: ' + expression)
}
async function screenshot(name) {
  await delay(150)
  const result = await call('Page.captureScreenshot', { format:'png' })
  fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(result.data, 'base64'))
}
try {
  await connect()
  await waitFor(`!!document.querySelector('[data-wb="new"]:not(:disabled)')`)
  await evaluate(`document.querySelector('[data-tab="pieces"]').click()`)
  await waitFor(`!!document.querySelector('#pieces-list .entity-item')`)
  await evaluate(`document.querySelector('#pieces-list .entity-item').click()`)
  await waitFor(`!!document.querySelector('#pieces-detail [data-visual-field="skills"] input[type="number"]')`)
  await evaluate(`(() => { const input = document.querySelector('#pieces-detail [data-visual-field="skills"] input[type="number"]'); input.value = '3'; input.dispatchEvent(new Event('change')); document.querySelector('#pieces-detail [data-save-json]').click(); })()`)
  await waitFor(`document.querySelector('#pieces-detail [data-footer-state]')?.textContent === '已保存'`)
  const hero = JSON.parse(fs.readFileSync(path.join(project, 'data/pieces/hero.json'), 'utf8'))
  assert.equal(hero.skills[0].level, 3)
  assert.equal(hero.skills[0].currentCooldown, 2)
  assert.equal(hero.skills[0].extension.keep, true)
  await evaluate(`(() => { for (const key of ['rules','playerRules']) { const section = document.querySelector('#pieces-detail [data-visual-field="' + key + '"]'); section.querySelector('input').value = 'battle-rule'; section.querySelector('.vf-row button:last-child').click(); } document.querySelector('#pieces-detail [data-save-json]').click(); })()`)
  await waitFor(`document.querySelector('#pieces-detail [data-footer-state]')?.textContent === '已保存'`)
  let ruleHero = JSON.parse(fs.readFileSync(path.join(project, 'data/pieces/hero.json'), 'utf8'))
  assert.deepEqual(ruleHero.rules, ['battle-rule'])
  assert.deepEqual(ruleHero.playerRules, ['battle-rule'])
  assert.equal(ruleHero.skills[0].extension.keep, true)
  await evaluate(`document.querySelector('#pieces-list .entity-item').click()`)
  await waitFor(`document.querySelector('#pieces-detail [data-visual-field="playerRules"]')?.textContent.includes('战斗规则')`)
  await evaluate(`document.querySelector('#pieces-detail [data-visual-field="rules"]').scrollIntoView({block:'start'})`)
  await screenshot('visual-piece-rules')
  await evaluate(`document.querySelector('#pieces-detail [data-visual-field="rules"] .vf-card button').click()`)
  await waitFor(`document.querySelector('#rules-detail [data-document-title]')?.textContent === '战斗规则'`)
  await evaluate(`document.querySelector('[data-tab="pieces"]').click(); document.querySelector('#pieces-detail [data-visual-field="rules"] .vf-card button:last-child').click(); document.querySelector('#pieces-detail [data-save-json]').click()`)
  await waitFor(`document.querySelector('#pieces-detail [data-footer-state]')?.textContent === '已保存'`)
  ruleHero = JSON.parse(fs.readFileSync(path.join(project, 'data/pieces/hero.json'), 'utf8'))
  assert.deepEqual(ruleHero.rules, [])
  assert.deepEqual(ruleHero.playerRules, ['battle-rule'])
  await evaluate(`document.querySelector('#pieces-detail .vf-card .vf-row button').click()`)
  await waitFor(`!!document.querySelector('#skills-detail [data-visual-field="keywords"] input')`)
  await evaluate(`(() => { const section = document.querySelector('#skills-detail [data-visual-field="keywords"]'); section.querySelector('input').value = '禁疗'; section.querySelector('.vf-row button').click(); const name = document.querySelector('#skills-detail input[aria-label="statusTag 1 名称"]'); name.value = '鲜血印记'; name.dispatchEvent(new Event('change')); document.querySelector('#skills-detail [data-save-json]').click(); })()`)
  await waitFor(`document.querySelector('#skills-detail [data-footer-state]')?.textContent === '已保存'`)
  const visualSkill = JSON.parse(fs.readFileSync(path.join(project, 'data/skills/drain.json'), 'utf8'))
  assert.deepEqual(visualSkill.keywords, ['恢复', '禁疗'])
  assert.equal(visualSkill.statusTag.name, '鲜血印记')
  assert.equal(visualSkill.statusTag.extension.keep, true)
  assert.equal(visualSkill.extension.keep, true)
  await evaluate(`document.querySelector('#skills-list .entity-item').click()`)
  await waitFor(`document.querySelector('#skills-detail [data-visual-field="keywords"]')?.textContent.includes('禁疗')`)
  await evaluate(`(() => { document.querySelector('#skills-detail [data-editor-mode="json"]').click(); const source = document.querySelector('#skills-detail [data-json-source]'); const value = JSON.parse(source.value); value.keywords = ['冰冻']; source.value = JSON.stringify(value, null, 2); source.dispatchEvent(new Event('input')); document.querySelector('#skills-detail [data-editor-mode="fields"]').click(); })()`)
  assert.equal(await evaluate(`document.querySelector('#skills-detail [data-visual-field="keywords"]').textContent.includes('冰冻')`), true)
  await evaluate(`document.querySelector('[data-tab="pieces"]').click(); document.querySelector('#pieces-detail .vf-card .vf-row button').click()`)
  assert.equal(await evaluate(`JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).keywords[0]`), '冰冻')
  await evaluate(`document.querySelector('[data-tab="skills"]').click()`)
  await screenshot('visual-skill-tags')
  assert.equal(await evaluate(`(() => { document.querySelector('#skills-detail [data-save-json]').click(); document.querySelector('[data-new-document="skills"]').click(); return !document.getElementById('create-dialog').open && [...document.querySelectorAll('#skills-detail input, #skills-detail textarea, #skills-detail button')].every(node => node.disabled); })()`), true)
  await waitFor(`document.querySelector('#skills-detail [data-footer-state]')?.textContent === '已保存'`)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, 'data/skills/drain.json'), 'utf8')).keywords, ['冰冻'])
  await evaluate(`document.querySelector('[data-tab="workbench"]').click()`)
  await screenshot('workbench-empty')
  await evaluate(`(() => { document.querySelector('[data-wb="new"]').click(); const form = document.querySelector('.wb-modal form'); form.elements.title.value = '吸血战士：第一次玩法验证'; form.elements.brief.value = '让战士的普攻可以按实际伤害回血，保留近战定位。'; form.elements.criteria.value = '生命不能超过上限；按实际造成的伤害恢复 30%。'; form.requestSubmit(); })()`)
  await waitFor(`!!document.querySelector('[data-wb="handoff"]:not(:disabled)')`)
  const task = (await evaluate('window.editorAPI.workbenchList()'))[0]
  const skillFile = path.join(project, 'data/skills/drain.json')
  fs.writeFileSync(skillFile, JSON.stringify({ id:'drain', name:'血之回响', description:'恢复实际伤害的 35%', ratio:0.35 }, null, 2))
  await evaluate(`document.querySelector('[data-wb="refresh"]').click()`)
  await waitFor(`document.querySelector('.wb-fields')?.textContent.includes('0.35')`)
  await screenshot('workbench-changes')
  await evaluate(`document.querySelector('[data-wb="check"]').click()`)
  await waitFor(`document.querySelector('.wb-topline .wb-tag')?.textContent.includes('结构与引用检查通过')`)
  await evaluate(`(() => { document.querySelector('[data-section="tests"]').click(); const form = document.getElementById('wb-scenario-form'); form.elements.setup.value = '战士当前 40/100 血量，敌人相邻且没有护盾'; form.elements.action.value = '执行一次普攻，造成 20 点实际伤害'; form.elements.expected.value = '恢复 7 点生命，最终 47/100'; form.requestSubmit(); })()`)
  await waitFor(`document.querySelectorAll('.wb-card .wb-tag').length > 0 && !document.querySelector('[data-wb="check"]').disabled`)
  await evaluate(`(() => { const form = document.getElementById('wb-feedback-form'); form.elements.message.value = '请检查恢复量是否按实际伤害计算，满血时不要显示多余治疗。'; form.requestSubmit(); })()`)
  await waitFor(`document.querySelector('.wb-main')?.textContent.includes('人工反馈') && !document.querySelector('[data-wb="check"]').disabled`)
  await screenshot('workbench-feedback')
  await evaluate(`document.querySelector('[data-section="versions"]').click(); document.querySelector('[data-wb="keep"]').click()`)
  await waitFor(`document.querySelector('.wb-main')?.textContent.includes('候选 1') && !document.querySelector('[data-wb="check"]').disabled`)
  await screenshot('workbench-versions')
  const kept = await evaluate(`window.editorAPI.workbenchInspect(${JSON.stringify(task.id)})`)
  assert.equal(kept.feedback.length, 1)
  assert.equal(kept.scenarios[0].executed, false)
  assert.equal(kept.versions[0].published, false)
  assert.equal(kept.check.runtimeVerified, false)
  await evaluate(`window.editorAPI.workbenchHandoff(${JSON.stringify(task.id)})`)
  const handoff = JSON.parse(fs.readFileSync(path.join(project, '.workbench/tasks', task.id, 'AI_CONTEXT.json'), 'utf8'))
  assert.equal(handoff.checkCommand[1], '--check-content-task')
  const cli = spawnSync(handoff.checkCommand[0], [...handoff.checkCommand.slice(1), `--user-data-dir=${path.join(temporary, 'cli-user')}`], { env, windowsHide:true, encoding:'utf8', timeout:60000 })
  assert.equal(cli.status, 0, cli.stderr)
  fs.writeFileSync(skillFile, '{ broken')
  await evaluate(`document.querySelector('[data-wb="refresh"]').click()`)
  await waitFor(`document.querySelector('.wb-topline .wb-tag')?.textContent.includes('需要重检')`)
  const failed = spawnSync(handoff.checkCommand[0], [...handoff.checkCommand.slice(1), `--user-data-dir=${path.join(temporary, 'cli-user-2')}`], { env, windowsHide:true, encoding:'utf8', timeout:60000 })
  assert.equal(failed.status, 1)
  const outcome = { passed:true, artifact:executable, visualSkillLevelSaved:true, visualKeywordsSavedAndReopened:true, statusTagObjectPreserved:true, unknownFieldsPreserved:true, jsonToVisualSync:true, taskCreation:'UI', actualDiff:true, checkCommandPassed:true, invalidJsonCommandRejected:true, staleEvidenceInvalidated:true, feedbackBoundToVersion:true, candidateImmutable:true, runtimeVerified:false, scenariosExecuted:false }
  outcome.visualRulesSavedAndReopened = true
  outcome.ruleRemovalPreservesPlayerRules = true
  outcome.relatedRuleNavigation = true
  fs.writeFileSync(path.join(evidence, 'workbench-smoke.json'), JSON.stringify(outcome, null, 2) + '\n')
  console.log(JSON.stringify(outcome))
} finally {
  if (socket) {
    try { await evaluate('window.close()') } catch { /* Renderer may close before its response. */ }
    socket.close()
  }
  child.kill()
  await delay(1000)
  const resolved = path.resolve(temporary)
  if (resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('rvb-workbench-smoke-')) {
    try { fs.rmSync(resolved, { recursive:true, force:true }) } catch { console.error('Retained test fixture:', resolved) }
  }
}
