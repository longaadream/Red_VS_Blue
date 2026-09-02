#!/usr/bin/env node
/** RED-45 static inventory for every data-driven code surface and lexical binding. */
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const GROUPS = ['skills', 'rules', 'cards']
const CODE_FIELDS = new Set(['code', 'skillCode'])
const JS_AMBIENT = new Set([
  'Array', 'Boolean', 'Error', 'Infinity', 'JSON', 'Map', 'NaN', 'Number', 'Object',
  'Promise', 'RegExp', 'Set', 'String', 'Symbol', 'console', 'isFinite', 'isNaN',
  'parseFloat', 'parseInt', 'setTimeout', 'undefined',
])

const SURFACES = {
  ruleSkillCode: {
    dataFields: ['rules.skillCode'],
    runtime: 'lib/game/skills.ts::loadRuleById',
    signature: 'statement body with battle/context plus injected helpers',
    bindings: [
      'battle', 'context', 'dealDamage', 'healDamage', 'addCardToHand', 'checkToxin',
      'addStatusEffectById', 'removeStatusEffectById', 'addPlayerRuleById',
      'removePlayerRuleById', 'addRuleById', 'removeRuleById', 'addPlayerStatusEffectById',
      'removePlayerStatusEffectById', 'addPlayerSkillById', 'removePlayerSkillById',
      'addSkillById', 'removeSkillById',
      'selectOption', 'fireEvent',
      'Math', 'Date',
    ],
    runtimeEvidence: 'tests/game/skillcode-browser-differential.test.ts',
  },
  ruleTriggerSkill: {
    dataFields: ['rules.effect.type=triggerSkill'],
    runtime: 'lib/game/skills.ts::loadRuleById -> executeSkill',
    signature: 'trigger context adapted to the full skill execution environment',
    bindings: [],
    semanticDifference: 'not equivalent to inline rule skillCode; it adapts and mutates the trigger context before invoking a referenced skill',
    runtimeEvidence: 'tests/game/skillcode-browser-differential.test.ts',
  },
  skillCode: {
    dataFields: ['skills.code'],
    runtime: 'lib/game/skills.ts::executeSkillFunction',
    signature: 'executeSkill(context) with skill environment bindings',
    bindings: [
      'context', 'sourcePiece', 'battle', 'select', 'selectTarget', 'selectOption',
      'teleport', 'dealDamage', 'healDamage', 'traceProjectile', 'addStatusEffectById',
      'removeStatusEffectById', 'getAllEnemiesInRange', 'getAllAlliesInRange',
      'calculateDistance', 'isTargetInRange', 'addRuleById', 'removeRuleById',
      'addPlayerRuleById', 'removePlayerRuleById', 'addPlayerSkillById',
      'removePlayerSkillById', 'addPlayerStatusEffectById', 'removePlayerStatusEffectById',
      'addSkillById', 'removeSkillById', 'addCardToHand', 'discardCard', 'getHand',
      'fireEvent', 'Math', 'Date', 'console',
    ],
    runtimeEvidence: 'tests/game/skillcode-browser-differential.test.ts',
  },
  cardCode: {
    dataFields: ['cards.code'],
    runtime: 'lib/game/skills.ts::executeCardFunction',
    signature: 'executeCard(context); active and reactive cards share the same wrapper',
    bindings: [
      'context', 'battle', 'playerId', 'selectTarget', 'selectOption', 'dealDamage',
      'healDamage', 'addCardToHand', 'discardCard', 'getHand', 'addStatusEffectById',
      'removeStatusEffectById', 'addRuleById', 'removeRuleById', 'addPlayerRuleById',
      'removePlayerRuleById', 'Math', 'Date', 'console',
    ],
    semanticDifference: 'cards have no guaranteed sourcePiece; reactive cards reuse the mutable trigger context',
    runtimeEvidence: 'tests/game/skillcode-browser-differential.test.ts',
  },
  pendingEffectCode: {
    dataFields: ['serialized pending.effectCode'],
    runtime: 'lib/game/turn.ts::pendingTargetSelect',
    signature: 'serialized function(ctx) with deterministic Math/Date',
    bindings: ['Math', 'Date'],
    semanticDifference: 'closures are unavailable after serialization; only ctx and deterministic Math/Date survive',
    runtimeEvidence: 'tests/game/skillcode-browser-differential.test.ts',
  },
}

const injected = Object.fromEntries(Object.entries(SURFACES).map(([surface, value]) => [surface, new Set(value.bindings)]))

function surfaceFor(group, field) {
  if (group === 'rules' && field === 'skillCode') return 'ruleSkillCode'
  if (group === 'skills' && field === 'code') return 'skillCode'
  if (group === 'cards' && field === 'code') return 'cardCode'
  return null
}

