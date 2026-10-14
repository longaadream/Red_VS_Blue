import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

/*
 * This is intentionally a small DOM harness.  The lexical helpers do not
 * need a browser layout, but loading the sentence editor still expects the
 * normal window/document globals.  Keeping the stub here makes the test
 * independent from Electron while exercising the editor's own scope and
 * expression insertion helpers.
 */
class StubElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.children = []
    this.dataset = {}
    this.attributes = {}
    this.className = ''
    this.textContent = ''
    this.value = ''
    this.style = {}
    this.classList = {
      add: (...names) => names.forEach(name => { this.className = `${this.className} ${name}`.trim() }),
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' ') },
      toggle: (name, force) => {
        const present = this.className.split(/\s+/).includes(name)
        const next = force === undefined ? !present : Boolean(force)
        if (next && !present) this.className = `${this.className} ${name}`.trim()
        if (!next && present) this.className = this.className.split(/\s+/).filter(item => item && item !== name).join(' ')
        return next
      },
      contains: name => this.className.split(/\s+/).includes(name),
    }
  }

  append(...items) {
    for (const item of items) {
      if (item === null || item === undefined) continue
      this.children.push(item)
      if (item && typeof item === 'object') item.parentNode = this
    }
  }

  replaceChildren(...items) {
    this.children = []
    this.append(...items)
  }

  setAttribute(name, value) {
    const text = String(value)
    this.attributes[name] = text
    if (name === 'class') this.className = text
    if (name === 'id') this.id = text
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      this.dataset[key] = text
    }
  }

  getAttribute(name) {
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      return this.dataset[key] ?? null
    }
    return this.attributes[name] ?? null
  }

  querySelector() { return null }
  querySelectorAll() { return [] }
  closest() { return null }
  matches() { return false }
  addEventListener() {}
  focus() { this.ownerDocument.activeElement = this }
}

class StubDocument {
  constructor() {
    this.activeElement = null
    this.body = new StubElement('body', this)
  }

  createElement(tagName) { return new StubElement(tagName, this) }
  getElementById() { return null }
}

function loadEditorInternals() {
  const filename = fileURLToPath(new URL('../../electron-editor/ui/sentence-editor.js', import.meta.url))
  const source = fs.readFileSync(filename, 'utf8')
  const marker = 'window.SkillSentenceEditor = { mount }'
  assert.ok(source.includes(marker), 'sentence editor export marker must remain stable')
  const instrumented = source.replace(
    marker,
    'window.SkillSentenceEditor = { mount, __test: { statementLocationForLexicalId, createPureExpression, valueLabel } }',
  )
  const window = {}
  const document = new StubDocument()
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout })
  vm.runInContext(instrumented, context, { filename })
  return window.SkillSentenceEditor.__test
}

const internals = loadEditorInternals()

const descriptors = [
  {
    id: 'ref.holder', version: '1', label: '当前棋子', inputs: [],
    outputs: [{ name: 'piece', label: '棋子', type: 'piece' }],
    effects: { pure: true },
  },
  {
    id: 'piece.wrap', version: '1', label: '包装棋子',
    inputs: [{ name: 'piece', label: '棋子', type: 'piece' }],
    outputs: [{ name: 'piece', label: '棋子', type: 'piece' }],
    effects: { pure: true },
  },
  {
    id: 'piece.identity', version: '1', label: '保持棋子',
    inputs: [{ name: 'piece', label: '棋子', type: 'piece' }],
    outputs: [{ name: 'piece', label: '棋子', type: 'piece' }],
    effects: { pure: true },
  },
  {
    id: 'piece.consume', version: '1', label: '使用棋子',
    inputs: [{ name: 'piece', label: '棋子', type: 'piece' }],
    outputs: [{ name: 'ok', label: '完成', type: 'boolean' }],
    effects: { writes: ['gameplay'] },
  },
]

