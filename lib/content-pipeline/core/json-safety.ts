import type { JsonValueV1 } from '../contracts'
import { CONTENT_PIPELINE_LIMITS_V1 } from './error-codes'

export type JsonSafetyFailureReasonV1 =
  | 'bom'
  | 'utf8'
  | 'syntax'
  | 'duplicate-key'
  | 'unicode'
  | 'depth'
  | 'nodes'
  | 'string-bytes'

export class JsonSafetyErrorV1 extends Error {
  readonly reason: JsonSafetyFailureReasonV1

  constructor(reason: JsonSafetyFailureReasonV1) {
    super(`Strict JSON validation failed: ${reason}`)
    this.name = 'JsonSafetyErrorV1'
    this.reason = reason
  }
}

export const EXECUTABLE_CONTENT_FIELDS_V1 = Object.freeze([
  'code',
  'skillCode',
  'triggerSkill',
  'previewCode',
  'effectCode',
] as const)

const executableContentFields = new Set<string>(EXECUTABLE_CONTENT_FIELDS_V1)
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const utf8Encoder = new TextEncoder()

function fail(reason: JsonSafetyFailureReasonV1): never {
  throw new JsonSafetyErrorV1(reason)
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index)
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false
    }
  }
  return true
}

class StrictJsonParserV1 {
  private index = 0
  private nodes = 0

  constructor(private readonly text: string) {}

  parse(): JsonValueV1 {
    this.skipWhitespace()
    const value = this.parseValue(1)
    this.skipWhitespace()
    if (this.index !== this.text.length) fail('syntax')
    return value
  }

  private countNode(): void {
    this.nodes += 1
    if (this.nodes > CONTENT_PIPELINE_LIMITS_V1.maxJsonNodes) fail('nodes')
  }

  private parseValue(depth: number): JsonValueV1 {
    if (depth > CONTENT_PIPELINE_LIMITS_V1.maxJsonDepth) fail('depth')
    this.countNode()
    const current = this.text[this.index]
    if (current === '{') return this.parseObject(depth)
    if (current === '[') return this.parseArray(depth)
    if (current === '"') return this.parseString()
    if (current === 't') return this.parseLiteral('true', true)
    if (current === 'f') return this.parseLiteral('false', false)
    if (current === 'n') return this.parseLiteral('null', null)
    if (current === '-' || (current >= '0' && current <= '9')) {
      return this.parseNumber()
    }
    return fail('syntax')
  }

  private parseObject(depth: number): { [key: string]: JsonValueV1 } {
    this.index += 1
    this.skipWhitespace()
    const result: { [key: string]: JsonValueV1 } = Object.create(null) as {
      [key: string]: JsonValueV1
    }
    const seen = new Set<string>()
    if (this.text[this.index] === '}') {
      this.index += 1
      return result
    }

    while (this.index < this.text.length) {
      if (this.text[this.index] !== '"') fail('syntax')
      this.countNode()
      const key = this.parseString()
      if (seen.has(key)) fail('duplicate-key')
      seen.add(key)
      this.skipWhitespace()
      if (this.text[this.index] !== ':') fail('syntax')
      this.index += 1
      this.skipWhitespace()
      result[key] = this.parseValue(depth + 1)
      this.skipWhitespace()
      const separator = this.text[this.index]
      if (separator === '}') {
        this.index += 1
        return result
      }
      if (separator !== ',') fail('syntax')
      this.index += 1
      this.skipWhitespace()
    }
    return fail('syntax')
  }

  private parseArray(depth: number): JsonValueV1[] {
    this.index += 1
    this.skipWhitespace()
    const result: JsonValueV1[] = []
    if (this.text[this.index] === ']') {
      this.index += 1
      return result
    }

    while (this.index < this.text.length) {
      result.push(this.parseValue(depth + 1))
      this.skipWhitespace()
      const separator = this.text[this.index]
      if (separator === ']') {
        this.index += 1
        return result
      }
      if (separator !== ',') fail('syntax')
      this.index += 1
      this.skipWhitespace()
    }
    return fail('syntax')
  }

  private parseString(): string {
    const start = this.index
    this.index += 1
    let closed = false
    while (this.index < this.text.length) {
      const codeUnit = this.text.charCodeAt(this.index)
      if (codeUnit === 0x22) {
        this.index += 1
        closed = true
        break
      }
      if (codeUnit < 0x20) fail('syntax')
      if (codeUnit === 0x5c) {
        this.index += 1
        const escape = this.text[this.index]
        if (escape === 'u') {
          const digits = this.text.slice(this.index + 1, this.index + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail('syntax')
          this.index += 5
          continue
        }
        if (!'"\\/bfnrt'.includes(escape ?? '')) fail('syntax')
        this.index += 1
        continue
      }
      this.index += 1
    }
    if (!closed) fail('syntax')

    let value: unknown
    try {
      value = JSON.parse(this.text.slice(start, this.index)) as unknown
    } catch {
      return fail('syntax')
    }
    if (typeof value !== 'string') return fail('syntax')
    if (!isWellFormedUnicode(value)) fail('unicode')
    if (utf8Encoder.encode(value).byteLength > CONTENT_PIPELINE_LIMITS_V1.maxJsonStringBytes) {
      fail('string-bytes')
    }
    return value
  }

  private parseNumber(): number {
    const start = this.index
    if (this.text[this.index] === '-') this.index += 1
    if (this.text[this.index] === '0') {
      this.index += 1
      if (this.isDigit(this.text[this.index])) fail('syntax')
    } else {
      if (!this.isNonZeroDigit(this.text[this.index])) fail('syntax')
      this.index += 1
      while (this.isDigit(this.text[this.index])) this.index += 1
    }
    if (this.text[this.index] === '.') {
      this.index += 1
      if (!this.isDigit(this.text[this.index])) fail('syntax')
      while (this.isDigit(this.text[this.index])) this.index += 1
    }
    const exponent = this.text[this.index]
    if (exponent === 'e' || exponent === 'E') {
      this.index += 1
      const sign = this.text[this.index]
      if (sign === '+' || sign === '-') this.index += 1
      if (!this.isDigit(this.text[this.index])) fail('syntax')
      while (this.isDigit(this.text[this.index])) this.index += 1
    }
    const value = Number(this.text.slice(start, this.index))
    if (!Number.isFinite(value)) fail('syntax')
    return value
  }

  private parseLiteral<T extends null | boolean>(token: string, value: T): T {
    if (this.text.slice(this.index, this.index + token.length) !== token) {
      return fail('syntax')
    }
    this.index += token.length
    return value
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const current = this.text.charCodeAt(this.index)
      if (current !== 0x20 && current !== 0x09 && current !== 0x0a && current !== 0x0d) {
        return
      }
      this.index += 1
    }
  }

  private isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= '0' && value <= '9'
  }

  private isNonZeroDigit(value: string | undefined): boolean {
    return value !== undefined && value >= '1' && value <= '9'
  }
}

export function parseStrictJsonBytesV1(input: Uint8Array): JsonValueV1 {
  if (
    input.byteLength >= 3
    && input[0] === 0xef
    && input[1] === 0xbb
    && input[2] === 0xbf
  ) {
    fail('bom')
  }

  let text: string
  try {
    text = utf8Decoder.decode(input)
  } catch {
    return fail('utf8')
  }
  return new StrictJsonParserV1(text).parse()
}

export function hasExecutableContentV1(value: JsonValueV1): boolean {
  const pending: JsonValueV1[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current === null || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    for (const [key, nested] of Object.entries(current)) {
      if (executableContentFields.has(key)) return true
      pending.push(nested)
    }
  }
  return false
}
