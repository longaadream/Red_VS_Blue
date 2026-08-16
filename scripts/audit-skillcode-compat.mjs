#!/usr/bin/env node
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'

const GROUPS = ['skills', 'rules', 'cards', 'effects']
const CODE_FIELDS = new Set(['code', 'skillCode', 'filterCode', 'effectCode'])
const KNOWN_HELPERS = [
  'selectTarget', 'selectOption', 'dealDamage', 'healDamage', 'applyEffect', 'fireEvent',
  'addRuleById', 'removeRuleById', 'addCardToHand', 'discardCard', 'getHand',
  'addStatusEffectById', 'removeStatusEffectById', 'addPlayerRuleById',
  'removePlayerRuleById', 'Math.random', 'Date.now',
]
const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void',
  'while', 'with', 'yield',
])
const AMBIENT = new Set(['Array', 'Boolean', 'Date', 'Error', 'JSON', 'Math', 'Number', 'Object', 'Promise', 'String', 'console', 'setTimeout'])

function stripStringsAndComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, ' ')
}

function declaredNames(source) {
  const names = new Set()
  for (const match of source.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  for (const match of source.matchAll(/(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/g)) {
    for (const name of (match[1] || match[2] || '').match(/[A-Za-z_$][\w$]*/g) || []) names.add(name)
  }
  return names
}

function freeVariables(source) {
  const clean = stripStringsAndComments(source)
  const declared = declaredNames(clean)
  const identifiers = new Set()
  for (const match of clean.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = match[0]
    const previous = clean.slice(0, match.index).trimEnd().at(-1)
    if (previous === '.' || KEYWORDS.has(name) || AMBIENT.has(name) || declared.has(name)) continue
    identifiers.add(name)
  }
  return [...identifiers].sort()
}

function collectCode(value, field, entries) {
  if (Array.isArray(value)) return value.forEach(item => collectCode(item, field, entries))
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (CODE_FIELDS.has(key) && typeof child === 'string') {
      entries.push({ field: key, helpers: KNOWN_HELPERS.filter(helper => child.includes(helper)), freeVariables: freeVariables(child) })
    }
    collectCode(child, key, entries)
  }
}

const groups = {}
const helperUse = new Map()
const freeVariableUse = new Map()
for (const group of GROUPS) {
  const files = globSync(`data/${group}/**/*.json`).sort()
  groups[group] = files.map(file => {
    const entries = []
    collectCode(JSON.parse(readFileSync(file, 'utf8')), undefined, entries)
    for (const entry of entries) {
      for (const helper of entry.helpers) helperUse.set(helper, (helperUse.get(helper) || 0) + 1)
      for (const variable of entry.freeVariables) freeVariableUse.set(variable, (freeVariableUse.get(variable) || 0) + 1)
    }
    return { file: path.posix.normalize(file), executionFields: entries }
  }).filter(entry => entry.executionFields.length > 0)
}

const executionSurfaces = {
  ruleSkillCode: { dataFields: ['rules.skillCode'], runtime: 'lib/game/skills.ts', status: 'evidence-required' },
  ruleTriggerSkill: { dataFields: ['rules.effect.type=triggerSkill'], runtime: 'lib/game/skills.ts', status: 'evidence-required' },
  skillCode: { dataFields: ['skills.code'], runtime: 'lib/game/skills.ts', status: 'evidence-required' },
  cardCode: { dataFields: ['cards.code'], runtime: 'lib/game/skills.ts', status: 'evidence-required' },
  attachedEffectCode: { dataFields: ['effects.filterCode', 'effects.effectCode'], runtime: 'lib/game/triggers.ts', status: 'evidence-required' },
  pendingEffectCode: { dataFields: ['serialized pending.effectCode'], runtime: 'lib/game/turn.ts', status: 'evidence-required' },
}

console.log(JSON.stringify({
  schemaVersion: 2,
  groups,
  executionSurfaces,
  helperUse: Object.fromEntries([...helperUse].sort()),
  freeVariableUse: Object.fromEntries([...freeVariableUse].sort()),
}, null, 2))