function call(id, module, inputs = {}) {
  return { kind: 'call', id, module, version: '1', inputs, parameters: {} }
}

function branch(id, children) {
  return { kind: 'if', id, condition: { kind: 'literal', value: true }, then: children, else: [] }
}

function emptyGraph(body = []) {
  return {
    version: 'rvb-gameplay-modules/v1',
    surface: 'skill',
    body,
    inputs: [],
    outputs: [],
    composites: [],
    continuations: [],
  }
}

function createCore() {
  return {
    getGameplayModuleGraph: (draft, field) => draft.gameplayModules?.entries?.[field]?.graph || null,
    getGameplayModuleCatalog: () => descriptors,
    applyGameplayModuleGraph: (draft, graph, field) => ({
      ...draft,
      gameplayModules: {
        ...(draft.gameplayModules || {}),
        entries: {
          ...(draft.gameplayModules?.entries || {}),
          [field]: { ...(draft.gameplayModules?.entries?.[field] || {}), graph },
        },
      },
    }),
  }
}

function draftFor(graph) {
  return {
    id: 'lexical-scope-fixture',
    gameplayModules: { version: 'rvb-gameplay-module-document/v1', entries: { code: { graph } } },
  }
}

function frame(kind, id, extra = {}) {
  return { kind, id, version: '1', ...extra }
}

test('branch consumers resolve parent sources and compose in the declaration branch', () => {
  const holder = call('holder', 'ref.holder')
  const source = call('parent-source', 'piece.wrap', {
    piece: { kind: 'output', node: holder.id, port: 'piece' },
  })
  const consumer = call('nested-consumer', 'piece.consume', {
    piece: { kind: 'output', node: source.id, port: 'piece' },
  })
  const innerBranch = branch('inner-branch', [consumer])
  const outerBranch = branch('outer-branch', [source, innerBranch])
  const graph = emptyGraph([holder, outerBranch])
  const activePath = [
    frame('branch', outerBranch.id, { parentId: outerBranch.id, branch: 'then' }),
    frame('branch', innerBranch.id, { parentId: innerBranch.id, branch: 'then' }),
  ]

  const sourceLocation = internals.statementLocationForLexicalId(graph, source.id, activePath)
  assert.equal(sourceLocation.statement, source)
  assert.deepEqual(sourceLocation.scopePath, [activePath[0]], 'source opens in its parent branch scope')

  let draft = draftFor(graph)
  const result = internals.createPureExpression({
    core: createCore(), field: 'code', getDraft: () => draft, onChange: next => { draft = next },
  }, source.id, 'piece', 'piece', 'piece.identity', '1', sourceLocation.scopePath)

  assert.deepEqual(result.scopePath, sourceLocation.scopePath)
  const updatedGraph = draft.gameplayModules.entries.code.graph
  const updatedOuter = updatedGraph.body.find(statement => statement.id === outerBranch.id)
  assert.equal(updatedOuter.then[0].id, result.statement.id, 'expression is inserted into the source declaration branch')
  assert.deepEqual(JSON.parse(JSON.stringify(updatedOuter.then[0].inputs.piece)), { kind: 'output', node: holder.id, port: 'piece' })
  assert.deepEqual(JSON.parse(JSON.stringify(updatedOuter.then[1].inputs.piece)), { kind: 'output', node: result.statement.id, port: 'piece' })
  assert.deepEqual(JSON.parse(JSON.stringify(updatedOuter.then[2].then[0].inputs.piece)), { kind: 'output', node: source.id, port: 'piece' })
})

