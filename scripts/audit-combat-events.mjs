#!/usr/bin/env node
/** RED-45 read-only catalog of event names sent to and consumed by the trigger system. */
import { globSync, readFileSync } from 'node:fs'
import ts from 'typescript'

const declaredSource = readFileSync('lib/game/triggers.ts', 'utf8')
const declared = new Set([...declaredSource.matchAll(/^\s*\|\s*"([^"]+)"/gm)].map((match) => match[1]))
const emitted = new Map()
const consumed = new Map()
const dynamicCalls = []
const CODE_FIELDS = new Set(['code', 'skillCode'])

function addEvidence(catalog, event, source) {
  const sources = catalog.get(event) ?? new Set()
  sources.add(source)
  catalog.set(event, sources)
}

function collectVariableInitializers(sourceFile) {
  const initializers = new Map()
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const candidates = initializers.get(node.name.text) ?? []
      candidates.push(node.initializer)
      initializers.set(node.name.text, candidates)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return initializers
}

function unwrapExpression(node) {
  while (
    node
    && (
      ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isParenthesizedExpression(node)
      || ts.isSatisfiesExpression(node)
    )
  ) node = node.expression
  return node
}

function literalEventType(contextNode, initializers, seen = new Set()) {
  contextNode = unwrapExpression(contextNode)
  if (contextNode && ts.isIdentifier(contextNode)) {
    if (seen.has(contextNode.text)) return null
    const candidates = initializers.get(contextNode.text) ?? []
    const resolved = new Set(candidates
      .map(candidate => literalEventType(candidate, initializers, new Set([...seen, contextNode.text])))
      .filter(Boolean))
    return resolved.size === 1 ? [...resolved][0] : null
  }
  if (!contextNode || !ts.isObjectLiteralExpression(contextNode)) return null
  for (const property of contextNode.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : null
    const initializer = unwrapExpression(property.initializer)
    if (name === 'type' && ts.isStringLiteralLike(initializer)) return initializer.text
  }
  return null
}

for (const file of globSync('lib/game/**/*.ts')) {
  const source = readFileSync(file, 'utf8')
  const normalizedFile = file.replace(/\\/g, '/')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const initializers = collectVariableInitializers(sourceFile)
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'checkTriggers'
    ) {
      const contextNode = node.arguments[1]
      const event = literalEventType(contextNode, initializers)
      if (event) {
        addEvidence(emitted, event, normalizedFile)
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

function collectDataEvidence(value, file, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectDataEvidence(entry, file, [...trail, String(index)]))
    return
  }
  if (!value || typeof value !== 'object') return

  if (value.trigger && typeof value.trigger === 'object' && typeof value.trigger.type === 'string') {
    addEvidence(consumed, value.trigger.type, `${file}#${[...trail, 'trigger.type'].join('.')}`)
  }
  for (const [key, child] of Object.entries(value)) {
    if (CODE_FIELDS.has(key) && typeof child === 'string') {
      for (const match of child.matchAll(/\bfireEvent\s*\(\s*(['"])([^'"]+)\1/g)) {
        addEvidence(emitted, match[2], `${file}#${[...trail, key].join('.')}`)
      }
    }
    collectDataEvidence(child, file, [...trail, key])
  }
}

for (const group of ['skills', 'rules', 'cards']) {
  for (const file of globSync(`data/${group}/**/*.json`).sort()) {
    collectDataEvidence(JSON.parse(readFileSync(file, 'utf8')), file.replace(/\\/g, '/'))
  }
}

const eventNames = new Set([...declared, ...emitted.keys(), ...consumed.keys()])
const events = [...eventNames].sort().map(event => ({
  event,
  declared: declared.has(event),
  producers: [...(emitted.get(event) ?? [])].sort(),
  consumers: [...(consumed.get(event) ?? [])].sort(),
}))
const report = {
  schemaVersion: 2,
  declared: [...declared].sort(),
  events,
  emittedOnly: events.filter(entry => !entry.declared && entry.producers.length > 0),
  consumedOnly: events.filter(entry => entry.consumers.length > 0 && entry.producers.length === 0),
  declaredWithoutProducers: events.filter(entry => entry.declared && entry.producers.length === 0),
  declaredWithoutConsumers: events.filter(entry => entry.declared && entry.consumers.length === 0),
  undeclaredEvents: events.filter(entry => !entry.declared),
  dynamicCalls,
}
console.log(JSON.stringify(report, null, 2))
if (report.undeclaredEvents.length > 0 || report.consumedOnly.length > 0 || report.declaredWithoutProducers.length > 0) {
  process.exitCode = 1
}
