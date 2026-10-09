import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { createContentGraphBindings } from '../../electron-editor/content-graph-bindings'

function inspect(code:string) {
  const tree = ts.createSourceFile('content.js',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  const names = createContentGraphBindings(tree)
  const identifiers:ts.Identifier[] = []
  const visit = (node:ts.Node):void => { if (ts.isIdentifier(node)) identifiers.push(node); ts.forEachChild(node,visit) }
  visit(tree)
  return {names,identifiers}
}

describe('content graph lexical binding resolution', () => {
  it('distinguishes a callback parameter from a same-spelled outer const', () => {
    const {names,identifiers} = inspect('function executeSkill(context){ const tile=context.tile; return context.items.map(tile => tile.x).concat(tile); }')
    const tiles = identifiers.filter(node => node.text === 'tile' && !ts.isPropertyAccessExpression(node.parent))
    expect(names.name(tiles[0])).not.toBe('tile')
    expect(names.name(tiles[1])).toBe('tile')
    expect(names.name(tiles.at(-1)!)).toBe(names.name(tiles[0]))
  })
  it('resolves shorthand values without changing object property keys', () => {
    const {names,identifiers} = inspect('function executeSkill(context){let x=1; {let x=2; context.value={x};} return x;}')
    const xs = identifiers.filter(node => node.text === 'x')
    expect(names.name(xs[0])).not.toBe(names.name(xs[1]))
    expect(names.name(xs[2])).toBe(names.name(xs[1]))
    expect(names.name(xs[3])).toBe(names.name(xs[0]))
    expect(xs[2].text).toBe('x')
  })
  it('flags repeated lexical captures but not ordinary per-iteration locals', () => {
    const capture = inspect('function executeSkill(context){for(let i=0;i<2;i++){context.callbacks.push(()=>i);}}')
    expect(capture.names.bindings[0].repeatedCapture).toBe(true)
    const plain = inspect('function executeSkill(context){for(let i=0;i<2;i++){const value=i+1;context.values.push(value);}}')
    expect(plain.names.bindings.every(binding => !binding.repeatedCapture)).toBe(true)
  })
})
