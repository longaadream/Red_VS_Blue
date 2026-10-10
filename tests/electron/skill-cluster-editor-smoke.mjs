import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/* Real Electron smoke for active/passive Skill Cluster authoring views. */
const require = createRequire(import.meta.url)
const root = process.cwd()
const evidence = process.env.RVB_SKILL_CLUSTER_EVIDENCE_DIR || path.join(root, 'docs/qa/RED-252-gameplay-module')
fs.mkdirSync(evidence, { recursive: true })
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-skill-cluster-smoke-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)

const rule = {
  id: 'cluster-demo-rule', name: 'Cluster 演示规则', description: '规则来源保持明确。', priority: 1,
  trigger: { type: 'gameStart' }, skillCode: 'return { success: true };', extension: { keep: 'rule' },
}
const skill = {
  id: 'cluster-demo-skill', name: 'Cluster 演示主动技能', description: '当前技能效果的精确说明。', kind: 'active', type: 'normal',
  code: 'function executeSkill(context){return {success:true};}', cooldownTurns: 1, actionPointCost: 1,
  relatedRules: [rule.id], statusTag: { id: 'cluster-demo-status', type: 'cluster-demo-status', duration: 2, amount: 3, extension: { keep: 'status' } },
  extension: { keep: 'skill' },
}
const siblingSkill = {
  id: 'cluster-demo-skill-b', name: 'Cluster 第二主动技能', description: '第二个能力拥有同名状态。', kind: 'active', type: 'normal',
  code: 'function executeSkill(context){return {success:true};}', cooldownTurns: 1, actionPointCost: 1,
  relatedRules: [rule.id], statusTag: { id: 'cluster-demo-status', type: 'cluster-demo-status', duration: 9, description: '来自第二技能', extension: { keep: 'sibling-status' } },
  extension: { keep: 'sibling-skill' },
}
const piece = {
  id: 'cluster-demo-piece', name: 'Cluster 演示被动棋子', description: '棋子常驻规则独立展示。', faction: 'neutral', rarity: 'common',
  stats: { maxHp: 10, attack: 1, defense: 1, moveRange: 1 }, skills: [skill.id, siblingSkill.id], rules: [rule.id], extension: { keep: 'piece' },
}
for (const [subdir, values] of Object.entries({ skills: [skill, siblingSkill], pieces: [piece], rules: [rule] })) {
  for (const value of values) fs.writeFileSync(path.join(project, 'data', subdir, `${value.id}.json`), JSON.stringify(value, null, 2) + '\n')
  fs.writeFileSync(path.join(project, 'data', subdir, 'manifest.json'), JSON.stringify(values.map(value => value.id)) + '\n')
}
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')

