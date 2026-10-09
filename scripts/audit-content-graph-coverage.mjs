#!/usr/bin/env node

/**
 * RED-252: build a deterministic coverage inventory for ordinary-match content.
 *
 * This audit deliberately treats the existing `code`/`skillCode` strings as
 * legacy execution sources. A source-flow/AST view is evidence only; each
 * inline code field becomes validated after its primary contentGraph or
 * contentGraphEntries[field] artifact records successful compiler validation.
 * Definitions without inline code are classified as declarative and still
 * need dependency/effect validation.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

export const CONTENT_GRAPH_VERSION = 'rvb-content-graph/v1'
export const GRAPH_COMPILER_VERSION = 'rvb-content-graph-compiler/v1'
export const BASE_BRANCH = 'main'
export const BASE_SHA = '00df31f8bd35b34200d507fd83853bf5ac99ba94'
export const GROUPS = ['pieces', 'skills', 'rules', 'cards']
export const CODE_FIELDS = new Set(['code', 'skillCode', 'previewCode', 'effect'])
export const MIGRATION_STATUSES = ['declarative', 'legacy', 'graph-unverified', 'graph-partial', 'graph-validated']
export const FIELD_MIGRATION_STATUSES = ['legacy', 'graph-unverified', 'graph-validated']
export const SOURCE_KINDS = ['declarative', 'inline-fields']
export const SOURCE_GRAPH_STATUSES = [
  'legacy-until-graph-source',
  'graph-source-unverified',
  'graph-source-partial',
  'graph-source-validated',
]
export const LEGACY_CONTENT_FIXTURE = 'tests/game/fixtures/RED-252-legacy-content.json'
// These are the only generated/pending definitions for which the audit has an
// independently reproducible graph builder.  A compiler-validated artifact is
// still insufficient for these entries: the graph and emitted source must
// match the graph built from the frozen source by the registered migration.
export const REGISTERED_GRAPH_PROOF_KEYS = [
  'rules/rule-rafaam-curse-ward',
  'skills/rafaam-curse-amplify',
  'skills/tails-armor-assembly',
  'skills/minato-spiral-barrage',
  'skills/turalyon-grand-crusade',
]
export const DISPLAY_FIELDS = new Set([
  'name', 'description', 'targetText', 'keywords', 'effectTags', 'icon', 'image',
])

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_OUTPUT = resolve(SCRIPT_ROOT, 'docs/qa/RED-252-content-coverage.json')

const ID_PATTERN = /(?<![a-z0-9_-])(?:skill|rule|card|piece|pve)-[a-z0-9][a-z0-9-]*(?![a-z0-9_-])/gi
const CONTENT_CALL_PATTERN = /(?:add|remove)(?:skill|rule|card)|addcardtohand|(?:summon|spawn)(?:piece|byid)?|(?:create|register)(?:skill|rule|card|piece|template)|\.skills?\.add|\.rules?\.add|\.cards?\.(?:add|hand)/i
const DYNAMIC_PROOF_VERSION = 1
const PENDING_SOURCE_FIELDS = new Set(['effectCode'])

// This is deliberately a source hash, rather than an allow-list of IDs.  The
// frozen RED-252 fixture contains this legacy candidate, but the corresponding
// card is absent from the current card manifest.  If the source changes, the
// candidate becomes an ordinary unresolved dynamic reference until a new
// baseline proof is recorded. An explicitly verified compiled source also
// requires a valid graph artifact; an arbitrary graph is never an exemption.
const BASELINE_MISSING_DYNAMIC_CANDIDATES = new Map([
  ['skills/initial-draw|code', {
    sourceSha256: '46105653d5e4d1ef10ee3828026a5d5d5ede7bd8d340e6e01e4ff173954ff4ac',
    compiledSourceSha256: '6636f77940a01ed628dcd938c86c4f96b8cc74b16cc526cc2a84ac0a3ed1f05c',
    candidateIds: ['sample-active-card'],
    fixture: 'tests/game/fixtures/RED-252-legacy-content.json',
  }],
])

function fail(message) {
  throw new Error(`[content-graph-coverage] ${message}`)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Canonical JSON for stable audit hashes. Arrays retain semantic order. */
export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('cannot hash non-finite number')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort(compareCodePoints).map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  fail(`cannot canonicalize ${typeof value}`)
}

function compareCodePoints(left, right) {
  const a = [...left]
  const b = [...right]
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    if (a[index] < b[index]) return -1
    if (a[index] > b[index]) return 1
  }
  return a.length - b.length
}

export function sha256(value) {
  const bytes = typeof value === 'string' ? value : canonicalize(value)
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`invalid JSON ${path}: ${error.message}`)
  }
}

function loadLegacyContentFixture(root) {
  const fixturePath = resolve(root, LEGACY_CONTENT_FIXTURE)
  if (!existsSync(fixturePath)) return {
    available: false,
    path: posixPath(relative(root, fixturePath)),
    schemaVersion: null,
    baseSha: null,
    entries: new Map(),
  }
  const fixture = readJson(fixturePath)
  const entries = isPlainObject(fixture.entries)
    ? new Map(Object.entries(fixture.entries))
    : new Map()
  return {
    available: true,
    path: posixPath(relative(root, fixturePath)),
    schemaVersion: fixture.schemaVersion ?? null,
    baseSha: fixture.baseSha ?? null,
    entries,
  }
}

function posixPath(path) {
  return path.replaceAll('\\', '/')
}

function nodeName(node) {
  if (!node) return ''
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return `${nodeName(node.expression)}.${node.name.text}`
  if (ts.isElementAccessExpression(node)) return `${nodeName(node.expression)}[]`
  return node.getText()
}

function sourceLocation(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { line: position.line + 1, column: position.character + 1 }
}

function unwrap(node) {
  while (node && (
    ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node)
    || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node)
  )) node = node.expression
  return node
}

function isStaticString(node) {
  node = unwrap(node)
  return Boolean(node && ts.isStringLiteralLike(node))
}

function literalText(node) {
  node = unwrap(node)
  return isStaticString(node) ? node.text : null
}

