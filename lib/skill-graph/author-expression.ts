/** Data-only author expressions. Evaluation belongs to registered gameplay modules. */
type Span = { readonly start: number; readonly end: number }
export type AuthorExpression = Span & (
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'identifier'; readonly name: string }
  | { readonly kind: 'unary'; readonly operator: string; readonly operand: AuthorExpression }
  | { readonly kind: 'binary'; readonly operator: string; readonly left: AuthorExpression; readonly right: AuthorExpression }
  | { readonly kind: 'member'; readonly object: AuthorExpression; readonly field: string }
  | { readonly kind: 'index'; readonly object: AuthorExpression; readonly index: AuthorExpression }
  | { readonly kind: 'call'; readonly callee: AuthorExpression; readonly arguments: readonly AuthorArgument[] }
  | { readonly kind: 'tuple'; readonly items: readonly AuthorExpression[] }
  | { readonly kind: 'object'; readonly fields: readonly { readonly name: string; readonly value: AuthorExpression }[] }
)
export type AuthorArgument = { readonly name?: string; readonly value: AuthorExpression }
export class AuthorExpressionError extends Error {
  constructor(message: string, readonly position: number) {
    super(`${message}（第 ${position + 1} 个字符）`)
    this.name = 'AuthorExpressionError'
  }
}
type Token = Span & { kind: 'identifier' | 'number' | 'string' | 'punctuation' | 'end'; text: string; value?: string | number }
const quotes: Readonly<Record<string, string>> = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』', '＂': '＂', '＇': '＇' }
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const precedence: Readonly<Record<string, number>> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 7 }
const fold = (character: string): string => {
  const code = character.charCodeAt(0)
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0)
  return ({ '。': '.', '　': ' ', '×': '*', '÷': '/', '−': '-' } as Record<string, string>)[character] ?? character
}

/** Offsets always refer to original text, including full-width syntax. */
function tokenize(source: string): Token[] {
  if (source.length > 32768) throw new AuthorExpressionError('表达式超过长度上限', 32768)
  const tokens: Token[] = []
  let cursor = 0
  while (cursor < source.length) {
    if (tokens.length >= 4096) throw new AuthorExpressionError('表达式超过符号数量上限', cursor)
    const start = cursor
    const original = source[cursor]
    const character = fold(original)
    if (/\s/.test(character)) { cursor++; continue }
    if (quotes[original]) {
      const close = quotes[original]
      let value = ''
      let closed = false
      cursor++
      while (cursor < source.length) {
        const next = source[cursor++]
        if (next === close) { closed = true; break }
        if (next !== '\\') { value += next; continue }
        if (cursor >= source.length) break
        const escaped = source[cursor++]
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '"': '"', "'": "'" }
        if (escaped === 'u') {
          const hex = source.slice(cursor, cursor + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new AuthorExpressionError('无效的 Unicode 转义', cursor)
          value += String.fromCharCode(parseInt(hex, 16)); cursor += 4
        } else if (escaped in escapes) value += escapes[escaped]
        else if (escaped === close) value += close
        else throw new AuthorExpressionError('无效的文本转义', cursor - 1)
      }
      if (!closed) throw new AuthorExpressionError('文本缺少结束引号', start)
      tokens.push({ kind: 'string', text: source.slice(start, cursor), value, start, end: cursor })
      continue
    }
    if (/[0-9]/.test(character) || character === '.' && /[0-9]/.test(fold(source[cursor + 1] ?? ''))) {
      let numeric = ''
      while (cursor < source.length && /[0-9.eE+-]/.test(fold(source[cursor]))) {
        const next = fold(source[cursor])
        if ((next === '+' || next === '-') && !/[eE]$/.test(numeric)) break
        if (next === '.' && numeric.includes('.')) break
        numeric += next; cursor++
      }
      if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(numeric) || !Number.isFinite(Number(numeric))) throw new AuthorExpressionError('无效的数值', start)
      tokens.push({ kind: 'number', text: numeric, value: Number(numeric), start, end: cursor }); continue
    }
    if (/[$_\p{L}]/u.test(character)) {
      let text = character; cursor++
      while (cursor < source.length && /[$_\p{L}\p{N}\p{M}]/u.test(fold(source[cursor]))) text += fold(source[cursor++])
      tokens.push({ kind: 'identifier', text, start, end: cursor }); continue
    }
    const pair = character + fold(source[cursor + 1] ?? '')
    if (Object.hasOwn(precedence, pair)) { cursor += 2; tokens.push({ kind: 'punctuation', text: pair, start, end: cursor }); continue }
    if ('+-*/%^!<>(){}[].,:'.includes(character)) { cursor++; tokens.push({ kind: 'punctuation', text: character, start, end: cursor }); continue }
    throw new AuthorExpressionError(`无法识别的符号「${original}」`, cursor)
  }
  tokens.push({ kind: 'end', text: '', start: cursor, end: cursor })
  return tokens
}

