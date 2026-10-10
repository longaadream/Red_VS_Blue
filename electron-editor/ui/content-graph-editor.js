/* Structured content-graph editor. It edits graph data only; authored code is never executed here. */
(() => {
  const GRAPH_VERSION = 'rvb-content-graph/v1'
  const NODE_KINDS = [
    ['bind', '绑定输入'],
    ['call', '调用能力'],
    ['branch', '条件分支'],
    ['set', '设置值'],
    ['loop', '循环子流程'],
    ['invoke', '调用子流程'],
    ['delete', '删除属性'],
    ['try', '异常处理子流程'],
    ['throw', '抛出异常'],
    ['materializeSource', '创建独立卡牌或续接子图'],
    ['return', '返回结果'],
  ]
  const CONTENT_KINDS = ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview']
  const clone = value => JSON.parse(JSON.stringify(value))
  const text = (tag, value, className) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (value !== undefined) node.textContent = value
    return node
  }
  const svg = (tag, attrs) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value))
    return node
  }
  const record = value => value && typeof value === 'object' && !Array.isArray(value)

  function graphKind(category, graph, field = '') {
    if (typeof graph?.surface === 'string' && CONTENT_KINDS.includes(graph.surface)) return graph.surface
    if (field === 'previewCode') return 'preview'
    return category === 'rules' ? 'rule' : category === 'cards' ? 'card' : 'skill'
  }

  function defaultGraph(category, core, field = '') {
    if (typeof core?.createContentGraph === 'function') {
      const generated = core.createContentGraph(graphKind(category, null, field))
      if (generated) return generated
    }
    const first = { id: 'bind-1', kind: 'bind', name: 'value', expr: { kind: 'literal', value: null }, next: 'return-1', x: 40, y: 70 }
    const last = { id: 'return-1', kind: 'return', x: 350, y: 70 }
    return { version: GRAPH_VERSION, surface: graphKind(category, null, field), entry: first.id, nodes: [first, last] }
  }

  function primaryFieldOf(draft, fallback) {
    return typeof draft?.contentGraphField === 'string' && draft.contentGraphField.length > 0
      ? draft.contentGraphField
      : fallback
  }

  function graphFieldsOf(draft, fallback) {
    const primary = primaryFieldOf(draft, fallback)
    const fields = [fallback]
    if (primary !== fallback) fields.push(primary)
    if (Object.hasOwn(draft || {}, 'previewCode') || Object.hasOwn(draft?.contentGraphEntries || {}, 'previewCode')) fields.push('previewCode')
    return [...new Set(fields)]
  }

  function defaultNode(kind, id, next) {
    if (kind === 'bind') return { id, kind, name: `value${id.replace(/[^0-9]/g, '') || ''}`, expr: { kind: 'literal', value: null }, next }
    if (kind === 'call') return { id, kind, capability: 'flow.event.block', args: [], next }
    if (kind === 'branch') return { id, kind, condition: { kind: 'literal', value: true }, yes: next, no: next }
    if (kind === 'set') return { id, kind, target: { kind: 'ref', name: 'value' }, operator: '+=', value: { kind: 'literal', value: 1 }, next }
    if (kind === 'loop') return { id, kind, loop: 'while', condition: { kind: 'literal', value: false }, body: { entry: `${id}-end`, end: `${id}-end`, nodes: [{ id: `${id}-end`, kind: 'regionEnd' }] }, next }
    if (kind === 'invoke') return { id, kind, target: { kind: 'function', value: { kind: 'function', parameters: [], body: { entry: `${id}-end`, end: `${id}-end`, nodes: [{ id: `${id}-end`, kind: 'regionEnd' }] } } }, args: [], next }
    if (kind === 'delete') return { id, kind, target: { kind: 'get', object: { kind: 'object', entries: [] }, key: 'value' }, next }
    if (kind === 'try') return { id, kind, body: { entry: `${id}-end`, end: `${id}-end`, nodes: [{ id: `${id}-end`, kind: 'regionEnd' }] }, finally: { entry: `${id}-finally-end`, end: `${id}-finally-end`, nodes: [{ id: `${id}-finally-end`, kind: 'regionEnd' }] }, next }
    if (kind === 'throw') return { id, kind, value: { kind: 'literal', value: '流程异常' } }
    if (kind === 'materializeSource') return { id, kind, graph: { version: GRAPH_VERSION, surface: 'card', entry: 'return', nodes: [{ id: 'return', kind: 'return' }] }, bindings: {}, result: `source${id.replace(/[^0-9]/g, '') || ''}`, next }
    return { id, kind }
  }

  function edgeTargets(node) {
    const edges = []
    for (const port of ['next', 'yes', 'no']) if (typeof node?.[port] === 'string' && node[port]) edges.push({ port, id: node[port] })
    if (Array.isArray(node?.branches)) node.branches.forEach((branch, index) => {
      if (typeof branch === 'string') edges.push({ port: `branch-${index + 1}`, id: branch })
      else if (record(branch) && typeof branch.next === 'string') edges.push({ port: branch.label || `branch-${index + 1}`, id: branch.next })
    })
    return edges
  }

  function nodeLabel(node) {
    return NODE_KINDS.find(([kind]) => kind === node?.kind)?.[1] || String(node?.kind || '节点')
  }

  function graphError(core, draft) {
    if (!core || typeof core.assertContentGraphArtifact !== 'function') return ''
    try { core.assertContentGraphArtifact(draft); return '' } catch (error) { return error instanceof Error ? error.message : String(error) }
  }

  window.ContentGraphEditor = {
    mount(container, options = {}) {
      const getDraft = typeof options.getDraft === 'function' ? options.getDraft : () => ({})
      const onChange = typeof options.onChange === 'function' ? options.onChange : () => {}
      const category = options.category || 'skills'
      const initialField = options.field || 'code'
      const core = () => window.ContentGraphCore || null
      let selected = null
      let selectedField = initialField
      let message = ''
      let locked = false
      let destroyed = false
      let drag = null
      const editingLocked = () => locked || Boolean(container.closest('[data-saving="true"]'))

      const normalizeSelectedField = draft => {
        const fields = graphFieldsOf(draft, initialField)
        if (!fields.includes(selectedField)) selectedField = fields[0]
        return fields
      }

      const currentGraph = () => {
        const draft = getDraft()
        normalizeSelectedField(draft)
        const primary = primaryFieldOf(draft, initialField)
        if (selectedField === primary) return record(draft?.contentGraph) ? draft.contentGraph : null
        const entry = draft?.contentGraphEntries?.[selectedField]
        return record(entry?.graph) ? entry.graph : null
      }

      const setDraftGraph = graph => {
        if (editingLocked()) return
        const draft = getDraft()
        const primary = primaryFieldOf(draft, initialField)
        const graphDraft = selectedField === primary
          ? { ...clone(draft), contentGraph: graph }
          : {
              ...clone(draft),
              contentGraphEntries: {
                ...(draft.contentGraphEntries || {}),
                [selectedField]: {
                  ...(draft.contentGraphEntries?.[selectedField] || {}),
                  graph,
                },
              },
            }
        try {
          const compiler = core()
          if (typeof compiler?.applyContentGraph === 'function') {
            // An incomplete edit deliberately leaves stale generated code in the
            // draft. Repair only this entry before validating the full document;
            // all other entries still have to match their own generated code.
            const compiled = compiler.compileContentGraph(graph)
            graphDraft[selectedField] = compiled.code
            if (selectedField === primary) graphDraft.contentGraphCompilerVersion = compiled.compilerVersion
            else graphDraft.contentGraphEntries[selectedField].compilerVersion = compiled.compilerVersion
            onChange(compiler.applyContentGraph(graphDraft, graph, selectedField))
            message = '已生成内容代码；保存时会再次校验图与产物。'
          } else {
            if (selectedField === primaryFieldOf(draft, initialField)) onChange(graphDraft)
            else onChange({
              ...clone(draft),
              contentGraphEntries: {
                ...(draft.contentGraphEntries || {}),
                [selectedField]: { graph },
              },
            })
            message = '已更新结构化流程图；编译器尚未加载。'
          }
        } catch (error) {
          // Keep an incomplete draft visible so the editor can repair it. The save boundary
          // rejects it while generated fields do not match, so stale code is never persisted.
          onChange(graphDraft)
          message = error instanceof Error ? error.message : String(error)
        }
        render()
      }

      const updateNode = (id, update) => {
        const graph = currentGraph()
        if (!graph || !Array.isArray(graph.nodes)) return
        const next = clone(graph), node = next.nodes.find(item => item.id === id)
        if (!node) return
        update(node, next)
        setDraftGraph(next)
      }

      const addNode = kind => {
        const graph = currentGraph()
        if (!graph) return
        const next = clone(graph), prefix = `${kind}-`, used = new Set(next.nodes.map(node => node.id))
        let index = 1
        while (used.has(prefix + index)) index++
        const id = prefix + index
        const previous = next.nodes.at(-1)
        const terminal = next.nodes.find(item => item.kind === 'return')
        const predecessor = terminal ? next.nodes.find(item => item.next === terminal.id) : previous
        const fallbackNext = terminal?.id || id
        let node = { ...defaultNode(kind, id, previous?.kind === 'branch' ? undefined : fallbackNext), x: 40 + (next.nodes.length % 3) * 300, y: 70 + Math.floor(next.nodes.length / 3) * 150 }
        if (kind === 'branch') {
          const firstReturn = next.nodes.find(item => item.kind === 'return')
          let secondReturn = next.nodes.find(item => item.kind === 'return' && item !== firstReturn)
          if (!firstReturn) {
            next.nodes.push({ id: `${id}-yes`, kind: 'return', x: node.x + 300, y: node.y - 55 })
          }
          const yesTarget = firstReturn || next.nodes.at(-1)
          if (!secondReturn) {
            secondReturn = { id: `${id}-no`, kind: 'return', x: node.x + 300, y: node.y + 95 }
            next.nodes.push(secondReturn)
          }
          node = { ...node, yes: yesTarget.id, no: secondReturn.id }
        }
        const linkFrom = predecessor && predecessor.kind !== 'return' && predecessor.kind !== 'branch' ? predecessor : previous
        if (linkFrom && linkFrom.kind !== 'return' && linkFrom.kind !== 'branch') linkFrom.next = id
        next.nodes.push(node)
        if (!next.entry) next.entry = id
        selected = id
        setDraftGraph(next)
      }

      const removeNode = id => {
        const graph = currentGraph()
        if (!graph || id === graph.entry) return
        const next = clone(graph)
        next.nodes = next.nodes.filter(node => node.id !== id)
        for (const node of next.nodes) {
          for (const port of ['next', 'yes', 'no']) if (node[port] === id) delete node[port]
          if (Array.isArray(node.branches)) node.branches = node.branches.filter(branch => (typeof branch === 'string' ? branch : branch?.next) !== id)
        }
        selected = null
        setDraftGraph(next)
      }

      const cancelDrag = () => {
        if (!drag) return
        document.removeEventListener('pointermove', drag.move)
        document.removeEventListener('pointerup', drag.up)
        drag = null
      }

      const finishDrag = () => {
        if (!drag) return
        const active = drag
        cancelDrag()
        if (!active.moved || editingLocked()) {
          render()
          return
        }
        const graph = currentGraph()
        if (!graph || !Array.isArray(graph.nodes)) return
        const next = clone(graph)
        const node = next.nodes.find(item => item.id === active.id)
        if (!node) return
        node.x = active.x
        node.y = active.y
        setDraftGraph(next)
      }

      const select = (label, values, current, change) => {
        const wrapper = text('label', label)
        const control = document.createElement('select')
        for (const [value, name] of values) { const option = text('option', name); option.value = value; control.append(option) }
        control.value = current ?? ''
        control.onchange = () => { if (!editingLocked()) change(control.value) }
        wrapper.append(control)
        return wrapper
      }

      function render() {
        if (destroyed) return
        container.replaceChildren()
        container.className = 'content-graph-editor'
        const fields = normalizeSelectedField(getDraft())
        const title = text('p', `内容流程图 · ${category}/${selectedField}`, 'content-graph-help')
        title.append(text('span', ' 图只编辑结构化节点参数；生成的代码由可信编译器写入，编辑器不会执行 JavaScript。'))
        container.append(title)

        const toolbar = text('div', undefined, 'content-graph-toolbar')
        const graph = currentGraph()
        const fieldSelect = document.createElement('select')
        fieldSelect.setAttribute('aria-label', '流程图入口')
        for (const graphField of fields) {
          const option = text('option', (graphField === 'previewCode' ? '预览入口 · ' : '主入口 · ') + graphField)
          option.value = graphField
          fieldSelect.append(option)
        }
        fieldSelect.value = selectedField
        fieldSelect.disabled = editingLocked()
        fieldSelect.onchange = () => {
          if (editingLocked()) return
          selectedField = fieldSelect.value
          selected = null
          message = ''
          render()
        }
        const addKind = document.createElement('select'); addKind.setAttribute('aria-label', '新增节点类型')
        for (const [kind, label] of NODE_KINDS) { const option = text('option', label); option.value = kind; addKind.append(option) }
        const button = (label, action, className = 'content-graph-button') => {
          const control = text('button', label, className); control.type = 'button'; control.disabled = editingLocked(); control.onclick = () => { if (!editingLocked()) action() }; return control
        }
        toolbar.append(fieldSelect, addKind, button('新增节点', () => addNode(addKind.value)))
        if (!graph) {
          toolbar.append(button('建立流程图', () => { const next = defaultGraph(category, core(), selectedField); selected = next.entry; setDraftGraph(next) }))
          container.append(toolbar, text('p', '这个内容尚未建立流程图。建立后可以从绑定、调用、设置、分支和返回节点组合出受支持的结构。', 'content-graph-empty'))
          return
        }
        toolbar.append(button('自动排列', () => {
          const next = clone(graph)
          next.nodes.forEach((node, index) => { node.x = 35 + (index % 3) * 300; node.y = 55 + Math.floor(index / 3) * 145 })
          setDraftGraph(next)
        }), button('重新生成', () => setDraftGraph(clone(graph))))
        const clear = button('解除当前入口图，保留生成字段', () => {
          const draft = clone(getDraft())
          const primary = primaryFieldOf(draft, initialField)
          if (selectedField === primary) {
            const previewEntry = draft.contentGraphEntries?.previewCode
            if (primary !== 'previewCode' && record(previewEntry?.graph)) {
              draft.contentGraph = clone(previewEntry.graph)
              draft.contentGraphField = 'previewCode'
              draft.contentGraphCompilerVersion = previewEntry.compilerVersion
              delete draft.contentGraphEntries.previewCode
              if (!Object.keys(draft.contentGraphEntries).length) delete draft.contentGraphEntries
            } else {
              delete draft.contentGraph
              delete draft.contentGraphField
              delete draft.contentGraphCompilerVersion
              selectedField = initialField
            }
          } else if (draft.contentGraphEntries) {
            delete draft.contentGraphEntries[selectedField]
            if (!Object.keys(draft.contentGraphEntries).length) delete draft.contentGraphEntries
          }
          onChange(draft); message = ''; render()
        })
        toolbar.append(clear)
        container.append(toolbar)

        const error = graphError(core(), getDraft())
        const notice = text('p', message || error || '图已载入。选择节点后编辑结构化参数。', error ? 'content-graph-error' : 'content-graph-notice')
        notice.setAttribute('role', 'status'); container.append(notice)

        if (!Array.isArray(graph.nodes) || !graph.nodes.length) {
          container.append(text('p', '节点列表为空，请新增节点或恢复有效图。', 'content-graph-error'))
          return
        }
        const nodes = graph.nodes.filter(record)
        const byId = new Map(nodes.map(node => [node.id, node]))
        const width = Math.max(700, ...nodes.map(node => Number.isFinite(node.x) ? node.x + 250 : 700))
        const height = Math.max(380, ...nodes.map(node => Number.isFinite(node.y) ? node.y + 130 : 380))
        const layout = text('div', undefined, 'content-graph-layout')
        const viewport = text('div', undefined, 'content-graph-viewport')
        const canvas = text('div', undefined, 'content-graph-canvas'); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`
        const wires = svg('svg', { width, height, class: 'content-graph-wires', 'aria-hidden': 'true' })
        for (const node of nodes) for (const edge of edgeTargets(node)) {
          const target = byId.get(edge.id); if (!target) continue
          const x1 = (Number.isFinite(node.x) ? node.x : 0) + 230, y1 = (Number.isFinite(node.y) ? node.y : 0) + 43
          const x2 = Number.isFinite(target.x) ? target.x : 0, y2 = (Number.isFinite(target.y) ? target.y : 0) + 43
          wires.append(svg('path', { d: `M${x1},${y1} C${x1 + 55},${y1} ${x2 - 55},${y2} ${x2},${y2}`, class: `content-graph-wire ${edge.port === 'yes' ? 'yes' : edge.port === 'no' ? 'no' : ''}` }))
          const label = svg('text', { x: x1 + 8, y: y1 - 6 }); label.textContent = edge.port === 'next' ? '→' : `${edge.port} →`; wires.append(label)
        }
        canvas.append(wires)
        for (const node of nodes) {
          const card = button('', () => { selected = node.id; render() }, 'content-graph-node')
          card.classList.toggle('selected', selected === node.id); card.dataset.contentGraphNode = node.id
          card.style.left = `${Number.isFinite(node.x) ? node.x : 0}px`; card.style.top = `${Number.isFinite(node.y) ? node.y : 0}px`
          card.onpointerdown = event => {
            if (event.button !== 0 || editingLocked()) return
            event.preventDefault()
            selected = node.id
            const startX = event.clientX
            const startY = event.clientY
            const originX = Number.isFinite(node.x) ? node.x : 0
            const originY = Number.isFinite(node.y) ? node.y : 0
            const move = moveEvent => {
              if (!drag || drag.id !== node.id || editingLocked()) return
              drag.x = Math.max(0, originX + moveEvent.clientX - startX)
              drag.y = Math.max(0, originY + moveEvent.clientY - startY)
              drag.moved = drag.moved || drag.x !== originX || drag.y !== originY
              card.style.left = drag.x + 'px'
              card.style.top = drag.y + 'px'
            }
            const up = upEvent => {
              if (!drag || drag.id !== node.id || upEvent.pointerId !== event.pointerId) return
              finishDrag()
            }
            cancelDrag()
            drag = { id: node.id, x: originX, y: originY, moved: false, move, up }
            document.addEventListener('pointermove', move)
            document.addEventListener('pointerup', up)
          }
          const details = Object.keys(node).filter(key => !['id', 'kind', 'x', 'y'].includes(key)).slice(0, 3)
          card.append(text('strong', nodeLabel(node)), text('code', node.id), text('span', details.join(' · ') || '无参数'))
          canvas.append(card)
        }
        viewport.append(canvas); layout.append(viewport)

        const inspector = text('aside', undefined, 'content-graph-inspector')
        const current = nodes.find(node => node.id === selected) || nodes[0]
        selected = current.id
        inspector.append(text('h3', `${nodeLabel(current)} · ${current.id}`))
        const graphKindSelect = select('内容入口', CONTENT_KINDS.map(kind => [kind, kind]), graphKind(category, graph, selectedField), value => { const next = clone(graph); next.surface = value; setDraftGraph(next) })
        inspector.append(graphKindSelect)
        const paramsLabel = text('label', '结构化参数 JSON', 'content-graph-params-label')
        const editable = clone(current); delete editable.id; delete editable.kind; delete editable.x; delete editable.y
        const params = document.createElement('textarea'); params.rows = 12; params.spellcheck = false; params.value = JSON.stringify(editable, null, 2); params.setAttribute('aria-label', '结构化节点参数 JSON')
        params.onchange = () => {
          if (editingLocked()) return
          try {
            const value = JSON.parse(params.value)
            if (!record(value)) throw new Error('参数必须是 JSON 对象')
            updateNode(current.id, (node) => {
              for (const key of Object.keys(node)) if (!['id', 'kind', 'x', 'y'].includes(key)) delete node[key]
              Object.assign(node, value)
            })
          } catch (error) { message = error instanceof Error ? error.message : String(error); render() }
        }
        paramsLabel.append(params); inspector.append(paramsLabel)
        const ports = current.kind === 'branch' ? ['yes', 'no'] : ['return', 'throw'].includes(current.kind) ? [] : ['next']
        const choices = [['', '未连接'], ...nodes.filter(node => node.id !== current.id).map(node => [node.id, `${nodeLabel(node)} · ${node.id}`])]
        for (const port of ports) inspector.append(select(port === 'next' ? '下一步 →' : `${port} →`, choices, current[port], value => updateNode(current.id, (node) => { if (value) node[port] = value; else delete node[port] })))
        if (current.kind !== 'return' && current.id !== graph.entry) inspector.append(button('删除节点', () => removeNode(current.id)))
        layout.append(inspector); container.append(layout)
      }

      const api = {
        refresh: () => { message = ''; render() },
        setLocked: value => { locked = Boolean(value); render() },
        destroy: () => { cancelDrag(); destroyed = true; container.replaceChildren() },
      }
      render()
      return api
    },
  }
})()