function expressionHasStaticContentId(node, knownIds) {
  let found = false
  const visit = child => {
    if (found || !child) return
    const value = literalText(child)
    if (value && knownIds.has(value)) found = true
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function dynamicPrefixCandidates(node) {
  const candidates = new Set()
  const visit = child => {
    if (!child) return
    const value = literalText(child)
    if (value) {
      const match = value.match(/(?:skill|rule|card|piece|pve)-/gi)
      if (match) for (const prefix of match) candidates.add(prefix.toLowerCase())
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return [...candidates].sort(compareCodePoints)
}

function isDynamicExpression(node) {
  node = unwrap(node)
  return Boolean(node && (
    ts.isBinaryExpression(node)
    || ts.isTemplateExpression(node)
    || ts.isIdentifier(node)
    || ts.isPropertyAccessExpression(node)
    || ts.isElementAccessExpression(node)
    || ts.isConditionalExpression(node)
    || ts.isCallExpression(node)
  ))
}

function expectedGroupFromId(id) {
  if (id.startsWith('skill-')) return 'skills'
  if (id.startsWith('rule-')) return 'rules'
  if (id.startsWith('card-')) return 'cards'
  if (id.startsWith('piece-')) return 'pieces'
  if (id.startsWith('pve-')) return null
  return null
}

function relationFor(group, keyPath, context = '') {
  const path = `${keyPath} ${context}`.toLowerCase()
  if (group === 'pieces' && /summon|template|fallback/.test(path)) return 'summon-template'
  if (group === 'skills') return /transform/.test(path) ? 'transformed-skill' : 'skill-reference'
  if (group === 'rules') return /related|rule|player/.test(path) ? 'rule-reference' : 'rule-reference'
  if (group === 'cards') return /related|hand|card/.test(path) ? 'card-reference' : 'card-reference'
  return 'content-reference'
}

function contentIdFromValue(value, catalogs) {
  if (typeof value !== 'string') return null
  for (const group of GROUPS) if (catalogs[group].has(value)) return { group, id: value }
  return null
}

function addReference(state, reference) {
  const key = [reference.from, reference.fieldPath, reference.toGroup ?? '', reference.toId ?? '', reference.rawId ?? '', reference.relation, reference.evidenceKind].join('|')
  if (state.referenceKeys.has(key)) return
  state.referenceKeys.add(key)
  state.references.push(reference)
}

function addUnknown(state, unknown) {
  const key = [unknown.from, unknown.fieldPath, unknown.rawId, unknown.reason, unknown.line ?? '', unknown.column ?? ''].join('|')
  if (state.unknownKeys.has(key)) return
  state.unknownKeys.add(key)
  state.unknown.push(unknown)
}

function addDynamic(state, dynamic) {
  const key = [dynamic.from, dynamic.fieldPath, dynamic.line, dynamic.column, dynamic.expression, dynamic.reason].join('|')
  if (state.dynamicKeys.has(key)) return
  state.dynamicKeys.add(key)
  state.dynamic.push(dynamic)
}

function addGeneratedFamily(state, family) {
  const key = [family.from, family.fieldPath, family.familyPattern, family.sourceProof?.sourceSha256 ?? ''].join('|')
  if (state.generatedFamilyKeys.has(key)) return
  state.generatedFamilyKeys.add(key)
  state.generatedFamilies.push(family)
}

function addPendingSource(state, pending) {
  const key = [pending.from, pending.fieldPath, pending.sourceSha256].join('|')
  if (state.pendingSourceKeys.has(key)) return
  state.pendingSourceKeys.add(key)
  state.pendingSources.push(pending)
}

function addBaselineMissingCandidate(state, candidate) {
  const key = [candidate.from, candidate.fieldPath, candidate.candidateId, candidate.sourceProof?.sourceSha256 ?? ''].join('|')
  if (state.baselineMissingCandidateKeys.has(key)) return
  state.baselineMissingCandidateKeys.add(key)
  state.baselineMissingCandidates.push(candidate)
}

function propertyNameText(name) {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return null
}

function objectPropertyInitializer(object, propertyNames) {
  if (!object || !ts.isObjectLiteralExpression(unwrap(object))) return null
  const names = new Set(propertyNames)
  for (const property of unwrap(object).properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = propertyNameText(property.name)
    if (name && names.has(name)) return property.initializer
  }
  return null
}

function isCallNamed(node, expected) {
  return ts.isCallExpression(node) && nodeName(node.expression).toLowerCase() === expected.toLowerCase()
}

function findVariableInitializer(sourceFile, name, position) {
  let match = null
  const consider = (node, initializer) => {
    const start = node.getStart(sourceFile)
    if (start > position) return
    if (!match || start >= match.start) match = { start, initializer }
  }
  const visit = node => {
    if (ts.isVariableDeclaration(node) && propertyNameText(node.name) === name && node.initializer) {
      consider(node, node.initializer)
    }
    // The compiler's state-machine emitter hoists declarations and writes
    // their values in later switch cases. Treat an assignment to the same
    // local as the equivalent source-bound initializer.
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
      && node.left.text === name) {
      consider(node, node.right)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return match?.initializer ?? null
}

function staticArrayValues(sourceFile, node, position, seen = new Set()) {
  node = unwrap(node)
  if (!node) return null
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return null
    const nextSeen = new Set(seen)
    nextSeen.add(node.text)
    const initializer = findVariableInitializer(sourceFile, node.text, position)
    return initializer ? staticArrayValues(sourceFile, initializer, position, nextSeen) : null
  }
  if (ts.isElementAccessExpression(node)) return staticArrayValues(sourceFile, node.expression, position, seen)
  if (ts.isArrayLiteralExpression(node)) {
    const values = []
    for (const element of node.elements) {
      const direct = literalText(element)
      if (direct !== null) {
        values.push(direct)
        continue
      }
      const property = objectPropertyInitializer(element, ['value', 'id'])
      const objectValue = literalText(property)
      if (objectValue === null) return null
      values.push(objectValue)
    }
    return values
  }
  if (ts.isCallExpression(node) && isCallNamed(node, 'selectOption')) {
    const options = objectPropertyInitializer(node.arguments[0], ['options'])
    return options ? staticArrayValues(sourceFile, options, position, seen) : null
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literalText(node.whenTrue) !== null
      ? [literalText(node.whenTrue)]
      : staticArrayValues(sourceFile, node.whenTrue, position, seen)
    const whenFalse = literalText(node.whenFalse) !== null
      ? [literalText(node.whenFalse)]
      : staticArrayValues(sourceFile, node.whenFalse, position, seen)
    if (!whenTrue || !whenFalse) return null
    return [...whenTrue, ...whenFalse]
  }
  return null
}

function knownCandidateIds(state, values) {
  return [...new Set((values ?? []).filter(value => contentIdFromValue(value, state.catalogs)).sort(compareCodePoints))]
}

function allLiteralTexts(node) {
  const values = []
  const visit = child => {
    const value = literalText(child)
    if (value !== null) values.push(value)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return values
}

function hasIdentifier(node, name) {
  let found = false
  const visit = child => {
    if (found) return
    if (ts.isIdentifier(child) && child.text === name) found = true
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function hasJoinCall(node, name) {
  let found = false
  const visit = child => {
    if (found) return
    if (ts.isCallExpression(child)
      && child.arguments.length === 1
      && literalText(child.arguments[0]) === '-') {
      const callee = unwrap(child.expression)
      const calleeObject = ts.isPropertyAccessExpression(callee)
        ? unwrap(callee.expression)
        : ts.isElementAccessExpression(callee) && literalText(callee.argumentExpression) === 'join'
          ? unwrap(callee.expression)
          : null
      const calleeName = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) && literalText(callee.argumentExpression) === 'join'
          ? 'join'
          : null
      if (calleeName === 'join' && ts.isIdentifier(calleeObject) && calleeObject.text === name) {
      found = true
      }
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function armorGeneratedCandidateIds(sourceFile, argument, position) {
  if (!ts.isIdentifier(unwrap(argument)) || unwrap(argument).text !== 'id') return []
  const initializer = findVariableInitializer(sourceFile, 'id', position)
  if (!initializer || !hasJoinCall(initializer, 'selected') || !allLiteralTexts(initializer).includes('armor-')) return []
  const modules = findVariableInitializer(sourceFile, 'modules', position)
  const values = staticArrayValues(sourceFile, modules, position)
  const expected = new Set(['attack', 'defense', 'heal', 'speed'])
  if (!values || values.length !== expected.size || new Set(values).size !== expected.size || !values.every(value => expected.has(value))) return []
  const sorted = [...values].sort(compareCodePoints)
  const candidates = []
  for (let left = 0; left < sorted.length; left += 1) {
    for (let right = left + 1; right < sorted.length; right += 1) {
      candidates.push(`armor-${sorted[left]}-${sorted[right]}`)
    }
  }
  return candidates
}

function hasRafaamCursePrefixFilter(sourceFile) {
  let found = false
  const visit = node => {
    if (found) return
    if (ts.isCallExpression(node) && node.arguments.length === 1 && literalText(node.arguments[0]) === 'rafaam-curse') {
      const callee = unwrap(node.expression)
      const method = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee)
          ? literalText(callee.argumentExpression)
          : null
      const receiver = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
        ? unwrap(callee.expression)
        : null
      const receiverObject = receiver && ts.isElementAccessExpression(receiver)
        ? unwrap(receiver.expression)
        : receiver && ts.isPropertyAccessExpression(receiver)
          ? unwrap(receiver.expression)
          : null
      const receiverKey = receiver && ts.isElementAccessExpression(receiver)
        ? literalText(receiver.argumentExpression)
        : receiver && ts.isPropertyAccessExpression(receiver)
          ? receiver.name.text
          : null
      if (method === 'indexOf' && receiverKey === 'cardId' && ts.isIdentifier(receiverObject) && receiverObject.text === 'card') {
        found = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function plusParts(node) {
  node = unwrap(node)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...plusParts(node.left), ...plusParts(node.right)]
  }
  return [node]
}

function hasDateNow(node) {
  let found = false
  const visit = child => {
    if (found) return
    if (isCallNamed(child, 'Date.now')) found = true
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function generatedFamilies(sourceFile, source, dynamicName = null, options = {}) {
  const families = []
  const visit = node => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      && !(node.parent && ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
      && hasDateNow(node)) {
      const parts = plusParts(node)
      const prefixes = allLiteralTexts(node).filter(value => value.endsWith('-') && value.startsWith('rafaam-curse-'))
      const prefix = prefixes.sort((left, right) => right.length - left.length || compareCodePoints(left, right))[0]
      if (prefix) {
        const copyFamily = prefix === 'rafaam-curse-copy-' && parts.some(part => ts.isIdentifier(part) && part.text === 'i')
        const familyPattern = copyFamily
          ? '^rafaam-curse-copy-[0-9]+-[0-9]+$'
          : '^rafaam-curse-[0-9]+$'
        const location = sourceLocation(sourceFile, node)
        families.push({
          familyPattern,
          expression: node.getText(sourceFile).slice(0, 240),
          line: location.line,
          column: location.column,
          sourceSha256: sha256(source),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (families.length === 0
    && dynamicName
    && options.allowNormalizedCompilerAssignments === true
    && hasDateNow(sourceFile)) {
    const prefixes = [...new Set(allLiteralTexts(sourceFile).filter(value => value.endsWith('-') && value.startsWith('rafaam-curse-')))]
      .sort((left, right) => right.length - left.length || compareCodePoints(left, right))
    const assignment = (() => {
      let found = false
      const find = node => {
        if (found) return
        if (ts.isBinaryExpression(node)
          && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(node.left)
          && node.left.text === dynamicName) found = true
        ts.forEachChild(node, find)
      }
      find(sourceFile)
      return found
    })()
    const prefix = prefixes[0]
    if (assignment && prefix) {
      const copyFamily = prefix === 'rafaam-curse-copy-' && hasIdentifier(sourceFile, 'i')
      const familyPattern = copyFamily
        ? '^rafaam-curse-copy-[0-9]+-[0-9]+$'
        : '^rafaam-curse-[0-9]+$'
      let literalNode = null
      const findLiteral = node => {
        if (literalNode) return
        if (ts.isStringLiteralLike(node) && node.text === prefix) literalNode = node
        ts.forEachChild(node, findLiteral)
      }
      findLiteral(sourceFile)
      const location = literalNode ? sourceLocation(sourceFile, literalNode) : { line: 1, column: 1 }
      families.push({
        familyPattern,
        expression: `${dynamicName} derives from ${JSON.stringify(prefix)} + Date.now() through compiler assignments`,
        line: location.line,
        column: location.column,
        sourceSha256: sha256(source),
        proofKind: 'recognized-normalized-compiler-assignment',
      })
    }
  }
  return families
}

function dynamicResolution(state, sourceFile, source, owner, fieldPath, argument) {
  const expression = argument.getText(sourceFile).slice(0, 240)
  const sourceSha256 = sha256(source)
  const registeredProof = REGISTERED_GRAPH_PROOF_KEYS.includes(owner.nodeKey)
    ? registeredGraphProofFor(state.registeredGraphProofs, owner.nodeKey, fieldPath, owner.definition)
    : null
  const position = argument.getStart(sourceFile)
  const unwrappedArgument = unwrap(argument)
  const elementBase = ts.isElementAccessExpression(unwrappedArgument) ? unwrap(unwrappedArgument.expression) : null
  const initializer = ts.isIdentifier(unwrap(argument))
    ? findVariableInitializer(sourceFile, unwrap(argument).text, position)
    : elementBase && ts.isIdentifier(elementBase)
      ? findVariableInitializer(sourceFile, elementBase.text, position)
      : null
  let observedValues = initializer ? staticArrayValues(sourceFile, initializer, position) : null
  let candidateIds = knownCandidateIds(state, observedValues)
  let proofKind = observedValues ? 'recognized-array-or-options' : 'unresolved-expression'
  const generatedCandidateIds = armorGeneratedCandidateIds(sourceFile, argument, position)
  if (generatedCandidateIds.length > 0) {
    candidateIds = []
    observedValues = generatedCandidateIds
    proofKind = 'recognized-module-pair-combinations'
  }

  // Rafaam's amplifier consumes an existing curse card before optionally
  // cloning it.  The source's explicit prefix predicate binds this finite
  // catalog lookup to the current code; PVE cards stay outside the ordinary
  // candidate set.
  if (candidateIds.length === 0
    && ts.isIdentifier(unwrap(argument))
    && unwrap(argument).text === 'cardId'
    && (source.includes("card.cardId.indexOf('rafaam-curse')") || hasRafaamCursePrefixFilter(sourceFile))) {
    candidateIds = [...state.catalogs.cards.values()]
      .filter(entry => entry.scope === 'ordinary' && entry.id.startsWith('rafaam-curse-'))
      .map(entry => entry.id)
      .sort(compareCodePoints)
    if (candidateIds.length > 0) proofKind = 'recognized-prefix-filter-and-catalog'
  }

  const baseline = BASELINE_MISSING_DYNAMIC_CANDIDATES.get(`${owner.nodeKey}|${fieldPath}`)
  const baselineVerified = baseline?.sourceSha256 === sourceSha256
    || (baseline?.compiledSourceSha256 === sourceSha256 && owner.migration?.fields?.[fieldPath]?.status === 'graph-validated')
  const baselineMatches = baselineVerified
    ? (observedValues ?? []).filter(value => baseline.candidateIds.includes(value) && !state.knownIds.has(value)).sort(compareCodePoints)
    : []
  const unknownCandidateIds = [...new Set((observedValues ?? [])
    .filter(value => !state.knownIds.has(value)
      && !baselineMatches.includes(value)
      && !generatedCandidateIds.includes(value))
    .sort(compareCodePoints))]
  const dynamicName = ts.isIdentifier(unwrappedArgument) ? unwrappedArgument.text : null
  const copySourceProof = (() => {
    const wardEntry = state.catalogs.rules.get('rule-rafaam-curse-ward')
    const staticSourceEntry = state.catalogs.cards.get('rafaam-curse-sample')
    const wardField = wardEntry?.migration?.fields?.skillCode
    const wardSource = wardEntry?.definition?.skillCode
    let generatedSourceProof = { status: 'graph-source-unverified', reason: 'The generated ward source entry is unavailable.' }
    if (wardEntry && typeof wardSource === 'string' && wardField?.status === 'graph-validated') {
      const wardFile = ts.createSourceFile('rafaam-curse-ward-copy-proof.js', wardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      const family = generatedFamilies(wardFile, wardSource, 'cardId', { allowNormalizedCompilerAssignments: true })
        .find(candidate => candidate.familyPattern === '^rafaam-curse-[0-9]+$')
      if (family) generatedSourceProof = inspectSourceField(wardEntry.definition, 'skillCode', wardEntry.migration, 1, {
        registeredProof: registeredGraphProofFor(
          state.registeredGraphProofs,
          wardEntry.nodeKey,
          'skillCode',
          wardEntry.definition,
        ),
      })
    }
    return inspectRafaamCopySource(owner.definition, owner.migration, {
      staticSourceEntry,
      generatedSourceProof,
      registeredProof,
      ordinaryCurseIds: [...state.catalogs.cards.values()]
        .filter(entry => entry.scope === 'ordinary' && entry.id.startsWith('rafaam-curse-'))
        .map(entry => entry.id)
        .sort(compareCodePoints),
    })
  })()
  const familyEvidence = generatedFamilies(sourceFile, source, dynamicName, {
    allowNormalizedCompilerAssignments: owner.migration?.fields?.[fieldPath]?.status === 'graph-validated',
  }).map(family => {
    const sourceOptions = registeredProof ? { registeredProof } : {}
    const generatedSource = family.familyPattern === '^rafaam-curse-copy-[0-9]+-[0-9]+$'
      ? {
          ...inspectSourceField(owner.definition, fieldPath, owner.migration, 1, sourceOptions),
          status: copySourceProof.status,
          reason: copySourceProof.reason,
          copySourceProof,
        }
      : inspectSourceField(owner.definition, fieldPath, owner.migration, 1, sourceOptions)
    return {
      familyPattern: family.familyPattern,
      expression: family.expression,
      line: family.line,
      column: family.column,
      generatedExecutableStatus: generatedSource.status,
      generatedExecutableField: 'customCards.code',
      generatedSourceStatus: generatedSource.status,
      generatedSourceProof: generatedSource,
      sourceProof: {
        version: DYNAMIC_PROOF_VERSION,
        kind: family.proofKind ?? 'recognized-generated-prefix',
        sourceSha256,
        expression: family.expression,
        ...(family.proofKind === 'recognized-normalized-compiler-assignment' ? { normalizedCompilerAssignments: true } : {}),
        ...(family.proofKind === 'recognized-normalized-compiler-assignment' ? { compilerArtifactValidated: true } : {}),
      },
    }
  })
  if (familyEvidence.length > 0 && candidateIds.length === 0 && generatedCandidateIds.length === 0) {
    proofKind = familyEvidence.some(family => family.sourceProof.normalizedCompilerAssignments)
      ? 'recognized-normalized-compiler-assignment'
      : 'recognized-generated-prefix'
  }
  const normalizedCompilerAssignment = familyEvidence.some(family => family.sourceProof.normalizedCompilerAssignments)
  const sourceProof = {
    version: DYNAMIC_PROOF_VERSION,
    kind: proofKind,
    sourceSha256,
    expression,
    ...(observedValues?.length ? { observedValues: [...new Set(observedValues)].sort(compareCodePoints) } : {}),
    ...(normalizedCompilerAssignment ? { normalizedCompilerAssignments: true, compilerArtifactValidated: true } : {}),
  }
  const status = generatedCandidateIds.length > 0
    ? 'generated-candidate-set'
    : familyEvidence.length > 0 && candidateIds.length > 0
      ? 'resolved-with-generated-family'
      : familyEvidence.length > 0
        ? 'resolved-generated-family'
      : baselineMatches.length > 0
        ? 'resolved-with-baseline-missing'
        : candidateIds.length > 0
          ? 'resolved-finite-candidates'
          : 'unresolved'
  return {
    status,
    ...(candidateIds.length > 0 ? { candidateIds } : {}),
    ...(generatedCandidateIds.length > 0 ? { generatedCandidateIds } : {}),
    ...(baselineMatches.length > 0 ? { baselineMissingCandidateIds: baselineMatches } : {}),
    ...(unknownCandidateIds.length > 0 ? { unknownCandidateIds } : {}),
    ...(familyEvidence.length > 0 ? { generatedFamilies: familyEvidence } : {}),
    sourceProof,
    ...(baselineVerified ? { baselineFixture: baseline.fixture, baselineSourceSha256: baseline.sourceSha256 } : {}),
  }
}

function escapeRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function registerDynamicResolution(state, owner, fieldPath, location, resolution) {
  const registeredProof = REGISTERED_GRAPH_PROOF_KEYS.includes(owner.nodeKey)
    ? registeredGraphProofFor(state.registeredGraphProofs, owner.nodeKey, fieldPath, owner.definition)
    : null
  for (const candidateId of resolution.candidateIds ?? []) {
    const known = contentIdFromValue(candidateId, state.catalogs)
    if (!known) continue
    addReference(state, {
      from: owner.nodeKey,
      fromGroup: owner.group,
      fromId: owner.id,
      toGroup: known.group,
      toId: known.id,
      relation: relationFor(known.group, fieldPath, 'dynamic candidate'),
      fieldPath,
      evidenceKind: 'dynamic-finite-candidate',
      dynamicResolution: resolution.status,
      ...location,
    })
  }
  for (const candidateId of resolution.baselineMissingCandidateIds ?? []) {
    addBaselineMissingCandidate(state, {
      from: owner.nodeKey,
      fromGroup: owner.group,
      fromId: owner.id,
      fieldPath,
      candidateId,
      reason: 'frozen-baseline-candidate-missing-from-manifest',
      sourceProof: {
        ...resolution.sourceProof,
        candidateId,
        fixture: resolution.baselineFixture,
      },
      ...location,
    })
  }
  for (const candidateId of resolution.unknownCandidateIds ?? []) {
    addUnknown(state, {
      from: owner.nodeKey,
      fromGroup: owner.group,
      fromId: owner.id,
      rawId: candidateId,
      expectedGroup: expectedGroupFromId(candidateId),
      fieldPath,
      evidenceKind: 'dynamic-candidate',
      reason: 'dynamic-candidate-not-present-in-manifest',
      sourceProof: resolution.sourceProof,
      ...location,
    })
  }
  for (const family of resolution.generatedFamilies ?? []) {
    addGeneratedFamily(state, {
      from: owner.nodeKey,
      fromGroup: owner.group,
      fromId: owner.id,
      fieldPath,
      familyPattern: family.familyPattern,
      expression: family.expression,
      line: family.line,
      column: family.column,
      generatedExecutableStatus: family.generatedExecutableStatus,
      generatedExecutableField: family.generatedExecutableField,
      generatedSourceStatus: family.generatedSourceStatus,
      generatedSourceProof: family.generatedSourceProof,
      sourceProof: family.sourceProof,
    })
  }
  if ((resolution.generatedCandidateIds ?? []).length > 0) {
    const candidateIds = [...resolution.generatedCandidateIds].sort(compareCodePoints)
    const generatedSource = inspectSourceField(
      owner.definition,
      fieldPath,
      owner.migration,
      1,
      registeredProof ? { registeredProof } : {},
    )
    addGeneratedFamily(state, {
      from: owner.nodeKey,
      fromGroup: owner.group,
      fromId: owner.id,
      fieldPath,
      familyPattern: `^(?:${candidateIds.map(escapeRegexLiteral).join('|')})$`,
      candidateIds,
      line: location.line,
      column: location.column,
      generatedExecutableStatus: generatedSource.status,
      generatedExecutableField: 'customCards.code',
      generatedSourceStatus: generatedSource.status,
      generatedSourceProof: generatedSource,
      sourceProof: resolution.sourceProof,
    })
  }
}

function scanIdentifierText(state, owner, fieldPath, text, evidenceKind, location = null, context = '') {
  if (typeof text !== 'string') return
  // Most current IDs are unprefixed (for example `naruto-rasengan` and
  // `holy-charge`). Match against the manifest vocabulary first, then record
  // prefixed IDs that are not in the vocabulary as unknown references.
  const knownIds = [...state.knownIds].sort((left, right) => right.length - left.length || compareCodePoints(left, right))
  for (const rawId of knownIds) {
    let offset = text.indexOf(rawId)
    while (offset !== -1) {
      const before = offset === 0 ? '' : text[offset - 1]
      const after = text[offset + rawId.length] ?? ''
      if (!/[a-z0-9-]/i.test(before) && !/[a-z0-9-]/i.test(after)) {
        const known = contentIdFromValue(rawId, state.catalogs)
        addReference(state, {
          from: owner.nodeKey,
          fromGroup: owner.group,
          fromId: owner.id,
          toGroup: known.group,
          toId: known.id,
          relation: relationFor(known.group, fieldPath, context),
          fieldPath,
          evidenceKind,
          ...(location ?? {}),
        })
      }
      offset = text.indexOf(rawId, offset + rawId.length)
    }
  }
  // Unknown IDs are actionable only in code or explicit reference fields;
  // labels such as `skill-rule` in status metadata are not content links.
  const unknownContext = evidenceKind === 'code-literal'
    || /(?:skill|rule|card|piece|template|summon).*?(?:id|ids)|(?:related|transformed|fallback)/i.test(fieldPath)
  if (unknownContext) {
    const matches = text.matchAll(ID_PATTERN)
    for (const match of matches) {
      const rawId = match[0]
      const known = contentIdFromValue(rawId, state.catalogs)
      if (!known) {
        addUnknown(state, {
          from: owner.nodeKey,
          fromGroup: owner.group,
          fromId: owner.id,
          rawId,
          expectedGroup: expectedGroupFromId(rawId),
          fieldPath,
          evidenceKind,
          reason: 'literal-content-id-not-present-in-manifest',
          ...(location ?? {}),
        })
      }
    }
  }
}

function dynamicArgumentIndices(callee, argumentCount) {
  if (/addcardtohand/i.test(callee)) return argumentCount > 0 ? [0] : []
  if (/(?:add|remove)(?:skill|rule)|\.skills?\.add|\.rules?\.add|\.cards?\.(?:add|hand)/i.test(callee)) {
    return argumentCount > 0 ? [argumentCount - 1] : []
  }
  return [...Array(argumentCount).keys()]
}

function isCompilerControlString(node) {
  let current = node
  while (current?.parent) {
    const parent = current.parent
    if (ts.isCaseClause(parent) && parent.expression === current) return true
    if (ts.isVariableDeclaration(parent)
      && propertyNameText(parent.name) === '_pc'
      && parent.initializer === current) return true
    if (ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(parent.left)
      && parent.left.text === '_pc'
      && parent.right === current) return true
    // A compiler jump may be selected through a conditional expression, so
    // keep walking until its assignment to the program counter is reached.
    current = parent
  }
  return false
}

function hasEmbeddedExecutableSource(node) {
  return allLiteralTexts(node).some(value => /^\s*function\s+execute(?:Card|Skill|Rule)\s*\(/.test(value))
}

function isValidatedMaterializedSource(owner, fieldPath) {
  if (owner?.migration?.fields?.[fieldPath]?.status !== 'graph-validated') return false
  const graph = graphForField(owner.definition, fieldPath)
  if (!graph) return false
  return inspectTypedSourceGraph(graph).materializeSourceCount > 0
}

function isEmbeddedGeneratedSourceExpression(node, owner, fieldPath) {
  return isValidatedMaterializedSource(owner, fieldPath) && hasEmbeddedExecutableSource(node)
}

function isEmbeddedGeneratedSourceLiteral(node, owner, fieldPath) {
  if (!isValidatedMaterializedSource(owner, fieldPath)) return false
  let current = node
  while (current?.parent) {
    const parent = current.parent
    if (ts.isVariableDeclaration(parent)
      && propertyNameText(parent.name) === 'generatedCardSource'
      && parent.initializer === current) return true
    if (ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(parent.left)
      && (parent.left.text === 'generatedCardSource' || /^__rvb_content_graph_materialized_source_/.test(parent.left.text))
      && parent.right === current) return true
    current = parent
  }
  return false
}

function isTypedGeneratedSourceLiteral(node, owner, fieldPath) {
  if (owner?.migration?.fields?.[fieldPath]?.status !== 'graph-validated') return false
  const graph = graphForField(owner.definition, fieldPath)
  if (!graph || inspectTypedSourceGraph(graph).typedSourceCount === 0) return false
  return isExecutableSourceLiteral(node.text)
}

function scanCode(state, owner, fieldPath, source) {
  const fileName = `${owner.nodeKey.replaceAll('/', '_')}.${fieldPath.replaceAll('.', '_')}.js`
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const knownIds = state.knownIds
  const visit = node => {
    if (ts.isStringLiteralLike(node)) {
      if (!isCompilerControlString(node)
        && !isEmbeddedGeneratedSourceLiteral(node, owner, fieldPath)
        && !isTypedGeneratedSourceLiteral(node, owner, fieldPath)) {
        const loc = sourceLocation(sourceFile, node)
        scanIdentifierText(state, owner, fieldPath, node.text, 'code-literal', loc, node.parent ? node.parent.getText(sourceFile).slice(0, 160) : '')
      }
    }

    if (ts.isTemplateExpression(node)) {
      const loc = sourceLocation(sourceFile, node)
      const expression = node.getText(sourceFile)
      const prefixes = dynamicPrefixCandidates(node)
      if (prefixes.length > 0) {
        addDynamic(state, {
          from: owner.nodeKey,
          fromGroup: owner.group,
          fromId: owner.id,
          fieldPath,
          line: loc.line,
          column: loc.column,
          expression: expression.slice(0, 240),
          candidatePrefixes: prefixes,
          reason: 'template-expression-computes-content-id',
          resolution: {
            status: 'unresolved',
            sourceProof: {
              version: DYNAMIC_PROOF_VERSION,
              kind: 'unresolved-expression',
              sourceSha256: sha256(source),
              expression: expression.slice(0, 240),
            },
          },
        })
      }
    }

    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      && !isEmbeddedGeneratedSourceExpression(node, owner, fieldPath)) {
      const prefixes = dynamicPrefixCandidates(node)
      if (prefixes.length > 0 && !expressionHasStaticContentId(node, knownIds)) {
        const loc = sourceLocation(sourceFile, node)
        addDynamic(state, {
          from: owner.nodeKey,
          fromGroup: owner.group,
          fromId: owner.id,
          fieldPath,
          line: loc.line,
          column: loc.column,
          expression: node.getText(sourceFile).slice(0, 240),
          candidatePrefixes: prefixes,
          reason: 'binary-expression-computes-content-id',
          resolution: {
            status: 'unresolved',
            sourceProof: {
              version: DYNAMIC_PROOF_VERSION,
              kind: 'unresolved-expression',
              sourceSha256: sha256(source),
              expression: node.getText(sourceFile).slice(0, 240),
            },
          },
        })
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = nodeName(node.expression)
      const codeLikeCall = CONTENT_CALL_PATTERN.test(callee)
      if (codeLikeCall) {
        const selectedArguments = new Set(dynamicArgumentIndices(callee, node.arguments.length))
        for (const [argumentIndex, argument] of node.arguments.entries()) {
          if (!selectedArguments.has(argumentIndex)) continue
          if (!isDynamicExpression(argument)) continue
          if (expressionHasStaticContentId(argument, knownIds)) continue
          const prefixes = dynamicPrefixCandidates(argument)
          const loc = sourceLocation(sourceFile, argument)
          const resolution = dynamicResolution(state, sourceFile, source, owner, fieldPath, argument)
          const dynamic = {
            from: owner.nodeKey,
            fromGroup: owner.group,
            fromId: owner.id,
            fieldPath,
            line: loc.line,
            column: loc.column,
            expression: argument.getText(sourceFile).slice(0, 240),
            candidatePrefixes: prefixes,
            call: callee,
            reason: 'dynamic-content-id-argument',
            resolution,
          }
          addDynamic(state, dynamic)
          registerDynamicResolution(state, owner, fieldPath, loc, resolution)
        }
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function shouldScanDataString(key) {
  if (DISPLAY_FIELDS.has(key)) return false
  if (key === 'id') return false
  // Content IDs can be nested in future extension fields. Once display text
  // and object identity fields are removed, scanning every remaining string
  // is safer than maintaining a brittle list of camelCase field names.
  return true
}

function scanData(state, owner, value, path = '') {
  if (typeof value === 'string') {
    const key = path.split('.').at(-1) ?? ''
    if (shouldScanDataString(key)) scanIdentifierText(state, owner, path, value, 'data-literal')
    return
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanData(state, owner, child, path ? `${path}.${index}` : String(index)))
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    if (CODE_FIELDS.has(key) && typeof child === 'string') {
      scanCode(state, owner, childPath, child)
      continue
    }
    scanData(state, owner, child, childPath)
  }
}

function loadContentGraphValidator(root) {
  const sourcePath = resolve(root, 'electron-editor/content-graph.ts')
  if (!existsSync(sourcePath)) return {
    available: false,
    sourcePath: posixPath(relative(root, sourcePath)),
    reason: 'Content graph compiler source is not present; graph artifacts remain unverified.',
    assertContentGraphArtifact: null,
    assertContentGraphDocument: null,
    compileContentGraph: null,
    documentAvailable: false,
    documentSourcePath: posixPath(relative(root, resolve(root, 'electron-editor/content-graph-document.ts'))),
  }
  try {
    // The audit is plain Node ESM while the compiler is TypeScript and has no
    // runtime dependencies. Transpile the repository compiler in memory and
    // call its real assertion function; never infer validity from a field that
    // the content entry claims about itself.
    const output = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: sourcePath,
    }).outputText
    const compilerModule = { exports: {} }
    const require = createRequire(sourcePath)
    vm.runInNewContext(output, {
      module: compilerModule,
      exports: compilerModule.exports,
      require,
      __filename: sourcePath,
      __dirname: dirname(sourcePath),
      console,
    }, { filename: sourcePath })
    const assertion = compilerModule.exports.assertContentGraphArtifact
    const compiler = compilerModule.exports.compileContentGraph
    if (typeof assertion !== 'function') throw new Error('assertContentGraphArtifact export is unavailable')
    if (typeof compiler !== 'function') throw new Error('compileContentGraph export is unavailable')
    const documentSourcePath = resolve(root, 'electron-editor/content-graph-document.ts')
    let documentAssertion = null
    let documentReason = 'Content graph document adapter source is not present; additional graph entries remain unverified.'
    if (existsSync(documentSourcePath)) {
      try {
        const documentOutput = ts.transpileModule(readFileSync(documentSourcePath, 'utf8'), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
          },
          fileName: documentSourcePath,
        }).outputText
        const documentModule = { exports: {} }
        const documentRequireBase = createRequire(documentSourcePath)
        const documentRequire = request => request === './content-graph'
          ? compilerModule.exports
          : documentRequireBase(request)
        vm.runInNewContext(documentOutput, {
          module: documentModule,
          exports: documentModule.exports,
          require: documentRequire,
          __filename: documentSourcePath,
          __dirname: dirname(documentSourcePath),
          console,
        }, { filename: documentSourcePath })
        documentAssertion = documentModule.exports.assertContentGraphDocument
        if (typeof documentAssertion !== 'function') throw new Error('assertContentGraphDocument export is unavailable')
        documentReason = 'Loaded and executing the repository content graph document assertion.'
      } catch (error) {
        documentAssertion = null
        documentReason = `Content graph document adapter could not be loaded: ${error.message}`
      }
    }
    return {
      available: true,
      sourcePath: posixPath(relative(root, sourcePath)),
      compilerVersion: GRAPH_COMPILER_VERSION,
      reason: `Loaded and executing the repository content graph compiler assertion. ${documentReason}`,
      assertContentGraphArtifact: assertion,
      assertContentGraphDocument: documentAssertion,
      compileContentGraph: compiler,
      documentAvailable: typeof documentAssertion === 'function',
      documentSourcePath: posixPath(relative(root, documentSourcePath)),
    }
  } catch (error) {
    return {
      available: false,
      sourcePath: posixPath(relative(root, sourcePath)),
      reason: `Content graph compiler could not be loaded: ${error.message}`,
      assertContentGraphArtifact: null,
      assertContentGraphDocument: null,
      compileContentGraph: null,
      documentAvailable: false,
      documentSourcePath: posixPath(relative(root, resolve(root, 'electron-editor/content-graph-document.ts'))),
    }
  }
}

const registeredGraphProofCache = new Map()

/**
 * Build the small, explicitly registered RED-252 graph corpus from the frozen
 * source.  The audit is intentionally plain Node, while the migration
 * builders are TypeScript modules.  Running one short-lived tsx child keeps
 * this proof independent from the current data graph and avoids duplicating
 * the migration builders in the inventory script.
 */
export function loadRegisteredGraphProofs(root) {
  const cached = registeredGraphProofCache.get(root)
  if (cached) return cached
  const unavailable = reason => {
    const result = {
      available: false,
      reason,
      entries: {},
    }
    registeredGraphProofCache.set(root, result)
    return result
  }
  const source = [
    "import fs from 'node:fs'",
    "import * as generatedModule from './scripts/migrate-generated-content-graphs.ts'",
    "import * as pendingModule from './electron-editor/content-graph-pending.ts'",
    "import * as documentModule from './electron-editor/content-graph-document.ts'",
    'const generated = generatedModule.default ?? generatedModule',
    'const pending = pendingModule.default ?? pendingModule',
    'const document = documentModule.default ?? documentModule',
    "const fixture = JSON.parse(fs.readFileSync('./tests/game/fixtures/RED-252-legacy-content.json', 'utf8'))",
    'const result = {}',
    'for (const id of generated.GENERATED_CONTENT_IDS) {',
    '  const legacy = fixture.entries[id]',
    '  const change = generated.buildGeneratedContentMigration(id, { root: process.cwd(), legacy, current: legacy })',
    '  result[id] = { field: change.field, graph: change.graph, compiled: change.document[change.field], families: change.families }',
    '}',
    "for (const id of ['skills/minato-spiral-barrage', 'skills/turalyon-grand-crusade']) {",
    '  const legacy = fixture.entries[id]',
    '  const built = pending.buildContentGraphWithPending(String(legacy.code), \'skill\', `${id}.js`)',
    "  const migrated = document.applyContentGraph(legacy, built.graph, 'code')",
    "  result[id] = { field: 'code', graph: built.graph, compiled: migrated.code, sourcePairs: built.sourcePairs }",
    '}',
    'process.stdout.write(JSON.stringify(result))',
  ].join('\n')
  try {
    const output = execFileSync(process.execPath, [
      '--import', 'tsx',
      '--input-type=module',
      '-e', source,
    ], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim()
    const rawEntries = JSON.parse(output)
    const entries = {}
    for (const key of REGISTERED_GRAPH_PROOF_KEYS) {
      const entry = rawEntries[key]
      if (!isPlainObject(entry) || !isPlainObject(entry.graph) || typeof entry.field !== 'string' || typeof entry.compiled !== 'string') {
        return unavailable(`Registered graph builder did not return a complete proof entry for ${key}.`)
      }
      entries[key] = {
        field: entry.field,
        graph: entry.graph,
        compiled: entry.compiled,
        expectedGraphSha256: sha256(entry.graph),
        expectedCompiledSourceSha256: sha256(entry.compiled),
        ...(Array.isArray(entry.families) ? {
          expectedFamilyGraphSha256: entry.families.map(family => sha256(family.graph)),
        } : {}),
        ...(Array.isArray(entry.sourcePairs) ? {
          expectedPendingSourcePairs: entry.sourcePairs.map(pair => ({
            legacySha256: sha256(pair.legacy),
            compiledSha256: sha256(pair.compiled),
          })),
        } : {}),
      }
    }
    const result = {
      available: true,
      reason: 'Registered generated and pending migration builders reproduced the graph corpus from the frozen RED-252 source.',
      entries,
    }
    registeredGraphProofCache.set(root, result)
    return result
  } catch (error) {
    return unavailable(`Registered graph builders could not be loaded: ${error.message}`)
  }
}

export function registeredGraphProofFor(proofs, nodeKey, field, definition) {
  const expected = proofs?.entries?.[nodeKey]
  const actualGraph = graphForField(definition, field)
  if (!proofs?.available || !expected || expected.field !== field || !actualGraph) {
    return {
      status: 'graph-source-unverified',
      nodeKey,
      field,
      expectedGraphSha256: expected?.expectedGraphSha256 ?? null,
      actualGraphSha256: actualGraph ? sha256(actualGraph) : null,
      expectedCompiledSourceSha256: expected?.expectedCompiledSourceSha256 ?? null,
      actualCompiledSourceSha256: typeof definition?.[field] === 'string' ? sha256(definition[field]) : null,
      reason: !proofs?.available
        ? proofs?.reason ?? 'Registered graph proof is unavailable.'
        : !expected
          ? `No registered frozen graph proof exists for ${nodeKey}.${field}.`
          : expected.field !== field
            ? `Registered frozen graph proof targets ${expected.field}, not ${field}.`
            : `Definition ${nodeKey}.${field} has no graph artifact.`,
    }
  }
  const actualGraphSha256 = sha256(actualGraph)
  const actualCompiledSourceSha256 = typeof definition[field] === 'string' ? sha256(definition[field]) : null
  const graphMatches = canonicalize(actualGraph) === canonicalize(expected.graph)
  const compiledMatches = definition[field] === expected.compiled
  const status = graphMatches && compiledMatches ? 'graph-source-validated' : 'graph-source-unverified'
  return {
    status,
    nodeKey,
    field,
    expectedGraphSha256: expected.expectedGraphSha256,
    actualGraphSha256,
    expectedCompiledSourceSha256: expected.expectedCompiledSourceSha256,
    actualCompiledSourceSha256,
    graphMatches,
    compiledMatches,
    ...(expected.expectedFamilyGraphSha256 ? { expectedFamilyGraphSha256: expected.expectedFamilyGraphSha256 } : {}),
    ...(expected.expectedPendingSourcePairs ? { expectedPendingSourcePairs: expected.expectedPendingSourcePairs } : {}),
    reason: status === 'graph-source-validated'
      ? 'The actual graph and compiler output exactly match the independently rebuilt graph from the frozen RED-252 source.'
      : `The actual ${field} graph or compiled source differs from the independently rebuilt frozen graph (graphMatches=${graphMatches}, compiledMatches=${compiledMatches}).`,
  }
}

function inlineCodeFields(definition) {
  return [...CODE_FIELDS].filter(field => typeof definition?.[field] === 'string')
}

function migrationResult({ sourceKind, codeFields, status, graphArtifact, reason, targetField = null, targetStatus = null, fieldOverrides = {} }) {
  const fields = Object.fromEntries(codeFields.map(field => {
    if (fieldOverrides[field]) return [field, fieldOverrides[field]]
    if (field === targetField && targetStatus) {
      return [field, {
        status: targetStatus,
        graphArtifact,
        reason,
      }]
    }
    return [field, {
      status: 'legacy',
      graphArtifact: graphArtifact === 'missing' ? 'missing' : 'not-targeted',
      reason: graphArtifact === 'missing'
        ? `No explicit contentGraph artifact for inline field "${field}"; the legacy field remains authoritative.`
        : targetField
          ? `contentGraphField targets "${targetField}"; inline field "${field}" remains legacy until it has its own validated artifact.`
          : `No validated contentGraph field targets inline field "${field}"; the legacy field remains authoritative.`,
    }]
  }))
  return {
    sourceKind,
    codeFields,
    status,
    graphArtifact,
    reason,
    fields,
  }
}

function hasOwn(value, key) {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key))
}

function entryPreflight(entry, field) {
  if (!isPlainObject(entry)) throw new Error(`contentGraphEntries.${field} must be an object.`)
  if (!hasOwn(entry, 'graph')) throw new Error(`contentGraphEntries.${field}.graph is missing.`)
  if (entry.compilerVersion !== GRAPH_COMPILER_VERSION) {
    throw new Error(`contentGraphEntries.${field}.compilerVersion must equal ${GRAPH_COMPILER_VERSION}.`)
  }
}

function validateExtraEntry(definition, field, entry, validator) {
  entryPreflight(entry, field)
  if (!validator?.available || typeof validator.assertContentGraphArtifact !== 'function') {
    throw new Error(validator?.reason ?? 'Compiler validator is unavailable.')
  }
  validator.assertContentGraphArtifact({
    ...definition,
    contentGraph: entry.graph,
    contentGraphField: field,
    contentGraphCompilerVersion: entry.compilerVersion,
  })
}

function migrationArtifact(definition, validator) {
  const hasPrimaryGraph = hasOwn(definition, 'contentGraph')
  const graph = hasPrimaryGraph && isPlainObject(definition.contentGraph) ? definition.contentGraph : null
  const hasEntries = hasOwn(definition, 'contentGraphEntries')
  const entries = hasEntries && isPlainObject(definition.contentGraphEntries) ? definition.contentGraphEntries : null
  const codeFields = inlineCodeFields(definition)
  const sourceKind = codeFields.length === 0 ? 'declarative' : 'inline-fields'
  const entryFields = entries ? Object.keys(entries) : []
  const fieldOverrides = {}
  const setField = (field, status, graphArtifact, reason) => {
    if (codeFields.includes(field)) fieldOverrides[field] = { status, graphArtifact, reason }
  }

  if (hasEntries && !entries) {
    return migrationResult({
      sourceKind,
      codeFields,
      status: 'graph-unverified',
      graphArtifact: 'invalid-entries',
      reason: 'contentGraphEntries must be an object keyed by generated inline fields.',
    })
  }

  if (!hasPrimaryGraph && !hasEntries) {
    if (sourceKind === 'declarative') return {
      sourceKind,
      codeFields,
      status: 'declarative',
      graphArtifact: 'not-applicable',
      reason: 'No inline code fields; code migration is not applicable. Declarative effects and dependencies still require separate validation.',
      fields: {},
    }
    return migrationResult({
      sourceKind,
      codeFields,
      status: 'legacy',
      graphArtifact: 'missing',
      reason: 'No explicit contentGraph artifact; inline code fields remain authoritative legacy sources.',
    })
  }

  if (!graph && sourceKind === 'declarative') return {
    sourceKind,
    codeFields,
    status: 'graph-unverified',
    graphArtifact: 'target-field-missing',
    reason: 'A graph artifact is present on a declarative definition with no inline code field to validate.',
    fields: {},
  }

  // A document containing only independent entries is supported for audit
  // purposes, although applyContentGraphField normally creates a primary
  // compatibility artifact first.
  if (!graph) {
    if (!validator?.documentAvailable || typeof validator.assertContentGraphDocument !== 'function') {
      for (const field of entryFields) setField(field, 'graph-unverified', 'document-validator-unavailable', 'The document validator is unavailable; this extra graph entry cannot be counted as validated.')
      return migrationResult({
        sourceKind,
        codeFields,
        status: 'graph-unverified',
        graphArtifact: 'document-validator-unavailable',
        reason: validator?.reason ?? 'The document validator is unavailable for contentGraphEntries.',
        fieldOverrides,
      })
    }
    try {
      validator.assertContentGraphDocument(definition)
      for (const field of entryFields) setField(field, 'graph-validated', 'validated', `The document compiler assertion accepted the independent graph entry for inline field "${field}".`)
    } catch (error) {
      for (const field of entryFields) {
        try {
          validateExtraEntry(definition, field, entries[field], validator)
          setField(field, 'graph-validated', 'validated', `The compiler assertion accepted the independent graph entry for inline field "${field}".`)
        } catch (entryError) {
          setField(field, 'graph-unverified', 'compiler-rejected', `Compiler artifact assertion failed for inline field "${field}": ${entryError.message}`)
        }
      }
      return migrationResult({
        sourceKind,
        codeFields,
        status: 'graph-unverified',
        graphArtifact: 'document-rejected',
        reason: `Content graph document assertion failed: ${error.message}`,
        fieldOverrides,
      })
    }
    const allFieldsValidated = codeFields.length > 0 && codeFields.every(field => fieldOverrides[field]?.status === 'graph-validated')
    return migrationResult({
      sourceKind,
      codeFields,
      status: allFieldsValidated ? 'graph-validated' : 'graph-partial',
      graphArtifact: 'validated',
      reason: allFieldsValidated
        ? 'The document compiler assertion accepted every inline field graph entry.'
        : 'Some inline fields have independent graph entries, while other inline fields remain legacy.',
      fieldOverrides,
    })
  }

  // A graph attached to a definition with no string-valued target field is
  // itself unverified. Keeping sourceKind=declarative here makes the reason
  // visible without treating an invalid graph as a code migration.
  const targetField = typeof definition.contentGraphField === 'string' && definition.contentGraphField.length > 0
    ? definition.contentGraphField
    : null
  const unverified = (graphArtifact, reason) => migrationResult({
    sourceKind,
    codeFields,
    status: 'graph-unverified',
    graphArtifact,
    reason,
    targetField: targetField && codeFields.includes(targetField) ? targetField : null,
    targetStatus: targetField && codeFields.includes(targetField) ? 'graph-unverified' : null,
  })

  if (graph.version !== CONTENT_GRAPH_VERSION) return unverified(
    'invalid-version',
    `contentGraph version ${String(graph.version)} is not ${CONTENT_GRAPH_VERSION}.`,
  )
  if (!targetField) return unverified(
    'missing-field-metadata',
    'contentGraphField is required so the compiler output has one explicit target field; every other inline field remains legacy.',
  )
  if (!codeFields.includes(targetField)) return unverified(
    'target-field-missing',
    `contentGraphField "${targetField}" does not name a string-valued inline field on this definition.`,
  )
  if (definition.contentGraphCompilerVersion !== GRAPH_COMPILER_VERSION) return unverified(
    'missing-compiler-metadata',
    `contentGraphCompilerVersion must equal ${GRAPH_COMPILER_VERSION}.`,
  )
  if (!validator?.available || typeof validator.assertContentGraphArtifact !== 'function') return unverified(
    'validator-unavailable',
    validator?.reason ?? 'Compiler validator is unavailable.',
  )
  try {
    // The repository assertion checks only contentGraphField. Sibling fields
    // are deliberately reported as legacy below until they get their own
    // explicit artifact and compiler validation.
    validator.assertContentGraphArtifact(definition)
  } catch (error) {
    return unverified(
      'compiler-rejected',
      `Compiler artifact assertion failed for inline field "${targetField}": ${error.message}`,
    )
  }

  const duplicatePrimaryEntry = entryFields.includes(targetField)
  if (duplicatePrimaryEntry) {
    setField(targetField, 'graph-unverified', 'duplicate-primary-entry', `Primary contentGraph field "${targetField}" is duplicated in contentGraphEntries.`)
    return migrationResult({
      sourceKind,
      codeFields,
      status: 'graph-unverified',
      graphArtifact: 'duplicate-primary-entry',
      reason: `Primary contentGraph field "${targetField}" must not also appear in contentGraphEntries.`,
      targetField,
      targetStatus: 'graph-unverified',
      fieldOverrides,
    })
  }

  if (entryFields.length > 0) {
    if (!validator?.documentAvailable || typeof validator.assertContentGraphDocument !== 'function') {
      setField(targetField, 'graph-validated', 'validated', `The repository compiler assertion accepted the primary inline field "${targetField}".`)
      for (const field of entryFields) setField(field, 'graph-unverified', 'document-validator-unavailable', `The document validator is unavailable; extra inline field "${field}" remains unverified.`)
      return migrationResult({
        sourceKind,
        codeFields,
        status: 'graph-unverified',
        graphArtifact: 'document-validator-unavailable',
        reason: validator?.reason ?? 'The document validator is unavailable for contentGraphEntries.',
        targetField,
        targetStatus: 'graph-validated',
        fieldOverrides,
      })
    }
    try {
      validator.assertContentGraphDocument(definition)
      setField(targetField, 'graph-validated', 'validated', `The document compiler assertion accepted the primary inline field "${targetField}".`)
      for (const field of entryFields) setField(field, 'graph-validated', 'validated', `The document compiler assertion accepted the independent graph entry for inline field "${field}".`)
    } catch (error) {
      setField(targetField, 'graph-validated', 'validated', `The repository compiler assertion accepted the primary inline field "${targetField}"; the document assertion failed on another artifact.`)
      for (const field of entryFields) {
        try {
          validateExtraEntry(definition, field, entries[field], validator)
          setField(field, 'graph-validated', 'validated', `The compiler assertion accepted the independent graph entry for inline field "${field}".`)
        } catch (entryError) {
          setField(field, 'graph-unverified', 'compiler-rejected', `Compiler artifact assertion failed for inline field "${field}": ${entryError.message}`)
        }
      }
      return migrationResult({
        sourceKind,
        codeFields,
        status: 'graph-unverified',
        graphArtifact: 'document-rejected',
        reason: `Content graph document assertion failed: ${error.message}`,
        targetField,
        targetStatus: 'graph-validated',
        fieldOverrides,
      })
    }
    const allFieldsValidated = codeFields.length > 0 && codeFields.every(field => fieldOverrides[field]?.status === 'graph-validated' || field === targetField)
    return migrationResult({
      sourceKind,
      codeFields,
      status: allFieldsValidated ? 'graph-validated' : 'graph-partial',
      graphArtifact: 'validated',
      reason: allFieldsValidated
        ? 'The document compiler assertion accepted every inline field graph artifact.'
        : `The document compiler assertion accepted the primary field "${targetField}" and some extra entries; remaining inline fields are legacy.`,
      targetField,
      targetStatus: 'graph-validated',
      fieldOverrides,
    })
  }

  const status = codeFields.length === 1 ? 'graph-validated' : 'graph-partial'
  const reason = codeFields.length === 1
    ? `The repository compiler assertion accepted the explicit graph artifact for inline field "${targetField}".`
    : `The repository compiler assertion accepted inline field "${targetField}"; sibling inline fields remain legacy and require separate artifacts.`
  return migrationResult({
    sourceKind,
    codeFields,
    status,
    graphArtifact: 'validated',
    reason,
    targetField,
    targetStatus: 'graph-validated',
  })
}

export function loadContentGraphArtifactValidator(root = SCRIPT_ROOT) {
  return loadContentGraphValidator(resolve(root))
}

export function classifyMigration(definition, options = {}) {
  const validator = options.validator ?? loadContentGraphValidator(options.root ?? SCRIPT_ROOT)
  return migrationArtifact(definition, validator)
}

function isExecutableSourceLiteral(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  const tree = ts.createSourceFile('legacy-generated-source.js', `(${value})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const statement = tree.statements[0]
  if (!statement || !ts.isExpressionStatement(statement)) return false
  const expression = unwrap(statement.expression)
  return Boolean(expression && (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)))
}

/**
 * Inspect a validated graph for executable child sources.  A graph's mere
 * presence is not enough: generated card and pending code must be represented
 * by a typed `source` expression or `materializeSource` node.  String values
 * stored under executable `code`/`effectCode` entries are retained as explicit
 * legacy evidence.
 */
export function inspectTypedSourceGraph(graph) {
  const result = {
    sourceExpressionCount: 0,
    materializeSourceCount: 0,
    sourceExpressionPaths: [],
    materializeSourcePaths: [],
    rawExecutableSourceLiterals: [],
    unresolvedSinkPaths: [],
  }
  const sourcePaths = new Set()
  const materializePaths = new Set()
  const rawPaths = new Set()
  const unresolvedSinkPaths = new Set()
  const merge = (nested, prefix) => {
    for (const path of nested.sourceExpressionPaths) {
      const mergedPath = `${prefix}${path.slice(1)}`
      if (sourcePaths.has(mergedPath)) continue
      sourcePaths.add(mergedPath)
      result.sourceExpressionPaths.push(mergedPath)
    }
    for (const path of nested.materializeSourcePaths) {
      const mergedPath = `${prefix}${path.slice(1)}`
      if (materializePaths.has(mergedPath)) continue
      materializePaths.add(mergedPath)
      result.materializeSourcePaths.push(mergedPath)
    }
    for (const raw of nested.rawExecutableSourceLiterals) {
      const mergedPath = `${prefix}${raw.path.slice(1)}`
      if (rawPaths.has(mergedPath)) continue
      rawPaths.add(mergedPath)
      result.rawExecutableSourceLiterals.push({ ...raw, path: mergedPath })
    }
    for (const path of nested.unresolvedSinkPaths ?? []) {
      result.unresolvedSinkPaths.push(`${prefix}${path.slice(1)}`)
    }
  }
  const recordRaw = (value, path) => {
    if (!isExecutableSourceLiteral(value)) return
    if (rawPaths.has(path)) return
    rawPaths.add(path)
    result.rawExecutableSourceLiterals.push({
      path,
      sourceSha256: sha256(value),
      sourceLength: value.length,
    })
  }
  const graphBindings = currentGraph => {
    const bindings = new Map()
    const poisoned = new Set()
    const collect = (value, path) => {
      if (!value || typeof value !== 'object') return
      if (value.kind === 'bind' && typeof value.name === 'string' && value.expr) {
        const list = bindings.get(value.name) ?? []
        list.push({ value: value.expr, path: `${path}.expr` })
        bindings.set(value.name, list)
      }
      if (value.kind === 'materializeSource' && typeof value.result === 'string' && isPlainObject(value.graph)) {
        const list = bindings.get(value.result) ?? []
        list.push({ value, path })
        bindings.set(value.result, list)
      }
      if (value.kind === 'set'
        && value.target?.kind === 'ref'
        && typeof value.target.name === 'string') {
        if (value.operator !== '=' || !value.value) {
          poisoned.add(value.target.name)
        } else {
          const list = bindings.get(value.target.name) ?? []
          list.push({ value: value.value, path: `${path}.value` })
          bindings.set(value.target.name, list)
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (value.kind === 'object' && key === 'entries') continue
        if (key === 'graph' && (value.kind === 'source' || value.kind === 'materializeSource')) continue
        collect(child, `${path}.${key}`)
      }
      if (value.kind === 'object' && value.entries !== undefined) {
        const entries = Array.isArray(value.entries)
          ? value.entries
          : Object.entries(value.entries).map(([key, child]) => ({ key, value: child }))
        for (const entry of entries) {
          if (!entry || typeof entry.key !== 'string') continue
          collect(entry.value, `${path}.entries.${entry.key}`)
        }
      }
    }
    collect(currentGraph, '$')
    return { bindings, poisoned }
  }
  const analyzeGraph = (currentGraph, graphPath) => {
    if (!isPlainObject(currentGraph)) return
    const bindingInfo = graphBindings(currentGraph)
    const bindings = bindingInfo.bindings
    const poisonedBindings = bindingInfo.poisoned
    const activeRefs = new Set()
    const analyze = (value, path, sink = false) => {
      if (!value || typeof value !== 'object') return
      if (value.kind === 'source' && isPlainObject(value.graph)) {
        if (!sink) return
        if (!sourcePaths.has(path)) {
          sourcePaths.add(path)
          result.sourceExpressionPaths.push(path)
        }
        const child = inspectTypedSourceGraph(value.graph)
        merge(child, path)
        return
      }
      if (value.kind === 'ref' && typeof value.name === 'string' && sink) {
        if (activeRefs.has(value.name)) return
        const definitions = bindings.get(value.name) ?? []
        if (poisonedBindings.has(value.name) || definitions.length !== 1) {
          unresolvedSinkPaths.add(path)
          return
        }
        activeRefs.add(value.name)
        analyze(definitions[0].value, definitions[0].path, true)
        activeRefs.delete(value.name)
        return
      }
      if (value.kind === 'literal') {
        if (sink) {
          if (isExecutableSourceLiteral(value.value)) recordRaw(value.value, path)
          else unresolvedSinkPaths.add(path)
        }
        return
      }
      if (value.kind === 'materializeSource' && isPlainObject(value.graph)) {
        if (!sink) return
        if (!materializePaths.has(path)) {
          materializePaths.add(path)
          result.materializeSourcePaths.push(path)
        }
        const child = inspectTypedSourceGraph(value.graph)
        merge(child, path)
        return
      }
      if (value.kind === 'object' && value.entries !== undefined) {
        const entries = Array.isArray(value.entries)
          ? value.entries
          : Object.entries(value.entries).map(([key, child]) => ({ key, value: child }))
        for (const entry of entries) {
          if (!entry || typeof entry.key !== 'string') continue
          const childSink = entry.key === 'code' || PENDING_SOURCE_FIELDS.has(entry.key)
          analyze(entry.value, `${path}.entries.${entry.key}`, childSink)
        }
        return
      }
      if (sink) {
        // Source provenance is deliberately closed over the small set of
        // direct graph forms above.  A call/get/binary/conditional/etc. at an
        // executable sink may construct source text or select an unknown
        // value, so it cannot satisfy a migration proof.
        unresolvedSinkPaths.add(path)
        return
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === 'graph' && (value.kind === 'source' || value.kind === 'materializeSource')) continue
        analyze(child, `${path}.${key}`, sink)
      }
    }
    const nodes = Array.isArray(currentGraph.nodes) ? currentGraph.nodes : []
    const isCodeSinkTarget = target => {
      if (!target || typeof target !== 'object') return false
      if (target.kind === 'get' && (target.key === 'code' || PENDING_SOURCE_FIELDS.has(target.key))) return true
      if (target.kind !== 'index' || target.object?.kind !== 'get' || target.object.key !== 'customCards') return false
      return true
    }
    const hasExecutableSink = value => {
      if (!value || typeof value !== 'object') return false
      if (value.kind === 'object' && value.entries !== undefined) {
        const entries = Array.isArray(value.entries)
          ? value.entries
          : Object.entries(value.entries).map(([key, child]) => ({ key, value: child }))
        return entries.some(entry => entry && typeof entry.key === 'string'
          && (entry.key === 'code' || PENDING_SOURCE_FIELDS.has(entry.key)))
      }
      return false
    }
    for (let index = 0; index < nodes.length; index += 1) {
      analyze(nodes[index], `${graphPath}.nodes.${index}`, false)
      const node = nodes[index]
      if (!node || typeof node !== 'object') continue
      if (node.kind === 'return') {
        if (node.value) analyze(node.value, `${graphPath}.nodes.${index}.value`, hasExecutableSink(node.value))
      }
      if (node.kind === 'set' && node.value && isCodeSinkTarget(node.target)) {
        analyze(node.value, `${graphPath}.nodes.${index}.value`, true)
      }
      if (node.kind === 'materializeSource' && isPlainObject(node.graph)) {
        // The materialized graph only becomes an executable source when its
        // result is consumed by a code/effectCode sink.  Leave it indexed for
        // the binding resolver above; an unused node must not count.
      }
    }
  }
  analyzeGraph(graph, '$')
  result.sourceExpressionCount = result.sourceExpressionPaths.length
  result.materializeSourceCount = result.materializeSourcePaths.length
  result.unresolvedSinkPaths = [...new Set([
    ...result.unresolvedSinkPaths,
    ...unresolvedSinkPaths,
  ])].sort(compareCodePoints)
  return {
    ...result,
    typedSourceCount: result.sourceExpressionCount + result.materializeSourceCount,
  }
}

function graphForField(definition, field) {
  if (definition?.contentGraphField === field && isPlainObject(definition.contentGraph)) return definition.contentGraph
  const entry = definition?.contentGraphEntries?.[field]
  if (isPlainObject(entry?.graph)) return entry.graph
  return null
}

function migrationFieldStatus(migration, field) {
  return migration?.fields?.[field]?.status ?? 'legacy'
}

/** Return the source proof used by generated-family and pending audits. */
export function inspectSourceField(definition, field, migration, expectedSourceCount = 1, options = {}) {
  const graph = graphForField(definition, field)
  const graphInspection = graph ? inspectTypedSourceGraph(graph) : {
    sourceExpressionCount: 0,
    materializeSourceCount: 0,
    sourceExpressionPaths: [],
    materializeSourcePaths: [],
    rawExecutableSourceLiterals: [],
    unresolvedSinkPaths: [],
    typedSourceCount: 0,
  }
  const artifactStatus = migrationFieldStatus(migration, field)
  const registeredProof = options.registeredProof
  const actualGraphSha256 = graph ? sha256(graph) : null
  const actualCompiledSourceSha256 = typeof definition?.[field] === 'string' ? sha256(definition[field]) : null
  const exactRegisteredProof = registeredProof?.status === 'graph-source-validated'
    && registeredProof.expectedGraphSha256 === actualGraphSha256
    && registeredProof.expectedCompiledSourceSha256 === actualCompiledSourceSha256
  let status = 'legacy-until-graph-source'
  let reason = `Inline field "${field}" has no independently validated typed source graph.`
  if (!exactRegisteredProof) {
    status = 'graph-source-unverified'
    reason = !registeredProof
      ? 'An independently rebuilt frozen graph proof is required before executable source can be counted as graph-validated.'
      : registeredProof.status !== 'graph-source-validated'
      ? registeredProof.reason
      : 'The registered graph proof no longer matches the actual graph or compiled source bytes.'
  } else if (graph && artifactStatus !== 'graph-validated') {
    status = 'graph-source-unverified'
    reason = `The graph artifact for inline field "${field}" is not compiler-validated.`
  } else if (graph && artifactStatus === 'graph-validated') {
    status = 'graph-source-validated'
    reason = `The compiler-validated graph and compiled ${field} exactly match the independently rebuilt frozen graph proof.`
  }
  return {
    status,
    reason,
    field,
    expectedSourceCount,
    graphArtifactStatus: artifactStatus,
    graphPresent: Boolean(graph),
    ...(registeredProof ? { registeredGraphProof: registeredProof } : {}),
    ...graphInspection,
  }
}

function isRefValue(value, name = undefined) {
  return Boolean(value
    && value.kind === 'ref'
    && (name === undefined || value.name === name))
}

function isCustomCardsIndex(value, indexName) {
  return Boolean(value
    && value.kind === 'index'
    && value.object?.kind === 'get'
    && value.object.key === 'customCards'
    && value.object.object?.kind === 'ref'
    && value.object.object.name === 'battle'
    && isRefValue(value.index, indexName))
}

function graphNodeList(graph) {
  const result = []
  const collect = (nodes, prefix) => {
    if (!Array.isArray(nodes)) return
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]
      if (!node || typeof node !== 'object') continue
      result.push({ node, path: `${prefix}.${index}` })
      if (node.body?.nodes) collect(node.body.nodes, `${prefix}.${index}.body.nodes`)
      if (node.update?.nodes) collect(node.update.nodes, `${prefix}.${index}.update.nodes`)
    }
  }
  collect(graph?.nodes, '$.nodes')
  return result
}

function graphBindings(graph) {
  const bindings = new Map()
  const poisoned = new Set()
  for (const { node, path } of graphNodeList(graph)) {
    if (node.kind === 'bind' && typeof node.name === 'string' && node.expr) {
      const definitions = bindings.get(node.name) ?? []
      definitions.push({ value: node.expr, path: `${path}.expr` })
      bindings.set(node.name, definitions)
    }
    if (node.kind === 'set'
      && node.target?.kind === 'ref'
      && typeof node.target.name === 'string') {
      if (node.operator !== '=' || !node.value) {
        poisoned.add(node.target.name)
      } else {
        const definitions = bindings.get(node.target.name) ?? []
        definitions.push({ value: node.value, path: `${path}.value` })
        bindings.set(node.target.name, definitions)
      }
    }
    if (node.kind === 'call' && typeof node.result === 'string') {
      const definitions = bindings.get(node.result) ?? []
      definitions.push({ value: { kind: 'call-result', node }, path })
      bindings.set(node.result, definitions)
    }
  }
  bindings.poisoned = poisoned
  return bindings
}

function resolveGraphAlias(value, bindings, seen = new Set()) {
  if (!isRefValue(value)) return value
  if (seen.has(value.name)) return null
  if (bindings.poisoned?.has(value.name)) return null
  const definitions = bindings.get(value.name) ?? []
  if (definitions.length !== 1) return null
  const nextSeen = new Set(seen)
  nextSeen.add(value.name)
  return resolveGraphAlias(definitions[0].value, bindings, nextSeen)
}

function hasRafaamPrefixFilterExpression(value) {
  let found = false
  const visit = node => {
    if (found || !node || typeof node !== 'object') return
    if (node.kind === 'collection'
      && node.method === 'indexOf'
      && node.object?.kind === 'get'
      && node.object.key === 'cardId'
      && node.object.object?.kind === 'ref'
      && node.object.object.name === 'card'
      && node.args?.length === 1
      && node.args[0]?.kind === 'literal'
      && node.args[0].value === 'rafaam-curse') {
      found = true
      return
    }
    for (const child of Object.values(node)) visit(child)
  }
  visit(value)
  return found
}

function inspectRootGraphSource(entry, field) {
  const graph = graphForField(entry?.definition, field)
  const migration = entry?.migration?.fields?.[field]
  if (!entry || !graph || migration?.status !== 'graph-validated') {
    return {
      status: 'graph-source-unverified',
      id: entry?.id ?? null,
      field,
      reason: 'The production source entry does not have an independently compiler-validated graph artifact.',
    }
  }
  const inspection = inspectTypedSourceGraph(graph)
  if (inspection.rawExecutableSourceLiterals.length > 0 || inspection.unresolvedSinkPaths.length > 0) {
    return {
      status: 'graph-source-unverified',
      id: entry.id,
      field,
      reason: 'The production source graph contains a raw executable literal or unresolved executable sink provenance.',
      inspection,
    }
  }
  return {
    status: 'graph-source-validated',
    id: entry.id,
    field,
    sourceSha256: sha256(entry.definition[field]),
    graphArtifactStatus: migration.status,
    inspection,
  }
}

/**
 * Prove that Rafaam's copy family preserves a legal production card source.
 * The proof is intentionally specific to the known graph shape: it follows
 * the filtered hand card into battle.customCards, requires JSON clone/parse,
 * permits only the copied id mutation, and checks the registered static and
 * generated source entries independently.
 */
export function inspectRafaamCopySource(definition, migration, options = {}) {
  const graph = graphForField(definition, 'code')
  const registeredProof = options.registeredProof ?? null
  const registeredArtifactMatches = registeredProof?.status === 'graph-source-validated'
    && registeredProof.expectedGraphSha256 === (graph ? sha256(graph) : null)
    && registeredProof.expectedCompiledSourceSha256 === (typeof definition?.code === 'string' ? sha256(definition.code) : null)
  const nodes = graphNodeList(graph)
  const bindings = graphBindings(graph)
  const filterNode = nodes.find(({ node }) => node.kind === 'bind'
    && node.name === 'curses'
    && node.expr?.kind === 'collection'
    && node.expr.method === 'filter'
    && hasRafaamPrefixFilterExpression(node.expr))
  const cardIdNode = nodes.find(({ node }) => node.kind === 'bind'
    && node.name === 'cardId'
    && node.expr?.kind === 'get'
    && node.expr.key === 'cardId'
    && node.expr.object?.kind === 'ref'
    && node.expr.object.name === 'card')
  const customNode = nodes.find(({ node }) => node.kind === 'bind'
    && node.name === 'custom'
    && isCustomCardsIndex(node.expr, 'cardId'))
  const stringifyNode = nodes.find(({ node }) => node.kind === 'call'
    && node.capability === 'JSON.stringify'
    && node.args?.length === 1
    && isRefValue(node.args[0], 'custom'))
  const parseNode = nodes.find(({ node }) => node.kind === 'call'
    && node.capability === 'JSON.parse'
    && node.args?.length === 1
    && stringifyNode
    && resolveGraphAlias(node.args[0], bindings)?.kind === 'call-result'
    && resolveGraphAlias(node.args[0], bindings).node === stringifyNode.node)
  const copyIdNode = nodes.find(({ node }) => node.kind === 'set'
    && node.target?.kind === 'get'
    && node.target.object?.kind === 'ref'
    && node.target.object.name === 'copy'
    && node.target.key === 'id'
    && isRefValue(node.value, 'copyId'))
  const storeNode = nodes.find(({ node }) => node.kind === 'set'
    && isCustomCardsIndex(node.target, 'copyId')
    && isRefValue(node.value, 'copy'))
  const copyIdAssignment = nodes.find(({ node }) => node.kind === 'set'
    && node.target?.kind === 'ref'
    && node.target.name === 'cardId'
    && isRefValue(node.value, 'copyId'))
  const copyCodeMutation = nodes.find(({ node }) => node.kind === 'set'
    && node.target?.kind === 'get'
    && node.target.object?.kind === 'ref'
    && node.target.object.name === 'copy'
    && (node.target.key === 'code' || PENDING_SOURCE_FIELDS.has(node.target.key)))
  const graphProof = {
    status: registeredArtifactMatches
      && filterNode && cardIdNode && customNode && stringifyNode && parseNode && copyIdNode && storeNode && copyIdAssignment && !copyCodeMutation
      ? 'graph-source-validated'
      : 'graph-source-unverified',
    registeredArtifact: registeredArtifactMatches,
    filter: Boolean(filterNode),
    cardIdFromHand: Boolean(cardIdNode),
    customCardsLookup: Boolean(customNode),
    jsonStringify: Boolean(stringifyNode),
    jsonParse: Boolean(parseNode),
    copyIdOnlyMutation: Boolean(copyIdNode && !copyCodeMutation),
    copiedCardStored: Boolean(storeNode),
    copiedIdReusedForHand: Boolean(copyIdAssignment),
    copyCodeMutation: Boolean(copyCodeMutation),
  }
  const staticSource = inspectRootGraphSource(options.staticSourceEntry, 'code')
  const generatedSource = options.generatedSourceProof ?? { status: 'graph-source-unverified', reason: 'Generated source proof was not supplied.' }
  const ordinaryCurseIds = options.ordinaryCurseIds ?? []
  const ordinarySourceSetClosed = ordinaryCurseIds.length === 1 && ordinaryCurseIds[0] === 'rafaam-curse-sample'
  const sources = [staticSource, {
    id: 'rule-rafaam-curse-ward',
    familyPattern: '^rafaam-curse-[0-9]+$',
    ...generatedSource,
  }]
  const sourcesValidated = sources.every(source => source.status === 'graph-source-validated')
  const status = graphProof.status === 'graph-source-validated'
    && ordinarySourceSetClosed
    && sourcesValidated
    ? 'graph-source-validated'
    : 'graph-source-unverified'
  return {
    status,
    reason: status === 'graph-source-validated'
      ? 'The validated copy graph preserves code from the only ordinary static Rafaam curse and the validated generated ward family; external custom cards remain outside the ordinary manifest scope.'
      : 'The copy graph, legal ordinary source set, or one of its typed source proofs is incomplete.',
    sourceScope: 'ordinary-manifest-and-validated-generated-family',
    externalCustomCardsExcluded: true,
    ...(registeredProof ? { registeredGraphProof: registeredProof } : {}),
    ordinaryCurseIds,
    graphProof,
    sources,
  }
}

/** Find pending target effect sources only inside actual executable code fields. */
export function findPendingSourceCandidates(source) {
  if (typeof source !== 'string' || source.length === 0) return []
  const sourceFile = ts.createSourceFile('pending-source-audit.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const candidates = []
  let serial = 0
  const visit = node => {
    if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === 'effectCode') {
      const initializer = unwrap(node.initializer)
      let kind = 'unsupported'
      let functionName = null
      let legacySource = null
      if (isStaticString(initializer)) {
        kind = 'effectCode-string'
        legacySource = literalText(initializer)
      } else if (ts.isCallExpression(initializer)
        && initializer.arguments.length === 0
        && ts.isPropertyAccessExpression(unwrap(initializer.expression))
        && unwrap(initializer.expression).name.text === 'toString') {
        const receiver = unwrap(unwrap(initializer.expression).expression)
        if (ts.isIdentifier(receiver)) {
          kind = 'local-function-toString'
          functionName = receiver.text
        } else if (ts.isFunctionExpression(receiver) || ts.isArrowFunction(receiver)) {
          kind = 'inline-function-toString'
        }
      }
      const location = sourceLocation(sourceFile, node)
      candidates.push({
        id: `pending-${serial++}`,
        kind,
        functionName,
        path: `$.effectCode[${serial - 1}]`,
        line: location.line,
        column: location.column,
        expression: node.initializer.getText(sourceFile).slice(0, 240),
        ...(legacySource !== null ? { legacySourceSha256: sha256(legacySource), legacySourceLength: legacySource.length } : {}),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return candidates
}

export function inspectPendingSourceField(definition, field, source, migration, options = {}) {
  // Once a field is compiled, its emitted state machine may contain one
  // materialized effectCode literal even when the legacy source had several
  // independent effectCode producers.  Use the frozen source for the
  // expected-candidate denominator while retaining the current field hash.
  const legacySource = typeof options.legacySource === 'string' ? options.legacySource : source
  const candidates = findPendingSourceCandidates(legacySource)
  if (candidates.length === 0) return null
  return {
    ...inspectSourceField(definition, field, migration, candidates.length, options),
    field,
    sourceSha256: sha256(source),
    ...(legacySource !== source ? { legacySourceSha256: sha256(legacySource) } : {}),
    ...(typeof options.fixture === 'string' ? { sourceBaselineFixture: options.fixture } : {}),
    candidateCount: candidates.length,
    candidates,
  }
}

function parityHashes(definition) {
  const text = {
    name: definition.name ?? null,
    description: definition.description ?? null,
    targetText: definition.targetText ?? null,
    keywords: definition.keywords ?? null,
    effectTags: definition.effectTags ?? null,
  }
  const targeting = {
    targeting: definition.targeting ?? null,
    range: definition.range ?? null,
    targetType: definition.targetType ?? null,
    filter: definition.filter ?? null,
    form: definition.form ?? null,
    requiresTarget: definition.requiresTarget ?? null,
    concealTargetInBattleLog: definition.concealTargetInBattleLog ?? null,
    rollbackPendingTargetOnCancel: definition.rollbackPendingTargetOnCancel ?? null,
  }
  const code = {
    code: definition.code ?? null,
    skillCode: definition.skillCode ?? null,
    previewCode: definition.previewCode ?? null,
    effect: definition.effect ?? null,
  }
  return {
    textSha256: sha256(text),
    targetingSha256: sha256(targeting),
    codeSha256: sha256(code),
    metadataSha256: sha256({ text, targeting, code }),
  }
}

function classifyAvailability(group, id, definition) {
  const modes = Array.isArray(definition.availability?.modes) ? definition.availability.modes : []
  const pveOnly = id.startsWith('pve-') || (modes.length > 0 && modes.every(mode => mode === 'pve'))
  if (pveOnly) return {
    scope: 'excluded',
    exclusionReason: 'pve-only',
    exclusionEvidence: {
      field: definition.availability?.modes ? 'availability.modes' : 'id',
      value: definition.availability?.modes ?? id,
      explanation: 'Adventure/PVE content is outside the ordinary-match denominator.',
    },
  }
  if (group === 'rules') return {
    scope: 'ordinary',
    root: true,
    rootReason: 'ordinary-global-rule-entry',
  }
  if (group === 'pieces') return {
    scope: 'ordinary',
    root: true,
    rootReason: 'ordinary-piece-entry',
  }
  if (group === 'cards') return {
    scope: 'ordinary',
    root: true,
    rootReason: 'ordinary-card-entry',
  }
  return { scope: 'ordinary', root: false }
}

function loadCatalog(root, validator) {
  const entries = []
  const manifests = {}
  const catalogs = Object.fromEntries(GROUPS.map(group => [group, new Map()]))
  const errors = []
  for (const group of GROUPS) {
    const manifestRelativePath = `data/${group}/manifest.json`
    const manifestPath = resolve(root, manifestRelativePath)
    if (!existsSync(manifestPath)) {
      errors.push(`${manifestRelativePath}: manifest missing`)
      continue
    }
    const ids = readJson(manifestPath)
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
      errors.push(`${manifestRelativePath}: manifest must be an array of string IDs`)
      continue
    }
    const sortedIds = [...ids].sort(compareCodePoints)
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index)
    if (duplicateIds.length > 0) errors.push(`${manifestRelativePath}: duplicate IDs ${[...new Set(duplicateIds)].join(', ')}`)
    const manifestEntries = []
    for (const id of sortedIds) {
      const relativePath = `data/${group}/${id}.json`
      const absolutePath = resolve(root, relativePath)
      if (!existsSync(absolutePath)) {
        errors.push(`${relativePath}: manifest entry is missing`)
        continue
      }
      const definition = readJson(absolutePath)
      if (definition.id !== id) errors.push(`${relativePath}: definition.id is ${String(definition.id)}; expected ${id}`)
      const classification = classifyAvailability(group, id, definition)
      const entry = {
        group,
        id,
        nodeKey: `${group}/${id}`,
        sourcePath: relativePath,
        definition,
        ...classification,
        hashes: parityHashes(definition),
        migration: migrationArtifact(definition, validator),
      }
      catalogs[group].set(id, entry)
      entries.push(entry)
      manifestEntries.push(entry)
    }
    manifests[group] = {
      path: manifestRelativePath,
      ids: sortedIds,
      sha256: sha256(sortedIds),
      count: sortedIds.length,
      entries: manifestEntries,
    }
  }
  return { entries, manifests, catalogs, errors }
}

function makeReport(root) {
  const validator = loadContentGraphValidator(root)
  const catalog = loadCatalog(root, validator)
  const legacyFixture = loadLegacyContentFixture(root)
  const registeredGraphProofs = loadRegisteredGraphProofs(root)
  const allCatalogIds = new Set(catalog.entries.map(entry => entry.id))
  const state = {
    catalogs: catalog.catalogs,
    registeredGraphProofs,
    knownIds: allCatalogIds,
    references: [],
    referenceKeys: new Set(),
    unknown: [],
    unknownKeys: new Set(),
    dynamic: [],
    dynamicKeys: new Set(),
    generatedFamilies: [],
    generatedFamilyKeys: new Set(),
    pendingSources: [],
    pendingSourceKeys: new Set(),
    baselineMissingCandidates: [],
    baselineMissingCandidateKeys: new Set(),
  }

  for (const entry of catalog.entries) {
    scanData(state, entry, entry.definition)
    for (const field of entry.migration.codeFields) {
      const source = entry.definition[field]
      const legacyDefinition = legacyFixture.entries.get(entry.nodeKey)
      const legacySource = typeof legacyDefinition?.[field] === 'string' ? legacyDefinition[field] : source
      const pending = inspectPendingSourceField(entry.definition, field, source, entry.migration, {
        legacySource,
        fixture: legacyFixture.available ? legacyFixture.path : undefined,
        ...(REGISTERED_GRAPH_PROOF_KEYS.includes(entry.nodeKey)
          ? {
              registeredProof: registeredGraphProofFor(registeredGraphProofs, entry.nodeKey, field, entry.definition),
            }
          : {}),
      })
      if (!pending) continue
      addPendingSource(state, {
        from: entry.nodeKey,
        fromGroup: entry.group,
        fromId: entry.id,
        fieldPath: field,
        ...pending,
      })
    }
  }

  const byNode = new Map(catalog.entries.map(entry => [entry.nodeKey, entry]))
  const outgoing = new Map(catalog.entries.map(entry => [entry.nodeKey, []]))
  for (const reference of state.references) {
    const target = byNode.get(`${reference.toGroup}/${reference.toId}`)
    if (!target) continue
    const edges = outgoing.get(reference.from) ?? []
    edges.push({
      to: target.nodeKey,
      toGroup: target.group,
      toId: target.id,
      relation: reference.relation,
      fieldPath: reference.fieldPath,
      evidenceKind: reference.evidenceKind,
    })
    outgoing.set(reference.from, edges)
  }
  for (const edges of outgoing.values()) {
    const unique = new Map(edges.map(edge => [JSON.stringify(edge), edge]))
    edges.splice(0, edges.length, ...[...unique.values()].sort((a, b) => (
      compareCodePoints(a.to, b.to) || compareCodePoints(a.fieldPath, b.fieldPath) || compareCodePoints(a.relation, b.relation)
    )))
  }

  const roots = catalog.entries.filter(entry => entry.scope === 'ordinary' && entry.root).map(entry => entry.nodeKey).sort(compareCodePoints)
  const reachable = new Map()
  const queue = roots.map(nodeKey => ({ nodeKey, path: [nodeKey] }))
  for (const nodeKey of roots) reachable.set(nodeKey, [nodeKey])
  while (queue.length > 0) {
    const current = queue.shift()
    for (const edge of outgoing.get(current.nodeKey) ?? []) {
      if (reachable.has(edge.to)) continue
      const path = [...current.path, edge.to]
      reachable.set(edge.to, path)
      queue.push({ nodeKey: edge.to, path })
    }
  }

  const ordinaryEntries = catalog.entries.filter(entry => entry.scope === 'ordinary')
  const excludedEntries = catalog.entries.filter(entry => entry.scope === 'excluded')
  const ordinaryReachable = new Set(ordinaryEntries.filter(entry => reachable.has(entry.nodeKey)).map(entry => entry.nodeKey))
  const ordinaryReachableNonPieces = ordinaryEntries.filter(entry => entry.group !== 'pieces' && reachable.has(entry.nodeKey))
  const dynamicFrom = new Set(state.dynamic.map(item => item.from))
  const pendingByNode = new Map()
  for (const pending of state.pendingSources) {
    const items = pendingByNode.get(pending.from) ?? []
    items.push(pending)
    pendingByNode.set(pending.from, items)
  }
  const nodes = catalog.entries.map(entry => ({
    group: entry.group,
    id: entry.id,
    nodeKey: entry.nodeKey,
    sourcePath: entry.sourcePath,
    scope: entry.scope,
    ...(entry.root ? { root: true, rootReason: entry.rootReason } : {}),
    ...(entry.exclusionReason ? {
      exclusionReason: entry.exclusionReason,
      exclusionEvidence: entry.exclusionEvidence,
    } : {}),
    reachability: entry.scope === 'excluded'
      ? {
          status: reachable.has(entry.nodeKey) ? 'excluded-but-referenced' : 'excluded',
          pathFromOrdinaryRoot: reachable.get(entry.nodeKey) ?? null,
        }
      : {
          status: ordinaryReachable.has(entry.nodeKey) ? 'reachable' : (dynamicFrom.has(entry.nodeKey) ? 'dynamic-only' : 'unreachable'),
          pathFromOrdinaryRoot: reachable.get(entry.nodeKey) ?? null,
        },
    hashes: entry.hashes,
    migration: entry.migration,
    outgoing: outgoing.get(entry.nodeKey) ?? [],
    ...(pendingByNode.has(entry.nodeKey) ? { pendingSources: pendingByNode.get(entry.nodeKey) } : {}),
  })).sort((a, b) => compareCodePoints(a.nodeKey, b.nodeKey))

  const manifestSummary = Object.fromEntries(GROUPS.map(group => {
    const manifest = catalog.manifests[group]
    const entries = manifest?.entries ?? []
    const ordinary = entries.filter(entry => entry.scope === 'ordinary')
    const excluded = entries.filter(entry => entry.scope === 'excluded')
    const reachableEntries = ordinary.filter(entry => reachable.has(entry.nodeKey))
    const dynamicOnlyEntries = ordinary.filter(entry => !reachable.has(entry.nodeKey) && dynamicFrom.has(entry.nodeKey))
    const ordinaryCodeFields = ordinary.flatMap(entry => entry.migration.codeFields)
    const sourceKindCount = Object.fromEntries(SOURCE_KINDS.map(kind => [kind, ordinary.filter(entry => entry.migration.sourceKind === kind).length]))
    return [group, {
      path: manifest?.path ?? `data/${group}/manifest.json`,
      manifestSha256: manifest?.sha256 ?? null,
      manifestCount: manifest?.count ?? 0,
      ordinaryCount: ordinary.length,
      ordinarySourceKindCount: sourceKindCount,
      ordinaryDeclarativeCount: sourceKindCount.declarative,
      ordinaryInlineFieldEntryCount: sourceKindCount['inline-fields'],
      ordinaryInlineCodeFieldCount: ordinaryCodeFields.length,
      ordinaryReachableCount: reachableEntries.length,
      ordinaryUnreachableCount: ordinary.length - reachableEntries.length,
      ordinaryDynamicOnlyCount: dynamicOnlyEntries.length,
      excludedCount: excluded.length,
      excludedIds: excluded.map(entry => entry.id).sort(compareCodePoints),
    }]
  }))

  const references = state.references.map(reference => ({ ...reference })).sort((a, b) => (
    compareCodePoints(a.from, b.from)
      || compareCodePoints(a.fieldPath, b.fieldPath)
      || compareCodePoints(a.toGroup ?? '', b.toGroup ?? '')
      || compareCodePoints(a.toId ?? '', b.toId ?? '')
      || compareCodePoints(a.evidenceKind, b.evidenceKind)
  ))
  const unknownReferences = state.unknown.map(reference => ({ ...reference })).sort((a, b) => (
    compareCodePoints(a.from, b.from)
      || compareCodePoints(a.fieldPath, b.fieldPath)
      || compareCodePoints(a.rawId, b.rawId)
      || (a.line ?? 0) - (b.line ?? 0)
  ))
  const dynamicReferences = state.dynamic.map(reference => ({ ...reference })).sort((a, b) => (
    compareCodePoints(a.from, b.from)
      || compareCodePoints(a.fieldPath, b.fieldPath)
      || (a.line ?? 0) - (b.line ?? 0)
      || (a.column ?? 0) - (b.column ?? 0)
      || compareCodePoints(a.expression, b.expression)
  ))
  const generatedFamilyReferences = state.generatedFamilies.map(family => ({ ...family })).sort((a, b) => (
    compareCodePoints(a.from, b.from)
      || compareCodePoints(a.fieldPath, b.fieldPath)
      || compareCodePoints(a.familyPattern, b.familyPattern)
      || compareCodePoints(a.expression, b.expression)
  ))
  const pendingSourceReferences = state.pendingSources.map(pending => ({ ...pending })).sort((a, b) => (
    compareCodePoints(a.from, b.from)
      || compareCodePoints(a.fieldPath, b.fieldPath)
      || compareCodePoints(a.sourceSha256, b.sourceSha256)
  ))
  const baselineMissingCandidates = state.baselineMissingCandidates.map(candidate => ({ ...candidate })).sort((a, b) => (
    compareCodePoints(a.from, b.from)
      || compareCodePoints(a.fieldPath, b.fieldPath)
      || compareCodePoints(a.candidateId, b.candidateId)
  ))
  const dynamicResolvedCount = dynamicReferences.filter(reference => reference.resolution?.status !== 'unresolved').length
  const dynamicUnresolvedCount = dynamicReferences.length - dynamicResolvedCount
  const generatedCandidateCount = generatedFamilyReferences.reduce((total, family) => total + (family.candidateIds?.length ?? 0), 0)
  const generatedExecutableStatusCounts = Object.fromEntries([...new Set(generatedFamilyReferences.map(family => family.generatedExecutableStatus))]
    .sort(compareCodePoints)
    .map(status => [status, generatedFamilyReferences.filter(family => family.generatedExecutableStatus === status).length]))
  const generatedSourceStatusCounts = Object.fromEntries(SOURCE_GRAPH_STATUSES
    .map(status => [status, generatedFamilyReferences.filter(family => family.generatedSourceStatus === status).length]))
  const pendingSourceStatusCounts = Object.fromEntries(SOURCE_GRAPH_STATUSES
    .map(status => [status, pendingSourceReferences.filter(pending => pending.status === status).length]))
  const pendingSourceOccurrenceCount = pendingSourceReferences.reduce((total, pending) => total + pending.candidateCount, 0)

  const migrationCounts = Object.fromEntries(MIGRATION_STATUSES.map(status => [status, catalog.entries.filter(entry => entry.migration.status === status).length]))
  const ordinaryMigrationCounts = Object.fromEntries(MIGRATION_STATUSES.map(status => [status, ordinaryEntries.filter(entry => entry.migration.status === status).length]))
  const sourceKindCounts = Object.fromEntries(SOURCE_KINDS.map(kind => [kind, catalog.entries.filter(entry => entry.migration.sourceKind === kind).length]))
  const ordinarySourceKindCounts = Object.fromEntries(SOURCE_KINDS.map(kind => [kind, ordinaryEntries.filter(entry => entry.migration.sourceKind === kind).length]))
  const fieldEntries = catalog.entries.flatMap(entry => Object.entries(entry.migration.fields).map(([field, migration]) => ({
    ...migration,
    field,
    nodeKey: entry.nodeKey,
  })))
  const ordinaryFieldEntries = fieldEntries.filter(field => ordinaryEntries.some(entry => entry.nodeKey === field.nodeKey))
  const fieldMigrationCounts = Object.fromEntries(FIELD_MIGRATION_STATUSES.map(status => [status, fieldEntries.filter(field => field.status === status).length]))
  const ordinaryFieldMigrationCounts = Object.fromEntries(FIELD_MIGRATION_STATUSES.map(status => [status, ordinaryFieldEntries.filter(field => field.status === status).length]))
  return {
    schemaVersion: 1,
    reportKind: 'content-graph-coverage',
    assessmentScope: 'compiler-ir-and-behavior-compatibility',
    semanticModuleCoverage: {
      status: 'not-assessed',
      complete: false,
      reason: 'Validated v1 compiler graphs do not prove registered semantic-module composition. Domain-module dependencies, typed ports and absence of author-level code escape hatches require a separate audit.',
    },
    baseBranch: BASE_BRANCH,
    baseSha: BASE_SHA,
    contentGraphVersion: CONTENT_GRAPH_VERSION,
    graphCompilerVersion: GRAPH_COMPILER_VERSION,
    legacyContentFixture: {
      available: legacyFixture.available,
      path: legacyFixture.path,
      schemaVersion: legacyFixture.schemaVersion,
      baseSha: legacyFixture.baseSha,
    },
    compilerValidator: {
      available: validator.available,
      sourcePath: validator.sourcePath,
      ...(validator.compilerVersion ? { compilerVersion: validator.compilerVersion } : {}),
      documentAvailable: validator.documentAvailable,
      documentSourcePath: validator.documentSourcePath,
      reason: validator.reason,
    },
    registeredGraphProof: {
      available: registeredGraphProofs.available,
      reason: registeredGraphProofs.reason,
      entries: Object.fromEntries(Object.entries(registeredGraphProofs.entries).map(([nodeKey, proof]) => [nodeKey, {
        field: proof.field,
        expectedGraphSha256: proof.expectedGraphSha256,
        expectedCompiledSourceSha256: proof.expectedCompiledSourceSha256,
        ...(proof.expectedFamilyGraphSha256 ? { expectedFamilyGraphSha256: proof.expectedFamilyGraphSha256 } : {}),
        ...(proof.expectedPendingSourcePairs ? { expectedPendingSourcePairs: proof.expectedPendingSourcePairs } : {}),
      }])),
    },
    executionPolicy: {
      legacyCodeIsAuthoritative: true,
      legacyCodeScope: 'inline-fields only',
      graphViewDoesNotCountAsMigration: true,
      declarativeIsNotCodeMigration: true,
      migrationRequires: [
        'entries with no string-valued inline code fields are declarative; their effects and dependencies still require separate validation',
        'every string-valued inline code field is tracked independently',
        'definition.contentGraph.version == rvb-content-graph/v1',
        'contentGraphField names the one inline field validated by the artifact',
        'contentGraphCompilerVersion == rvb-content-graph-compiler/v1',
        'repository assertContentGraphArtifact accepts that generated field byte-for-byte',
        'a contentGraph accepted for one field does not migrate sibling fields such as previewCode',
        'each contentGraphEntries[field] graph and compilerVersion must independently compile to content[field]',
        'the primary contentGraphField must not be repeated in contentGraphEntries',
        'generated executable families require a compiler-validated typed source/materializeSource graph; a graph containing a legacy code/effectCode source literal remains incomplete',
        'the Rafaam copy family additionally requires a validated hand-card filter, customCards lookup, JSON clone preserving code, and a closed ordinary source set',
        'pending effectCode occurrences are counted independently and require matching compiler-validated typed source graphs',
        'the registered generated/pending corpus must exactly match an independently rebuilt frozen graph and compiler output; the sink walker is diagnostic only',
      ],
    },
    scope: {
      ordinaryEntries: 'pieces with non-PVE availability, ordinary cards, and non-PVE global rules',
      excludedEntries: 'entries marked PVE-only by availability.modes or pve- ID prefix',
      roots: roots,
      rootPolicy: 'All ordinary pieces, ordinary cards, and non-PVE rules are roots. Skills are reached transitively.',
    },
    counts: {
      manifests: Object.fromEntries(GROUPS.map(group => [group, catalog.manifests[group]?.count ?? 0])),
      ordinary: ordinaryEntries.length,
      excluded: excludedEntries.length,
      ordinaryReachable: ordinaryReachable.size,
      ordinaryUnreachable: ordinaryEntries.length - ordinaryReachable.size,
      ordinaryReachableNonPiece: ordinaryReachableNonPieces.length,
      ordinaryReachableNonPieceSourceKind: Object.fromEntries(SOURCE_KINDS.map(kind => [
        kind,
        ordinaryReachableNonPieces.filter(entry => entry.migration.sourceKind === kind).length,
      ])),
      references: references.length,
      unknownReferences: unknownReferences.length,
      dynamicReferences: dynamicReferences.length,
      dynamicResolved: dynamicResolvedCount,
      dynamicUnresolved: dynamicUnresolvedCount,
      generatedFamilies: generatedFamilyReferences.length,
      generatedCandidateIds: generatedCandidateCount,
      generatedExecutableStatus: generatedExecutableStatusCounts,
      generatedSourceStatus: generatedSourceStatusCounts,
      pendingSourceFields: pendingSourceReferences.length,
      pendingSourceOccurrences: pendingSourceOccurrenceCount,
      pendingSourceStatus: pendingSourceStatusCounts,
      baselineMissingCandidates: baselineMissingCandidates.length,
      sourceKind: sourceKindCounts,
      ordinarySourceKind: ordinarySourceKindCounts,
      inlineCodeFields: fieldEntries.length,
      ordinaryInlineCodeFields: ordinaryFieldEntries.length,
      fieldMigration: fieldMigrationCounts,
      ordinaryFieldMigration: ordinaryFieldMigrationCounts,
      migration: migrationCounts,
      ordinaryMigration: ordinaryMigrationCounts,
    },
    manifests: manifestSummary,
    nodes,
    references,
    unknownReferences,
    dynamicReferences,
    generatedFamilies: generatedFamilyReferences,
    pendingSources: pendingSourceReferences,
    baselineMissingCandidates,
    validation: {
      errors: [...catalog.errors].sort(compareCodePoints),
      ordinaryUnreachable: nodes.filter(node => node.scope === 'ordinary' && node.reachability.status === 'unreachable').map(node => node.nodeKey),
      ordinaryDynamicOnly: nodes.filter(node => node.scope === 'ordinary' && node.reachability.status === 'dynamic-only').map(node => node.nodeKey),
      ordinaryReferencesExcluded: references.filter(reference => {
        const target = byNode.get(`${reference.toGroup}/${reference.toId}`)
        const source = byNode.get(reference.from)
        return source?.scope === 'ordinary' && target?.scope === 'excluded'
      }).map(reference => ({
        from: reference.from,
        to: `${reference.toGroup}/${reference.toId}`,
        fieldPath: reference.fieldPath,
        evidenceKind: reference.evidenceKind,
      })),
      allOrdinaryEntriesHaveStableHashes: ordinaryEntries.every(entry => Object.values(entry.hashes).every(hash => /^[a-f0-9]{64}$/.test(hash))),
      allOrdinaryInlineFieldsLegacyUntilValidated: ordinaryFieldEntries.every(field => field.status !== 'graph-validated'),
      allOrdinaryEntriesClassifiedBySourceKind: ordinaryEntries.every(entry => SOURCE_KINDS.includes(entry.migration.sourceKind)),
      allDynamicProofsSourceBound: dynamicReferences.every(reference => /^[a-f0-9]{64}$/.test(reference.resolution?.sourceProof?.sourceSha256 ?? '')),
      allGeneratedFamiliesSourceBound: generatedFamilyReferences.every(family => /^[a-f0-9]{64}$/.test(family.sourceProof?.sourceSha256 ?? '')),
      allGeneratedSourceProofsActual: generatedFamilyReferences.every(family => (
        SOURCE_GRAPH_STATUSES.includes(family.generatedSourceStatus)
          && (family.generatedSourceProof?.copySourceProof?.status === 'graph-source-validated'
            || (typeof family.generatedSourceProof?.typedSourceCount === 'number' && family.generatedSourceProof.typedSourceCount > 0))
          && typeof family.generatedSourceProof?.rawExecutableSourceLiterals?.length === 'number'
      )),
      allGeneratedSourcesGraphValidated: generatedFamilyReferences.every(family => family.generatedSourceStatus === 'graph-source-validated'),
      allPendingSourceProofsActual: pendingSourceReferences.every(pending => (
        SOURCE_GRAPH_STATUSES.includes(pending.status)
          && typeof pending.candidateCount === 'number'
          && typeof pending.typedSourceCount === 'number'
      )),
      allPendingSourcesGraphValidated: pendingSourceReferences.every(pending => pending.status === 'graph-source-validated'),
      allRegisteredGraphProofsAvailable: registeredGraphProofs.available
        && REGISTERED_GRAPH_PROOF_KEYS.every(nodeKey => registeredGraphProofs.entries[nodeKey]),
      allRegisteredGraphProofsValidated: [...generatedFamilyReferences, ...pendingSourceReferences]
        .filter(item => REGISTERED_GRAPH_PROOF_KEYS.includes(item.from))
        .every(item => item.generatedSourceProof?.registeredGraphProof?.status === 'graph-source-validated'
          || item.registeredGraphProof?.status === 'graph-source-validated'),
      baselineMissingCandidatesAreExplicit: baselineMissingCandidates.every(candidate => candidate.reason === 'frozen-baseline-candidate-missing-from-manifest'),
    },
  }
}

export function buildCoverageReport(options = {}) {
  const root = resolve(options.root ?? SCRIPT_ROOT)
  return makeReport(root)
}

export function writeCoverageReport(options = {}) {
  const root = resolve(options.root ?? SCRIPT_ROOT)
  const output = resolve(options.output ?? resolve(root, 'docs/qa/RED-252-content-coverage.json'))
  const report = makeReport(root)
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { output, report }
}

function gitBaseSha(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function runCli() {
  const args = process.argv.slice(2)
  const shouldWrite = args.includes('--write')
  const rootArgument = args.find(argument => argument.startsWith('--root='))?.slice('--root='.length)
  const root = resolve(rootArgument ?? SCRIPT_ROOT)
  const outputArgument = args.find(argument => argument.startsWith('--output='))?.slice('--output='.length)
  const result = shouldWrite
    ? writeCoverageReport({ root, output: outputArgument ?? resolve(root, 'docs/qa/RED-252-content-coverage.json') })
    : { report: buildCoverageReport({ root }) }
  if (shouldWrite) {
    process.stdout.write(`${JSON.stringify({ output: posixPath(relative(root, result.output)), counts: result.report.counts, originMainSha: gitBaseSha(root) }, null, 2)}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
  }
  if (result.report.validation.errors.length > 0) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) runCli()