test('composite lexical lookup keeps same IDs inside the composite and refuses root fallback', () => {
  const rootDuplicate = call('same-node', 'ref.holder')
  const localDuplicate = call('same-node', 'piece.wrap')
  const localBranch = branch('composite-branch', [call('composite-consumer', 'piece.consume', {
    piece: { kind: 'output', node: 'same-node', port: 'piece' },
  })])
  const graph = emptyGraph([rootDuplicate])
  graph.composites.push({ id: 'shared-composite', version: '1', body: [localDuplicate, localBranch], inputs: [], outputs: [] })
  const activePath = [
    frame('composite', 'shared-composite'),
    frame('branch', localBranch.id, { parentId: localBranch.id, branch: 'then' }),
  ]

  const local = internals.statementLocationForLexicalId(graph, 'same-node', activePath)
  assert.equal(local.statement, localDuplicate)
  assert.deepEqual(local.scopePath, [activePath[0]])

  graph.composites[0].body = [localBranch]
  assert.equal(internals.statementLocationForLexicalId(graph, 'same-node', activePath), null, 'composite lookup must not cross into root graph')
})

test('continuation lexical lookup keeps same IDs inside the continuation and refuses root fallback', () => {
  const rootDuplicate = call('same-node', 'ref.holder')
  const localDuplicate = call('same-node', 'piece.wrap')
  const localBranch = branch('continuation-branch', [call('continuation-consumer', 'piece.consume', {
    piece: { kind: 'output', node: 'same-node', port: 'piece' },
  })])
  const continuationGraph = emptyGraph([localDuplicate, localBranch])
  const graph = emptyGraph([rootDuplicate])
  graph.continuations.push({ id: 'shared-continuation', version: '1', graph: continuationGraph })
  const activePath = [
    frame('continuation', 'shared-continuation'),
    frame('branch', localBranch.id, { parentId: localBranch.id, branch: 'then' }),
  ]

  const local = internals.statementLocationForLexicalId(graph, 'same-node', activePath)
  assert.equal(local.statement, localDuplicate)
  assert.deepEqual(local.scopePath, [activePath[0]])

  continuationGraph.body = [localBranch]
  assert.equal(internals.statementLocationForLexicalId(graph, 'same-node', activePath), null, 'continuation lookup must not cross into root graph')
})

test('formula labels preserve mixed operations, non-associative grouping and negative operands without changing the graph', () => {
  const literal = value => ({ kind: 'literal', value })
  const output = node => ({ kind: 'output', node, port: 'value' })
  const cases = [
    ['math.add', 'math.multiply', 'left', 1, 2, 3, '（1 ＋ 2） × 3'],
    ['math.subtract', 'math.subtract', 'right', 2, 3, 1, '1 − （2 − 3）'],
    ['math.divide', 'math.divide', 'right', 2, 3, 1, '1 ÷ （2 ÷ 3）'],
    ['math.power', 'math.power', 'left', -2, 2, 3, '（（-2） ^ 2） ^ 3'],
    ['math.modulo', 'math.multiply', 'right', 5, 2, -1, '（-1） × （5 % 2）'],
  ]
  for (const [innerModule, outerModule, nestedSide, a, b, c, expected] of cases) {
    const inner = call('inner', innerModule, { left: literal(a), right: literal(b) })
    const outer = call('outer', outerModule, {
      left: nestedSide === 'left' ? output(inner.id) : literal(c),
      right: nestedSide === 'right' ? output(inner.id) : literal(c),
    })
    const graph = emptyGraph([inner, outer])
    const before = JSON.stringify(graph)
    assert.equal(internals.valueLabel(createCore(), graph, output(outer.id)), expected)
    assert.equal(JSON.stringify(graph), before, 'display must not rewrite calculation order')
  }
})

test('formula labels terminate for malformed cycles without rewriting author data', () => {
  const self = call('cycle', 'math.add', {
    left: { kind: 'output', node: 'cycle', port: 'value' },
    right: { kind: 'literal', value: 1 },
  })
  const graph = emptyGraph([self])
  const before = JSON.stringify(graph)
  const label = internals.valueLabel(createCore(), graph, { kind: 'output', node: self.id, port: 'value' })
  assert.equal(typeof label, 'string')
  assert.ok(label.length > 0 && label.length < 200)
  assert.equal(JSON.stringify(graph), before)
})