const listener = net.createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const executable = process.env.RVB_GRAPH_EDITOR_EXE || process.env.RVB_GRAPH_ELECTRON_BINARY || path.join(root, 'node_modules/electron/dist/electron.exe')
const args = process.env.RVB_GRAPH_EDITOR_EXE ? [] : [path.join(root, 'electron-editor/dist/main.js')]
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [...args, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--editor-smoke-hidden'], { env, windowsHide: true, stdio: 'ignore' })
let startupError
child.on('error', error => { startupError = error })
let socket
let sequence = 0
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function connect() {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (startupError) throw startupError
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()
      const tab = tabs.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (tab) {
        socket = new WebSocket(tab.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
        return
      }
    } catch { /* bounded startup retry */ }
    await delay(250)
  }
  throw new Error('Editor startup timed out')
}
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
    const onMessage = event => {
      const result = JSON.parse(event.data)
      if (result.id !== id) return
      clearTimeout(timer); socket.removeEventListener('message', onMessage)
      if (result.error) reject(new Error(JSON.stringify(result.error))); else resolve(result.result)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function until(expression) {
  for (let attempt = 0; attempt < 180; attempt++) { if (await evaluate(expression)) return; await delay(100) }
  throw new Error(`UI condition timed out: ${expression}`)
}
async function openCollection(collection, id) {
  await until(`Boolean(document.querySelector('#${collection}-list .entity-item'))`)
  await evaluate(`(()=>{document.querySelector('[data-tab=${JSON.stringify(collection)}]').click();const e=[...document.querySelectorAll('#${collection}-list .entity-item')].find(x=>x.querySelector('.id').textContent===${JSON.stringify(id)});if(!e)throw new Error('missing ${collection}/${id}');e.click()})()`)
}
async function openDraftDocument(collection, id) {
  await until(`Boolean(window.openCollectionDocument && document.querySelector('#${collection}-list .entity-item'))`)
  await evaluate(`openCollectionDocument(${JSON.stringify(collection)}, ${JSON.stringify(id)})`)
}
async function click(expression) { await evaluate(`(${expression}).click()`) }
async function clickStatus(collection, ownerId) {
  const selector = `#${collection}-detail [data-skill-cluster-member=${JSON.stringify(`status:${skill.statusTag.id}`)}]`
  await evaluate(`(()=>{const rows=[...document.querySelectorAll(${JSON.stringify(selector)})];const row=rows.find(e=>e.dataset.skillClusterMemberKey.includes(${JSON.stringify(ownerId)}));if(!row)throw new Error('missing status owner '+${JSON.stringify(ownerId)});if(typeof row.onclick!=='function')throw new Error('status row has no handler');row.onclick()})()`)
}
try {
  await connect()
  await openCollection('skills', skill.id)
  await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-editor]'))")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-skill-cluster-editor]')?.dataset.skillClusterKind"), 'active')
  assert.equal(await evaluate("document.querySelector('#skills-detail .skill-cluster-kicker').textContent"), '技能总览')
  assert.equal(await evaluate("document.querySelector('#skills-detail .skill-cluster-description').textContent"), skill.description)
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-skill-cluster-member=\"rule:cluster-demo-rule\"]'))"), true)
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-skill-cluster-editor] textarea').length"), 0, 'Cluster status editing does not default to raw JSON')

  // Both valid edits and malformed raw JSON are renderer drafts. Crossing a
  // collection tab must preserve the exact text and the last valid object.
  await click("document.querySelector('#skills-detail [data-editor-mode=json]')")
  await evaluate("(()=>{const e=document.querySelector('#skills-detail [data-json-source]');const value=JSON.parse(e.value);value.description='JSON 草稿保留';e.value=JSON.stringify(value,null,2);e.dispatchEvent(new Event('input',{bubbles:true}))})()")
  await openDraftDocument('pieces', piece.id)
  await openDraftDocument('skills', skill.id)
  await click("document.querySelector('#skills-detail [data-editor-mode=json]')")
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).description"), 'JSON 草稿保留')
  const invalidJson = '{\n  "description": "未完成"'
  await evaluate(`(()=>{const e=document.querySelector('#skills-detail [data-json-source]');e.value=${JSON.stringify(invalidJson)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-footer-state]').textContent"), 'JSON 有错误')
  await openDraftDocument('pieces', piece.id)
  await openDraftDocument('skills', skill.id)
  await click("document.querySelector('#skills-detail [data-editor-mode=json]')")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-json-source]').value"), invalidJson)
  await click("document.querySelector('#skills-detail [data-reset-document]')")
  await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-editor]'))")

  // A malformed owner draft blocks a foreign inline status edit with a
  // repair-first message; it is never silently replaced by the edit.
  await click("document.querySelector('#skills-detail [data-editor-mode=json]')")
  await evaluate(`(()=>{const e=document.querySelector('#skills-detail [data-json-source]');e.value=${JSON.stringify(invalidJson)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await openDraftDocument('skills', siblingSkill.id)
  await openDraftDocument('pieces', piece.id)
  await clickStatus('pieces', skill.id)
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-status-field=duration]'))")
  await evaluate("(()=>{const e=document.querySelector('#pieces-detail [data-skill-cluster-status-field=duration]');e.value='3';e.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await until("document.querySelector('#pieces-detail .skill-cluster-message.error')?.textContent.includes('先修复')")
  await openDraftDocument('skills', skill.id)
  await click("document.querySelector('#skills-detail [data-editor-mode=json]')")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-json-source]').value"), invalidJson)
  await click("document.querySelector('#skills-detail [data-reset-document]')")
  await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-editor]'))")

  // Edit an inline status, then follow its explicit rule link and return. The
  // skill draft must survive the navigation without an implicit save.
  await click("document.querySelector('#skills-detail [data-skill-cluster-member=" + JSON.stringify(`status:${skill.statusTag.id}`) + "]')")
  await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-status-field=duration]'))")
  await evaluate("(()=>{const e=document.querySelector('#skills-detail [data-skill-cluster-status-field=duration]');e.value='4';e.dispatchEvent(new Event('change',{bubbles:true}))})()")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-footer-state]').textContent"), '未保存')
  await click("document.querySelector('#skills-detail [data-skill-cluster-member=\"rule:cluster-demo-rule\"]')")
  await click("[...document.querySelectorAll('#skills-detail .skill-cluster-detail .skill-cluster-action')].find(e=>e.textContent.includes('打开规则'))")
  await until("document.querySelector('#rules-detail [data-document-title]')?.textContent.includes('Cluster 演示规则')")
  assert.equal(await evaluate("document.querySelector('#rules-detail [data-cluster-return]')?.textContent"), '返回技能总览')
  await click("document.querySelector('#rules-detail [data-cluster-return]')")
  await click("document.querySelector('#skills-detail [data-skill-cluster-member=" + JSON.stringify(`status:${skill.statusTag.id}`) + "]')")
  await until("document.querySelector('#skills-detail [data-skill-cluster-status-field=duration]')?.value==='4'")

  // Passive roots are first-class clusters. Their rule relationship is shown
  // from the piece declaration and is not guessed from a similar name.
  await openDraftDocument('pieces', piece.id)
  await until("document.querySelector('#pieces-detail [data-skill-cluster-kind]')?.dataset.skillClusterKind==='passive'")
  assert.equal(await evaluate("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-member=\"rule:cluster-demo-rule\"]'))"), true)
  // Replacing Skill A with Skill B in the same collection must retire A's
  // panel closure. Editing A's duplicate status from the passive root must not
  // mutate B's currently mounted editor.
  await openDraftDocument('skills', siblingSkill.id)
  await openDraftDocument('pieces', piece.id)
  await clickStatus('pieces', skill.id)
  await until("document.querySelector('#pieces-detail [data-skill-cluster-status-field=duration]')?.value==='4'")
  await evaluate("(()=>{const e=document.querySelector('#pieces-detail [data-skill-cluster-status-field=duration]');e.value='5';e.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await openDraftDocument('skills', siblingSkill.id)
  await clickStatus('skills', siblingSkill.id)
  await until("document.querySelector('#skills-detail [data-skill-cluster-status-field=duration]')?.value==='9'")
  await openDraftDocument('skills', skill.id)
  await clickStatus('skills', skill.id)
  await until("document.querySelector('#skills-detail [data-skill-cluster-status-field=duration]')?.value==='5'")

  // Save the skill draft, reload, and verify the inline shape and extension
  // fields survive the normal document writer.
  await openDraftDocument('skills', skill.id)
  await clickStatus('skills', skill.id)
  await until("document.querySelector('#skills-detail [data-skill-cluster-status-field=duration]')?.value==='5'")
  await click("document.querySelector('#skills-detail [data-save-json]')")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
  const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data/skills', `${skill.id}.json`), 'utf8'))
  assert.equal(persisted.statusTag.duration, 5)
  assert.deepEqual(persisted.statusTag.extension, skill.statusTag.extension)
  assert.deepEqual(persisted.extension, skill.extension)
  await call('Page.reload')
  await openCollection('skills', skill.id)
  await clickStatus('skills', skill.id)
  await until("document.querySelector('#skills-detail [data-skill-cluster-status-field=duration]')?.value==='5'")
  await openDraftDocument('skills', skill.id)
  await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-editor]'))")
  await evaluate("document.querySelector('[data-new-document=skills]').click()")
  await evaluate("(()=>{document.querySelector('#create-id').value='cluster-new-passive';document.querySelector('#create-name').value='新建被动能力';document.querySelector('#create-form').requestSubmit()})()")
  await until("Boolean(document.querySelector('#skills-detail [data-field-path=kind]'))")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-editor-pane=fields]').classList.contains('active')"), true)
  assert.equal(await evaluate("(()=>{const values=[...document.querySelectorAll('#skills-detail [data-field-path=kind] option')].map(e=>e.value);return values.includes('active')&&values.includes('passive')})()"), true)
  await evaluate("(()=>{const e=document.querySelector('#skills-detail [data-field-path=kind]');e.value='passive';e.dispatchEvent(new Event('input',{bubbles:true}))})()")
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).kind"), 'passive')
  await click("document.querySelector('#skills-detail [data-reset-document]')")
  await openDraftDocument('skills', skill.id)
  await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-editor]'))")
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(evidence, 'skill-cluster-editor.png'), Buffer.from(screenshot.data, 'base64'))
  const report = { ok: true, checks: ['active Cluster overview and exact description', 'valid and invalid raw JSON draft roundtrip', 'invalid foreign owner blocks inline edit', 'explicit linked rule navigation', 'unsaved inline status draft roundtrip', 'passive piece Cluster root', 'same-collection session retirement for duplicate status owners', 'foreign status draft sync to owning skill', 'structured status edit preserves extensions', 'save and reload', 'new passive skill kind control and module starter', 'Cluster screenshot'], screenshots: ['skill-cluster-editor.png'] }
  fs.writeFileSync(path.join(evidence, 'skill-cluster-smoke.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  socket?.close()
  child.kill()
}
