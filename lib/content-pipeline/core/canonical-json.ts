import { compareUnicodeCodePointsV1 } from '@/lib/content-pipeline/contracts'

const UTF8_ENCODER = new TextEncoder()
const NUMBER_TO_STRING = Number.prototype.toString
const HEX_DIGITS = '0123456789abcdef'

export class CanonicalJsonV1Error extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalJsonV1Error'
  }
}

const INTERNAL_CANONICAL_ERRORS_V1 = new WeakSet<object>()

function fail(message: string): never {
  const error = new CanonicalJsonV1Error(message)
  INTERNAL_CANONICAL_ERRORS_V1.add(error)
  throw Object.freeze(error)
}

function escapeStringV1(value: string): string {
  let result = '"'

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('Canonical JSON strings must contain only well-formed Unicode scalar values')
      }
      result += value[index] + value[index + 1]
      index += 1
      continue
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail('Canonical JSON strings must contain only well-formed Unicode scalar values')
    }

    switch (codeUnit) {
      case 0x08:
        result += '\\b'
        break
      case 0x09:
        result += '\\t'
        break
      case 0x0a:
        result += '\\n'
        break
      case 0x0c:
        result += '\\f'
        break
      case 0x0d:
        result += '\\r'
        break
      case 0x22:
        result += '\\"'
        break
      case 0x5c:
        result += '\\\\'
        break
      default:
        if (codeUnit <= 0x1f) {
          result += `\\u00${HEX_DIGITS[(codeUnit >>> 4) & 0x0f]}${HEX_DIGITS[codeUnit & 0x0f]}`
        } else {
          result += value[index]
        }
    }
  }

  return `${result}"`
}

function serializeArrayV1(value: unknown[], ancestors: WeakSet<object>): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    fail('Canonical JSON arrays must use the standard Array prototype')
  }

  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== value.length + 1) {
    fail('Canonical JSON arrays must be dense and must not contain extra properties')
  }

  const serialized: string[] = []
  ancestors.add(value)
  try {
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        fail('Canonical JSON arrays must contain enumerable data properties at every index')
      }
      serialized.push(serializeValueV1(descriptor.value, ancestors))
    }

    for (const key of ownKeys) {
      if (typeof key === 'symbol') {
        fail('Canonical JSON values must not contain symbol keys')
      }
      if (key === 'length') continue
      const numericIndex = Number(key)
      if (!Number.isInteger(numericIndex) || numericIndex < 0 || numericIndex >= value.length) {
        fail('Canonical JSON arrays must not contain extra properties')
      }
    }
  } finally {
    ancestors.delete(value)
  }

  return `[${serialized.join(',')}]`
}

function serializeObjectV1(value: object, ancestors: WeakSet<object>): string {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('Canonical JSON objects must be plain objects')
  }

  const descriptors = new Map<string, PropertyDescriptor>()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      fail('Canonical JSON values must not contain symbol keys')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      fail('Canonical JSON objects must contain only enumerable data properties')
    }
    // Escaping validates that the key is a well-formed Unicode scalar sequence.
    escapeStringV1(key)
    descriptors.set(key, descriptor)
  }

  const keys = [...descriptors.keys()].sort(compareUnicodeCodePointsV1)
  const serialized: string[] = []
  ancestors.add(value)
  try {
    for (const key of keys) {
      serialized.push(
        `${escapeStringV1(key)}:${serializeValueV1(descriptors.get(key)!.value, ancestors)}`,
      )
    }
  } finally {
    ancestors.delete(value)
  }

  return `{${serialized.join(',')}}`
}

function serializeValueV1(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        fail('Canonical JSON numbers must be finite IEEE-754 binary64 values')
      }
      return Object.is(value, -0) ? '0' : NUMBER_TO_STRING.call(value)
    case 'string':
      return escapeStringV1(value)
    case 'object':
      if (ancestors.has(value)) {
        fail('Canonical JSON values must not be cyclic')
      }
      return Array.isArray(value)
        ? serializeArrayV1(value, ancestors)
        : serializeObjectV1(value, ancestors)
    default:
      return fail(`Canonical JSON does not support ${typeof value} values`)
  }
}

/**
 * Serializes an already-parsed JSON value using RVB Canonical JSON v1.
 * Raw UTF-8 syntax and duplicate-key checks belong to the strict JSON parser.
 */
export function canonicalizeJsonV1(value: unknown): string {
  try {
    return serializeValueV1(value, new WeakSet<object>())
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && INTERNAL_CANONICAL_ERRORS_V1.has(error)
    ) {
      throw error
    }
    throw new CanonicalJsonV1Error('Canonical JSON input inspection failed')
  }
}

export function canonicalJsonBytesV1(value: unknown): Uint8Array {
  return UTF8_ENCODER.encode(canonicalizeJsonV1(value))
}