function collectBindingName(node, names) {
  if (!node) return
  if (ts.isIdentifier(node)) {
    names.add(node.text)
    return
  }
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const element of node.elements) {
      if (ts.isBindingElement(element)) collectBindingName(element.name, names)
    }
  }
}

function collectDeclaredNames(sourceFile) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      collectBindingName(node.name, names)
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
      && node.name
    ) names.add(node.name.text)
    if (ts.isCatchClause(node) && node.variableDeclaration) collectBindingName(node.variableDeclaration.name, names)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

function isNonReferenceIdentifier(node) {
  const parent = node.parent
  if (!parent) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true
  if (ts.isGetAccessorDeclaration(parent) && parent.name === node) return true
  if (ts.isSetAccessorDeclaration(parent) && parent.name === node) return true
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true
  if (ts.isLabeledStatement(parent) && parent.label === node) return true
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return true
  if (ts.isQualifiedName(parent) && parent.right === node) return true
  return false
}

function analyzeCode(code, field, surface) {
  const wrapped = field === 'skillCode'
    ? `function __audit__() {\n${code}\n}`
    : `const __audit__ = (${code});`
  const sourceFile = ts.createSourceFile('audit-code.ts', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaredNames = collectDeclaredNames(sourceFile)
  const freeVariables = new Set()
  const visit = (node) => {
    if (
      ts.isIdentifier(node)
      && node.text.length > 0
      && !declaredNames.has(node.text)
      && !isNonReferenceIdentifier(node)
    ) freeVariables.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const bindings = [...freeVariables].sort().map(name => ({
    name,
    status: injected[surface]?.has(name)
      ? 'supported'
      : JS_AMBIENT.has(name)
        ? 'ambient'
        : 'unsupported',
  }))
  const parseErrors = sourceFile.parseDiagnostics.map(diagnostic => ({
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    offset: diagnostic.start ?? 0,
  }))
  return { bindings, freeVariables: [...freeVariables].sort(), parseErrors }
}

function collectCode(value, group, file, trail, entries, triggerSkills) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCode(item, group, file, [...trail, String(index)], entries, triggerSkills))
    return
  }
  if (!value || typeof value !== 'object') return

  if (value.effect?.type === 'triggerSkill') {
    triggerSkills.push({
      file,
      path: [...trail, 'effect'].join('.'),
      skillId: typeof value.effect.skillId === 'string' ? value.effect.skillId : null,
      surface: 'ruleTriggerSkill',
    })
  }

  for (const [key, child] of Object.entries(value)) {
    if (CODE_FIELDS.has(key) && typeof child === 'string') {
      const surface = surfaceFor(group, key)
      const analysis = analyzeCode(child, key, surface)
      entries.push({
        field: key,
        path: [...trail, key].join('.'),
        surface,
        ...analysis,
      })
    }
    collectCode(child, group, file, [...trail, key], entries, triggerSkills)
  }
}

const groups = {}
const triggerSkills = []
const helperUse = new Map()
const freeVariableUse = new Map()
const unsupportedUse = new Map()
const syntaxErrors = []
const unclassifiedFields = []

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

for (const group of GROUPS) {
  const files = globSync(`data/${group}/**/*.json`).sort()
  groups[group] = files.map(file => {
    const entries = []
    const normalizedFile = path.posix.normalize(file.replace(/\\/g, '/'))
    collectCode(JSON.parse(readFileSync(file, 'utf8')), group, normalizedFile, [], entries, triggerSkills)
    for (const entry of entries) {
      if (!entry.surface) unclassifiedFields.push({ file: normalizedFile, field: entry.field, path: entry.path })
      for (const binding of entry.bindings) {
        increment(freeVariableUse, binding.name)
        if (binding.status === 'supported') increment(helperUse, binding.name)
        if (binding.status === 'unsupported') {
          const uses = unsupportedUse.get(binding.name) ?? []
          uses.push({ file: normalizedFile, field: entry.field, path: entry.path, surface: entry.surface })
          unsupportedUse.set(binding.name, uses)
        }
      }
      for (const error of entry.parseErrors) syntaxErrors.push({ file: normalizedFile, field: entry.field, path: entry.path, ...error })
    }
    return { file: normalizedFile, executionFields: entries }
  }).filter(entry => entry.executionFields.length > 0)
}

const report = {
  schemaVersion: 2,
  analysisVersion: 4,
  groups,
  executionSurfaces: SURFACES,
  triggerSkills,
  helperUse: Object.fromEntries([...helperUse].sort()),
  freeVariableUse: Object.fromEntries([...freeVariableUse].sort()),
  unsupportedUse: Object.fromEntries([...unsupportedUse].sort()),
  syntaxErrors,
  unclassifiedFields,
}
console.log(JSON.stringify(report, null, 2))
if (syntaxErrors.length > 0 || unclassifiedFields.length > 0 || unsupportedUse.size > 0) process.exitCode = 1
