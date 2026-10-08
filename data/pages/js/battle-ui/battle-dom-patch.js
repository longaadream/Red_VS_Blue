;(function (root) {
  'use strict'

  // Small keyed DOM reconciler for the battle HUD. It deliberately preserves
  // the keyed root element, so browser focus and any imperative listeners on
  // that element survive ordinary state updates.
  function childrenOf(container) {
    return container && container.children ? Array.prototype.slice.call(container.children) : []
  }

  function defaultParse(html, doc) {
    if (!doc || !doc.createElement) return null
    const template = doc.createElement('template')
    template.innerHTML = String(html == null ? '' : html).trim()
    return template.content && template.content.firstElementChild
      ? template.content.firstElementChild
      : template.firstElementChild || null
  }

  function focusPath(element, rootElement) {
    if (!element || !rootElement || element === rootElement) return []
    const path = []
    let current = element
    while (current && current !== rootElement) {
      const parent = current.parentElement
      if (!parent) return []
      path.unshift(Array.prototype.indexOf.call(parent.children || [], current))
      current = parent
    }
    return current === rootElement ? path : []
  }

  function focusAtPath(rootElement, path) {
    let current = rootElement
    for (let index = 0; current && index < path.length; index += 1) {
      current = current.children && current.children[path[index]]
    }
    if (current && typeof current.focus === 'function') {
      try { current.focus({ preventScroll: true }) } catch { current.focus() }
    }
  }

  function copyAttributes(target, source) {
    if (!target || !source) return
    const sourceNames = new Set()
    Array.prototype.slice.call(source.attributes || []).forEach(function (attribute) {
      sourceNames.add(attribute.name)
      if (target.getAttribute(attribute.name) !== attribute.value) target.setAttribute(attribute.name, attribute.value)
    })
    Array.prototype.slice.call(target.attributes || []).forEach(function (attribute) {
      if (!sourceNames.has(attribute.name)) target.removeAttribute(attribute.name)
    })
  }

  function updateExisting(target, fresh, doc, focusState) {
    const active = doc && doc.activeElement
    const activeRoot = active && target.contains && target.contains(active) ? target : null
    const path = activeRoot ? focusPath(active, target) : []
    if (activeRoot && focusState) focusState.value = { node: target, path: path }
    copyAttributes(target, fresh)
    const nextHTML = fresh.innerHTML || ''
    if ('innerHTML' in target && target.innerHTML !== nextHTML) target.innerHTML = nextHTML
    return target
  }

  function patchKeyed(container, entries, options) {
    if (!container) return container
    const input = options || {}
    const keyOf = typeof input.keyOf === 'function'
      ? input.keyOf
      : function (node) { return node && node.dataset ? node.dataset[input.datasetKey || 'key'] : null }
    const parse = typeof input.parse === 'function'
      ? input.parse
      : function (html) { return defaultParse(html, container.ownerDocument || root.document) }
    const current = new Map()
    childrenOf(container).forEach(function (node) {
      const key = keyOf(node)
      if (key != null && !current.has(String(key))) current.set(String(key), node)
    })
    const used = new Set()
    const list = Array.isArray(entries) ? entries : []
    const desiredNodes = []
    const focusState = { value: null }

    list.forEach(function (entry, index) {
      const key = String(entry && entry.key != null ? entry.key : index)
      if (used.has(key)) return
      used.add(key)
      const fresh = parse(entry && entry.html != null ? entry.html : '', container.ownerDocument || root.document)
      if (!fresh) return
      const existing = current.get(key)
      const node = existing && existing.tagName === fresh.tagName
        ? updateExisting(existing, fresh, container.ownerDocument || root.document, focusState)
        : fresh
      desiredNodes.push(node)
    })

    // Hosts in this module are entirely keyed collections. Removing every
    // direct child outside the desired set prevents old unkeyed placeholders
    // or an earlier empty-state node from surviving the next render.
    childrenOf(container).forEach(function (node) {
      if (desiredNodes.indexOf(node) === -1) container.removeChild(node)
    })
    desiredNodes.forEach(function (node, index) {
      const currentNode = childrenOf(container)[index]
      if (currentNode !== node) container.insertBefore(node, currentNode || null)
    })
    const focused = focusState.value
    if (focused && desiredNodes.indexOf(focused.node) !== -1) {
      if (focused.path.length) focusAtPath(focused.node, focused.path)
      else if (typeof focused.node.focus === 'function') {
        try { focused.node.focus({ preventScroll: true }) } catch { focused.node.focus() }
      }
    }
    return container
  }

  root.BattleDomPatch = Object.freeze({ patchKeyed: patchKeyed })
})(typeof window !== 'undefined' ? window : globalThis)
