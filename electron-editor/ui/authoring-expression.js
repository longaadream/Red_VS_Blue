(function installExpressionInput(global) {
  'use strict'

  if (!global || !global.document) return

  const document = global.document
  const STYLE_ATTRIBUTE = 'data-expression-input-styles'

  /**
   * The host can copy this string into its own stylesheet.  mount() also
   * installs it once so the standalone preview remains usable without a
   * bundler or a second asset.
   */
  const CSS = `
.ei-root {
  position: relative;
  display: block;
  min-width: 0;
  color: #16202a;
  font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.ei-control {
  display: flex;
  align-items: stretch;
  gap: 8px;
  min-width: 0;
}
.ei-label {
  display: block;
  margin: 0 0 5px;
  color: #61707e;
  font-size: 12px;
  font-weight: 600;
}
.ei-editor {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 38px;
  padding: 8px 10px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid #c8d0d8;
  border-radius: 9px;
  background: #fff;
  color: #17212b;
  outline: none;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.ei-editor:focus {
  border-color: #4779a7;
  box-shadow: 0 0 0 3px rgb(71 121 167 / 16%);
}
.ei-editor:empty::before {
  color: #9aa8b4;
  content: attr(data-placeholder);
  pointer-events: none;
}
.ei-chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  margin: 0 1px;
  padding: 1px 6px;
  overflow: hidden;
  vertical-align: baseline;
  border: 1px solid #aac5dc;
  border-radius: 5px;
  background: #eaf3fb;
  color: #1f5c8f;
  cursor: text;
  font-size: 0.95em;
  line-height: 1.45;
  text-overflow: ellipsis;
  user-select: text;
  white-space: pre-wrap;
}
.ei-chip:hover,
.ei-chip.ei-chip-selected {
  border-color: #4779a7;
  background: #dbeafa;
  box-shadow: 0 0 0 2px rgb(71 121 167 / 14%);
}
.ei-expand {
  flex: 0 0 auto;
  align-self: stretch;
  min-width: 42px;
  padding: 0 10px;
  border: 1px solid #c8d0d8;
  border-radius: 9px;
  background: #f7f9fb;
  color: #365875;
  cursor: pointer;
  font: inherit;
}
.ei-expand:hover,
.ei-expand:focus-visible {
  border-color: #4779a7;
  background: #eef5fb;
  outline: none;
}
.ei-suggestions {
  box-sizing: border-box;
  position: fixed;
  z-index: 2147483000;
  display: none;
  min-width: 220px;
  max-width: min(420px, calc(100vw - 16px));
  max-height: min(320px, calc(100vh - 16px));
  overflow: auto;
  padding: 5px;
  border: 1px solid #c8d5e0;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 12px 32px rgb(23 33 43 / 18%), 0 2px 7px rgb(23 33 43 / 10%);
}
.ei-suggestions.ei-open {
  display: block;
}
.ei-parameter-hint {
  position: fixed;
  z-index: 2147482999;
  display: none;
  max-width: min(360px, calc(100vw - 16px));
  overflow: hidden;
  color: #8995a0;
  font-size: 12px;
  line-height: 18px;
  pointer-events: none;
  text-shadow: 0 0 1px rgb(255 255 255 / 70%);
  user-select: none;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ei-parameter-hint.ei-visible {
  display: block;
}
.ei-candidate {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #17212b;
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.ei-candidate:hover,
.ei-candidate.ei-active {
  background: #edf4fb;
}
.ei-candidate-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.ei-candidate-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ei-candidate-kind {
  flex: 0 0 auto;
  color: #738494;
  font-size: 11px;
}
.ei-candidate-value {
  display: block;
  overflow: hidden;
  color: #47708e;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ei-candidate-description {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  color: #71808d;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ei-empty {
  padding: 12px 10px;
  color: #7b8995;
  text-align: center;
}
@media (max-width: 520px) {
  .ei-control { gap: 5px; }
  .ei-expand { min-width: 38px; padding: 0 8px; }
  .ei-suggestions { min-width: 0; }
}
`

  let styleElement
  let mountedCount = 0

  function installStyles() {
    if (styleElement && styleElement.isConnected) return
    styleElement = document.querySelector(`style[${STYLE_ATTRIBUTE}]`)
    if (styleElement) return
    styleElement = document.createElement('style')
    styleElement.setAttribute(STYLE_ATTRIBUTE, '')
    styleElement.textContent = CSS
    ;(document.head || document.documentElement).appendChild(styleElement)
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value)
  }

  const FALLBACK_SYNTAX_FOLDS = Object.freeze({
    '．': '.', '（': '(', '）': ')', '［': '[', '］': ']', '｛': '{', '｝': '}',
    '，': ',', '：': ':', '；': ';', '！': '!', '＋': '+', '－': '-',
    '＊': '*', '／': '/', '＝': '=', '＆': '&', '｜': '|', '＜': '<', '＞': '>',
    '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
    '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  })

  function fallbackNormalizeSyntax(value) {
    const source = text(value)
    let result = ''
    let quote = ''
    let escaped = false
    const quoteClosers = { '"': '"', "'": "'", '＂': '＂', '“': '”', '‘': '’' }
    for (const character of source) {
      if (quote) {
        result += character
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === quote) quote = ''
        continue
      }
      if (quoteClosers[character]) {
        quote = quoteClosers[character]
        result += character
        continue
      }
      result += FALLBACK_SYNTAX_FOLDS[character] || character
    }
    return result
  }

  function normalizeSyntax(value) {
    const source = text(value)
    const normalize = global?.AuthoringSyntax?.normalize
    if (typeof normalize === 'function') {
      try {
        const normalized = text(normalize(source))
        if (normalized.length === source.length) return normalized
      } catch {
        // The standalone expression asset remains usable before the syntax
        // helper is loaded, or when a host supplies an incompatible helper.
      }
    }
    return fallbackNormalizeSyntax(source)
  }

  function normaliseCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return null
    const value = candidate.value === null || candidate.value === undefined ? '' : String(candidate.value)
    const label = candidate.label === null || candidate.label === undefined ? value : String(candidate.label)
    return {
      label,
      value,
      kind: candidate.kind === null || candidate.kind === undefined ? '' : String(candidate.kind),
      description: candidate.description === null || candidate.description === undefined ? '' : String(candidate.description),
      signature: candidate.signature === null || candidate.signature === undefined ? '' : String(candidate.signature),
    }
  }

  function candidateMatches(candidate, query) {
    const needle = normalizeSyntax(query).toLocaleLowerCase()
    if (!needle) return true
    return [candidate.label, candidate.value, candidate.signature, candidate.kind, candidate.description]
      .some(part => normalizeSyntax(part).toLocaleLowerCase().includes(needle))
  }

  function functionParts(candidate) {
    if (!candidate) return null
    const rawSignature = text(candidate.signature || candidate.value).trim()
    if (!/函数|方法|function/i.test(candidate.kind || '') && !/[（(]/u.test(rawSignature)) return null
    const signature = normalizeSyntax(rawSignature)
    const open = signature.indexOf('(')
    const close = signature.lastIndexOf(')')
    if (open <= 0 || close < open) return null
    const signatureName = signature.slice(0, open).trim()
    const labelName = normalizeSyntax(text(candidate.label).trim())
    // A member candidate may expose a friendly label such as “包含” while
    // its signature carries the receiver (“名单.包含(目标)”).  Keep the
    // qualified name exactly once so replacing the current token never
    // duplicates or drops the receiver.
    const name = signatureName.includes('.') ? signatureName : (labelName || signatureName)
    if (!name) return null
    return { signature, name, args: signature.slice(open + 1, close) }
  }

  function referenceText(candidate) {
    const parts = functionParts(candidate)
    return parts ? parts.signature : normalizeSyntax(candidate.value)
  }

  function isReferenceCandidate(candidate) {
    if (!candidate || !referenceText(candidate)) return false
    if (functionParts(candidate)) return true
    return !/^(函数|类型|取值|布尔|常量)$/u.test(candidate.kind || '')
  }

  function referenceBoundary(value, index) {
    if (index < 0 || index >= value.length) return true
    return /[\s()+\-*/!&|=<>%,;:.[\]{}'"`]/u.test(value[index])
  }

  function isChip(node) {
    return Boolean(node && node.nodeType === 1 && node.classList.contains('ei-chip'))
  }

  function serialise(node) {
    if (!node) return ''
    if (node.nodeType === 3) return node.nodeValue || ''
    if (node.nodeType !== 1 && node.nodeType !== 11) return ''
    // Chips are visual grouping only.  Their visible text is the source of
    // truth so local edits, IME composition, paste and undo cannot leave a
    // stale data-value behind.
    if (isChip(node)) return node.textContent || ''
    if (node.nodeName === 'BR') return '\n'
    let result = ''
    node.childNodes.forEach(child => { if(child.nodeType===1 && /^(DIV|P)$/.test(child.nodeName) && result && !result.endsWith('\n'))result+='\n'; result += serialise(child) })
    return result
  }

  function containsOrSelf(parent, node) {
    return parent === node || Boolean(parent && parent.contains && parent.contains(node))
  }

  function closestChip(node, root) {
    let current = node && node.nodeType === 3 ? node.parentNode : node
    while (current && current !== root) {
      if (isChip(current)) return current
      current = current.parentNode
    }
    return current && isChip(current) ? current : null
  }

  function selectionRange(root) {
    const selection = global.getSelection ? global.getSelection() : null
    if (!selection || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    if (!containsOrSelf(root, range.startContainer) || !containsOrSelf(root, range.endContainer)) return null
    return range
  }

  function setCaret(range) {
    const selection = global.getSelection ? global.getSelection() : null
    if (!selection) return
    selection.removeAllRanges()
    selection.addRange(range)
  }

  function collapseAfter(node) {
    const range = document.createRange()
    range.setStartAfter(node)
    range.collapse(true)
    setCaret(range)
  }

  function collapseAtEnd(root) {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    setCaret(range)
  }

  function prefixAtCaret(root, range) {
    if (!range || !range.collapsed) return ''
    const prefix=range.cloneRange();prefix.selectNodeContents(root);prefix.setEnd(range.startContainer,range.startOffset)
    return serialise(prefix.cloneContents())
  }

  function queryAtCaret(root, range) {
    const before=normalizeSyntax(prefixAtCaret(root,range))
    if(global.AuthoringTypes?.referenceQuery)return global.AuthoringTypes.referenceQuery(before)
    const match=before.match(/[\p{L}_][\p{L}\p{N}_.]*(?:\[\d+\][\p{L}\p{N}_.]*)*$/u)
    return match ? match[0] : ''
  }

  const REFERENCE_PATTERN = /[\p{L}_][\p{L}\p{N}_.]*(?:\[\d+\][\p{L}\p{N}_.]*)*/gu

  function referenceAtOffset(value, offset) {
    const source = text(value)
    const normalized = normalizeSyntax(source)
    const position = Math.max(0, Math.min(source.length, Number(offset) || 0))
    REFERENCE_PATTERN.lastIndex = 0
    for (const match of normalized.matchAll(REFERENCE_PATTERN)) {
      const start = match.index || 0
      const end = start + match[0].length
      // A browser caret at a character boundary can land on either side of
      // the character under the pointer.  Accept both sides, but never scan
      // an unrelated reference elsewhere in the editor.
      if (position >= start && position <= end) return { reference: match[0], start, end }
    }
    return null
  }

  function rangeFromPoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    if (typeof document.caretRangeFromPoint === 'function') {
      return document.caretRangeFromPoint(x, y)
    }
    if (typeof document.caretPositionFromPoint === 'function') {
      const position = document.caretPositionFromPoint(x, y)
      if (!position) return null
      const range = document.createRange()
      range.setStart(position.offsetNode, position.offset)
      range.collapse(true)
      return range
    }
    return null
  }

  function insertPlainText(root, value) {
    let range = selectionRange(root)
    if (!range) {
      range = document.createRange()
      range.selectNodeContents(root)
      range.collapse(false)
    }
    range.deleteContents()
    const node = document.createTextNode(text(value))
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    setCaret(range)
  }

  function mount(container, options) {
    if (!container || typeof container.appendChild !== 'function') throw new TypeError('ExpressionInput.mount 需要容器元素')
    const config = options && typeof options === 'object' ? options : {}
    installStyles()
    mountedCount += 1

    const root = document.createElement('div')
    root.className = 'ei-root'
    const label = text(config.label)
    if (label) {
      const labelElement = document.createElement('label')
      labelElement.className = 'ei-label'
      labelElement.textContent = label
      root.appendChild(labelElement)
    }

    const control = document.createElement('div')
    control.className = 'ei-control'
    const editor = document.createElement('div')
    editor.className = 'ei-editor'
    editor.contentEditable = 'true'
    editor.spellcheck = false
    editor.setAttribute('role', 'textbox')
    editor.setAttribute('aria-multiline', 'false')
    editor.setAttribute('aria-label', label || '表达式')
    editor.dataset.placeholder = config.placeholder || '输入表达式或选择变量'
    editor.textContent = text(config.value)

    const expand = document.createElement('button')
    expand.type = 'button'
    expand.className = 'ei-expand'
    expand.textContent = '展开'
    expand.setAttribute('aria-label', label ? `展开${label}` : '展开表达式编辑器')
    expand.title = '展开表达式编辑器'
    control.append(editor, expand)
    root.appendChild(control)
    container.appendChild(root)

    const panel = document.createElement('div')
    panel.className = 'ei-suggestions'
    panel.setAttribute('role', 'listbox')
    panel.setAttribute('aria-label', '表达式候选')
    const body = document.body || document.documentElement
    body.appendChild(panel)
    const hintElement = typeof config.getParameterHint === 'function' ? document.createElement('span') : null
    if (hintElement) {
      hintElement.className = 'ei-parameter-hint'
      hintElement.setAttribute('aria-hidden', 'true')
      hintElement.setAttribute('contenteditable', 'false')
      hintElement.tabIndex = -1
      hintElement.style.pointerEvents = 'none'
      body.appendChild(hintElement)
    }

    let destroyed = false
    let composing = false
    let compositionSettling = false
    let compositionEndTimer = null
    let panelOpen = false
    let hintVisible = false
    let hintRect = null
    let activeIndex = 0
    let candidates = []
    const knownReferences = new Set()
    let requestNumber = 0
    let anchorRect = null
    let savedRange = null
    let restoreNumber = 0

    function isComposing() {
      return composing || compositionSettling
    }

    function hideParameterHint() {
      hintVisible = false
      hintRect = null
      if (!hintElement) return
      hintElement.classList.remove('ei-visible')
      hintElement.style.display = 'none'
      hintElement.textContent = ''
      if (panelOpen && !destroyed) positionPanel()
    }

    function rememberSelection() {
      const range = selectionRange(editor)
      if (range && typeof range.cloneRange === 'function') savedRange = range.cloneRange()
    }

    function restoreSelection() {
      if (!savedRange || !containsOrSelf(editor, savedRange.startContainer) || !containsOrSelf(editor, savedRange.endContainer)) {
        return false
      }
      setCaret(savedRange.cloneRange())
      return true
    }

    function focusEditor() {
      editor.focus()
      if (!selectionRange(editor) && !restoreSelection()) collapseAtEnd(editor)
    }

    function createChip(candidate) {
      const parts = functionParts(candidate)
      const chip = document.createElement('span')
      chip.className = 'ei-chip'
      // Keep the span as a visual group while allowing the browser to edit
      // its text normally through the editor's inherited editing host.  Do
      // not add a nested contenteditable host: callers intentionally use the
      // editor's [contenteditable="true"] selector as a single target.
      // Do not mirror the source in data-value: that would make a later
      // character edit serialize an older reference.
      chip.dataset.kind = candidate.kind
      chip.title = candidate.description || candidate.value
      chip.textContent = parts ? parts.name : candidate.value
      knownReferences.add(referenceText(candidate))
      if (parts) knownReferences.add(parts.name)
      return chip
    }

    function candidateFragment(candidate) {
      const parts = functionParts(candidate)
      const fragment = document.createDocumentFragment()
      const chip = createChip(candidate)
      fragment.appendChild(chip)
      if (!parts) return { fragment, caretNode: chip, caretOffset: 1 }

      const opening = document.createTextNode('(')
      const argumentsNode = document.createTextNode(parts.args)
      const closing = document.createTextNode(')')
      fragment.append(opening, argumentsNode, closing)
      return {
        fragment,
        caretNode: parts.args ? argumentsNode : closing,
        caretOffset: 0,
      }
    }

    function restoreCandidateList(source) {
      const sequence = ++restoreNumber
      if (!source || typeof config.getSuggestions !== 'function') return
      let result
      try {
        result = config.getSuggestions('', { value: source, label, reason: 'restore' })
      } catch {
        return
      }

      const apply = items => {
        if (destroyed || isComposing() || sequence !== restoreNumber || value() !== source) return
        const seen = new Set()
        const references = (Array.isArray(items) ? items : [])
          .map(normaliseCandidate)
          .filter(candidate => {
            const match = referenceText(candidate)
            if (!isReferenceCandidate(candidate) || seen.has(match)) return false
            seen.add(match)
            return true
          })
          .sort((a, b) => referenceText(b).length - referenceText(a).length)
        if (!references.length) return
        references.forEach(candidate => {
          knownReferences.add(referenceText(candidate))
          const parts = functionParts(candidate)
          if (parts) knownReferences.add(parts.name)
        })

        const fragment = document.createDocumentFragment()
        const normalizedSource = normalizeSyntax(source)
        let plainStart = 0
        let index = 0
        let found = false
        while (index < source.length) {
          const candidate = references.find(item => {
            const match = referenceText(item)
            // Restoring a normal ASCII reference into a visual chip is safe
            // only when the source already uses the same spelling.  A
            // fullwidth expression is still user-authored text; recognizing
            // it for suggestions/inspection must not silently rewrite it.
            return source.slice(index, index + match.length) === match
              && normalizedSource.startsWith(match, index)
              && referenceBoundary(normalizedSource, index - 1)
              && referenceBoundary(normalizedSource, index + match.length)
          })
          if (!candidate) {
            index += 1
            continue
          }
          if (plainStart < index) fragment.appendChild(document.createTextNode(source.slice(plainStart, index)))
          const content = candidateFragment(candidate)
          fragment.appendChild(content.fragment)
          found = true
          index += referenceText(candidate).length
          plainStart = index
        }
        if (!found) return
        if (plainStart < source.length) fragment.appendChild(document.createTextNode(source.slice(plainStart)))
        editor.replaceChildren(fragment)
      }

      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then(apply).catch(() => {})
      } else {
        apply(result)
      }
    }

    function value() {
      return serialise(editor)
    }

    function normalizeMemberDots() {
      const source = value()
      const normalized = global.AuthoringSyntax?.normalizeMemberDots(source) ?? source
      if (normalized === source) return
      const selection = global.getSelection()
      const offsetOf = (node, offset) => {
        if (!containsOrSelf(editor, node)) return null
        const range = document.createRange()
        range.selectNodeContents(editor)
        range.setEnd(node, offset)
        return serialise(range.cloneContents()).length
      }
      const anchorOffset = offsetOf(selection?.anchorNode, selection?.anchorOffset || 0)
      const focusOffset = offsetOf(selection?.focusNode, selection?.focusOffset || 0)
      const walker = document.createTreeWalker(editor, 4)
      const nodes = []
      let node
      while ((node = walker.nextNode())) {
        const offset = offsetOf(node, 0)
        const next = normalized.slice(offset, offset + node.length)
        nodes.push(node)
        // Keep text nodes and chip wrappers; replacing the editing host would
        // discard native editing history and lose the caret inside a chip.
        if (node.data !== next) node.replaceData(0, node.length, next)
      }
      const positionAt = requested => {
        for (const item of nodes) {
          const offset = offsetOf(item, 0)
          if (requested >= offset && requested <= offset + item.length) return [item, requested - offset]
        }
        return [editor, editor.childNodes.length]
      }
      if (anchorOffset !== null && focusOffset !== null) {
        selection.setBaseAndExtent(...positionAt(anchorOffset), ...positionAt(focusOffset))
      }
    }

    function notify() {
      if (composing || destroyed) return
      if (typeof config.onChange !== 'function') return
      config.onChange(value())
    }

    function anchor() {
      const selection = global.getSelection()
      const range = selectionRange(editor)?.cloneRange()
      if (range) {
        // Anchor at the insertion caret, not the whole selection or input box.
        if (containsOrSelf(editor, selection?.focusNode)) range.setStart(selection.focusNode, selection.focusOffset)
        range.collapse(true)
        const rect = range.getClientRects()[0]
        if (rect?.height) return rect
        const node = range.startContainer, offset = range.startOffset
        if (node.nodeType === 3 && node.length) {
          const probe = range.cloneRange()
          probe.setStart(node, offset > 0 ? offset - 1 : 0)
          probe.setEnd(node, offset > 0 ? offset : 1)
          const boxes = probe.getClientRects(), box = boxes[boxes.length - 1]
          if (box?.height) return { left: offset > 0 ? box.right : box.left, top: box.top, bottom: box.bottom, height: box.height }
        } else if (node.nodeType === 1) {
          const next = node.childNodes[offset], previous = node.childNodes[offset - 1]
          const child = next || previous
          if (child) {
            const probe = document.createRange(); probe.selectNode(child)
            const boxes = probe.getClientRects(), box = next ? boxes[0] : boxes[boxes.length - 1]
            if (box?.height) return { left: next ? box.left : box.right, top: box.top, bottom: box.bottom, height: box.height }
          }
        }
      }
      // Empty input: use its text insertion origin rather than its bottom edge.
      const box = editor.getBoundingClientRect(), style = global.getComputedStyle(editor)
      const top = box.top + parseFloat(style.paddingTop || 0)
      anchorRect = { left: box.left + parseFloat(style.paddingLeft || 0), top, bottom: top + (parseFloat(style.lineHeight) || 22) }
      return anchorRect
    }

    function positionParameterHint() {
      if (!hintVisible || !hintElement || destroyed) return
      const rect = anchor()
      const viewportWidth = global.innerWidth || document.documentElement.clientWidth || 320
      const viewportHeight = global.innerHeight || document.documentElement.clientHeight || 480
      const measured = hintElement.getBoundingClientRect()
      const width = Math.min(measured.width || 180, Math.max(0, viewportWidth - 16))
      const height = measured.height || 18
      const lineHeight = Math.max(Number(rect?.height) || height, height)
      const range = selectionRange(editor)
      const caretOffset = range ? offsetAtRange(range) : 0
      const hasTrailingText = Boolean(range && value().slice(caretOffset).trim())
      const caretLeft = Number.isFinite(rect?.left) ? rect.left : 8
      const sameLineTop = (Number.isFinite(rect?.top) ? rect.top : 8) + Math.max(0, (lineHeight - height) / 2)
      const sameLineFits = !hasTrailingText
        && caretLeft >= 8
        && caretLeft + width <= viewportWidth - 8
        && sameLineTop >= 8
        && sameLineTop + height <= viewportHeight - 8
      const gap = 3
      let left = caretLeft
      let top = sameLineTop
      let below = false
      if (!sameLineFits) {
        left = Number.isFinite(rect?.left) ? rect.left : 8
        top = (Number.isFinite(rect?.bottom) ? rect.bottom : (Number.isFinite(rect?.top) ? rect.top : 8)) + gap
        below = true
      }
      left = Math.max(8, Math.min(left, Math.max(8, viewportWidth - width - 8)))
      if (top + height > viewportHeight - 8 && Number.isFinite(rect?.top) && rect.top - gap - height >= 8) {
        top = rect.top - gap - height
        below = false
      }
      top = Math.max(8, Math.min(top, Math.max(8, viewportHeight - height - 8)))
      hintElement.style.left = `${Math.round(left)}px`
      hintElement.style.top = `${Math.round(top)}px`
      hintRect = { left, top, right: left + width, bottom: top + height, below }
    }

    function updateParameterHint() {
      if (!hintElement || destroyed || isComposing() || document.activeElement !== editor) {
        hideParameterHint()
        return
      }
      const range = selectionRange(editor)
      if (!range || !range.collapsed) {
        hideParameterHint()
        return
      }
      let result = null
      try {
        result = config.getParameterHint({
          prefix: prefixAtCaret(editor, range),
          value: value(),
          label,
        })
      } catch {
        result = null
      }
      if (!result || typeof result !== 'object' || result.then || result.empty !== true) {
        hideParameterHint()
        return
      }
      const hintLabel = text(result.label).trim()
      const hintType = text(result.type).trim()
      if (!hintLabel && !hintType) {
        hideParameterHint()
        return
      }
      hintElement.textContent = hintLabel && hintType ? `${hintLabel} · ${hintType}` : (hintLabel || hintType)
      hintElement.classList.add('ei-visible')
      hintElement.style.display = 'block'
      hintVisible = true
      positionParameterHint()
      if (panelOpen) positionPanel()
    }

    function positionPanel() {
      if (!panelOpen || destroyed) return
      const rect = anchor()
      const viewportWidth = global.innerWidth || document.documentElement.clientWidth || 320
      const viewportHeight = global.innerHeight || document.documentElement.clientHeight || 480
      const width = Math.min(360, viewportWidth - 16)
      panel.style.width = `${width}px`
      const panelWidth = panel.getBoundingClientRect().width || width
      const panelHeight = panel.getBoundingClientRect().height || 160
      const gap = 6
      let left = rect.left
      if (left + panelWidth > viewportWidth - 8) left = viewportWidth - panelWidth - 8
      left = Math.max(8, left)
      let top = rect.bottom + gap
      if (hintVisible && hintRect?.below && hintRect.bottom > top) top = hintRect.bottom + gap
      if (top + panelHeight > viewportHeight - 8 && rect.top - gap - panelHeight >= 8) top = rect.top - gap - panelHeight
      top = Math.max(8, Math.min(top, viewportHeight - panelHeight - 8))
      panel.style.left = `${Math.round(left)}px`
      panel.style.top = `${Math.round(top)}px`
    }

    function closePanel() {
      panelOpen = false
      panel.classList.remove('ei-open')
      editor.removeAttribute('aria-expanded')
      editor.removeAttribute('aria-activedescendant')
      editor.querySelectorAll('.ei-chip-selected').forEach(chip => chip.classList.remove('ei-chip-selected'))
    }

    function renderPanel() {
      if (destroyed || !panelOpen) return
      panel.replaceChildren()
      if (candidates.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'ei-empty'
        empty.textContent = '没有匹配候选'
        panel.appendChild(empty)
        positionPanel()
        return
      }
      candidates.forEach((candidate, index) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'ei-candidate'
        button.id = `ei-candidate-${requestNumber}-${index}`
        button.dataset.index = String(index)
        button.setAttribute('role', 'option')
        button.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false')
        if (index === activeIndex) button.classList.add('ei-active')

        const main = document.createElement('span')
        main.className = 'ei-candidate-main'
        const labelElement = document.createElement('span')
        labelElement.className = 'ei-candidate-label'
        labelElement.textContent = candidate.label
        main.appendChild(labelElement)
        if (candidate.kind) {
          const kind = document.createElement('span')
          kind.className = 'ei-candidate-kind'
          kind.textContent = candidate.kind
          main.appendChild(kind)
        }
        button.appendChild(main)

        if (candidate.value && candidate.value !== candidate.label) {
          const candidateValue = document.createElement('span')
          candidateValue.className = 'ei-candidate-value'
          candidateValue.textContent = candidate.value
          button.appendChild(candidateValue)
        }
        if (candidate.description) {
          const description = document.createElement('span')
          description.className = 'ei-candidate-description'
          description.textContent = candidate.description
          button.appendChild(description)
        }
        button.addEventListener('pointerdown', event => {
          event.preventDefault()
          choose(index)
        })
        panel.appendChild(button)
      })
      editor.setAttribute('aria-expanded', 'true')
      const active = panel.children[activeIndex]
      if (active && active.id) editor.setAttribute('aria-activedescendant', active.id)
      positionPanel()
      const selected = panel.children[activeIndex]
      if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest' })
    }

    function readSuggestions(query) {
      if (destroyed || isComposing()) return
      const sequence = ++requestNumber
      let result
      try {
        result = typeof config.getSuggestions === 'function'
          ? config.getSuggestions(query, { value: value(), prefix: prefixAtCaret(editor, selectionRange(editor)), label, reason: 'input' })
          : []
      } catch {
        result = []
      }
      const applySuggestions = items => {
        if (destroyed || isComposing() || sequence !== requestNumber) return
        const list = Array.isArray(items) ? items : []
        const seen = new Set()
        candidates = list.map(normaliseCandidate).filter(item => {
          if (!item || seen.has(`${item.value}\u0000${item.label}`) || !candidateMatches(item, query)) return false
          seen.add(`${item.value}\u0000${item.label}`)
          if (isReferenceCandidate(item)) {
            knownReferences.add(referenceText(item))
            const parts = functionParts(item)
            if (parts) knownReferences.add(parts.name)
          }
          return true
        })
        activeIndex = 0
        renderPanel()
      }
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then(applySuggestions).catch(() => applySuggestions([]))
      } else {
        applySuggestions(result)
      }
    }

    function openPanel() {
      if (destroyed || isComposing()) return
      panelOpen = true
      anchor()
      panel.classList.add('ei-open')
      readSuggestions(queryAtCaret(editor, selectionRange(editor)))
      renderPanel()
    }

    function textSegments(root) {
      const segments = []
      let offset = 0
      const visit = node => {
        if (!node) return
        if (node.nodeType === 3) {
          const length = (node.nodeValue || '').length
          if (length) segments.push({ kind: 'text', node, start: offset, end: offset + length })
          offset += length
          return
        }
        // A chip is only a visual grouping.  Walk its real text nodes so a
        // candidate chosen while the caret is inside a chip can replace the
        // exact query and preserve both the prefix and suffix of that label.
        if (node.nodeType === 1 && node.nodeName === 'BR') {
          segments.push({ kind: 'break', node, start: offset, end: offset + 1 })
          offset += 1
          return
        }
        let serialisedChildren = ''
        node.childNodes?.forEach(child => {
          if (child.nodeType === 1 && /^(DIV|P)$/u.test(child.nodeName) && serialisedChildren && !serialisedChildren.endsWith('\n')) {
            // serialise() inserts a line break between block children.  Keep
            // that offset in sync so a later token replacement cannot drift
            // onto the adjacent line.
            segments.push({ kind: 'break', node: child, start: offset, end: offset + 1 })
            offset += 1
            serialisedChildren += '\n'
          }
          visit(child)
          serialisedChildren += serialise(child)
        })
      }
      visit(root)
      return { segments, length: offset }
    }

    function elementBoundary(node, after) {
      const parent = node?.parentNode
      if (!parent) return { node: editor, offset: editor.childNodes.length }
      const siblings = Array.from(parent.childNodes)
      const index = siblings.indexOf(node)
      return { node: parent, offset: Math.max(0, index + (after ? 1 : 0)) }
    }

    function pointAtTextOffset(root, requestedOffset, bias) {
      const { segments, length } = textSegments(root)
      const offset = Math.max(0, Math.min(length, Number(requestedOffset) || 0))
      for (const segment of segments) {
        const atEnd = offset === segment.end
        if (offset >= segment.start && (offset < segment.end || (atEnd && bias === 'end'))) {
          if (segment.kind === 'break') return elementBoundary(segment.node, false)
          return { node: segment.node, offset: offset - segment.start }
        }
      }
      const last = segments[segments.length - 1]
      if (last) {
        if (last.kind === 'text') return { node: last.node, offset: last.node.nodeValue?.length || 0 }
        return elementBoundary(last.node, true)
      }
      return { node: root, offset: root.childNodes.length }
    }

    function tokenRange(range) {
      const query = queryAtCaret(editor, range)
      if (!query) return range
      const prefix = range.cloneRange()
      prefix.selectNodeContents(editor)
      prefix.setEnd(range.startContainer, range.startOffset)
      const endOffset = serialise(prefix.cloneContents()).length
      const target = document.createRange()
      const start = pointAtTextOffset(editor, endOffset - query.length, 'start')
      const end = pointAtTextOffset(editor, endOffset, 'end')
      target.setStart(start.node, start.offset)
      target.setEnd(end.node, end.offset)
      return target
    }

    function unwrapChipAncestors(node) {
      // A candidate chosen inside an existing visual chip is inserted at the
      // exact text range, which can temporarily make the new chip a child of
      // the old one.  Drop only those old visual wrappers; moving their real
      // children keeps every character and the caret node intact.
      let parent = node?.parentNode
      while (parent && parent !== editor) {
        if (!isChip(parent)) {
          parent = parent.parentNode
          continue
        }
        const wrapper = parent
        const host = wrapper.parentNode
        if (!host) break
        while (wrapper.firstChild) {
          const child = wrapper.firstChild
          if (child.nodeType === 3 && !child.nodeValue) {
            wrapper.removeChild(child)
            continue
          }
          host.insertBefore(child, wrapper)
        }
        host.removeChild(wrapper)
        parent = host
      }
    }

    function qualifyMemberFunction(candidate, query) {
      const parts = functionParts(candidate)
      const normalizedQuery = normalizeSyntax(query)
      const dot = normalizedQuery.lastIndexOf('.')
      if (!parts || dot < 1) return candidate
      const receiver = normalizedQuery.slice(0, dot)
      const member = normalizedQuery.slice(dot + 1)
      const currentName = parts.name
      const currentMember = currentName.slice(currentName.lastIndexOf('.') + 1)
      if (currentMember !== member || currentName.includes('.')) return candidate
      const qualifiedName = `${receiver}.${currentName}`
      const qualifiedSignature = `${qualifiedName}(${parts.args})`
      return { ...candidate, label: qualifiedName, value: qualifiedSignature, signature: qualifiedSignature }
    }

    function insertCandidate(range, candidate, replaceCurrentToken) {
      const query = replaceCurrentToken ? queryAtCaret(editor, range) : ''
      const insertionCandidate = replaceCurrentToken ? qualifyMemberFunction(candidate, query) : candidate
      const target = replaceCurrentToken ? tokenRange(range) : range
      target.deleteContents()
      const content = candidateFragment(insertionCandidate)
      const insertedChip = content.fragment.querySelector?.('.ei-chip') || null
      target.insertNode(content.fragment)
      if (insertedChip) unwrapChipAncestors(insertedChip)
      if (functionParts(insertionCandidate)) {
        const caret = document.createRange()
        caret.setStart(content.caretNode, content.caretOffset)
        caret.collapse(true)
        setCaret(caret)
      } else {
        collapseAfter(content.caretNode)
      }
    }

    function choose(index) {
      if (destroyed || isComposing() || !candidates[index]) return
      const candidate = candidates[index]
      const current = selectionRange(editor) || (restoreSelection() ? selectionRange(editor) : null)
      focusEditor()
      let range = current && current.collapsed ? current : selectionRange(editor)
      if (!range) {
        range = document.createRange()
        range.selectNodeContents(editor)
        range.collapse(false)
      }
      insertCandidate(range, candidate, true)
      closePanel()
      rememberSelection()
      notify()
      updateParameterHint()
    }

    function moveActive(delta) {
      if (!panelOpen || candidates.length === 0) return false
      activeIndex = (activeIndex + delta + candidates.length) % candidates.length
      renderPanel()
      return true
    }

    function onFocus() {
      if (!selectionRange(editor)) restoreSelection()
      if (isComposing()) return
      updateParameterHint()
      if (!panelOpen) openPanel()
    }

    function onBlur() {
      rememberSelection()
      hideParameterHint()
      closePanel()
    }

    function onInput(event) {
      if (event?.isComposing) {
        if (!composing) onCompositionStart()
        return
      }
      if (isComposing()) return
      normalizeMemberDots()
      rememberSelection()
      notify()
      anchorRect = null
      updateParameterHint()
      if (panelOpen) {
        readSuggestions(queryAtCaret(editor, selectionRange(editor)))
      } else if (document.activeElement === editor) {
        openPanel()
      }
    }

    function onCompositionStart() {
      if (destroyed) return
      if (compositionEndTimer !== null) {
        global.clearTimeout(compositionEndTimer)
        compositionEndTimer = null
      }
      composing = true
      compositionSettling = false
      closePanel()
      hideParameterHint()
      config.onCompositionStart?.()
    }

    function onCompositionUpdate() {
      if (!composing) onCompositionStart()
      hideParameterHint()
    }

    function finishComposition() {
      compositionEndTimer = null
      if (destroyed || (!composing && !compositionSettling)) return
      composing = false
      compositionSettling = true
      try {
        normalizeMemberDots()
        rememberSelection()
        // Keep compositionSettling set while the host receives the final
        // value. Sentence editor render guards use isComposing() to defer
        // replacing this editing host until the value is fully committed.
        notify()
      } finally {
        compositionSettling = false
        config.onCompositionEnd?.()
      }
      if (destroyed) return
      anchorRect = null
      updateParameterHint()
      if (panelOpen) {
        readSuggestions(queryAtCaret(editor, selectionRange(editor)))
      } else if (document.activeElement === editor) {
        openPanel()
      }
    }

    function onCompositionEnd() {
      if (destroyed) return
      if (compositionEndTimer !== null) global.clearTimeout(compositionEndTimer)
      // Chromium can deliver the final composition input after compositionend.
      // Keep the widget in a settling state through that input and finalize on
      // the next task so it cannot trigger a replacement mid-composition.
      compositionEndTimer = global.setTimeout(finishComposition, 0)
    }

    function onKeyDown(event) {
      if (isComposing() || event.isComposing || event.keyCode === 229) return
      if (event.key === 'F10' && event.shiftKey) {
        const range = selectionRange(editor)
        if (inspectAtRange(range, null, null, true)) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      if (event.key === 'Escape') {
        if (panelOpen) {
          event.preventDefault()
          event.stopPropagation()
          closePanel()
        }
        return
      }
      if (!panelOpen) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveActive(1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveActive(-1)
      } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey)) && candidates.length) {
        event.preventDefault()
        choose(activeIndex)
      }
    }

    function onClick() {
      if (isComposing()) return
      // Let the browser place the caret inside the editable chip.  Treating
      // the visual group as an atomic replacement made a click followed by a
      // character edit unexpectedly replace the whole reference.
      anchorRect = null
      updateParameterHint()
      if (panelOpen) readSuggestions(queryAtCaret(editor, selectionRange(editor)))
    }

    function onPaste(event) {
      if (isComposing()) return
      const clipboard = event.clipboardData
      if (!clipboard) return
      event.preventDefault()
      insertPlainText(editor, clipboard.getData('text/plain'))
      normalizeMemberDots()
      rememberSelection()
      notify()
      anchorRect = null
      updateParameterHint()
      if (panelOpen) {
        readSuggestions(queryAtCaret(editor, selectionRange(editor)))
      }
    }

    function onDocumentPointerDown(event) {
      if (containsOrSelf(root, event.target) || containsOrSelf(panel, event.target)) return
      closePanel()
    }

    function onReposition() {
      if (hintVisible) positionParameterHint()
      if (panelOpen) {
        positionPanel()
      }
    }

    function onSelectionChange() {
      if (destroyed || isComposing() || document.activeElement !== editor || !selectionRange(editor)) return
      rememberSelection()
      anchorRect = null
      updateParameterHint()
      if (panelOpen) {
        readSuggestions(queryAtCaret(editor, selectionRange(editor)))
      }
    }

    function chipAtRange(range) {
      const direct = closestChip(range?.startContainer, editor)
      if (direct) return direct
      const node = range?.startContainer
      if (!node || node.nodeType !== 1) return null
      const children = node.childNodes || []
      const previous = children[range.startOffset - 1]
      const next = children[range.startOffset]
      return (previous && closestChip(previous, editor)) || (next && closestChip(next, editor))
    }

    function offsetAtRange(range) {
      if (!range) return 0
      const prefix = range.cloneRange()
      prefix.selectNodeContents(editor)
      prefix.setEnd(range.startContainer, range.startOffset)
      return serialise(prefix.cloneContents()).length
    }

    function isRecognisedReference(reference, fullValue, prefix) {
      const normalizedReference = normalizeSyntax(reference)
      if (knownReferences.has(normalizedReference)) return true
      if (typeof config.getSuggestions !== 'function') return false
      let result
      try {
        result = config.getSuggestions(normalizedReference, { value: fullValue, prefix, label, reason: 'inspect' })
      } catch {
        return false
      }
      // Inspection must decide whether to take over the native context menu
      // synchronously.  Async suggestion providers can still serve normal
      // completion, but cannot prove a pointer target before the event ends.
      if (result && typeof result.then === 'function') return false
      return (Array.isArray(result) ? result : [])
        .map(normaliseCandidate)
        .some(candidate => {
          if (!isReferenceCandidate(candidate)) return false
          const parts = functionParts(candidate)
          return referenceText(candidate) === normalizedReference
            || parts?.name === normalizedReference
            || normalizeSyntax(candidate.label) === normalizedReference
        })
    }

    function inspectAtRange(range, preferredChip, point, keyboard) {
      if (typeof config.onInspect !== 'function') return false
      if (range && (!range.collapsed || !containsOrSelf(editor, range.startContainer))) return false
      const fullValue = value()
      const chip = preferredChip || chipAtRange(range)
      let reference = ''
      let prefix = ''
      // A chip is a visual group, so it may contain ordinary text that the
      // user inserted after choosing a suggestion.  Resolve the reference at
      // the actual caret/pointer first; otherwise a right click anywhere in
      // `落点.x + 伤害量` would always inspect the whole chip.
      const pointInsideChip = chip && range && containsOrSelf(chip, range.startContainer)
      if (range && (!chip || pointInsideChip)) {
        const match = referenceAtOffset(fullValue, offsetAtRange(range))
        if (match) {
          reference = match.reference
          prefix = fullValue.slice(0, match.start)
        }
      }
      if (!reference && chip && containsOrSelf(editor, chip)) {
        // Keep direct inspection usable when the browser cannot provide a
        // caret range, but only accept a complete single-path chip.  A chip
        // containing operators or multiple references must be resolved by
        // its actual pointer/caret location above.
        const chipValue = text(chip.textContent)
        const whole = referenceAtOffset(chipValue, 0)
        if (!whole || whole.start !== 0 || whole.end !== chipValue.length) return false
        reference = whole.reference
        const before = document.createRange()
        before.selectNodeContents(editor)
        before.setEndBefore(chip)
        prefix = fullValue.slice(0, serialise(before.cloneContents()).length)
      }
      if (!reference) return false
      if (!isRecognisedReference(reference, fullValue, prefix)) return false

      let x = Number(point?.x)
      let y = Number(point?.y)
      if (keyboard || !Number.isFinite(x) || !Number.isFinite(y)) {
        const rect = range?.getBoundingClientRect?.() || anchor()
        x = Number.isFinite(rect?.left) ? rect.left : 0
        y = Number.isFinite(rect?.bottom) ? rect.bottom : (Number.isFinite(rect?.top) ? rect.top : 0)
      }
      closePanel()
      config.onInspect(reference, {
        x,
        y,
        prefix,
        value: fullValue,
        keyboard: Boolean(keyboard),
        origin: editor,
      })
      return true
    }

    function onContextMenu(event) {
      if (destroyed || typeof config.onInspect !== 'function') return
      const directChip = closestChip(event.target, editor)
      const point = { x: Number(event.clientX), y: Number(event.clientY) }
      let range = rangeFromPoint(point.x, point.y)
      if (range && !containsOrSelf(editor, range.startContainer)) range = null
      if (!directChip && !range) return
      if (!inspectAtRange(range, directChip, point, false)) return
      event.preventDefault()
      event.stopPropagation()
    }

    editor.addEventListener('focus', onFocus)
    editor.addEventListener('blur', onBlur)
    editor.addEventListener('input', onInput)
    editor.addEventListener('keydown', onKeyDown)
    editor.addEventListener('click', onClick)
    editor.addEventListener('paste', onPaste)
    editor.addEventListener('compositionstart', onCompositionStart)
    editor.addEventListener('compositionupdate', onCompositionUpdate)
    editor.addEventListener('compositionend', onCompositionEnd)
    editor.addEventListener('contextmenu', onContextMenu)
    expand.addEventListener('click', () => {
      closePanel()
      if (typeof config.onExpand === 'function') config.onExpand(value())
    })
    document.addEventListener('pointerdown', onDocumentPointerDown)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('transitionend', onReposition, true)
    document.addEventListener('animationend', onReposition, true)
    global.addEventListener('resize', onReposition)
    global.addEventListener('scroll', onReposition, true)

    restoreCandidateList(value())

    function setValue(nextValue) {
      if (destroyed || isComposing()) return
      const next = text(nextValue)
      if (value() === next) return
      closePanel()
      editor.replaceChildren(document.createTextNode(next))
      savedRange = null
      restoreCandidateList(next)
      updateParameterHint()
    }

    function insertText(nextValue) {
      if (destroyed || isComposing()) return
      const inserted = text(nextValue)
      if (!inserted) return
      focusEditor()
      insertPlainText(editor, inserted)
      normalizeMemberDots()
      rememberSelection()
      notify()
      anchorRect = null
      updateParameterHint()
      if (panelOpen) {
        readSuggestions(queryAtCaret(editor, selectionRange(editor)))
      }
    }

    function destroy() {
      if (destroyed) return
      destroyed = true
      if (compositionEndTimer !== null) {
        global.clearTimeout(compositionEndTimer)
        compositionEndTimer = null
      }
      composing = false
      compositionSettling = false
      hideParameterHint()
      document.removeEventListener('pointerdown', onDocumentPointerDown)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('transitionend', onReposition, true)
      document.removeEventListener('animationend', onReposition, true)
      global.removeEventListener('resize', onReposition)
      global.removeEventListener('scroll', onReposition, true)
      editor.removeEventListener('focus', onFocus)
      editor.removeEventListener('blur', onBlur)
      editor.removeEventListener('input', onInput)
      editor.removeEventListener('keydown', onKeyDown)
      editor.removeEventListener('click', onClick)
      editor.removeEventListener('paste', onPaste)
      editor.removeEventListener('compositionstart', onCompositionStart)
      editor.removeEventListener('compositionupdate', onCompositionUpdate)
      editor.removeEventListener('compositionend', onCompositionEnd)
      editor.removeEventListener('contextmenu', onContextMenu)
      expand.replaceWith(expand.cloneNode(true))
      panel.remove()
      hintElement?.remove()
      root.remove()
      mountedCount = Math.max(0, mountedCount - 1)
    }

    function focus() {
      if (destroyed) return
      focusEditor()
      if (!panelOpen) openPanel()
    }

    return { setValue, destroy, focus, insertText, getText: value, isComposing }
  }

  global.ExpressionInput = {
    mount,
    css: CSS,
    getCSS: () => CSS,
    classes: Object.freeze({
      root: 'ei-root', editor: 'ei-editor', chip: 'ei-chip',
      suggestions: 'ei-suggestions', candidate: 'ei-candidate', expand: 'ei-expand',
      parameterHint: 'ei-parameter-hint',
    }),
  }
})(typeof window !== 'undefined' ? window : undefined)
