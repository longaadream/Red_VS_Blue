/** Text is a projection of declared graph inputs, never another rules source. */
export type GameplayTextBinding = {
  readonly template: string
  readonly values: Readonly<Record<string, { readonly entry: string; readonly input: string }>>
}
export type GameplayTextBindings = Partial<Record<'description' | 'targetText', GameplayTextBinding>>

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
function fail(message: string): never { throw new Error('Gameplay module text: ' + message) }

/** Only graph input bindings can feed text; runtime outputs cannot be guessed. */
export function renderGameplayModuleText(entries: Record<string, unknown>, bindings: unknown): Record<string, string> {
  if (!object(bindings)) fail('bindings must be an object')
  const rendered: Record<string, string> = {}
  for (const [field, raw] of Object.entries(bindings)) {
    if (!['description', 'targetText'].includes(field)) fail('unsupported text field ' + field)
    if (!object(raw) || Object.keys(raw).some(key => !['template', 'values'].includes(key)) || typeof raw.template !== 'string' || !object(raw.values)) fail('invalid binding for ' + field)
    const values: Record<string, string> = Object.create(null) as Record<string, string>
    for (const [token, source] of Object.entries(raw.values)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(token) || ['constructor', 'prototype', '__proto__'].includes(token)) fail('invalid placeholder ' + token)
      if (!object(source) || Object.keys(source).some(key => !['entry', 'input'].includes(key)) || typeof source.entry !== 'string' || typeof source.input !== 'string') fail('invalid source for ' + token)
      const entry = own(entries, source.entry) ? entries[source.entry] : undefined
      const graph = object(entry) ? entry.graph : undefined
      if (!object(graph) || !Array.isArray(graph.inputs) || !object(graph.inputBindings) || !own(graph.inputBindings, source.input)) fail('missing bound input for ' + token)
      const port = graph.inputs.find(item => object(item) && item.name === source.input)
      const value = graph.inputBindings[source.input]
      if (!object(port) || !['number', 'string', 'boolean'].includes(String(port.type)) || typeof value !== port.type || (typeof value === 'number' && !Number.isFinite(value))) fail('text requires a primitive declared input: ' + token)
      values[token] = String(value)
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
