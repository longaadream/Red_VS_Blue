/** Text is a projection of declared graph inputs, never another rules source. */
import { getGameplayModule } from './module-registry'
export type GameplayTextSource =
  | { readonly entry: string; readonly input: string }
  | { readonly entry: string; readonly node: string; readonly input: string }
  | { readonly entry: string; readonly node: string; readonly parameter: string }

export type GameplayTextBinding = {
  readonly template: string
  readonly values: Readonly<Record<string, GameplayTextSource>>
}
export type GameplayTextBindings = Partial<Record<'description' | 'targetText', GameplayTextBinding>>

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
function fail(message: string): never { throw new Error('Gameplay module text: ' + message) }

function statements(body: unknown): Record<string, unknown>[] {
  if (!Array.isArray(body)) return []
  return body.flatMap(item => {
    if (!object(item)) return []
    return [item, ...statements(item.then), ...statements(item.else), ...statements(item.body),
      ...statements(object(item.condition) ? item.condition.body : undefined)]
  })
}

function primitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

function sourceValue(entries: Record<string, unknown>, source: unknown, token: string): string | number | boolean {
  if (!object(source) || typeof source.entry !== 'string') fail('invalid source for ' + token)
  const entry = own(entries, source.entry) ? entries[source.entry] : undefined
  const graph = object(entry) ? entry.graph : undefined
  if (!object(graph)) fail('missing graph for ' + token)
  if (own(source, 'node')) {
    const parameter = own(source, 'parameter')
    const key = parameter ? 'parameter' : 'input'
    if (Object.keys(source).some(name => !['entry', 'node', key].includes(name)) || typeof source.node !== 'string' || typeof source[key] !== 'string') fail('invalid source for ' + token)
    const matches = statements(graph.body).filter(item => item.id === source.node)
    if (matches.length !== 1 || matches[0].kind !== 'call') fail('missing unique module call for ' + token)
    const table = matches[0][parameter ? 'parameters' : 'inputs']
    const raw = object(table) && own(table, source[key]) ? table[source[key]] : undefined
    const value = parameter ? raw : object(raw) && raw.kind === 'literal' ? raw.value : undefined
    if (!primitive(value)) fail('text requires a primitive literal: ' + token)
    return value
  }
  if (Object.keys(source).some(key => !['entry', 'input'].includes(key)) || typeof source.input !== 'string') fail('invalid source for ' + token)
  if (!Array.isArray(graph.inputs) || !object(graph.inputBindings) || !own(graph.inputBindings, source.input)) fail('missing bound input for ' + token)
  const port = graph.inputs.find(item => object(item) && item.name === source.input)
  const value = graph.inputBindings[source.input]
  if (!object(port) || !primitive(value) || typeof value !== port.type) fail('text requires a primitive declared input: ' + token)
  return value
}

/** Author-visible choices come from actual persisted values, never runtime guesses. */
export function getGameplayModuleTextSources(entries: Record<string, unknown>): Array<{ source: GameplayTextSource; label: string; value: string | number | boolean }> {
  const output: Array<{ source: GameplayTextSource; label: string; value: string | number | boolean }> = []
  for (const [entryName, entry] of Object.entries(entries)) {
    const graph = object(entry) ? entry.graph : undefined
    if (!object(graph)) continue
    for (const port of Array.isArray(graph.inputs) ? graph.inputs : []) {
      if (!object(port) || typeof port.name !== 'string') continue
      const value = object(graph.inputBindings) ? graph.inputBindings[port.name] : undefined
      if (primitive(value) && typeof value === port.type) output.push({ source: { entry: entryName, input: port.name }, label: `${entryName} · ${String(port.label || port.name)}`, value })
    }
    for (const call of statements(graph.body)) {
      if (call.kind !== 'call' || typeof call.id !== 'string') continue
      const descriptor = typeof call.module === 'string' ? getGameplayModule(call.module, typeof call.version === 'string' ? call.version : undefined) : undefined
      const label = (name: string, parameter: boolean) => {
        const port = (parameter ? descriptor?.parameters : descriptor?.inputs)?.find(port => port.name === name)
        return `${descriptor?.label || call.id} · ${port?.label || name}（${call.id}）`
      }
      for (const [name, value] of Object.entries(object(call.parameters) ? call.parameters : {})) {
        if (primitive(value)) output.push({ source: { entry: entryName, node: call.id, parameter: name }, label: label(name, true), value })
      }
      for (const [name, ref] of Object.entries(object(call.inputs) ? call.inputs : {})) {
        if (object(ref) && ref.kind === 'literal' && primitive(ref.value)) output.push({ source: { entry: entryName, node: call.id, input: name }, label: label(name, false), value: ref.value })
      }
    }
  }
  return output
}

/** Only declared bindings and literal module inputs feed text; runtime outputs cannot be guessed. */
export function renderGameplayModuleText(entries: Record<string, unknown>, bindings: unknown): Record<string, string> {
  if (!object(bindings)) fail('bindings must be an object')
  const rendered: Record<string, string> = {}
  for (const [field, raw] of Object.entries(bindings)) {
    if (!['description', 'targetText'].includes(field)) fail('unsupported text field ' + field)
    if (!object(raw) || Object.keys(raw).some(key => !['template', 'values'].includes(key)) || typeof raw.template !== 'string' || !object(raw.values)) fail('invalid binding for ' + field)
    const values: Record<string, string> = Object.create(null) as Record<string, string>
    for (const [token, source] of Object.entries(raw.values)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(token) || ['constructor', 'prototype', '__proto__'].includes(token)) fail('invalid placeholder ' + token)
      values[token] = String(sourceValue(entries, source, token))
    }
    const used = new Set<string>()
    rendered[field] = raw.template.replace(/\{\{([^{}]+)\}\}/g, (_match, token: string) => {
      if (!own(values, token)) fail('unbound placeholder ' + token)
      used.add(token)
      return values[token]
    })
    if (Object.keys(values).some(token => !used.has(token))) fail('unused text binding for ' + field)
  }
  return rendered
}
