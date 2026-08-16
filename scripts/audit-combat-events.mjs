#!/usr/bin/env node
/** RED-45 read-only catalog of event names sent to the trigger system. */
import { globSync, readFileSync } from 'node:fs'
import ts from 'typescript'

const declaredSource = readFileSync('lib/game/triggers.ts', 'utf8')
const declared = new Set([...declaredSource.matchAll(/^\s*\|\s*"([^"]+)"/gm)].map((m) => m[1]))
const emitted = new Map()
const dynamicCalls = []

function literalEventType(contextNode) {
  while (
    contextNode
    && (
      ts.isAsExpression(contextNode)
      || ts.isTypeAssertionExpression(contextNode)
      || ts.isParenthesizedExpression(contextNode)
      || ts.isSatisfiesExpression(contextNode)
    )
  ) contextNode = contextNode.expression
  if (!contextNode || !ts.isObjectLiteralExpression(contextNode)) return null
  for (const property of contextNode.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : null
    if (name === 'type' && ts.isStringLiteralLike(property.initializer)) return property.initializer.text
  }
  return null
}

for (const file of globSync('lib/game/**/*.ts')) {
  const source = readFileSync(file, 'utf8')
  const normalizedFile = file.replace(/\\/g, '/')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'checkTriggers'
    ) {
      const contextNode = node.arguments[1]
      const event = literalEventType(contextNode)
      if (event) {
        const names = emitted.get(event) ?? new Set()
        names.add(normalizedFile)
        emitted.set(event, names)
      } else {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        dynamicCalls.push({
          file: normalizedFile,
          line: line + 1,
          context: contextNode?.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 160) ?? '<missing>',
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}
const events = [...emitted].sort(([a], [b]) => a.localeCompare(b)).map(([event, files]) => ({
  event, declared: declared.has(event), producers: [...files].sort(),
}))
console.log(JSON.stringify({
  declared: [...declared].sort(),
  events,
  emittedOnly: events.filter((entry) => !entry.declared),
  dynamicCalls,
}, null, 2))
if (events.some((x) => !x.declared)) process.exitCode = 1