export function parseAuthorExpression(source: string): AuthorExpression {
  const tokens = tokenize(source)
  let cursor = 0
  let depth = 0
  const current = () => tokens[cursor]
  const take = () => tokens[cursor++]
  const fail = (message: string): never => { throw new AuthorExpressionError(message, current().start) }
  const accept = (text: string) => current().text === text && Boolean(take())
  const requireToken = (text: string) => { if (!accept(text)) fail(`此处需要「${text}」`) }
  const safeKey = (name: string, position: number) => { if (forbidden.has(name)) throw new AuthorExpressionError('此字段不可访问', position); return name }
  function primary(): AuthorExpression {
    const token = take()
    const span = { start: token.start, end: token.end }
    if (token.kind === 'number' || token.kind === 'string') return { ...span, kind: 'literal', value: token.value! }
    if (token.kind === 'identifier') {
      if (token.text === '真' || token.text === 'true') return { ...span, kind: 'literal', value: true }
      if (token.text === '假' || token.text === 'false') return { ...span, kind: 'literal', value: false }
      if (token.text === '空' || token.text === 'null') return { ...span, kind: 'literal', value: null }
      return { ...span, kind: 'identifier', name: safeKey(token.text, token.start) }
    }
    if (token.text === '(') {
      const value = expression(0); requireToken(')')
      return { ...value, start: token.start, end: tokens[cursor - 1].end }
    }
    if (token.text === '{') {
      if (accept('}')) return { kind: 'tuple', items: [], start: token.start, end: tokens[cursor - 1].end }
      if (['identifier', 'string'].includes(current().kind) && tokens[cursor + 1].text === ':') {
        const fields: { name: string; value: AuthorExpression }[] = []
        const seen = new Set<string>()
        do {
          const key = take()
          if (key.kind !== 'identifier' && key.kind !== 'string') throw new AuthorExpressionError('字段名须为名称或文本', key.start)
          const name = safeKey(String(key.value ?? key.text), key.start)
          if (seen.has(name)) throw new AuthorExpressionError(`字段「${name}」重复`, key.start)
          seen.add(name); requireToken(':'); fields.push({ name, value: expression(0) })
        } while (accept(',') && current().text !== '}')
        requireToken('}')
        return { kind: 'object', fields, start: token.start, end: tokens[cursor - 1].end }
      }
      const items: AuthorExpression[] = []
      do { items.push(expression(0)) } while (accept(',') && current().text !== '}')
      requireToken('}')
      return { kind: 'tuple', items, start: token.start, end: tokens[cursor - 1].end }
    }
    throw new AuthorExpressionError('此处需要变量、数值或表达式', token.start)
  }
  function expression(minimum: number): AuthorExpression {
    if (++depth > 64) fail('表达式嵌套超过上限')
    let value: AuthorExpression
    if (['!', '+', '-'].includes(current().text)) {
      const operator = take()
      const operand = expression(7)
      value = { kind: 'unary', operator: operator.text, operand, start: operator.start, end: operand.end }
    } else value = primary()
    for (;;) {
      if (accept('.')) {
        const field = take()
        if (field.kind !== 'identifier') throw new AuthorExpressionError('点号后需要字段名', field.start)
        value = { kind: 'member', object: value, field: safeKey(field.text, field.start), start: value.start, end: field.end }
      } else if (accept('[')) {
        const index = expression(0); requireToken(']')
        value = { kind: 'index', object: value, index, start: value.start, end: tokens[cursor - 1].end }
      } else if (accept('(')) {
        const args: AuthorArgument[] = []; const names = new Set<string>(); let named = false
        if (current().text !== ')') do {
          let name: string | undefined
          if (current().kind === 'identifier' && tokens[cursor + 1].text === ':') {
            const key = take(); name = safeKey(key.text, key.start); take(); named = true
            if (names.has(name)) throw new AuthorExpressionError(`参数「${name}」重复`, key.start)
            names.add(name)
          } else if (named) fail('命名参数之后不能再填写位置参数')
          args.push({ ...(name === undefined ? {} : { name }), value: expression(0) })
        } while (accept(',') && current().text !== ')')
        requireToken(')')
        value = { kind: 'call', callee: value, arguments: args, start: value.start, end: tokens[cursor - 1].end }
      } else {
        const operator = current().text
        const rank = precedence[operator]
        if (rank === undefined || rank < minimum) break
        take()
        const right = expression(operator === '^' ? rank : rank + 1)
        value = { kind: 'binary', operator, left: value, right, start: value.start, end: right.end }
      }
    }
    depth--; return value
  }
  const result = expression(0)
  if (current().kind !== 'end') fail(`多余的符号「${current().text}」`)
  return result
}
