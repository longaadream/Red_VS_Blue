import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

// Focused real-Electron coverage for the explicit result binding control. DOM
// composition events are deterministic here; this does not drive the native
// Windows IME candidate window.
const require = createRequire(import.meta.url)
const root = process.cwd()
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const gameplayCore = require(path.join(root, 'electron-editor/dist/gameplay-module-core.cjs'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-result-binding-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
const evidence = path.resolve(process.env.RVB_SELECTOR_RESULT_BINDING_EVIDENCE_DIR || path.join(root, 'output', 'completion-selector-result-binding'))
fs.mkdirSync(evidence, { recursive: true })
const skillId = 'result-binding-regression'
const cardId = 'result-binding-card-regression'
const ruleId = 'result-binding-rule-regression'
const producer = {
  kind: 'call',
  id: 'compare-result',
  module: 'compare.equal-string',
  version: '1',
  inputs: { left: { kind: 'literal', value: '甲' }, right: { kind: 'literal', value: '甲' } },
  parameters: {},
}
const legacyProducer = {
  kind: 'call',
  id: 'legacy-result',
  module: 'compare.equal-string',
  version: '1',
  inputs: { left: { kind: 'literal', value: '旧' }, right: { kind: 'literal', value: '旧' } },
  parameters: {},
  layout: { resultNames: { value: '原别名' } },
}
const staleBindingProducer = {
  kind: 'call',
  id: 'stale-binding-result',
  module: 'compare.equal-string',
  version: '1',
  inputs: { left: { kind: 'literal', value: '陈' }, right: { kind: 'literal', value: '陈' } },
  parameters: {},
  // This link names a removed declaration. It must not reserve the name for
  // a new binding elsewhere in the graph.
  layout: { resultVariables: { value: { name: '空缺', declarationId: 'removed-result-declaration', valueType: 'boolean' } } },
}
const invalidPortProducer = {
  kind: 'call',
  id: 'invalid-port-result',
  module: 'compare.equal-string',
  version: '1',
  inputs: { left: { kind: 'literal', value: '失效' }, right: { kind: 'literal', value: '失效' } },
  parameters: {},
  // The compare module exposes `value`, not `removed`. The declaration below
  // deliberately keeps the old port so the editor must show both rows and a
  // repair hint instead of projecting the declaration away.
  layout: { resultVariables: { removed: { name: '失效绑定', declarationId: 'invalid-port-declaration', valueType: 'boolean' } } },
}
const invalidPortDeclaration = {
  kind: 'call',
  id: 'invalid-port-declaration',
  module: 'local.declare',
  version: '2',
  inputs: { initial: { kind: 'output', node: 'invalid-port-result', port: 'removed' } },
  parameters: { name: '失效绑定', valueType: 'boolean' },
}
const declarationId = 'compare-result_value_result-1'
const multiOutputProducer = {
  kind: 'call', id: 'multiple-result', module: 'author.card.gain', version: '1',
  inputs: { player: { kind: 'output', node: 'fixture-player', port: 'player' }, card: { kind: 'output', node: 'fixture-card', port: 'card' } }, parameters: { extensionType: 'record' },
  layout: { resultVariables: { success: { name: '复用', declarationId: 'removed-output-variable', valueType: 'boolean' } } },
}
const selectorPiece = {
  kind: 'call', id: 'selector-piece', module: 'author.choice.target-piece', version: '1',
  inputs: {}, parameters: { range: 5, filter: 'enemy' },
}
const selectorPieceSecond = {
  kind: 'call', id: 'selector-piece-second', module: 'author.choice.target-piece', version: '1',
  inputs: {}, parameters: { range: 6, filter: 'enemy' },
}
const selectorCell = {
  kind: 'call', id: 'selector-cell', module: 'author.choice.target-cell', version: '1',
  inputs: {}, parameters: { range: 4, filter: 'all', requireWalkable: true, requireUnoccupied: true },
}
const selectorOption = {
  kind: 'call', id: 'selector-option', module: 'author.choice.option', version: '3',
  inputs: { options: { kind: 'literal', value: { format: 'author-map/v1', entries: [['甲', '一'], ['乙', '二']] } } },
  parameters: {
    optionsType: JSON.stringify({ kind: 'map', key: 'string', value: 'string' }),
    valueType: JSON.stringify({ kind: 'list', element: 'string' }),
    selectionMode: 'multi', title: '选择选项', canCancel: false,
  },
}
const selectorDelete = {
  kind: 'call', id: 'selector-delete', module: 'author.choice.target-piece', version: '1',
  inputs: {}, parameters: { range: 3, filter: 'enemy' },
}
const selectorDamage = {
  kind: 'call', id: 'selector-damage', module: 'author.effect.damage', version: '1',
  inputs: {
    source: { kind: 'output', node: 'selector-piece', port: 'piece' },
    target: { kind: 'output', node: 'selector-piece-second', port: 'piece' },
    amount: { kind: 'literal', value: 1 },
  },
  // Keep the legacy parameter pointed at the fixture's real skill so the
  // sentence shows its author-facing name. Missing IDs are covered after the
  // field is edited below and must retain the repair token/diagnostic.
  parameters: { damageType: 'normal', skillId },
}
const independentDeclaration = {
  kind: 'call', id: 'manual-declare', module: 'local.declare', version: '2',
  inputs: { initial: { kind: 'literal', value: true } },
  parameters: { name: '手写变量', valueType: 'boolean' },
}
const independentOutputDeclaration = {
  kind: 'call', id: 'manual-output-declare', module: 'local.declare', version: '2',
  inputs: { initial: { kind: 'output', node: 'multiple-result', port: 'placement' } },
  parameters: { name: '手写输出变量', valueType: 'string' },
}
const writer = {
  kind: 'call',
  id: 'write-target',
  module: 'local.write',
  version: '1',
  inputs: {
    handle: { kind: 'output', node: declarationId, port: 'handle' },
    value: { kind: 'literal', value: false },
  },
  parameters: { valueType: 'boolean' },
}
const reader = {
  kind: 'call',
  id: 'read-target',
  module: 'local.read',
  version: '1',
  inputs: { handle: { kind: 'output', node: declarationId, port: 'handle' } },
  parameters: { valueType: 'boolean' },
}
const terminal = {
  kind: 'return',
  id: 'return-result',
  values: {
    value: { kind: 'output', node: 'read-target', port: 'value' },
    piece: { kind: 'output', node: 'selector-piece', port: 'piece' },
    pieceSecond: { kind: 'output', node: 'selector-piece-second', port: 'piece' },
    cell: { kind: 'output', node: 'selector-cell', port: 'cell' },
    selected: { kind: 'output', node: 'selector-option', port: 'value' },
  },
}
const graph = {
  version: 'rvb-gameplay-modules/v1',
  surface: 'skill',
  body: [producer, writer, reader, legacyProducer, staleBindingProducer, invalidPortProducer, invalidPortDeclaration,
    { kind: 'call', id: 'fixture-player', module: 'ref.player', version: '1', inputs: {}, parameters: {} },
    { kind: 'call', id: 'fixture-card', module: 'ref.card-definition', version: '1', inputs: {}, parameters: { cardId } },
    multiOutputProducer, selectorPiece, selectorPieceSecond, selectorCell, selectorOption, selectorDelete, selectorDamage, independentDeclaration, independentOutputDeclaration, terminal],
  inputs: [],
  outputs: [
    { name: 'value', type: 'boolean' },
    { name: 'piece', type: 'piece' },
    { name: 'pieceSecond', type: 'piece' },
    { name: 'cell', type: 'cell' },
    { name: 'selected', type: { kind: 'list', element: 'string' } },
  ],
  composites: [],
  continuations: [],
}
const cardGraph = {
  version: 'rvb-gameplay-modules/v1',
  surface: 'card',
  body: [
    {
      kind: 'call',
      id: 'current-hand',
      module: 'ref.current-card',
      version: '1',
      inputs: {},
      parameters: {},
    },
    {
      kind: 'return',
      id: 'card-return',
      values: { value: { kind: 'literal', value: true } },
    },
  ],
  inputs: [],
  outputs: [{ name: 'value', type: 'boolean' }],
  composites: [],
  continuations: [],
}
const ruleGraph = {
  version: 'rvb-gameplay-modules/v1',
  surface: 'rule',
  body: [
    { kind: 'return', id: 'rule-return', values: { value: { kind: 'literal', value: true } } },
  ],
  inputs: [],
  outputs: [{ name: 'value', type: 'boolean' }],
  composites: [],
  continuations: [],
}
fs.writeFileSync(path.join(project, 'data/skills/manifest.json'), JSON.stringify([skillId]) + '\n')
fs.writeFileSync(path.join(project, 'data/cards/manifest.json'), JSON.stringify([cardId]) + '\n')
fs.writeFileSync(path.join(project, 'data/rules/manifest.json'), JSON.stringify([ruleId]) + '\n')
fs.writeFileSync(path.join(project, 'data/skills', skillId + '.json'), JSON.stringify({
  id: skillId,
  name: '返回值绑定回归',
  description: '测试显式保存返回值',
  kind: 'active',
  type: 'normal',
  code: '',
  gameplayModules: {
    version: 'rvb-gameplay-module-document/v1',
    entries: { code: { graph, compilerVersion: 'rvb-gameplay-module-compiler/v3' } },
  },
}, null, 2) + '\n')
fs.writeFileSync(path.join(project, 'data/cards', cardId + '.json'), JSON.stringify({
  id: cardId,
  name: '当前手牌返回值绑定回归',
  description: '验证当前手牌输出可以保存为局部变量并供统一扩展语句使用。',
  type: 'active',
  code: '',
  gameplayModules: {
    version: 'rvb-gameplay-module-document/v1',
    entries: { code: { graph: cardGraph, compilerVersion: 'rvb-gameplay-module-compiler/v3' } },
  },
}, null, 2) + '\n')
fs.writeFileSync(path.join(project, 'data/rules', ruleId + '.json'), JSON.stringify({
  id: ruleId,
  name: '规则能力组归因回归',
  description: '验证规则伤害可以从无归因切换为当前能力组。',
  priority: 1,
  trigger: { type: 'beginTurn' },
  skillCode: '',
  gameplayModules: {
    version: 'rvb-gameplay-module-document/v1',
    entries: { skillCode: { graph: ruleGraph, compilerVersion: 'rvb-gameplay-module-compiler/v3' } },
  },
}, null, 2) + '\n')
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')

const listener = net.createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const executable = process.env.RVB_GRAPH_EDITOR_EXE || process.env.RVB_GRAPH_ELECTRON_BINARY || path.join(root, 'node_modules/electron/dist/electron.exe')
const args = process.env.RVB_GRAPH_EDITOR_EXE ? [] : [path.join(root, 'electron-editor/dist/main.js')]
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, args.concat([
  '--user-data-dir=' + userData,
  '--remote-debugging-port=' + port,
  '--editor-smoke-hidden',
]), { env, windowsHide: true, stdio: 'ignore' })

let socket
let sequence = 0
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++sequence
    const timer = setTimeout(() => {
      socket?.removeEventListener('message', onMessage)
      reject(new Error('CDP timeout: ' + method))
    }, 30000)
    const onMessage = event => {
      const result = JSON.parse(event.data)
      if (result.id !== requestId) return
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      if (result.error) reject(new Error(JSON.stringify(result.error)))
      else resolve(result.result)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id: requestId, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function until(expression) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if (await evaluate(expression)) return
    } catch { /* renderer is still mounting */ }
    await delay(100)
  }
  throw new Error('UI condition timed out: ' + expression)
}
async function click(selector) {
  await evaluate('(()=>{const element=document.querySelector(' + JSON.stringify(selector) + ');if(!element)throw new Error(' + JSON.stringify('missing ' + selector) + ');element.click()})()')
  await delay(80)
}
async function setAuthorEditor(rootSelector, field, value) {
  const editorSelector = `${rootSelector} [data-sentence-author-field="${field}"] .ei-editor`
  await evaluate(`(()=>{
    const editor=document.querySelector(${JSON.stringify(editorSelector)})
    if(!editor)throw new Error('missing author expression editor: '+${JSON.stringify(field)})
    editor.focus()
    editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))
    editor.textContent=${JSON.stringify(value)}
    editor.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:${JSON.stringify(value)}}))
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,data:${JSON.stringify(value)},inputType:'insertCompositionText',isComposing:true}))
    editor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:${JSON.stringify(value)}}))
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,data:${JSON.stringify(value)},inputType:'insertText',isComposing:false}))
  })()`)
  await delay(80)
}

