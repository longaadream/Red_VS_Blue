import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { indentWithTab, undo, redo, isolateHistory } from '@codemirror/commands'
import { linter } from '@codemirror/lint'
import { oneDark } from '@codemirror/theme-one-dark'
import { inspectCode, CODE_FIELDS, MAX_CODE_LENGTH } from './format.mjs'

export { inspectCode }
const labels = { code: '执行代码', skillCode: '规则执行代码', effectCode: '延迟效果', previewCode: '旧预览代码' }
const hint = (category, field) => field === 'skillCode'
  ? '规则入口：直接写语句，可使用 context；不要包在 executeSkill 函数里。'
  : field === 'effectCode' ? '延迟效果入口：function(ctx) { … }，不依赖外层闭包。'
    : field === 'previewCode' ? '旧版预览字段，仅为已有资源兼容保留；新内容不需要填写。'
      : `入口：function ${category === 'cards' ? 'executeCard' : 'executeSkill'}(context) { … }`

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function mount(container, options) {
  let activeField = options.primaryField || 'code'
  let locked = false, destroyed = false, synchronizing = false, generation = 0
  const views = new Map()
  const toolbar = element('div', 'ide-toolbar')
  const fields = element('select', 'ide-fields')
  fields.setAttribute('aria-label', '代码入口')
  toolbar.append(fields)
  const makeButton = (label, action) => {
    const button = element('button', 'btn btn-ghost', label)
    button.type = 'button'; button.onclick = action; toolbar.append(button)
    return button
  }
  const message = element('div', 'ide-message')
  message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite')
  const entry = element('div', 'ide-entry')
  const editorHost = element('div', 'ide-host')
  const status = element('div', 'ide-status')
  const shortcut = element('div', 'ide-shortcuts', 'Ctrl+S 保存 · Shift+Alt+F 格式化 · Ctrl+F 搜索/替换 · Ctrl+Z 撤销 · Tab 缩进 · Esc 后 Tab 离开代码区')
  const imports = element('div', 'ide-imports')
  imports.hidden = true
  let pendingFiles = []
  const fileChoice = element('select')
  fileChoice.setAttribute('aria-label', '待导入的代码文件')
  const target = element('div', 'ide-import-target')
  const preview = element('pre', 'ide-import-preview')
  const apply = element('button', 'btn btn-primary', '替换当前入口的草稿')
  const cancel = element('button', 'btn btn-ghost', '关闭导入预览')
  cancel.onclick = () => { imports.hidden = true; pendingFiles = [] }
  imports.append(element('strong', '', '导入预览'), fileChoice, target, preview, apply, cancel)
  const current = () => views.get(activeField)
  const immutable = () => locked || Boolean(options.getDraft().skillGraph)
  const report = text => { if (!destroyed) message.textContent = text }

  function updateImportPreview() {
    const file = pendingFiles[Number(fileChoice.value)]
    preview.textContent = file?.source || ''
    target.textContent = `${file?.name || '未选择文件'} → ${options.filename} → ${activeField}（当前 ${current()?.view.state.doc.length || 0} 字符；导入 ${file?.source.length || 0} 字符）`
    apply.disabled = immutable() || !file
  }
  fileChoice.onchange = updateImportPreview
  apply.onclick = () => {
    if (immutable() || destroyed) return
    const file = pendingFiles[Number(fileChoice.value)]
    if (!file) return
    replaceCurrent(file.source)
    report(`已将 ${file.name} 放入 ${activeField} 草稿；Ctrl+Z 可撤销，保存后才写入 JSON。`)
  }
  async function chooseImport(mode) {
    if (immutable()) return
    const epoch = generation
    try {
      const files = await options.importCode(mode)
      if (destroyed || epoch !== generation || !container.isConnected || !files.length) return
      pendingFiles = files
      fileChoice.replaceChildren(...files.map((file, index) => {
        const option = element('option', '', file.name); option.value = String(index); return option
      }))
      imports.hidden = false; updateImportPreview()
    } catch (error) { report('导入失败：' + error.message) }
  }
  function replaceCurrent(source) {
    if (immutable()) return
    const view = current().view
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source }, annotations: isolateHistory.of('full') })
    view.focus()
  }
  async function formatCurrent() {
    if (immutable()) return
    const record = current(), field = activeField
    const source = record.view.state.doc.toString(), epoch = generation
    const result = await inspectCode(source, field)
    if (destroyed || locked || epoch !== generation || current() !== record || source !== record.view.state.doc.toString()) return
    if (result.error) {
      report(`格式化失败：第 ${result.line} 行，第 ${result.column} 列，${result.error}。原文已保留。`)
      const line = record.view.state.doc.line(Math.min(result.line, record.view.state.doc.lines))
      const position = Math.min(line.to, line.from + result.column - 1)
      record.view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) })
      record.view.focus()
      return
    }
    replaceCurrent(result.formatted)
    report('已按两空格缩进整理为草稿；Ctrl+Z 可撤销。')
  }
  makeButton('格式化', formatCurrent)
  makeButton('撤销', () => { if (!immutable()) undo(current().view) })
  makeButton('重做', () => { if (!immutable()) redo(current().view) })
  makeButton('导入文件', () => chooseImport('files'))
  makeButton('导入文件夹', () => chooseImport('folder'))

  function selectField() {
    activeField = fields.value
    for (const [field, record] of views) record.host.hidden = field !== activeField
    entry.textContent = hint(options.category, activeField) + (options.getDraft().skillGraph ? ' 当前由流程图生成，代码只读。' : '')
    current()?.view.requestMeasure()
    updateImportPreview()
    updateStatus()
  }
  fields.onchange = selectField
  function updateStatus() {
    const record = current()
    if (!record) return
    const selection = record.view.state.selection.main.head
    const line = record.view.state.doc.lineAt(selection)
    status.textContent = `JavaScript · 第 ${line.number} 行，${selection - line.from + 1} 列 · ${record.view.state.doc.length} 字符 · ${record.diagnostic || '正在检查语法…'}`
  }
  function refresh() {
    if (destroyed) return
    const draft = options.getDraft()
    const available = CODE_FIELDS.filter(field => Object.hasOwn(draft, field) || field === options.primaryField)
    const previous = activeField
    fields.replaceChildren(...available.map(field => {
      const option = element('option', '', `${labels[field]} · ${field}`); option.value = field; return option
    }))
    fields.value = available.includes(previous) ? previous : available[0]
    synchronizing = true
    for (const field of available) {
      const source = typeof draft[field] === 'string' ? draft[field] : ''
      if (!views.has(field)) {
        const host = element('div', 'ide-surface'); host.dataset.ideField = field; editorHost.append(host)
        const readOnly = new Compartment()
        const record = { host, readOnly, diagnostic: '', view: null }
        const view = new EditorView({ parent: host, doc: source, extensions: [
          basicSetup, javascript(), oneDark,
          EditorView.contentAttributes.of({ 'aria-label': `${labels[field]} ${field}`, spellcheck: 'false' }),
          EditorView.theme({ '&': { fontSize: '13px' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, monospace' }, '&.cm-editor': { height: 'clamp(200px, calc(100vh - 530px), 540px)' } }),
          readOnly.of([EditorState.readOnly.of(immutable()), EditorView.editable.of(!immutable())]),
          EditorState.transactionFilter.of(transaction => {
            if (transaction.newDoc.length > MAX_CODE_LENGTH && transaction.docChanged) {
              report('代码超过 200,000 字符，本次粘贴未应用。')
              return []
            }
            return transaction
          }),
          keymap.of([{ key: 'Mod-s', run: () => { if (!immutable()) options.save(); return true } },
            { key: 'Shift-Alt-f', run: () => { void formatCurrent(); return true } }, indentWithTab]),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !synchronizing && !destroyed) {
              options.onChange({ ...options.getDraft(), [field]: update.state.doc.toString() })
              record.diagnostic = '正在检查语法…'
            }
            if (field === activeField) updateStatus()
          }),
          linter(async view => {
            const snapshot = view.state.doc.toString()
            const result = await inspectCode(snapshot, field)
            if (destroyed || snapshot !== view.state.doc.toString()) return []
            record.diagnostic = result.error ? `第 ${result.line} 行：${result.error}` : '语法检查通过（尚未验证玩法）'
            if (field === activeField) updateStatus()
            if (!result.error) return []
            const line = view.state.doc.line(Math.min(result.line, view.state.doc.lines))
            const from = Math.min(line.to, line.from + result.column - 1)
            return [{ from, to: Math.min(view.state.doc.length, from + 1), severity: 'error', message: result.error }]
          }, { delay: 650 }),
        ] })
        record.view = view; views.set(field, record)
      } else {
        const view = views.get(field).view
        if (source !== view.state.doc.toString()) {
          // A different editor mode changed the shared draft. Do not merge unrelated histories.
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source }, annotations: isolateHistory.of('full') })
        }
      }
    }
    for (const [field, record] of views) if (!available.includes(field)) { record.view.destroy(); record.host.remove(); views.delete(field) }
    synchronizing = false
    selectField(); setLocked(locked)
  }
  function setLocked(value) {
    locked = value
    for (const record of views.values()) record.view.dispatch({ effects: record.readOnly.reconfigure([EditorState.readOnly.of(immutable()), EditorView.editable.of(!immutable())]) })
    toolbar.querySelectorAll('button').forEach(button => { button.disabled = immutable() })
    apply.disabled = immutable() || !pendingFiles.length
  }
  container.replaceChildren(toolbar, entry, editorHost, status, shortcut, message, imports)
  refresh()
  return { refresh, setLocked, destroy() { destroyed = true; generation++; for (const record of views.values()) record.view.destroy(); views.clear() } }
}
