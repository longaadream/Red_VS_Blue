/* The canvas edits the same versioned definition as the trusted authoring compiler. */
(() => {
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node }
  const clone = value => JSON.parse(JSON.stringify(value))
  const presentationLabels = {public:'所有人',owner:'仅持有者玩家',allies:'自己及队友',enemies:'敌方玩家',spectators:'仅观战者','while-alive':'持有棋子离场',battle:'本场战斗结束',statuses:'状态图标',health:'当前／最大生命',identity:'名称与头像',stats:'攻防与移动力',skills:'技能与冷却',live:'实时读取',snapshot:'使用创建时快照',self:'显示自身数据',remove:'取消绑定',currentHp:'当前生命值',maxHp:'最大生命值',defense:'防御力',moveRange:'移动力',float:'浮动文字',flash:'短暂地格高亮',sound:'提示音',notice:'普通提示音',success:'完成提示音',warning:'警示提示音'}
  window.ContentSkillGraph = {
    mount(container, { getDraft, onChange }) {
      const core = window.SkillGraphCore
      let selected = null, status = '', pendingGraph = null
      container.className = 'skill-graph-editor'
      const button = (text, action) => { const node = el('button', text, 'btn btn-sm'); node.type = 'button'; node.onclick = action; return node }
      const graph = () => pendingGraph || getDraft().skillGraph
      function update(next) {
        pendingGraph = next
        try {
          const draft = core.applySkillGraph(getDraft(), next)
          onChange(draft); pendingGraph = null; status = '已生成描述、目标配置和技能代码；保存后写入文件。'
        } catch (error) {
          // Persist incomplete graph drafts in the document buffer, never silently execute stale code.
          onChange({ ...getDraft(), skillGraph: next }); status = error.message
        }
        refresh()
      }
      function field(label, control, parent) { const wrapper = el('label', label); wrapper.append(control); parent.append(wrapper) }
      function select(options, current, change) {
        const input = el('select'); for (const [value, label] of options) { const option = el('option', label); option.value = value; input.append(option) }
        input.value = current ?? ''; input.onchange = () => change(input.value); return input
      }
      function changeNode(id, change) { const next = clone(graph()); change(next.nodes.find(node => node.id === id)); update(next) }
      function refresh() {
        container.replaceChildren()
        const help = el('p', '连接“主动使用 → 选择 → 条件或效果 → 完成”。可配置显示来源、数值进度、地格标记、文字／高亮／音效和可见对象。一个技能可有一组选项，支持多选。回合被动、召唤及复杂旧脚本仍使用代码编辑。', 'graph-help')
        container.append(help)
        const current = graph()
        if (!current) {
          container.append(el('p', '这个技能尚未使用流程图。建立新图会替换描述、预览、代码和目标配置；费用、冷却及其他扩展字段保留。旧脚本不会自动转换。'))
          container.append(button('建立空白技能图', () => { selected = 'start'; update(core.createSkillGraph()) }))
          return
        }
        if (current.version !== core.GRAPH_VERSION || !Array.isArray(current.nodes)) { container.append(el('p', '图版本或结构不受支持，请在完整 JSON 中检查；原始内容已保留。', 'graph-error')); return }
        let compiled
        try { compiled = core.compileSkillGraph(current); core.assertSkillGraphArtifact(getDraft()) } catch (error) { status = error.message }
        const toolbar = el('div', undefined, 'graph-toolbar')
        const choices = Object.entries(core.NODE_CATALOG).filter(([kind]) => kind !== 'start')
        const nodeType = select(choices.map(([kind, item]) => [kind, item.name]), 'damage', () => {})
        nodeType.setAttribute('aria-label', '新增节点类型')
        toolbar.append(nodeType, button('新增节点', () => {
          const next = clone(current)
          let count = 1; while (next.nodes.some(node => node.id === 'node-' + count)) count++
          selected = 'node-' + count
          next.nodes.push(core.newGraphNode(nodeType.value, selected, 60 + (next.nodes.length % 3) * 260, 90 + Math.floor(next.nodes.length / 3) * 125))
          update(next)
        }), button('自动排列', () => {
          const next = clone(current), seen = new Set(), order = []
          function walk(id) { const node = next.nodes.find(item => item.id === id); if (!node || seen.has(id)) return; seen.add(id); order.push(node); [node.next, node.yes, node.no].forEach(walk) }
          walk(next.entry); next.nodes.filter(node => !seen.has(node.id)).forEach(node => order.push(node))
          order.forEach((node, index) => { node.x = 25 + (index % 2) * 265; node.y = 25 + Math.floor(index / 2) * 125 }); update(next)
        }), button('重新生成', () => update(clone(current))), button('解除图关联，保留代码', () => {
          const draft = { ...getDraft() }; delete draft.skillGraph; delete draft.graphCompilerVersion; pendingGraph = null; status = ''; onChange(draft); refresh()
        }))
        container.append(toolbar)
        const notice = el('p', status || '图已校验。可拖动节点，选择节点后编辑参数与连线。', compiled ? 'graph-notice' : 'graph-error')
        notice.setAttribute('role', 'status'); container.append(notice)
        const layout = el('div', undefined, 'graph-layout'), viewport = el('div', undefined, 'graph-viewport'), canvas = el('div', undefined, 'graph-canvas')
        const width = Math.max(555, ...current.nodes.map(node => (node.x || 0) + 245)), height = Math.max(400, ...current.nodes.map(node => (node.y || 0) + 120))
        canvas.style.width = width + 'px'; canvas.style.height = height + 'px'
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', width); svg.setAttribute('height', height); svg.classList.add('graph-wires')
        for (const node of current.nodes) for (const port of ['next', 'yes', 'no']) {
          const target = current.nodes.find(candidate => candidate.id === node[port]); if (!target) continue
          const wire = document.createElementNS(svg.namespaceURI, 'path')
          const x1 = (node.x || 0) + 220, y1 = (node.y || 0) + (port === 'no' ? 70 : 40), x2 = target.x || 0, y2 = (target.y || 0) + 40
          wire.setAttribute('d', `M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2},${y2}`)
          wire.setAttribute('class', 'graph-wire ' + port); svg.append(wire)
          const label = document.createElementNS(svg.namespaceURI, 'text'); label.setAttribute('x', x1 + 6); label.setAttribute('y', y1 - 6); label.textContent = port === 'yes' ? '是 →' : port === 'no' ? '否 →' : '→'; svg.append(label)
        }
        canvas.append(svg)
        for (const node of current.nodes) {
          const card = button('', () => { selected = node.id; refresh() }); card.className = 'graph-node' + (selected === node.id ? ' selected' : '')
          card.dataset.graphNode = node.id; card.style.left = (node.x || 0) + 'px'; card.style.top = (node.y || 0) + 'px'
          card.append(el('strong', core.NODE_CATALOG[node.kind]?.name || node.kind), el('small', node.id), el('span', compiled?.nodeDescriptions[node.id] || '选择节点，配置参数和出口'))
          card.onpointerdown = event => {
            if (event.button !== 0 || container.closest('[data-saving="true"]')) return
            const startX = event.clientX, startY = event.clientY, oldX = node.x || 0, oldY = node.y || 0
            let moved = false
            card.setPointerCapture(event.pointerId)
            card.onpointermove = move => { if (Math.abs(move.clientX - startX) + Math.abs(move.clientY - startY) > 4) moved = true; card.style.left = Math.max(0, oldX + move.clientX - startX) + 'px'; card.style.top = Math.max(0, oldY + move.clientY - startY) + 'px' }
            card.onpointerup = up => {
              card.onpointermove = null; card.onpointerup = null
              if (moved) { selected = node.id; changeNode(node.id, item => { item.x = Math.min(9500, Math.max(0, oldX + up.clientX - startX)); item.y = Math.min(9500, Math.max(0, oldY + up.clientY - startY)) }) }
            }
          }
          canvas.append(card)
        }
        viewport.append(canvas); layout.append(viewport)
        const panel = el('aside', undefined, 'graph-inspector'), node = current.nodes.find(item => item.id === selected)
        if (node && core.NODE_CATALOG[node.kind]) {
          panel.append(el('h3', core.NODE_CATALOG[node.kind].name + ' · ' + node.id))
          for (const definition of core.NODE_CATALOG[node.kind].fields) {
            let control
            if (definition.type === 'number') {
              control = el('input'); control.type = 'number'; control.step = '1'; control.value = node.params[definition.key]
              control.onchange = () => changeNode(node.id, item => { item.params[definition.key] = Number(control.value) })
            } else if (definition.type === 'text') {
              control = el('input'); control.type = 'text'; control.maxLength = 120; control.value = node.params[definition.key]
              control.onchange = () => changeNode(node.id, item => { item.params[definition.key] = control.value })
            } else {
              const referenceKind = { piece: 'select-piece', cell: 'select-cell', damage: 'damage', option: 'select-options' }[definition.type]
              const options = definition.options ? definition.options.map(option => [option, (node.kind==='display-indicator' && option==='attack' ? '攻击力' : presentationLabels[option]) || ({enemy:'敌方',ally:'友方',all:'全部',yes:'允许',no:'不允许',physical:'物理',magical:'法术',true:'真实',fixed:'固定数值',attack:'本棋子攻击力百分比',actualDamage:'已造成的实际伤害百分比',root:'定身','divine-shield':'圣盾','hp-below':'生命值低于阈值','is-self':'目标是本棋子'})[option] || option])
                : [['', '请选择数据来源'], ...(definition.type === 'piece' ? [['self', '本棋子']] : []), ...current.nodes.filter(item => item.kind === referenceKind && item.id !== node.id).map(item => [item.id, core.NODE_CATALOG[item.kind].name + ' · ' + item.id])]
              control = select(options, node.params[definition.key], value => changeNode(node.id, item => { item.params[definition.key] = value }))
            }
            control.dataset.graphParam = definition.key; control.setAttribute('aria-label', definition.label); field(definition.label, control, panel)
          }
          const ports = node.kind === 'end' ? [] : ['condition','condition-option'].includes(node.kind) ? ['yes', 'no'] : ['next']
          for (const port of ports) {
            const control = select([['', '尚未连接'], ...current.nodes.filter(item => item.id !== node.id && item.kind !== 'start').map(item => [item.id, core.NODE_CATALOG[item.kind]?.name + ' · ' + item.id])], node[port], value => changeNode(node.id, item => { if (value) item[port] = value; else delete item[port] }))
            control.dataset.graphPort = port; field(port === 'yes' ? '条件成立 →' : port === 'no' ? '条件不成立 →' : '下一步 →', control, panel)
          }
          if (node.kind !== 'start') panel.append(button('删除节点', () => {
            const next = clone(current); next.nodes = next.nodes.filter(item => item.id !== node.id)
            for (const item of next.nodes) for (const port of ['next', 'yes', 'no']) if (item[port] === node.id) delete item[port]
            selected = null; update(next)
          }))
        } else panel.append(el('p', '选择一个节点来编辑参数与连线。'))
        layout.append(panel); container.append(layout)
        const preview = el('section', undefined, 'graph-preview'); preview.append(el('h3', '生成的技能描述'), el('p', compiled?.description || '修复连线与参数后生成。'))
        preview.append(el('small', '结构校验通过不代表实战验收。保存后的可信技能代码使用现有战斗引擎执行；外部内容准入规则保持不变。'))
        container.append(preview)
      }
      refresh()
      return { refresh: () => { pendingGraph = null; status = ''; refresh() } }
    },
  }
})()