try {
  let target
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const targets = await (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) })).json()
      target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
    } catch { /* Electron is still starting */ }
    await delay(100)
  }
  if (!target) throw new Error('Editor startup timed out')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await until("document.body.classList.contains('studio-surface') && Boolean(document.querySelector('#skills-list .entity-item'))")
  await evaluate('(()=>{document.querySelector(\'[data-tab=skills]\').click();const item=[...document.querySelectorAll("#skills-list .entity-item")].find(node=>node.dataset.entityId===' + JSON.stringify(skillId) + ');if(!item)throw new Error(\'missing result binding skill\');item.click()})()')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-node=\"compare-result\"]'))")

  const buttonState = await evaluate(`(()=>{
    const row=document.querySelector('#skills-detail [data-sentence-node="compare-result"]')
    const button=row?.querySelector('[data-sentence-save-result="compare-result:value"]')
    return {visible:Boolean(button),disabled:Boolean(button?.disabled),text:button?.textContent||'',legacy:Boolean(row?.querySelector('.sentence-result-legacy'))}
  })()`)
  assert.deepEqual(buttonState, { visible: true, disabled: false, text: '保存返回值', legacy: false })
  await click('#skills-detail [data-sentence-save-result="compare-result:value"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-result-variable-editor=\"compare-result:value\"] input[data-sentence-result-variable-name]'))")

  const composition = await evaluate(`(async()=>{
    const input=document.querySelector('#skills-detail [data-sentence-result-variable-name="compare-result:value"]')
    input.focus()
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))
    input.value='目标'
    input.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'目标'}))
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'目标',inputType:'insertCompositionText',isComposing:true}))
    const during={connected:input.isConnected,same:document.querySelector('#skills-detail [data-sentence-result-variable-name="compare-result:value"]')===input,value:input.value,focused:document.activeElement===input}
    const enter=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',code:'Enter',keyCode:229,isComposing:true})
    input.dispatchEvent(enter)
    const composingEnter={prevented:enter.defaultPrevented,editorStillOpen:!document.querySelector('[data-sentence-result-variable-editor="compare-result:value"]').hidden}
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'目标'}))
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'目标',inputType:'insertText',isComposing:false}))
    await new Promise(resolve=>setTimeout(resolve,30))
    const settled=document.querySelector('#skills-detail [data-sentence-result-variable-name="compare-result:value"]')
    const secondInput=settled
    secondInput.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))
    secondInput.value='目标'
    secondInput.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'目标'}))
    secondInput.dispatchEvent(new InputEvent('input',{bubbles:true,data:'目标',inputType:'insertCompositionText',isComposing:true}))
    secondInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'目标'}))
    secondInput.dispatchEvent(new InputEvent('input',{bubbles:true,data:'目标',inputType:'insertText',isComposing:false}))
    await new Promise(resolve=>setTimeout(resolve,30))
    const secondSettled=document.querySelector('#skills-detail [data-sentence-result-variable-name="compare-result:value"]')
    return {during,composingEnter,settled:{connected:settled?.isConnected===true,value:settled?.value||'',focused:document.activeElement===settled},second:{same:secondSettled===secondInput,value:secondSettled?.value||'',focused:document.activeElement===secondSettled}}
  })()`)
  assert.deepEqual(composition.during, { connected: true, same: true, value: '目标', focused: true })
  assert.deepEqual(composition.composingEnter, { prevented: false, editorStillOpen: true })
  assert.deepEqual(composition.settled, { connected: true, value: '目标', focused: true })
  assert.deepEqual(composition.second, { same: true, value: '目标', focused: true })

  await click('#skills-detail [data-sentence-result-variable-apply="compare-result:value"]')
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body[1]?.module==='local.declare'")
  const persisted = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules?.entries?.code?.graph?.body||[]
    const index=body.findIndex(item=>item?.id==='compare-result')
    const declaration=body[index+1]
    return {index,declaration,link:body[index]?.layout?.resultVariables?.value,visible:document.querySelector('#skills-detail')?.innerText?.includes('变量目标')===true}
  })()`)
  assert.equal(persisted.index, 0)
  assert.equal(persisted.declaration?.module, 'local.declare')
  assert.equal(String(persisted.declaration?.version), '2')
  assert.equal(persisted.declaration?.parameters?.name, '目标')
  assert.equal(persisted.declaration?.parameters?.valueType, 'boolean')
  assert.deepEqual(persisted.declaration?.inputs?.initial, { kind: 'output', node: 'compare-result', port: 'value' })
  const persistedWriter = persisted.declaration && (await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.module==='local.write'))()`))
  const persistedReader = persisted.declaration && (await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.module==='local.read'))()`))
  assert.deepEqual(persistedWriter?.inputs?.handle, { kind: 'output', node: persisted.declaration.id, port: 'handle' })
  assert.deepEqual(persistedReader?.inputs?.handle, { kind: 'output', node: persisted.declaration.id, port: 'handle' })
  assert.deepEqual(persistedWriter?.inputs?.value, { kind: 'literal', value: false })
  const persistedReturn = await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.kind==='return'))()`)
  assert.deepEqual(persistedReturn?.values?.value, { kind: 'output', node: 'read-target', port: 'value' })
  assert.equal(persisted.link?.name, '目标')
  assert.equal(persisted.link?.declarationId, persisted.declaration?.id)
  assert.equal(persisted.visible, true)

  // A declaration whose producer port disappeared is an ordinary visible
  // declaration with a repair hint. It must not be mistaken for a generated
  // binding merely because the old metadata still points at the producer.
  const invalidPortState = await evaluate(`(()=>({
    producerVisible:Boolean(document.querySelector('[data-sentence-node="invalid-port-result"]')),
    declarationVisible:Boolean(document.querySelector('[data-sentence-node="invalid-port-declaration"]')),
    diagnostic:document.querySelector('[data-sentence-node="invalid-port-result"] [data-sentence-result-binding-invalid="invalid-port-result:removed"]')?.textContent||'',
  }))()`)
  assert.equal(invalidPortState.producerVisible, true)
  assert.equal(invalidPortState.declarationVisible, true)
  assert.match(invalidPortState.diagnostic, /返回值绑定已失效/u)
  assert.match(invalidPortState.diagnostic, /返回端口已不存在/u)
  await click('#skills-detail [data-sentence-node="invalid-port-declaration"] [data-sentence-row-action="delete"]')
  await until(`!document.querySelector('[data-sentence-node="invalid-port-declaration"]')`)
  await click('#skills-detail [data-sentence-node="invalid-port-result"] [data-sentence-row-action="delete"]')
  await until(`!document.querySelector('[data-sentence-node="invalid-port-result"]')`)

  // Selector results keep their single typed return binding on the selector
  // row. The generated local declaration remains executable IR, but it is an
  // internal binding and must not become a second author sentence. Two
  // selectors also need distinct names so later value labels never fall back
  // to the implicit current target.
  const saveSelectorResult = async (nodeId, port, name, checkEmptyName = false) => {
    await click(`#skills-detail [data-sentence-save-result="${nodeId}:${port}"]`)
    await until(`Boolean(document.querySelector('[data-sentence-result-variable-editor="${nodeId}:${port}"] input[data-sentence-result-variable-name]'))`)
    if (checkEmptyName) {
      await evaluate(`(()=>{
        const input=document.querySelector('[data-sentence-result-variable-name="${nodeId}:${port}"]')
        const apply=document.querySelector('[data-sentence-result-variable-apply="${nodeId}:${port}"]')
        input.value=''
        input.dispatchEvent(new Event('input',{bubbles:true}))
        apply?.click()
      })()`)
      await until("document.body.innerText.includes('请填写变量名。')")
      // Keep the rejected name attached to A's draft while opening an
      // already-bound, read-only result viewer B. The global banner should
      // disappear, but A's editor must still carry the actionable error.
      await click('#skills-detail [data-sentence-save-result="selector-piece:piece"]')
      await until("Boolean(document.querySelector('[data-sentence-result-variable-editor=\"selector-piece:piece\"]'))")
      const switchedError = await evaluate(`(()=>({
        global:Boolean([...document.querySelectorAll('#skills-detail .sentence-message.error')].some(node=>node.textContent.includes('请填写变量名'))),
        local:Boolean(document.querySelector('[data-sentence-result-variable-error]')?.textContent?.includes('请填写变量名')),
      }))()`)
      assert.equal(switchedError.global, false)
      assert.equal(switchedError.local, true)
      await click('#skills-detail [data-sentence-result-variable-editor="selector-piece:piece"] .sentence-result-cancel')
      await click('#skills-detail [data-sentence-result-variable-editor="selector-delete:piece"] .sentence-result-cancel')
      await click(`#skills-detail [data-sentence-save-result="${nodeId}:${port}"]`)
      await until(`Boolean(document.querySelector('[data-sentence-result-variable-editor="${nodeId}:${port}"] input[data-sentence-result-variable-name]'))`)
    }
    await evaluate(`(()=>{
      const input=document.querySelector('[data-sentence-result-variable-name="${nodeId}:${port}"]')
      input.value=${JSON.stringify(name)}
      input.dispatchEvent(new Event('input',{bubbles:true}))
      document.querySelector('[data-sentence-result-variable-apply="${nodeId}:${port}"]')?.click()
    })()`)
    await until(`(()=>{
      const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
      const producer=(source.gameplayModules.entries.code.graph.body||[]).find(item=>item?.id===${JSON.stringify(nodeId)})
      return producer?.layout?.resultVariables?.[${JSON.stringify(port)}]?.name===${JSON.stringify(name)}
    })()`)
  }
  const applyAuthorExpression = async (name, source) => {
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-author-expression="${name}"] .ei-editor'))`)
    await evaluate(`(()=>{
      const editor=document.querySelector('[data-sentence-author-expression="${name}"] .ei-editor')
      editor.focus()
      editor.textContent=${JSON.stringify(source)}
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,data:${JSON.stringify(source)},inputType:'insertText',isComposing:false}))
    })()`)
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-apply-expression="${name}"]')) && document.querySelector('#skills-detail [data-sentence-apply-expression="${name}"]')?.disabled===false`)
    await click(`#skills-detail [data-sentence-apply-expression="${name}"]`)
  }
  const applyModuleInputExpression = async (nodeId, name, source) => {
    await click(`#skills-detail [data-sentence-module-editor="${nodeId}"]`)
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${nodeId}"]'))`)
    const field = `#skills-detail [data-sentence-inline-editor="${nodeId}"] [data-sentence-module-input="${name}"]`
    const hasField = await evaluate(`Boolean(document.querySelector(${JSON.stringify(field)}))`)
    if (!hasField) {
      const debug = await evaluate(`(()=>{const panel=document.querySelector('#skills-detail [data-sentence-inline-editor="${nodeId}"]');return {text:panel?.innerText||'',inputs:[...panel?.querySelectorAll('[data-sentence-module-input]')||[]].map(item=>item.dataset.sentenceModuleInput),parameters:[...panel?.querySelectorAll('[data-sentence-module-parameter]')||[]].map(item=>item.dataset.sentenceModuleParameter)}})()`)
      throw new Error(`missing module input ${name}: ${JSON.stringify(debug)}`)
    }
    await evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(field)});const details=field?.closest('details');if(details&&!details.open)details.querySelector('summary')?.click()})()`)
    const direct = `${field} [data-sentence-direct-expression="${name}"]`
    if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(direct)}))`)) await click(direct)
    await applyAuthorExpression(name, source)
  }
  const applyRuleModuleInputExpression = async (nodeId, name, source) => {
    await click(`#rules-detail [data-sentence-module-editor="${nodeId}"]`)
    await until(`Boolean(document.querySelector('#rules-detail [data-sentence-inline-editor="${nodeId}"]'))`)
    const field = `#rules-detail [data-sentence-inline-editor="${nodeId}"] [data-sentence-module-input="${name}"]`
    const hasField = await evaluate(`Boolean(document.querySelector(${JSON.stringify(field)}))`)
    if (!hasField) {
      const debug = await evaluate(`(()=>{const panel=document.querySelector('#rules-detail [data-sentence-inline-editor="${nodeId}"]');return {text:panel?.innerText||'',inputs:[...panel?.querySelectorAll('[data-sentence-module-input]')||[]].map(item=>item.dataset.sentenceModuleInput),parameters:[...panel?.querySelectorAll('[data-sentence-module-parameter]')||[]].map(item=>item.dataset.sentenceModuleParameter)}})()`)
      throw new Error(`missing rule module input ${name}: ${JSON.stringify(debug)}`)
    }
    await evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(field)});const details=field?.closest('details');if(details&&!details.open)details.querySelector('summary')?.click()})()`)
    const direct = `${field} [data-sentence-direct-expression="${name}"]`
    if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(direct)}))`)) await click(direct)
    await until(`Boolean(document.querySelector('#rules-detail [data-sentence-author-expression="${name}"] .ei-editor'))`)
    await evaluate(`(()=>{
      const editor=document.querySelector('#rules-detail [data-sentence-author-expression="${name}"] .ei-editor')
      editor.focus()
      editor.textContent=${JSON.stringify(source)}
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,data:${JSON.stringify(source)},inputType:'insertText',isComposing:false}))
    })()`)
    await until(`Boolean(document.querySelector('#rules-detail [data-sentence-apply-expression="${name}"]')) && document.querySelector('#rules-detail [data-sentence-apply-expression="${name}"]')?.disabled===false`)
    await click(`#rules-detail [data-sentence-apply-expression="${name}"]`)
  }
  await saveSelectorResult('selector-piece', 'piece', '目标一')
  await saveSelectorResult('selector-piece-second', 'piece', '目标二')
  await saveSelectorResult('selector-cell', 'cell', '地格一')
  await saveSelectorResult('selector-option', 'value', '选项组')
  const selectorBindingState = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const selectors=[['selector-piece','piece'],['selector-piece-second','piece'],['selector-cell','cell'],['selector-option','value']]
    const bindings=selectors.map(([node,port])=>{
      const producer=body.find(item=>item?.id===node)
      const link=producer?.layout?.resultVariables?.[port]
      const declaration=body.find(item=>item?.id===link?.declarationId)
      return {node,port,link,declarationId:declaration?.id,visible:Boolean(declaration&&document.querySelector('[data-sentence-node="'+declaration.id+'"]')),
        rowText:document.querySelector('[data-sentence-node="'+node+'"]')?.innerText||''}
    })
    return {bindings,independentVisible:Boolean(document.querySelector('[data-sentence-node="manual-declare"]')),
      independentOutputVisible:Boolean(document.querySelector('[data-sentence-node="manual-output-declare"]')),
      declarationCount:body.filter(item=>item?.module==='local.declare').length}
  })()`)
  assert.deepEqual(selectorBindingState.bindings.map(item=>({node:item.node,port:item.port,visible:item.visible})), [
    { node: 'selector-piece', port: 'piece', visible: false },
    { node: 'selector-piece-second', port: 'piece', visible: false },
    { node: 'selector-cell', port: 'cell', visible: false },
    { node: 'selector-option', port: 'value', visible: false },
  ])
  assert.equal(selectorBindingState.independentVisible, true)
  assert.equal(selectorBindingState.independentOutputVisible, true)
  assert.equal(selectorBindingState.declarationCount, 7)
  assert.match(selectorBindingState.bindings[0].rowText, /查看变量（目标一）/u)
  assert.match(selectorBindingState.bindings[1].rowText, /查看变量（目标二）/u)
  const selectorDamageText = await evaluate(`(()=>document.querySelector('[data-sentence-node="selector-damage"]')?.innerText||'')()`)
  assert.match(selectorDamageText, /目标一/u)
  assert.match(selectorDamageText, /目标二/u)
  assert.match(selectorDamageText, /返回值绑定回归/u)
  assert.doesNotMatch(selectorDamageText, /selector-result-binding/u)
  assert.doesNotMatch(selectorDamageText, /当前目标/u)
  const selectorScreenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(evidence, 'selector-result-binding.png'), Buffer.from(selectorScreenshot.data, 'base64'))

  // Legacy damage v1 keeps its authored skillId editable. It is a real
  // parameter on the old descriptor, so opening it must not turn the field
  // into a misleading prerequisite warning.
  await click('#skills-detail [data-sentence-module-editor="selector-damage"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor=\"selector-damage\"]'))")
  const legacyDamageEditor = await evaluate(`(()=>{
    const panel=document.querySelector('#skills-detail [data-sentence-inline-editor="selector-damage"]')
    const field=panel?.querySelector('[data-sentence-module-parameter="skillId"]')
    const warning=panel?.querySelector('[data-sentence-pending-parameter="selector-damage:skillId"]')
    return {field:Boolean(field),warning:Boolean(warning),value:field?.querySelector('input')?.value||''}
  })()`)
  assert.equal(legacyDamageEditor.field, true)
  assert.equal(legacyDamageEditor.warning, false)
  await evaluate(`(()=>{
    const field=document.querySelector('#skills-detail [data-sentence-inline-editor="selector-damage"] [data-sentence-module-parameter="skillId"]')
    const details=field?.closest('details');if(details&&!details.open)details.querySelector('summary')?.click()
    const input=field?.querySelector('input');if(!input)throw new Error('legacy skillId input missing')
    input.value='legacy-fireball';input.dispatchEvent(new Event('change',{bubbles:true}))
  })()`)
  await until(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.id==='selector-damage')?.parameters?.skillId==='legacy-fireball')()`)
  await click('#skills-detail [data-sentence-inline-editor="selector-damage"] .sentence-popover-close')
  const missingSkillReference = await evaluate(`(()=>{
    const row=document.querySelector('#skills-detail [data-sentence-node="selector-damage"]')
    const token=row?.querySelector('[data-sentence-slot-name="skillId"]')
    return {text:row?.innerText||'',missing:token?.dataset?.sentenceReferenceMissing||'',id:token?.dataset?.sentenceReferenceId||''}
  })()`)
  assert.match(missingSkillReference.text, /缺失的技能引用/u)
  assert.equal(missingSkillReference.missing, 'true')
  assert.equal(missingSkillReference.id, 'legacy-fireball')

  // Add a fresh typed damage row, choose the v3 descriptor, bind its optional
  // abilityGroup input from the Chinese current-context suggestion, and use
  // the current skill multiplier as a typed amount expression.
  await click('#skills-detail [data-sentence-add-effect]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=\"module\"]'))")
  await evaluate(`(()=>{
    const items=[...document.querySelectorAll('#skills-detail [data-sentence-popover="module"] [data-sentence-module="author.effect.damage"]')]
    const item=items.at(-1);if(!item)throw new Error('typed damage module missing')
    item.click()
  })()`)
  await delay(120)
  const typedDamageId = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    return [...(source.gameplayModules?.entries?.code?.graph?.body||[])].reverse().find(item=>item?.module==='author.effect.damage')?.id
  })()`)
  assert.equal(typeof typedDamageId, 'string')
  await click(`#skills-detail [data-sentence-module-editor="${typedDamageId}"]`)
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${typedDamageId}"]'))`)
  await evaluate(`(()=>{
    const panel=document.querySelector('#skills-detail [data-sentence-inline-editor="${typedDamageId}"]')
    const select=panel?.querySelector('[data-sentence-module-select]')
    if(!select)throw new Error('typed damage version selector missing')
    const expected=${JSON.stringify('author.effect.damage\0' + '3')}
    if(select.value!==expected){select.value=expected;select.dispatchEvent(new Event('change',{bubbles:true}))}
  })()`)
  await delay(120)
  await click(`#skills-detail [data-sentence-inline-editor="${typedDamageId}"] .sentence-popover-close`)
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-node="${typedDamageId}"] [data-sentence-auto-current-cluster="true"]'))`)
  const defaultClusterSlot = await evaluate(`(()=>{
    const row=document.querySelector('#skills-detail [data-sentence-node="${typedDamageId}"]')
    const slot=row?.querySelector('[data-sentence-auto-current-cluster="true"]')
    return {text:slot?.textContent||'',name:slot?.dataset?.sentenceSlotName||''}
  })()`)
  assert.equal(defaultClusterSlot.name, 'abilityGroup')
  assert.equal(defaultClusterSlot.text, '当前能力组')
  await click(`#skills-detail [data-sentence-node="${typedDamageId}"] [data-sentence-auto-current-cluster="true"]`)
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${typedDamageId}"][data-sentence-slot-editor="input:abilityGroup"]'))`)
  const defaultClusterDraft = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const damage=body.find(item=>item?.id===${JSON.stringify(typedDamageId)})
    const ref=damage?.inputs?.abilityGroup
    const producer=ref?.kind==='output' ? body.find(item=>item?.id===ref.node) : null
    return {ref,producerModule:producer?.module||'',producerPort:ref?.port||''}
  })()`)
  assert.equal(defaultClusterDraft.ref?.kind, 'output')
  assert.equal(defaultClusterDraft.producerModule, 'ref.current-cluster')
  assert.equal(defaultClusterDraft.producerPort, 'group')
  await click(`#skills-detail [data-sentence-inline-editor="${typedDamageId}"] .sentence-popover-close`)
  await applyModuleInputExpression(typedDamageId, 'source', '当前棋子')
  await applyModuleInputExpression(typedDamageId, 'target', '目标一')
  await applyModuleInputExpression(typedDamageId, 'amount', '当前技能.倍率')
  await applyModuleInputExpression(typedDamageId, 'abilityGroup', '当前能力组')
  const typedDamageDraft = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    return (source.gameplayModules.entries.code.graph.body||[]).find(item=>item?.id===${JSON.stringify(typedDamageId)})
  })()`)
  assert.equal(typedDamageDraft.version, '3')
  assert.deepEqual(typedDamageDraft.inputs?.abilityGroup, { kind: 'output', node: typedDamageDraft.inputs.abilityGroup.node, port: 'group' })
  assert.equal(typedDamageDraft.layout?.authorExpressions?.abilityGroup?.source, '当前能力组')
  assert.equal(typedDamageDraft.layout?.authorExpressions?.amount?.source, '当前技能.倍率')
  assert.match(await evaluate(`(()=>document.querySelector('[data-sentence-node="${typedDamageId}"]')?.innerText||'')()`), /当前能力组/u)
  await until("document.querySelector('#studio-save')?.disabled===false")
  await click('#studio-save')
  await delay(140)
  const savedTypedDamage = JSON.parse(fs.readFileSync(path.join(project, 'data/skills', skillId + '.json'), 'utf8')).gameplayModules.entries.code.graph.body.find(item => item?.id === typedDamageId)
  assert.equal(savedTypedDamage?.version, '3')
  assert.equal(savedTypedDamage?.layout?.authorExpressions?.abilityGroup?.source, '当前能力组')
  assert.equal(savedTypedDamage?.layout?.authorExpressions?.amount?.source, '当前技能.倍率')
  await evaluate(`document.querySelector('#skills-list .entity-item[data-entity-id="${skillId}"]')?.click()`)
  await delay(120)
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-node="${typedDamageId}"]'))`)
  const reopenedTypedDamage = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    return body.find(item=>item?.id===${JSON.stringify(typedDamageId)})
  })()`)
  assert.equal(reopenedTypedDamage?.version, '3')
  assert.equal(reopenedTypedDamage?.layout?.authorExpressions?.abilityGroup?.source, '当前能力组')
  assert.equal(reopenedTypedDamage?.layout?.authorExpressions?.amount?.source, '当前技能.倍率')
  const typedDamageScreenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(evidence, 'damage-v3-ability-group.png'), Buffer.from(typedDamageScreenshot.data, 'base64'))

  // The executable declaration follows its selector when the author moves a
  // row. An unreferenced selector can also be deleted as one row without
  // leaving an orphaned local.declare in the graph.
  await saveSelectorResult('selector-delete', 'piece', '待删除', true)
  const deleteBinding = await evaluate(`(()=>{
    const body=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body||[]
    return body.find(item=>item?.id==='selector-delete')?.layout?.resultVariables?.piece?.declarationId
  })()`)
  const movedCellBinding = await evaluate(`(()=>{
    const body=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body||[]
    return body.find(item=>item?.id==='selector-cell')?.layout?.resultVariables?.cell?.declarationId
  })()`)
  const movedOptionBinding = await evaluate(`(()=>{
    const body=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body||[]
    return body.find(item=>item?.id==='selector-option')?.layout?.resultVariables?.value?.declarationId
  })()`)
  await click('#skills-detail [data-sentence-node="selector-cell"] [data-sentence-row-action="down"]')
  await until(`(()=>{
    const body=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body||[]
    const cell=body.findIndex(item=>item?.id==='selector-cell')
    const cellDeclaration=body.findIndex(item=>item?.id===${JSON.stringify(movedCellBinding)})
    const option=body.findIndex(item=>item?.id==='selector-option')
    const optionDeclaration=body.findIndex(item=>item?.id===${JSON.stringify(movedOptionBinding)})
    return cell>=0 && cellDeclaration===cell+1 && option>=0 && optionDeclaration===option+1 && option<cell
  })()`)
  const movedCellOrder = await evaluate(`(()=>{
    const body=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body||[]
    return {
      cell:body.findIndex(item=>item?.id==='selector-cell'),
      cellDeclaration:body.findIndex(item=>item?.id===${JSON.stringify(movedCellBinding)}),
      option:body.findIndex(item=>item?.id==='selector-option'),
      optionDeclaration:body.findIndex(item=>item?.id===${JSON.stringify(movedOptionBinding)}),
    }
  })()`)
  assert.equal(movedCellOrder.cellDeclaration, movedCellOrder.cell + 1)
  assert.equal(movedCellOrder.optionDeclaration, movedCellOrder.option + 1)
  assert.ok(movedCellOrder.option < movedCellOrder.cell)
  await click('#skills-detail [data-sentence-node="selector-cell"] [data-sentence-row-action="up"]')
  await until(`(()=>{
    const body=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body||[]
    const cell=body.findIndex(item=>item?.id==='selector-cell')
    const cellDeclaration=body.findIndex(item=>item?.id===${JSON.stringify(movedCellBinding)})
    const option=body.findIndex(item=>item?.id==='selector-option')
    const optionDeclaration=body.findIndex(item=>item?.id===${JSON.stringify(movedOptionBinding)})
    return cell>=0 && cellDeclaration===cell+1 && option>=0 && optionDeclaration===option+1 && cell<option
  })()`)
  await click('#skills-detail [data-sentence-node="selector-delete"] [data-sentence-row-action="delete"]')
  await until(`(()=>{
    const body=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body||[]
    return !body.some(item=>item?.id==='selector-delete') && !body.some(item=>item?.id===${JSON.stringify(deleteBinding)})
  })()`)
  const deletedSelectorState = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const declarationId=${JSON.stringify(deleteBinding)}
    return {producer:body.some(item=>item?.id==='selector-delete'),declaration:body.some(item=>item?.id===declarationId),visible:Boolean(declarationId&&document.querySelector('[data-sentence-node="'+declarationId+'"]'))}
  })()`)
  assert.deepEqual(deletedSelectorState, { producer: false, declaration: false, visible: false })

  // A missing declaration behind an old resultVariables link must not reserve
  // the name. Once a real declaration exists, a second producer is rejected;
  // prototype names remain rejected by the local binding validator.
  await click('#skills-detail [data-sentence-save-result="legacy-result:value"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-result-variable-editor=\"legacy-result:value\"] input[data-sentence-result-variable-name]'))")
  await evaluate(`(()=>{
    const editor=document.querySelector('[data-sentence-result-variable-editor="legacy-result:value"]')
    const input=editor?.querySelector('[data-sentence-result-variable-name]')
    const apply=editor?.querySelector('[data-sentence-result-variable-apply]')
    if(!input||!apply) throw new Error('missing legacy result binding controls')
    input.value='空缺'; input.dispatchEvent(new Event('input',{bubbles:true})); apply.click()
  })()`)
  await delay(80)
  const legacyBindingCheck = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const legacy=body.find(item=>item?.id==='legacy-result')
    const declaration=body.find(item=>item?.module==='local.declare'&&item?.inputs?.initial?.node==='legacy-result')
    return {ok:true,legacyLink:legacy?.layout?.resultVariables,declaration}
  })()`)
  assert.equal(legacyBindingCheck.ok, true)
  assert.equal(legacyBindingCheck.legacyLink?.value?.name, '空缺')
  assert.equal(legacyBindingCheck.declaration?.parameters?.name, '空缺')

  await click('#skills-detail [data-sentence-save-result="stale-binding-result:value"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-result-variable-editor=\"stale-binding-result:value\"] input[data-sentence-result-variable-name]'))")
  await evaluate(`(()=>{
    const editor=document.querySelector('[data-sentence-result-variable-editor="stale-binding-result:value"]')
    const input=editor?.querySelector('[data-sentence-result-variable-name]')
    const apply=editor?.querySelector('[data-sentence-result-variable-apply]')
    if(!input||!apply) throw new Error('missing stale result binding controls')
    input.value='空缺'; input.dispatchEvent(new Event('input',{bubbles:true})); apply.click()
  })()`)
  await delay(80)
  const staleBindingCheck = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    return {
      staleLink:body.find(item=>item?.id==='stale-binding-result')?.layout?.resultVariables?.value,
      declaration:body.find(item=>item?.module==='local.declare'&&item?.inputs?.initial?.node==='stale-binding-result'),
    }
  })()`)
  assert.equal(staleBindingCheck.staleLink?.declarationId, 'removed-result-declaration')
  assert.equal(staleBindingCheck.declaration, undefined)
  await click('#skills-detail [data-sentence-result-variable-editor="stale-binding-result:value"] .sentence-result-cancel')
  await click('#skills-detail [data-sentence-result-variable-editor="legacy-result:value"] .sentence-result-cancel')

  // A stale link on another port of the same producer also releases its name.
  await click('#skills-detail [data-sentence-save-result="multiple-result:placement"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-result-variable-name=\"multiple-result:placement\"]'))")
  await evaluate(`(()=>{
    const input=document.querySelector('#skills-detail [data-sentence-result-variable-name="multiple-result:placement"]');
    input.value='复用';input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  await click('#skills-detail [data-sentence-result-variable-apply="multiple-result:placement"]')
  const reusedPort = await evaluate(`(()=>{
    const graph=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph;
    return graph.body.find(item=>item?.module==='local.declare'&&item?.parameters?.name==='复用');
  })()`)
  assert.equal(reusedPort?.inputs?.initial?.node, 'multiple-result')
  assert.equal(reusedPort?.inputs?.initial?.port, 'placement')
  const reusedPortRow = await evaluate(`(()=>{
    const body=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body||[]
    const producer=body.find(item=>item?.id==='multiple-result')
    const declarationId=producer?.layout?.resultVariables?.placement?.declarationId
    return {declarationId,visible:Boolean(declarationId&&document.querySelector('[data-sentence-node="'+declarationId+'"]'))}
  })()`)
  assert.equal(typeof reusedPortRow.declarationId, 'string')
  assert.equal(reusedPortRow.visible, false)
  assert.equal(await evaluate("Boolean(document.querySelector('[data-sentence-node=\"manual-output-declare\"]'))"), true)

  // A legacy resultNames edit remains available and still writes its metadata.
  const legacy = await evaluate(`(()=>{
    const input=document.querySelector('#skills-detail [data-sentence-node="legacy-result"] .sentence-result-legacy input')
    if(!input) return false
    input.value='旧别名'; input.dispatchEvent(new Event('change',{bubbles:true})); return true
  })()`)
  assert.equal(legacy, true)
  await delay(80)
  const legacyValue = await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.id==='legacy-result').layout.resultNames.value)()`)
  assert.equal(legacyValue, '旧别名')
  await until("Boolean(document.querySelector('#skills-detail [data-save-json]'))")
  await until("document.querySelector('#studio-save')?.disabled===false")
  await click('#studio-save')
  let saved = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const documentValue = JSON.parse(fs.readFileSync(path.join(project, 'data/skills', skillId + '.json'), 'utf8'))
      const body = documentValue.gameplayModules?.entries?.code?.graph?.body || []
      const fresh = body.find(item => item?.id === 'compare-result')
      const legacy = body.find(item => item?.id === 'legacy-result')
      saved = { declaration: body[body.findIndex(item => item?.id === 'compare-result') + 1], resultVariables: fresh?.layout?.resultVariables, resultNames: legacy?.layout?.resultNames, ids: body.map(item => `${item?.id}:${item?.module || item?.kind}`) }
    } catch { /* save is still in flight */ }
    if (saved?.declaration?.parameters?.name === '目标' && saved.resultNames?.value === '旧别名') break
    await delay(100)
  }
  if (saved?.declaration?.module !== 'local.declare') {
    const diagnostics = await evaluate(`(()=>({
      toast:[...document.querySelectorAll('.toast')].map(item=>item.textContent),
      issues:[...document.querySelectorAll('#skills-detail .error,#skills-detail .validation-error,#skills-detail .diagnostic')].map(item=>item.textContent),
      saveDisabled:document.querySelector('#studio-save')?.disabled,
      body:JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules?.entries?.code?.graph?.body?.map(item=>({id:item.id,module:item.module})),
    }))()`)
    throw new Error('result binding persistence failed: '+JSON.stringify(diagnostics))
  }
  assert.equal(saved?.declaration?.module, 'local.declare')
  assert.equal(saved?.declaration?.parameters?.name, '目标')
  assert.equal(saved?.resultVariables?.value?.name, '目标')
  assert.equal(saved?.resultNames?.value, '旧别名')

  // Execute the persisted graph with the same local handle protocol used by
  // the runtime. The producer starts true, the explicit local.write changes
  // it to false, and the return reads that changed value through local.read.
  const savedGraph = JSON.parse(fs.readFileSync(path.join(project, 'data/skills', skillId + '.json'), 'utf8')).gameplayModules.entries.code.graph
  const compiled = gameplayCore.compileGameplayModuleGraph(savedGraph, gameplayCore.GAMEPLAY_MODULE_REGISTRY)
  const values = new Map()
  const events = []
  let handleId = 0
  const flow = {
    refs: { player: () => 'player-red', holder: () => 'piece-one' },
    skills: { current: () => ({ instance: 'skill-one' }), field: () => ({ value: 2, defined: true }) },
    clusters: { current: () => ({ group: 'cluster-one' }), attribution: group => group },
    query: { hasPlayer: () => true, hasPiece: () => true },
    values: { require: value => value },
    containers: { authorMapItems: value => value.entries },
    choice: {
      authorTarget: (_config, id) => id === 'selector-piece'
        ? { instanceId: 'piece-one' }
        : id === 'selector-piece-second' ? { instanceId: 'piece-two' } : { x: 2, y: 3 },
      authorOption: () => ['一', '二'],
    },
    effects: { damage: () => ({ success: true, damage: 1 }), apply: () => ({ success: true, damage: 1 }) },
    cards: { gain: () => ({ instance: null, success: true, placement: 'hand' }) },
    execution: {
    declare(_type, _schemas, initial) {
      const handle = { id: ++handleId }
      values.set(handle, initial)
      events.push(['declare', initial])
      return { handle, success: true }
    },
    write(handle, _type, _schemas, value) {
      values.set(handle, value)
      events.push(['write', value])
      return true
    },
    read(handle) {
      const value = values.get(handle)
      events.push(['read', value])
      return { value, success: true }
    },
    },
  }
  const execute = new Function('flow', `return (${compiled.code})`)(flow)
  assert.deepEqual(execute({}), {
    value: false,
    piece: 'piece-one',
    pieceSecond: 'piece-two',
    cell: { x: 2, y: 3 },
    selected: ['一', '二'],
  })
  assert.deepEqual(events.slice(0, 3), [['declare', true], ['write', false], ['read', false]])

  // Reopen the same document after persistence; the explicit declaration and
  // both binding representations must remain available to the editor.
  await evaluate(`document.querySelector('#skills-list .entity-item[data-entity-id="${skillId}"]')?.click()`)
  await delay(120)
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-node=\"compare-result\"]'))")
  const reopened = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const fresh=body.find(item=>item?.id==='compare-result')
    const legacy=body.find(item=>item?.id==='legacy-result')
    return {declaration:body[body.findIndex(item=>item?.id==='compare-result')+1],resultVariables:fresh?.layout?.resultVariables,resultNames:legacy?.layout?.resultNames}
  })()`)
  assert.equal(reopened.declaration?.module, 'local.declare')
  assert.equal(reopened.declaration?.parameters?.name, '目标')
  assert.equal(reopened.resultVariables?.value?.name, '目标')
  assert.equal(reopened.resultNames?.value, '旧别名')
  const reopenedWriter = await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.module==='local.write'))()`)
  const reopenedReader = await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.module==='local.read'))()`)
  assert.deepEqual(reopenedWriter?.inputs?.handle, { kind: 'output', node: reopened.declaration.id, port: 'handle' })
  assert.deepEqual(reopenedReader?.inputs?.handle, { kind: 'output', node: reopened.declaration.id, port: 'handle' })
  assert.deepEqual(reopenedWriter?.inputs?.value, { kind: 'literal', value: false })
  const reopenedReturn = await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.kind==='return'))()`)
  assert.deepEqual(reopenedReturn?.values?.value, { kind: 'output', node: 'read-target', port: 'value' })
  const reopenedSelectorRows = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const selectors=[['selector-piece','piece'],['selector-piece-second','piece'],['selector-cell','cell'],['selector-option','value']]
    return selectors.map(([node,port])=>{
      const link=body.find(item=>item?.id===node)?.layout?.resultVariables?.[port]
      return {node, declarationId:link?.declarationId, producerVisible:Boolean(document.querySelector('[data-sentence-node="'+node+'"]')), declarationVisible:Boolean(link?.declarationId&&document.querySelector('[data-sentence-node="'+link.declarationId+'"]'))}
    })
  })()`)
  assert.equal(reopenedSelectorRows.length, 4)
  assert.ok(reopenedSelectorRows.every(item => typeof item.declarationId === 'string' && item.declarationId.length > 0))
  assert.deepEqual(reopenedSelectorRows.map(({ node, producerVisible, declarationVisible }) => ({ node, producerVisible, declarationVisible })), [
    { node: 'selector-piece', producerVisible: true, declarationVisible: false },
    { node: 'selector-piece-second', producerVisible: true, declarationVisible: false },
    { node: 'selector-cell', producerVisible: true, declarationVisible: false },
    { node: 'selector-option', producerVisible: true, declarationVisible: false },
  ])
  const boundUi = await evaluate(`(()=>{
    const row=document.querySelector('#skills-detail [data-sentence-node="compare-result"]')
    const button=row?.querySelector('[data-sentence-save-result="compare-result:value"]')
    button?.click()
    const input=row?.querySelector('[data-sentence-result-variable-name="compare-result:value"]')
    const apply=row?.querySelector('[data-sentence-result-variable-apply="compare-result:value"]')
    return {button:button?.textContent||'',readonly:input?.readOnly===true,applyDisabled:apply?.disabled===true,focused:document.activeElement===input}
  })()`)
  assert.deepEqual(boundUi, { button: '查看变量（目标）', readonly: true, applyDisabled: true, focused: true })
  await delay(80)
  assert.equal(await evaluate("document.querySelector('#studio-save')?.disabled"), true, 'read-only result viewer does not mark the document dirty')
  await click('#skills-detail [data-sentence-result-variable-editor="compare-result:value"] .sentence-result-cancel')
  await delay(50)
  assert.equal(await evaluate("document.querySelector('#studio-save')?.disabled"), true, 'closing read-only result viewer keeps the document clean')

  // A card's current-hand reference is a real record result. Save that result
  // as a local handle, then use the same unified extension declaration and
  // assignment inspectors against the local value. This guards the domain
  // propagation path (card-instance -> card extension) in addition to the
  // skill boolean result path above.
  await evaluate("document.querySelector('[data-tab=cards]').click()")
  await until(`Boolean(document.querySelector('#cards-list [data-entity-id=${JSON.stringify(cardId)}]'))`)
  await click(`#cards-list [data-entity-id="${cardId}"]`)
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-node=\"current-hand\"]'))")
  const cardResultButton = await evaluate(`(()=>{
    const row=document.querySelector('#cards-detail [data-sentence-node="current-hand"]')
    const button=row?.querySelector('[data-sentence-save-result="current-hand:card"]')
    return {visible:Boolean(button),disabled:Boolean(button?.disabled),text:button?.textContent||'',legacy:Boolean(row?.querySelector('.sentence-result-legacy'))}
  })()`)
  assert.deepEqual(cardResultButton, { visible: true, disabled: false, text: '保存返回值', legacy: false })
  await click('#cards-detail [data-sentence-save-result="current-hand:card"]')
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-result-variable-editor=\"current-hand:card\"] input[data-sentence-result-variable-name]'))")
  await evaluate(`(()=>{
    const input=document.querySelector('#cards-detail [data-sentence-result-variable-name="current-hand:card"]')
    input.value='手牌变量'
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'手牌变量',inputType:'insertText',isComposing:false}))
  })()`)
  await click('#cards-detail [data-sentence-result-variable-apply="current-hand:card"]')
  await until(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    return Boolean(source.gameplayModules?.entries?.code?.graph?.body?.some(item=>item?.module==='local.declare'&&item?.inputs?.initial?.node==='current-hand'))
  })()`)
  const cardBinding = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const producer=body.find(item=>item?.id==='current-hand')
    const declaration=body.find(item=>item?.module==='local.declare'&&item?.inputs?.initial?.node==='current-hand')
    return {producer,declaration,link:producer?.layout?.resultVariables?.card}
  })()`)
  assert.equal(cardBinding.declaration?.parameters?.name, '手牌变量')
  assert.equal(cardBinding.declaration?.parameters?.valueType, 'record')
  assert.deepEqual(cardBinding.declaration?.inputs?.initial, { kind: 'output', node: 'current-hand', port: 'card' })
  assert.equal(cardBinding.link?.name, '手牌变量')
  assert.equal(cardBinding.link?.declarationId, cardBinding.declaration?.id)

  // On a non-skill surface a v3 damage row without an abilityGroup input is
  // lowered as unattributed. The sentence must say that explicitly instead
  // of offering a decorative current-cluster label or synthetic slot.
  await click('#cards-detail [data-sentence-add-effect]')
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-popover=\"module\"]'))")
  await evaluate(`(()=>{
    const items=[...document.querySelectorAll('#cards-detail [data-sentence-popover="module"] [data-sentence-module="author.effect.damage"]')]
    const item=items.at(-1);if(!item)throw new Error('card typed damage module missing')
    item.click()
  })()`)
  await delay(100)
  const cardDamageId = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    return [...(source.gameplayModules?.entries?.code?.graph?.body||[])].reverse().find(item=>item?.module==='author.effect.damage')?.id
  })()`)
  assert.equal(typeof cardDamageId, 'string')
  await click(`#cards-detail [data-sentence-module-editor="${cardDamageId}"]`)
  await until(`Boolean(document.querySelector('#cards-detail [data-sentence-inline-editor="${cardDamageId}"]'))`)
  await evaluate(`(()=>{
    const panel=document.querySelector('#cards-detail [data-sentence-inline-editor="${cardDamageId}"]')
    const select=panel?.querySelector('[data-sentence-module-select]')
    if(!select)throw new Error('card typed damage version selector missing')
    const expected=${JSON.stringify('author.effect.damage\0' + '3')}
    if(select.value!==expected){select.value=expected;select.dispatchEvent(new Event('change',{bubbles:true}))}
  })()`)
  await delay(100)
  await click(`#cards-detail [data-sentence-inline-editor="${cardDamageId}"] .sentence-popover-close`)
  await until(`Boolean(document.querySelector('#cards-detail [data-sentence-node="${cardDamageId}"]'))`)
  const cardDamageText = await evaluate(`(()=>{
    const row=document.querySelector('#cards-detail [data-sentence-node="${cardDamageId}"]')
    return {text:row?.innerText||'',current:Boolean(row?.querySelector('[data-sentence-auto-current-cluster="true"]'))}
  })()`)
  assert.match(cardDamageText.text, /不归因于能力组/u)
  assert.doesNotMatch(cardDamageText.text, /当前能力组/u)
  assert.equal(cardDamageText.current, false)
  const cardDamageScreenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(evidence, 'damage-v3-card-unattributed.png'), Buffer.from(cardDamageScreenshot.data, 'base64'))
  await click(`#cards-detail [data-sentence-node="${cardDamageId}"] [data-sentence-row-action="delete"]`)
  await until(`!Boolean(document.querySelector('#cards-detail [data-sentence-node="${cardDamageId}"]'))`)

  await click('#cards-detail [data-sentence-add-effect]')
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-module=\"author.extension.declare\"]'))")
  await click('#cards-detail [data-sentence-module="author.extension.declare"]')
  await until("Boolean(document.querySelector('#cards-detail .sentence-author-statement-editor[data-sentence-author-statement]'))")
  const cardDeclarationPanel = '#cards-detail .sentence-author-statement-editor[data-sentence-author-statement]'
  await setAuthorEditor(cardDeclarationPanel, 'ownerSource', '手牌变量')
  await setAuthorEditor(cardDeclarationPanel, 'name', '护甲')
  await setAuthorEditor(cardDeclarationPanel, 'initialSource', '1')
  await click('#cards-detail [data-sentence-author-apply]')
  await until(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    return Boolean(source.gameplayModules?.entries?.code?.graph?.body?.some(item=>item?.layout?.authorStatement?.kind==='extension-declaration'&&item.layout.authorStatement.name==='护甲'))
  })()`)
  const cardExtension = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const declaration=body.find(item=>item?.module==='local.declare'&&item?.parameters?.name==='手牌变量')
    const statement=body.find(item=>item?.layout?.authorStatement?.kind==='extension-declaration')
    const ownerRead=statement?.inputs?.entity?.kind==='output' ? body.find(item=>item?.id===statement.inputs.entity.node) : null
    return {statement,ownerRead,declaration}
  })()`)
  assert.equal(cardExtension.statement?.module, 'extension.declare-instance')
  assert.equal(cardExtension.statement?.parameters?.entityKind, 'card')
  assert.equal(cardExtension.statement?.parameters?.name, '护甲')
  assert.equal(cardExtension.statement?.parameters?.valueType, 'number')
  assert.equal(cardExtension.statement?.layout?.authorStatement?.ownerSource, '手牌变量')
  assert.deepEqual(cardExtension.ownerRead?.inputs?.handle, { kind: 'output', node: cardExtension.declaration?.id, port: 'handle' })

  await click('#cards-detail [data-sentence-add-effect]')
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-module=\"author.assignment\"]'))")
  await click('#cards-detail [data-sentence-module="author.assignment"]')
  await until("Boolean(document.querySelector('#cards-detail .sentence-author-statement-editor[data-sentence-author-statement]'))")
  const cardAssignmentPanel = '#cards-detail .sentence-author-statement-editor[data-sentence-author-statement]'
  await setAuthorEditor(cardAssignmentPanel, 'targetSource', '手牌变量.extension.护甲')
  await setAuthorEditor(cardAssignmentPanel, 'valueSource', '2')
  await click('#cards-detail [data-sentence-author-apply]')
  await until(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    return Boolean(source.gameplayModules?.entries?.code?.graph?.body?.some(item=>item?.layout?.authorStatement?.kind==='assignment'&&item.layout.authorStatement.targetSource==='手牌变量.extension.护甲'))
  })()`)
  const cardAssignment = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const statement=body.find(item=>item?.layout?.authorStatement?.kind==='assignment')
    const entityRead=statement?.inputs?.entity?.kind==='output' ? body.find(item=>item?.id===statement.inputs.entity.node) : null
    return {statement,entityRead,body}
  })()`)
  assert.equal(cardAssignment.statement?.module, 'extension.write-instance')
  assert.equal(cardAssignment.statement?.parameters?.entityKind, 'card')
  assert.equal(cardAssignment.statement?.parameters?.name, '护甲')
  assert.equal(cardAssignment.statement?.parameters?.valueType, 'number')
  assert.deepEqual(cardAssignment.statement?.inputs?.value, { kind: 'literal', value: 2 })
  assert.deepEqual(cardAssignment.entityRead?.inputs?.handle, { kind: 'output', node: cardBinding.declaration.id, port: 'handle' })
  assert.equal(cardAssignment.statement?.layout?.authorStatement?.targetSource, '手牌变量.extension.护甲')
  const compiledCard = gameplayCore.compileGameplayModuleGraph(
    { ...cardGraph, body: cardAssignment.body }, gameplayCore.GAMEPLAY_MODULE_REGISTRY,
  )
  assert.match(compiledCard.code, /function executeCard\(/)

  await until("document.querySelector('#studio-save')?.disabled===false")
  await click('#studio-save')
  let savedCard = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { savedCard = JSON.parse(fs.readFileSync(path.join(project, 'data/cards', cardId + '.json'), 'utf8')) } catch { /* save is still in flight */ }
    const savedBody = savedCard?.gameplayModules?.entries?.code?.graph?.body || []
    if (savedBody.some(item => item?.module === 'extension.write-instance' && item?.parameters?.name === '护甲')) break
    await delay(100)
  }
  const savedCardBody = savedCard?.gameplayModules?.entries?.code?.graph?.body || []
  assert.ok(savedCardBody.some(item => item?.module === 'local.declare' && item?.parameters?.name === '手牌变量'))
  assert.ok(savedCardBody.some(item => item?.module === 'extension.declare-instance' && item?.parameters?.name === '护甲'))
  assert.ok(savedCardBody.some(item => item?.module === 'extension.write-instance' && item?.parameters?.name === '护甲'))

  // Rule v3 damage starts without an ability-group input. Its honest default
  // is unattributed, but the author can switch the attribution policy to
  // current; that choice must materialize ref.current-cluster instead of
  // leaving a compiler-only implicit fallback.
  await evaluate("document.querySelector('[data-tab=rules]').click()")
  await until(`Boolean(document.querySelector('#rules-list [data-entity-id=${JSON.stringify(ruleId)}]'))`)
  await click(`#rules-list [data-entity-id="${ruleId}"]`)
  await until("Boolean(document.querySelector('#rules-detail [data-sentence-node=\"rule-return\"]'))")
  await click('#rules-detail [data-sentence-add-effect]')
  await until("Boolean(document.querySelector('#rules-detail [data-sentence-popover=\"module\"]'))")
  await evaluate(`(()=>{
    const items=[...document.querySelectorAll('#rules-detail [data-sentence-popover="module"] [data-sentence-module="author.effect.damage"]')]
    const item=items.at(-1);if(!item)throw new Error('rule typed damage module missing')
    item.click()
  })()`)
  await delay(100)
  const ruleDamageId = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#rules-detail [data-json-source]').value||'{}')
    return [...(source.gameplayModules?.entries?.skillCode?.graph?.body||[])].reverse().find(item=>item?.module==='author.effect.damage')?.id
  })()`)
  assert.equal(typeof ruleDamageId, 'string')
  await click(`#rules-detail [data-sentence-module-editor="${ruleDamageId}"]`)
  await until(`Boolean(document.querySelector('#rules-detail [data-sentence-inline-editor="${ruleDamageId}"]'))`)
  await evaluate(`(()=>{
    const panel=document.querySelector('#rules-detail [data-sentence-inline-editor="${ruleDamageId}"]')
    const select=panel?.querySelector('[data-sentence-module-select]')
    if(!select)throw new Error('rule typed damage version selector missing')
    const expected=${JSON.stringify('author.effect.damage\0' + '3')}
    if(select.value!==expected){select.value=expected;select.dispatchEvent(new Event('change',{bubbles:true}))}
  })()`)
  await delay(100)
  await click(`#rules-detail [data-sentence-inline-editor="${ruleDamageId}"] .sentence-popover-close`)
  await until(`Boolean(document.querySelector('#rules-detail [data-sentence-node="${ruleDamageId}"]'))`)
  const ruleDefaultText = await evaluate(`(()=>{
    const row=document.querySelector('#rules-detail [data-sentence-node="${ruleDamageId}"]')
    return {text:row?.innerText||'',toggle:Boolean(row?.querySelector('[data-sentence-auto-unattributed="true"]'))}
  })()`)
  assert.match(ruleDefaultText.text, /不归因于能力组/u)
  assert.equal(ruleDefaultText.toggle, true)
  await click(`#rules-detail [data-sentence-node="${ruleDamageId}"] [data-sentence-auto-unattributed="true"]`)
  await until(`Boolean(document.querySelector('#rules-detail [data-sentence-inline-editor="${ruleDamageId}"][data-sentence-slot-editor="parameter:attribution"]'))`)
  const ruleAttributionEditor = await evaluate(`(()=>{
    const panel=document.querySelector('#rules-detail [data-sentence-inline-editor="${ruleDamageId}"]')
    return {select:Boolean(panel?.querySelector('[data-sentence-literal-enum="attribution"]')),pending:Boolean(panel?.querySelector('[data-sentence-pending-parameter]'))}
  })()`)
  assert.deepEqual(ruleAttributionEditor, { select: true, pending: false })
  await evaluate(`(()=>{
    const select=document.querySelector('#rules-detail [data-sentence-literal-enum="attribution"]')
    if(!select)throw new Error('rule attribution selector missing')
    select.value=JSON.stringify('current')
    select.dispatchEvent(new Event('change',{bubbles:true}))
  })()`)
  await until(`(()=>{
    const source=JSON.parse(document.querySelector('#rules-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.skillCode.graph.body||[]
    const damage=body.find(item=>item?.id===${JSON.stringify(ruleDamageId)})
    const ref=damage?.inputs?.abilityGroup
    const producer=ref?.kind==='output' ? body.find(item=>item?.id===ref.node) : null
    return ref?.kind==='output' && ref.port==='group' && producer?.module==='ref.current-cluster'
  })()`)
  await click(`#rules-detail [data-sentence-inline-editor="${ruleDamageId}"] .sentence-popover-close`)
  await applyRuleModuleInputExpression(ruleDamageId, 'source', '当前棋子')
  await applyRuleModuleInputExpression(ruleDamageId, 'target', '当前棋子')
  await applyRuleModuleInputExpression(ruleDamageId, 'amount', '1')
  const ruleDamageDraft = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#rules-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.skillCode.graph.body||[]
    const damage=body.find(item=>item?.id===${JSON.stringify(ruleDamageId)})
    const ref=damage?.inputs?.abilityGroup
    const producer=ref?.kind==='output' ? body.find(item=>item?.id===ref.node) : null
    return {damage,producerModule:producer?.module||''}
  })()`)
  assert.equal(ruleDamageDraft.damage?.version, '3')
  assert.equal(ruleDamageDraft.damage?.parameters?.attribution, 'current')
  assert.equal(ruleDamageDraft.damage?.inputs?.abilityGroup?.port, 'group')
  assert.equal(ruleDamageDraft.producerModule, 'ref.current-cluster')
  await until("document.querySelector('#studio-save')?.disabled===false")
  await click('#studio-save')
  await delay(140)
  const savedRule = JSON.parse(fs.readFileSync(path.join(project, 'data/rules', ruleId + '.json'), 'utf8'))
  const savedRuleBody = savedRule.gameplayModules.entries.skillCode.graph.body || []
  const savedRuleDamage = savedRuleBody.find(item=>item?.id===ruleDamageId)
  const savedRuleRef = savedRuleDamage?.inputs?.abilityGroup
  assert.equal(savedRuleDamage?.parameters?.attribution, 'current')
  assert.equal(savedRuleRef?.port, 'group')
  assert.equal(savedRuleBody.find(item=>item?.id===savedRuleRef?.node)?.module, 'ref.current-cluster')
  await click(`#rules-list [data-entity-id="${ruleId}"]`)
  await delay(120)
  await until(`Boolean(document.querySelector('#rules-detail [data-sentence-node="${ruleDamageId}"]'))`)
  const reopenedRule = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#rules-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.skillCode.graph.body||[]
    const damage=body.find(item=>item?.id===${JSON.stringify(ruleDamageId)})
    const ref=damage?.inputs?.abilityGroup
    const producer=ref?.kind==='output' ? body.find(item=>item?.id===ref.node) : null
    return {attribution:damage?.parameters?.attribution,ref,producerModule:producer?.module||''}
  })()`)
  assert.deepEqual(reopenedRule, {
    attribution: 'current',
    ref: { kind: 'output', node: reopenedRule.ref.node, port: 'group' },
    producerModule: 'ref.current-cluster',
  })
  const ruleDamageScreenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(evidence, 'damage-v3-rule-current-cluster.png'), Buffer.from(ruleDamageScreenshot.data, 'base64'))
} finally {
  socket?.close()
  if (child.exitCode === null) child.kill()
}

console.log('sentence-result-binding: passed')
